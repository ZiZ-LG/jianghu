import type {
  ReviewedKnowledgeItem,
  RiskLevel,
  SeedContentCategory,
} from '../domain.ts';
import {
  deriveRiskLevelFromSignals,
  normalizeCanonicalUrl,
  type EditorialRiskSignal,
} from './pipeline.ts';
import type { SourceRegistryEntry } from './sources.ts';
import type { RssFeedEntry } from '../../scripts/stephen-rss.ts';

export const INTAKE_RULE_VERSION = 'stephen-intake-v2';

export type IntakeDisposition = 'candidate' | 'manual_review' | 'duplicate';
export type IntakeDuplicateReason = 'normalized_url' | 'event_key' | 'source_fingerprint';

export interface IntakeProvenance {
  readonly protocol: 'rss2';
  readonly feedUrl: string;
  readonly contentType: string;
  readonly originalGuid: string;
}

export interface EditorialIntakeRecord {
  readonly candidateId: string;
  readonly sourceId: string;
  readonly originalTitle: string;
  readonly canonicalUrl: string | null;
  readonly publishedAt: string | null;
  readonly fetchedAt: string;
  readonly sourceSummary: string;
  readonly evidenceExcerpt: string;
  readonly eventKey: string;
  readonly contentFingerprint: string;
  readonly riskSignals: readonly EditorialRiskSignal[];
  readonly riskLevel: RiskLevel;
  readonly sourceConflict: boolean;
  readonly disposition: IntakeDisposition;
  readonly reasons: readonly string[];
  readonly duplicateReason?: IntakeDuplicateReason;
  readonly ruleVersion: string;
  readonly provenance: IntakeProvenance;
  readonly item?: ReviewedKnowledgeItem;
}

export interface EditorialIntakeHistory {
  readonly normalizedUrls?: ReadonlySet<string>;
  readonly eventKeys?: ReadonlySet<string>;
  readonly sourceFingerprints?: ReadonlySet<string>;
}

export interface EditorialIntakeInput {
  readonly source: SourceRegistryEntry | undefined;
  readonly sourceIdHint?: string;
  readonly entries: readonly RssFeedEntry[];
  readonly fetchedAt: string;
  readonly feedUrl: string;
  readonly contentType: string;
  readonly conflictingUrls?: ReadonlySet<string>;
  readonly history?: EditorialIntakeHistory;
}

export interface EditorialIntakeBatch {
  readonly scanned: number;
  readonly records: readonly EditorialIntakeRecord[];
  readonly candidates: readonly EditorialIntakeRecord[];
  readonly manualReview: readonly EditorialIntakeRecord[];
  readonly duplicates: readonly EditorialIntakeRecord[];
  readonly nextHistory: Required<EditorialIntakeHistory>;
}

function normalizeText(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function stableHash64(value: string) {
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function truncate(value: string, maximum: number) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maximum) return normalized;
  return normalized.slice(0, maximum).trimEnd();
}

function toIsoTimestamp(value: string) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function classifyRiskSignals(entry: RssFeedEntry): readonly EditorialRiskSignal[] {
  const searchable = normalizeText(`${entry.title} ${entry.descriptionText}`);
  const signals = new Set<EditorialRiskSignal>();
  if (/\b(pricing|price|billing|commercial terms?|subscription)\b|定价|价格|计费/.test(searchable)) {
    signals.add('pricing_commercial_terms');
  }
  if (/\b(security|privacy|cyber|vulnerabilit|breach|attack)\b|安全|隐私|漏洞|攻击/.test(searchable)) {
    signals.add('security_privacy');
  }
  if (/\b(law|legal|regulat|compliance|policy mandate)\b|法律|法规|监管|合规/.test(searchable)) {
    signals.add('legal_regulatory');
  }
  if (/\b(customer|case stud|client)\b|客户案例|客户成效/.test(searchable)) {
    signals.add('customer_case');
  }
  if (/\b\d+(?:\.\d+)?%|percent|percentage\b|百分之/.test(searchable)) {
    signals.add('quantified_outcome');
  }
  if (/\b(role|career|hiring|job)\b|岗位|招聘|职业/.test(searchable)) {
    signals.add('role_trend');
  }
  if (signals.size === 0) signals.add('ordinary_product_fact');
  return [...signals];
}

function seedCategoryForSource(source: SourceRegistryEntry): SeedContentCategory {
  if (source.kind === 'official_careers') return 'ai_role_change';
  if (source.kind === 'corporate_research') return 'org_adoption';
  return 'ai_technology';
}

function buildKnowledgeItem(
  record: Omit<EditorialIntakeRecord, 'item' | 'disposition' | 'reasons'>,
  source: SourceRegistryEntry,
): ReviewedKnowledgeItem | undefined {
  if (!record.canonicalUrl || !record.publishedAt || !record.originalTitle) return undefined;
  const shortId = record.candidateId.slice(3).toLocaleLowerCase();
  const evidenceId = `EV-${record.candidateId}`;
  return {
    id: record.candidateId,
    slug: `daily-${shortId}`,
    title: { zh: `官方更新候选｜${record.originalTitle}` },
    summary: {
      zh: `${source.name} 发布了这项更新。当前候选仅依据官方 RSS 元数据生成，需人工阅读原文并核验结论。`,
    },
    kind: 'update',
    domains: ['ai_technology'],
    topicSlugs: [],
    audience: ['transitioning_seller'],
    publishedAt: record.publishedAt,
    updatedAt: record.fetchedAt,
    freshness: 'current',
    whyItMatters: { zh: '其与目标用户、大客户销售或组织转型的关联尚待编辑核验。' },
    salesImplication: { zh: '需要结合具体客户场景判断，机器候选不直接给出销售结论。' },
    roleOrgImplication: { zh: '需要由编辑核对岗位分工、组织采用条件和适用边界。' },
    nextAction: { zh: '阅读官方原文，补充第二项独立事实，再决定是否进入公开候选。' },
    evidence: [{
      id: evidenceId,
      sourceId: source.id,
      title: record.originalTitle,
      publisher: source.name,
      url: record.canonicalUrl,
      publishedAt: record.publishedAt,
      level: 'official',
      language: source.language === 'zh' ? 'zh' : 'en',
      allowlisted: true,
      dateBasis: 'published',
    }],
    relatedItemIds: [],
    editorialStatus: 'candidate',
    riskLevel: record.riskLevel,
    publicationMode: 'manual',
    seedContent: false,
    audit: {
      sourceFingerprint: record.contentFingerprint,
      ruleVersion: INTAKE_RULE_VERSION,
      processedAt: record.fetchedAt,
      releaseVersion: 'unreleased',
      rollbackState: 'available',
    },
    seedCategory: seedCategoryForSource(source),
    conclusionScope: 'single_authority',
    supportingFacts: [{
      id: `${record.candidateId}-f1`,
      statement: `官方信源发布的原始标题为“${record.originalTitle}”。`,
      evidenceIds: [evidenceId],
    }],
    deeperAnalysis: {
      mechanism: '机器采集仅确认官方元数据，尚不能形成机制判断。',
      businessValue: '需由编辑结合第二项事实说明其业务价值。',
      boundary: '未完成原文复核、交叉佐证和适用边界检查前，不得公开。',
    },
    originalTitle: record.originalTitle,
    tags: [source.id, 'machine-intake'],
    toolIds: [],
    review: {
      status: 'pending_owner_review',
      verifiedAt: record.fetchedAt,
      changeWindow: 'within_30_days',
      factType: 'official_fact',
      verificationNotes: '仅核验到白名单官方 RSS 元数据，事实、结论和行动建议尚未终审。',
    },
  };
}

function createRecord(
  entry: RssFeedEntry,
  input: EditorialIntakeInput,
): EditorialIntakeRecord {
  const sourceId = input.source?.id ?? input.sourceIdHint?.trim() ?? 'unregistered-source';
  const originalTitle = entry.title.trim();
  const normalizedUrl = normalizeCanonicalUrl(entry.link);
  const url = normalizedUrl.startsWith('https://') ? new URL(normalizedUrl) : null;
  const hostAllowed = !input.source?.ingestion
    || (url !== null && input.source.ingestion.allowedItemHosts.includes(url.hostname));
  const canonicalUrl = url && hostAllowed ? url.href : null;
  const publishedAt = toIsoTimestamp(entry.publishedAt);
  const guidBasis = normalizeCanonicalUrl(entry.guid) || normalizeText(entry.guid);
  const identityBasis = canonicalUrl || guidBasis || `${normalizeText(originalTitle)}|${publishedAt ?? ''}`;
  const candidateId = `ED-${stableHash64(`${sourceId}|${identityBasis}`).toLocaleUpperCase()}`;
  const normalizedTitle = normalizeText(originalTitle);
  const eventWindow = publishedAt?.slice(0, 10) ?? 'undated';
  const eventBasis = normalizedTitle
    ? `${normalizedTitle}|${eventWindow}`
    : `${sourceId}|${guidBasis || identityBasis}|${eventWindow}`;
  const eventKey = `event-${stableHash64(eventBasis)}`;
  const contentFingerprint = stableHash64([
    normalizedTitle,
    normalizeText(entry.descriptionText),
    publishedAt ?? '',
  ].join('|'));
  const conflictingUrls = new Set(
    [...(input.conflictingUrls ?? [])]
      .map(normalizeCanonicalUrl)
      .filter(Boolean),
  );
  const sourceConflict = canonicalUrl !== null && conflictingUrls.has(canonicalUrl);
  const riskSignals = classifyRiskSignals(entry);
  const riskLevel = deriveRiskLevelFromSignals(riskSignals, sourceConflict);
  const reasons: string[] = [];

  if (!input.source) reasons.push('source is missing or not registered');
  if (!originalTitle) reasons.push('title is missing');
  if (!publishedAt) reasons.push('publishedAt is missing or invalid');
  if (!normalizedUrl.startsWith('https://')) reasons.push('canonical URL must use HTTPS');
  else if (!hostAllowed) reasons.push('canonical URL host is not allowlisted');
  if (sourceConflict) reasons.push('source conflict requires manual review');
  else if (riskLevel !== 'low') reasons.push(`${riskLevel} risk requires manual review`);
  if (input.source?.automaticEligibility === 'manual_review_only') {
    reasons.push('source requires manual review');
  }

  const sourceSummary = truncate(entry.descriptionText || originalTitle, 280);
  const evidenceExcerpt = truncate(entry.descriptionText || originalTitle, 160);
  const recordBase = {
    candidateId,
    sourceId,
    originalTitle,
    canonicalUrl,
    publishedAt,
    fetchedAt: input.fetchedAt,
    sourceSummary,
    evidenceExcerpt,
    eventKey,
    contentFingerprint,
    riskSignals,
    riskLevel,
    sourceConflict,
    ruleVersion: INTAKE_RULE_VERSION,
    provenance: {
      protocol: 'rss2' as const,
      feedUrl: input.feedUrl,
      contentType: input.contentType,
      originalGuid: entry.guid,
    },
  };
  const item = input.source ? buildKnowledgeItem(recordBase, input.source) : undefined;

  return {
    ...recordBase,
    disposition: reasons.length === 0 ? 'candidate' : 'manual_review',
    reasons,
    ...(item ? { item } : {}),
  };
}

export function buildEditorialIntake(input: EditorialIntakeInput): EditorialIntakeBatch {
  if (!input.fetchedAt.includes('T') || Number.isNaN(Date.parse(input.fetchedAt))) {
    throw new Error('fetchedAt must be an ISO timestamp');
  }
  const history = input.history ?? {};
  const seenUrls = new Set(
    [...(history.normalizedUrls ?? [])]
      .map(normalizeCanonicalUrl)
      .filter(Boolean),
  );
  const seenEvents = new Set(
    [...(history.eventKeys ?? [])]
      .map(normalizeText)
      .filter(Boolean),
  );
  const seenFingerprints = new Set(history.sourceFingerprints ?? []);
  const records: EditorialIntakeRecord[] = [];

  for (const entry of input.entries) {
    const record = createRecord(entry, input);
    const normalizedEvent = normalizeText(record.eventKey);
    let duplicateReason: IntakeDuplicateReason | undefined;
    if (record.canonicalUrl && seenUrls.has(record.canonicalUrl)) {
      duplicateReason = 'normalized_url';
    } else if (seenEvents.has(normalizedEvent)) {
      duplicateReason = 'event_key';
    } else if (seenFingerprints.has(record.contentFingerprint)) {
      duplicateReason = 'source_fingerprint';
    }

    if (duplicateReason) {
      records.push({
        ...record,
        disposition: 'duplicate',
        reasons: [`duplicate detected by ${duplicateReason}`],
        duplicateReason,
      });
    } else {
      records.push(record);
    }
    if (record.canonicalUrl) seenUrls.add(record.canonicalUrl);
    seenEvents.add(normalizedEvent);
    seenFingerprints.add(record.contentFingerprint);
  }

  return {
    scanned: input.entries.length,
    records,
    candidates: records.filter((record) => record.disposition === 'candidate'),
    manualReview: records.filter((record) => record.disposition === 'manual_review'),
    duplicates: records.filter((record) => record.disposition === 'duplicate'),
    nextHistory: {
      normalizedUrls: new Set(seenUrls),
      eventKeys: new Set(seenEvents),
      sourceFingerprints: new Set(seenFingerprints),
    },
  };
}
