import { describe, expect, it } from 'vitest';

import type { KnowledgeItem } from '../domain';
import { sourceRegistry } from './sources';
import {
  DEFAULT_PIPELINE_CONTROLS,
  createSourceFingerprint,
  createPublicationRecord,
  normalizeCanonicalUrl,
  processEditorialCandidates,
  rollbackRelease,
  selectDeterministicAuditSample,
  withdrawPublication,
  type EditorialPipelineCandidate,
} from './pipeline';

const baseItem: KnowledgeItem = {
  id: 'PIPE-001',
  slug: 'official-product-update',
  title: { zh: '官方产品更新' },
  summary: { zh: '官方发布了一项普通功能更新。' },
  kind: 'update',
  domains: ['ai_technology', 'enterprise_sales'],
  topicSlugs: ['ai-product-commercialization'],
  audience: ['transitioning_seller'],
  publishedAt: '2026-08-23T08:00:00.000Z',
  updatedAt: '2026-08-23T08:00:00.000Z',
  freshness: 'current',
  whyItMatters: { zh: '帮助销售判断客户对话的新能力边界。' },
  salesImplication: { zh: '可以用于更新客户发现问题。' },
  roleOrgImplication: { zh: '需要理解新能力对岗位分工的影响。' },
  nextAction: { zh: '将新能力写入一个客户场景的发现清单。' },
  evidence: [{
    id: 'EV-PIPE-001',
    sourceId: 'openai-news-rss',
    title: 'Official product update',
    publisher: 'OpenAI',
    url: 'https://openai.com/index/official-product-update/',
    publishedAt: '2026-08-23T08:00:00.000Z',
    level: 'official',
    language: 'en',
    allowlisted: true,
  }],
  relatedItemIds: [],
  editorialStatus: 'candidate',
  riskLevel: 'high',
  publicationMode: 'manual',
  seedContent: false,
  audit: {
    sourceFingerprint: 'intake-placeholder',
    ruleVersion: 'intake',
    processedAt: '2026-08-23T09:00:00.000Z',
    releaseVersion: 'unreleased',
    rollbackState: 'available',
  },
};

function candidate(
  overrides: Partial<EditorialPipelineCandidate> = {},
): EditorialPipelineCandidate {
  return {
    item: baseItem,
    sourceId: 'openai-news-rss',
    canonicalUrl: baseItem.evidence[0].url,
    fetchedAt: '2026-08-23T09:00:00.000Z',
    eventKey: 'openai-product-update-2026-08-23',
    riskSignals: ['ordinary_product_fact'],
    sourceConflict: false,
    ...overrides,
  };
}

describe('SAAS-603 deterministic editorial pipeline', () => {
  it('keeps automatic publishing disabled by default while preserving low-risk eligibility', () => {
    expect(DEFAULT_PIPELINE_CONTROLS.autoPublishingEnabled).toBe(false);
    expect(DEFAULT_PIPELINE_CONTROLS.stopSwitchEngaged).toBe(true);

    const result = processEditorialCandidates(
      [candidate()],
      sourceRegistry,
      DEFAULT_PIPELINE_CONTROLS,
    );

    expect(result.autoReady).toEqual([]);
    expect(result.manualReview).toHaveLength(1);
    expect(result.manualReview[0]).toMatchObject({
      riskLevel: 'low',
      automaticEligibility: true,
      disposition: 'manual_review',
    });
    expect(result.manualReview[0].reasons).toContain('automatic publishing is disabled');
  });

  it('only marks complete, official, non-seed, allowlisted low-risk facts auto-ready after both controls open', () => {
    const result = processEditorialCandidates(
      [candidate()],
      sourceRegistry,
      {
        ...DEFAULT_PIPELINE_CONTROLS,
        autoPublishingEnabled: true,
        stopSwitchEngaged: false,
      },
    );

    expect(result.autoReady).toHaveLength(1);
    expect(result.autoReady[0]).toMatchObject({
      riskLevel: 'low',
      automaticEligibility: true,
      disposition: 'auto_ready',
    });
    expect(result.autoReady[0].audit.ruleVersion).toBe(DEFAULT_PIPELINE_CONTROLS.ruleVersion);
  });

  it('derives medium and high risk deterministically and ignores an intake item\'s proposed risk', () => {
    const result = processEditorialCandidates([
      candidate({
        item: {
          ...baseItem,
          id: 'PIPE-CASE',
          slug: 'customer-case',
          title: { zh: '客户案例与效果数字' },
          summary: { zh: '厂商公布了一项客户效果主张。' },
          riskLevel: 'low',
        },
        eventKey: 'customer-case',
        riskSignals: ['customer_case', 'quantified_outcome'],
      }),
      candidate({
        item: {
          ...baseItem,
          id: 'PIPE-LAW',
          slug: 'law-update',
          title: { zh: '法规时间线更新' },
          summary: { zh: '欧盟官方更新了 AI Act 相关页面。' },
          riskLevel: 'low',
          evidence: [{
            ...baseItem.evidence[0],
            id: 'EV-PIPE-LAW',
            sourceId: 'eu-ai-act',
            publisher: 'European Commission',
            url: 'https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai',
          }],
        },
        sourceId: 'eu-ai-act',
        canonicalUrl: 'https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai',
        eventKey: 'law-update',
        riskSignals: ['legal_regulatory'],
      }),
    ], sourceRegistry, {
      ...DEFAULT_PIPELINE_CONTROLS,
      autoPublishingEnabled: true,
      stopSwitchEngaged: false,
    });

    expect(result.manualReview.map((entry) => [entry.itemId, entry.riskLevel]))
      .toEqual([['PIPE-CASE', 'medium'], ['PIPE-LAW', 'high']]);
    expect(result.autoReady).toEqual([]);
  });

  it('forces seeds, source conflicts, commentary and incomplete evidence into review or rejection', () => {
    const result = processEditorialCandidates([
      candidate({
        item: {
          ...baseItem,
          id: 'PIPE-SEED',
          slug: 'seed',
          title: { zh: '首批种子内容' },
          summary: { zh: '首批内容必须由项目所有者审核。' },
          seedContent: true,
        },
        canonicalUrl: 'https://openai.com/index/seed-content/',
        eventKey: 'seed',
      }),
      candidate({
        item: {
          ...baseItem,
          id: 'PIPE-CONFLICT',
          slug: 'conflict',
          title: { zh: '多信源冲突' },
          summary: { zh: '两个信源对同一事实的描述不一致。' },
        },
        canonicalUrl: 'https://openai.com/index/source-conflict/',
        eventKey: 'conflict',
        sourceConflict: true,
      }),
      candidate({
        item: {
          ...baseItem,
          id: 'PIPE-OPINION',
          slug: 'opinion',
          title: { zh: '编辑观点' },
          summary: { zh: '这是基于证据的编辑推断。' },
          evidence: [{ ...baseItem.evidence[0], level: 'editorial_inference' }],
        },
        canonicalUrl: 'https://openai.com/index/editorial-opinion/',
        eventKey: 'opinion',
        riskSignals: ['editorial_inference'],
      }),
      candidate({
        item: {
          ...baseItem,
          id: 'PIPE-BROKEN',
          slug: 'broken',
          title: { zh: '字段不完整的候选' },
          summary: { zh: '这条候选缺少行动字段。' },
          nextAction: { zh: '' },
        },
        canonicalUrl: 'https://openai.com/index/incomplete-candidate/',
        eventKey: 'broken',
      }),
    ], sourceRegistry, {
      ...DEFAULT_PIPELINE_CONTROLS,
      autoPublishingEnabled: true,
      stopSwitchEngaged: false,
    });

    expect(result.autoReady).toEqual([]);
    expect(result.manualReview.map((entry) => entry.itemId))
      .toEqual(['PIPE-SEED', 'PIPE-CONFLICT', 'PIPE-OPINION']);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].itemId).toBe('PIPE-BROKEN');
    expect(result.rejected[0].fieldErrors).toContain('nextAction.zh is required');
  });

  it('deduplicates normalized URLs, content fingerprints and event keys before routing', () => {
    const result = processEditorialCandidates([
      candidate(),
      candidate({
        item: { ...baseItem, id: 'PIPE-DUP-URL', slug: 'duplicate-url' },
        canonicalUrl: `${baseItem.evidence[0].url}?utm_source=test#section`,
        eventKey: 'different-event-key',
      }),
      candidate({
        canonicalUrl: 'https://openai.com/index/another-url/',
        item: {
          ...baseItem,
          id: 'PIPE-DUP-EVENT',
          slug: 'duplicate-event',
          title: { zh: '同一事件的另一条报道' },
          summary: { zh: '用不同文字描述同一个事件。' },
        },
      }),
      candidate({
        item: { ...baseItem, id: 'PIPE-DUP-FINGERPRINT', slug: 'duplicate-fingerprint' },
        canonicalUrl: 'https://openai.com/index/third-url/',
        eventKey: 'different-fingerprint-event',
      }),
    ], sourceRegistry, DEFAULT_PIPELINE_CONTROLS);

    expect(result.manualReview).toHaveLength(1);
    expect(result.duplicates.map((entry) => entry.itemId))
      .toEqual(['PIPE-DUP-URL', 'PIPE-DUP-EVENT', 'PIPE-DUP-FINGERPRINT']);
    expect(result.duplicates.map((entry) => entry.duplicateReason))
      .toEqual(['normalized_url', 'event_key', 'source_fingerprint']);
    expect(result.audit.filter((event) => event.action === 'duplicate_detected')).toHaveLength(3);
  });

  it('consults persisted URL, event and fingerprint history across separate runs', () => {
    const urlDuplicate = processEditorialCandidates(
      [candidate()],
      sourceRegistry,
      DEFAULT_PIPELINE_CONTROLS,
      {
        normalizedUrls: new Set([normalizeCanonicalUrl(baseItem.evidence[0].url)]),
        eventKeys: new Set(),
        sourceFingerprints: new Set(),
      },
    );
    const eventDuplicate = processEditorialCandidates(
      [candidate()],
      sourceRegistry,
      DEFAULT_PIPELINE_CONTROLS,
      {
        normalizedUrls: new Set(),
        eventKeys: new Set(['openai-product-update-2026-08-23']),
        sourceFingerprints: new Set(),
      },
    );
    const fingerprintDuplicate = processEditorialCandidates(
      [candidate()],
      sourceRegistry,
      DEFAULT_PIPELINE_CONTROLS,
      {
        normalizedUrls: new Set(),
        eventKeys: new Set(),
        sourceFingerprints: new Set([createSourceFingerprint(candidate())]),
      },
    );

    expect([
      urlDuplicate.duplicates[0]?.duplicateReason,
      eventDuplicate.duplicates[0]?.duplicateReason,
      fingerprintDuplicate.duplicates[0]?.duplicateReason,
    ]).toEqual(['normalized_url', 'event_key', 'source_fingerprint']);
  });

  it('rejects unsafe evidence URLs before any publication eligibility decision', () => {
    const unsafe = candidate({
      item: {
        ...baseItem,
        id: 'PIPE-UNSAFE-EVIDENCE',
        slug: 'unsafe-evidence',
        title: { zh: '不安全证据链接' },
        summary: { zh: '这条候选使用了不可接受的证据协议。' },
        evidence: [{ ...baseItem.evidence[0], url: 'javascript:alert(1)' }],
      },
      canonicalUrl: 'https://openai.com/index/unsafe-evidence/',
      eventKey: 'unsafe-evidence',
    });

    const result = processEditorialCandidates(
      [unsafe],
      sourceRegistry,
      DEFAULT_PIPELINE_CONTROLS,
    );

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].fieldErrors).toContain('evidence[0].url must use HTTPS');
  });

  it('uses deterministic review sampling and records withdrawal and rollback without deleting history', () => {
    const processed = processEditorialCandidates(
      [candidate()],
      sourceRegistry,
      DEFAULT_PIPELINE_CONTROLS,
    );
    expect(selectDeterministicAuditSample(processed.decisions, 1)).toHaveLength(1);
    expect(selectDeterministicAuditSample(processed.decisions, 0)).toEqual([]);

    const record = createPublicationRecord('PIPE-001', 'release-2026-08-23', '2026-08-23T10:00:00.000Z');
    const withdrawn = withdrawPublication(
      record,
      'source correction requested',
      'editor:owner',
      '2026-08-23T11:00:00.000Z',
    );
    const rolledBack = rollbackRelease(
      withdrawn,
      'release-2026-08-22',
      'editor:owner',
      '2026-08-23T12:00:00.000Z',
    );

    expect(rolledBack.status).toBe('rolled_back');
    expect(rolledBack.activeReleaseVersion).toBe('release-2026-08-22');
    expect(rolledBack.audit.map((event) => event.action))
      .toEqual(['published', 'withdrawn', 'rolled_back']);
    expect(rolledBack.audit[1].reason).toBe('source correction requested');
  });
});
