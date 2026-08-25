import {
  buildEditorialIntake,
  type EditorialIntakeHistory,
} from '../src/content/intake.ts';
import {
  DEFAULT_PIPELINE_CONTROLS,
  processEditorialCandidates,
} from '../src/content/pipeline.ts';
import {
  sourceRegistry,
  type SourceRegistryEntry,
  type SourceRssIngestion,
} from '../src/content/sources.ts';
import {
  draftEditorialCopy,
  type EditorialAiConfig,
} from './stephen-editorial-ai.ts';
import {
  projectEditorialGovernance,
  runSequentialEditorialScans,
} from './stephen-editorial-runner.ts';
import { fetchAllowlistedRss, parseRss2Feed } from './stephen-rss.ts';

type MachineSource = SourceRegistryEntry & { readonly ingestion: SourceRssIngestion };

function isMachineSource<T extends SourceRegistryEntry>(
  source: T,
): source is T & { readonly ingestion: SourceRssIngestion } {
  return source.ingestion !== undefined;
}

function loadAiConfig(): EditorialAiConfig | undefined {
  const baseUrl = process.env.EDITORIAL_AI_BASE_URL?.trim();
  const model = process.env.EDITORIAL_AI_MODEL?.trim();
  const apiKey = process.env.EDITORIAL_AI_API_KEY?.trim();
  const configuredCount = [baseUrl, model, apiKey].filter(Boolean).length;
  if (configuredCount === 0) return undefined;
  if (configuredCount !== 3) {
    throw new Error('EDITORIAL_AI_BASE_URL, EDITORIAL_AI_MODEL and EDITORIAL_AI_API_KEY must be set together');
  }
  return { baseUrl: baseUrl!, model: model!, apiKey: apiKey! };
}

function safeErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message.slice(0, 240);
  return 'unknown intake error';
}

async function scanSource(
  source: MachineSource,
  fetchedAt: string,
  aiConfig: EditorialAiConfig | undefined,
  history: EditorialIntakeHistory,
) {
  const fetched = await fetchAllowlistedRss(source);
  const feed = parseRss2Feed(fetched.xml, { maxItems: source.ingestion.maxItems });
  const intake = buildEditorialIntake({
    source,
    entries: feed.entries,
    fetchedAt,
    feedUrl: fetched.finalUrl,
    contentType: fetched.contentType,
    history,
  });
  const governable = intake.records.filter((record) => (
    record.disposition !== 'duplicate'
    && record.item !== undefined
    && record.canonicalUrl !== null
  ));
  const governance = processEditorialCandidates(
    governable.map((record) => ({
      item: record.item!,
      sourceId: record.sourceId,
      canonicalUrl: record.canonicalUrl!,
      fetchedAt: record.fetchedAt,
      eventKey: record.eventKey,
      riskSignals: record.riskSignals,
      sourceConflict: record.sourceConflict,
    })),
    sourceRegistry,
    DEFAULT_PIPELINE_CONTROLS,
  );
  const records = await Promise.all(intake.records.map(async (record) => {
    if (record.disposition === 'duplicate' || !record.canonicalUrl) return record;
    const editorialDraft = await draftEditorialCopy({
      originalTitle: record.originalTitle,
      sourceName: source.name,
      sourceUrl: record.canonicalUrl,
      sourceExcerpt: record.evidenceExcerpt,
    }, { config: aiConfig });
    return { ...record, editorialDraft };
  }));

  return {
    report: {
      sourceId: source.id,
      feedUrl: fetched.finalUrl,
      channelTitle: feed.channelTitle,
      scanned: intake.scanned,
      candidates: intake.candidates.length,
      manualReview: intake.manualReview.length,
      duplicates: intake.duplicates.length,
      governance: projectEditorialGovernance(governance),
      records,
    },
    nextHistory: intake.nextHistory,
  };
}

async function main() {
  const fetchedAt = new Date().toISOString();
  const aiConfig = loadAiConfig();
  const sources = sourceRegistry.filter(isMachineSource);
  const scanResult = await runSequentialEditorialScans(
    sources,
    (source, history) => scanSource(source, fetchedAt, aiConfig, history),
  );
  const scans = scanResult.reports;
  const failures = scanResult.failures.map((failure) => ({
    sourceId: failure.sourceId,
    error: safeErrorMessage(failure.error),
  }));

  const report = {
    task: 'SAAS-605',
    fetchedAt,
    controls: DEFAULT_PIPELINE_CONTROLS,
    aiMode: aiConfig ? 'configured' : 'deterministic_fallback',
    stats: {
      sourcesConfigured: sources.length,
      sourcesSucceeded: scans.length,
      sourcesFailed: failures.length,
      scanned: scans.reduce((sum, scan) => sum + scan.scanned, 0),
      candidates: scans.reduce((sum, scan) => sum + scan.candidates, 0),
      manualReview: scans.reduce((sum, scan) => sum + scan.manualReview, 0),
      duplicates: scans.reduce((sum, scan) => sum + scan.duplicates, 0),
    },
    scans,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(JSON.stringify({
    task: 'SAAS-605',
    error: safeErrorMessage(error),
  }));
  process.exitCode = 1;
});
