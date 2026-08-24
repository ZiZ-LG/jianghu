import { describe, expect, it } from 'vitest';

import googleCloudFixture from '../../scripts/fixtures/google-cloud-ai.xml?raw';
import openAiFixture from '../../scripts/fixtures/openai-news.xml?raw';
import {
  fetchAllowlistedRss,
  parseRss2Feed,
  type RssFeedEntry,
} from '../../scripts/stephen-rss';
import {
  buildEditorialIntake,
  INTAKE_RULE_VERSION,
} from './intake';
import { sourceRegistry } from './sources';

const openAiSource = sourceRegistry.find((source) => source.id === 'openai-news-rss');
const googleCloudSource = sourceRegistry.find((source) => source.id === 'google-cloud-ai-blog');

describe('SAAS-605 RSS intake boundary', () => {
  it('parses only bounded RSS metadata and rejects XML entity or structural drift', () => {
    const parsed = parseRss2Feed(openAiFixture, { maxItems: 20 });

    expect(parsed.channelTitle).toBe('OpenAI News');
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({
      title: 'Introducing a verified API capability',
      link: 'https://openai.com/index/verified-api-capability?utm_source=rss#details',
      guid: 'https://openai.com/index/verified-api-capability',
      publishedAt: 'Thu, 20 Aug 2026 07:00:00 GMT',
    });
    expect(parsed.entries[0].descriptionText.length).toBeLessThanOrEqual(1_000);

    expect(() => parseRss2Feed(
      '<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss><channel><item><title>&xxe;</title></item></channel></rss>',
      { maxItems: 20 },
    )).toThrow('RSS DTD and ENTITY declarations are not allowed');
    expect(() => parseRss2Feed(
      '<feed><entry><title>Atom drift</title></entry></feed>',
      { maxItems: 20 },
    )).toThrow('RSS 2.0 structure drift detected');
  });

  it('fails closed on non-feed content types and off-allowlist redirects', async () => {
    expect(openAiSource).toBeDefined();
    if (!openAiSource) return;

    const htmlFetch = (async () => new Response('<html>not a feed</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })) as typeof fetch;
    await expect(fetchAllowlistedRss(openAiSource, { fetchImpl: htmlFetch }))
      .rejects.toThrow('RSS response content type is not allowlisted');

    const requested: string[] = [];
    const redirectFetch = (async (input: URL | RequestInfo) => {
      requested.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: 'https://unapproved.example/feed.xml' },
      });
    }) as typeof fetch;
    await expect(fetchAllowlistedRss(openAiSource, { fetchImpl: redirectFetch }))
      .rejects.toThrow('RSS redirect host is not allowlisted');
    expect(requested).toEqual(['https://openai.com/news/rss.xml']);
  });

  it('keeps the source timeout active until the RSS response body is complete', async () => {
    expect(openAiSource).toBeDefined();
    if (!openAiSource || !('ingestion' in openAiSource)) return;
    const timeoutSource = {
      ...openAiSource,
      ingestion: { ...openAiSource.ingestion, timeoutMs: 1 },
    };
    const slowBodyFetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const complete = () => {
            if (init?.signal?.aborted) {
              controller.error(new DOMException('aborted', 'AbortError'));
              return;
            }
            controller.enqueue(new TextEncoder().encode(openAiFixture));
            controller.close();
          };
          setTimeout(complete, 10);
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/xml' },
      });
    }) as typeof fetch;

    await expect(fetchAllowlistedRss(timeoutSource, { fetchImpl: slowBodyFetch }))
      .rejects.toThrow('RSS request timed out');
  });

  it('stops reading an undeclared oversized response at the configured byte boundary', async () => {
    expect(openAiSource).toBeDefined();
    if (!openAiSource?.ingestion) return;
    const boundedSource = {
      ...openAiSource,
      ingestion: { ...openAiSource.ingestion, maxBytes: 16 },
    };
    let emittedChunks = 0;
    let cancelled = false;
    const oversizedFetch = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emittedChunks >= 100) {
          controller.close();
          return;
        }
        emittedChunks += 1;
        controller.enqueue(new Uint8Array(8).fill(65));
      },
      cancel() {
        cancelled = true;
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/xml' },
    })) as typeof fetch;

    await expect(fetchAllowlistedRss(boundedSource, { fetchImpl: oversizedFetch }))
      .rejects.toThrow('RSS response exceeds the byte limit');
    expect(cancelled).toBe(true);
    expect(emittedChunks).toBeLessThan(100);
  });

  it('cancels a declared oversized response before consuming its body', async () => {
    expect(openAiSource).toBeDefined();
    if (!openAiSource?.ingestion) return;
    let cancelled = false;
    const declaredOversizedFetch = (async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }), {
      status: 200,
      headers: {
        'content-type': 'text/xml',
        'content-length': String(openAiSource.ingestion!.maxBytes + 1),
      },
    })) as typeof fetch;

    await expect(fetchAllowlistedRss(openAiSource, { fetchImpl: declaredOversizedFetch }))
      .rejects.toThrow('RSS response exceeds the byte limit');
    expect(cancelled).toBe(true);
  });
});

describe('SAAS-605 candidate discovery model', () => {
  it('creates a stable manual-gated candidate with provenance and no full-text copy', () => {
    expect(openAiSource).toBeDefined();
    if (!openAiSource) return;
    const feed = parseRss2Feed(openAiFixture, { maxItems: 20 });

    const firstRun = buildEditorialIntake({
      source: openAiSource,
      entries: feed.entries,
      fetchedAt: '2026-08-24T07:30:00.000Z',
      feedUrl: 'https://openai.com/news/rss.xml',
      contentType: 'text/xml',
    });
    const secondRun = buildEditorialIntake({
      source: openAiSource,
      entries: feed.entries,
      fetchedAt: '2026-08-24T16:30:00.000Z',
      feedUrl: 'https://openai.com/news/rss.xml',
      contentType: 'text/xml',
    });

    expect(firstRun.candidates).toHaveLength(1);
    expect(firstRun.manualReview).toEqual([]);
    expect(firstRun.duplicates).toEqual([]);
    expect(firstRun.candidates[0].candidateId)
      .toBe(secondRun.candidates[0].candidateId);
    expect(firstRun.candidates[0]).toMatchObject({
      sourceId: 'openai-news-rss',
      originalTitle: 'Introducing a verified API capability',
      canonicalUrl: 'https://openai.com/index/verified-api-capability',
      publishedAt: '2026-08-20T07:00:00.000Z',
      fetchedAt: '2026-08-24T07:30:00.000Z',
      disposition: 'candidate',
      ruleVersion: INTAKE_RULE_VERSION,
      provenance: {
        protocol: 'rss2',
        feedUrl: 'https://openai.com/news/rss.xml',
        contentType: 'text/xml',
      },
      item: {
        editorialStatus: 'candidate',
        publicationMode: 'manual',
        seedContent: false,
        originalTitle: 'Introducing a verified API capability',
        review: { status: 'pending_owner_review' },
      },
    });
    expect(firstRun.candidates[0].sourceSummary.length).toBeLessThanOrEqual(280);
    expect(firstRun.candidates[0].evidenceExcerpt.length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(firstRun.candidates[0])).not.toContain('DO_NOT_STORE_FULL_TEXT');
  });

  it('routes missing source, date, HTTPS, conflicts and high-risk facts to manual review', () => {
    expect(openAiSource).toBeDefined();
    expect(googleCloudSource).toBeDefined();
    if (!openAiSource || !googleCloudSource) return;
    const validEntry = parseRss2Feed(openAiFixture, { maxItems: 20 }).entries[0];
    const googleEntry = parseRss2Feed(googleCloudFixture, { maxItems: 20 }).entries[0];
    const entries: readonly RssFeedEntry[] = [
      { ...validEntry, title: 'Missing date', guid: 'missing-date', link: 'https://openai.com/index/missing-date', publishedAt: '' },
      { ...validEntry, title: 'Unsafe URL', guid: 'unsafe-url', link: 'http://openai.com/index/unsafe-url' },
      { ...validEntry, title: 'Source conflict', guid: 'source-conflict', link: 'https://openai.com/index/source-conflict' },
    ];
    const invalid = buildEditorialIntake({
      source: openAiSource,
      entries,
      fetchedAt: '2026-08-24T07:30:00.000Z',
      feedUrl: 'https://openai.com/news/rss.xml',
      contentType: 'text/xml',
      conflictingUrls: new Set(['https://openai.com/index/source-conflict']),
    });
    const missingSource = buildEditorialIntake({
      source: undefined,
      sourceIdHint: 'missing-source',
      entries: [validEntry],
      fetchedAt: '2026-08-24T07:30:00.000Z',
      feedUrl: 'https://missing.example/feed.xml',
      contentType: 'application/rss+xml',
    });
    const highRisk = buildEditorialIntake({
      source: googleCloudSource,
      entries: [googleEntry],
      fetchedAt: '2026-08-24T07:30:00.000Z',
      feedUrl: 'https://cloudblog.withgoogle.com/products/ai-machine-learning/rss/',
      contentType: 'application/xml',
    });

    expect(invalid.candidates).toEqual([]);
    expect(invalid.manualReview.map((record) => record.reasons)).toEqual([
      ['publishedAt is missing or invalid'],
      ['canonical URL must use HTTPS'],
      ['source conflict requires manual review'],
    ]);
    expect(missingSource.manualReview[0].reasons)
      .toContain('source is missing or not registered');
    expect(highRisk.manualReview[0].riskSignals).toContain('security_privacy');
    expect(highRisk.manualReview[0].reasons).toContain('high risk requires manual review');
  });

  it('routes an HTTPS item on an off-allowlist host to manual review', () => {
    expect(openAiSource).toBeDefined();
    if (!openAiSource) return;
    const validEntry = parseRss2Feed(openAiFixture, { maxItems: 20 }).entries[0];
    const intake = buildEditorialIntake({
      source: openAiSource,
      entries: [{
        ...validEntry,
        guid: 'https-off-allowlist',
        link: 'https://unapproved.example/product-update',
      }],
      fetchedAt: '2026-08-24T07:30:00.000Z',
      feedUrl: 'https://openai.com/news/rss.xml',
      contentType: 'text/xml',
    });

    expect(intake.candidates).toEqual([]);
    expect(intake.manualReview[0].canonicalUrl).toBeNull();
    expect(intake.manualReview[0].reasons)
      .toContain('canonical URL host is not allowlisted');
  });

  it('exposes history for URL, event and fingerprint dedupe across separate batches', () => {
    expect(openAiSource).toBeDefined();
    if (!openAiSource) return;
    const entry = parseRss2Feed(openAiFixture, { maxItems: 20 }).entries[0];
    const first = buildEditorialIntake({
      source: openAiSource,
      entries: [entry],
      fetchedAt: '2026-08-24T07:30:00.000Z',
      feedUrl: 'https://openai.com/news/rss.xml',
      contentType: 'text/xml',
    });

    const urlDuplicate = buildEditorialIntake({
      source: openAiSource,
      entries: [{ ...entry, guid: 'url-duplicate' }],
      fetchedAt: '2026-08-24T08:30:00.000Z',
      feedUrl: 'https://openai.com/news/rss.xml',
      contentType: 'text/xml',
      history: { normalizedUrls: first.nextHistory.normalizedUrls },
    });
    const eventDuplicate = buildEditorialIntake({
      source: openAiSource,
      entries: [{
        ...entry,
        guid: 'event-duplicate',
        link: 'https://openai.com/index/event-duplicate',
        descriptionText: 'Different short source description.',
      }],
      fetchedAt: '2026-08-24T08:30:00.000Z',
      feedUrl: 'https://openai.com/news/rss.xml',
      contentType: 'text/xml',
      history: { eventKeys: first.nextHistory.eventKeys },
    });
    const fingerprintDuplicate = buildEditorialIntake({
      source: openAiSource,
      entries: [{
        ...entry,
        title: 'Different title for the fingerprint history check',
        guid: 'fingerprint-duplicate',
        link: 'https://openai.com/index/fingerprint-duplicate',
      }],
      fetchedAt: '2026-08-24T08:30:00.000Z',
      feedUrl: 'https://openai.com/news/rss.xml',
      contentType: 'text/xml',
      history: {
        sourceFingerprints: new Set([buildEditorialIntake({
          source: openAiSource,
          entries: [{
            ...entry,
            title: 'Different title for the fingerprint history check',
            guid: 'fingerprint-source',
            link: 'https://openai.com/index/fingerprint-source',
          }],
          fetchedAt: '2026-08-24T07:30:00.000Z',
          feedUrl: 'https://openai.com/news/rss.xml',
          contentType: 'text/xml',
        }).records[0].contentFingerprint]),
      },
    });

    expect(urlDuplicate.duplicates[0]?.duplicateReason).toBe('normalized_url');
    expect(eventDuplicate.duplicates[0]?.duplicateReason).toBe('event_key');
    expect(fingerprintDuplicate.duplicates[0]?.duplicateReason).toBe('source_fingerprint');
  });

  it('uses a source-independent deterministic event key within one publication day', () => {
    expect(openAiSource).toBeDefined();
    expect(googleCloudSource).toBeDefined();
    if (!openAiSource || !googleCloudSource) return;
    const baseEntry = parseRss2Feed(openAiFixture, { maxItems: 20 }).entries[0];
    const sharedTitle = 'A shared official product event';
    const first = buildEditorialIntake({
      source: openAiSource,
      entries: [{ ...baseEntry, title: sharedTitle }],
      fetchedAt: '2026-08-24T07:30:00.000Z',
      feedUrl: 'https://openai.com/news/rss.xml',
      contentType: 'text/xml',
    });
    const second = buildEditorialIntake({
      source: googleCloudSource,
      entries: [{
        ...baseEntry,
        title: `  ${sharedTitle.toLocaleUpperCase()}  `,
        guid: 'google-shared-event',
        link: 'https://cloud.google.com/blog/products/ai-machine-learning/shared-event',
      }],
      fetchedAt: '2026-08-24T07:31:00.000Z',
      feedUrl: 'https://cloudblog.withgoogle.com/products/ai-machine-learning/rss/',
      contentType: 'application/xml',
      history: first.nextHistory,
    });

    expect(first.records[0].eventKey).toBe(second.records[0].eventKey);
    expect(second.duplicates[0]?.duplicateReason).toBe('event_key');
  });
});
