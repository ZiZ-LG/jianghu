import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';

type RuntimeSchema = {
  safeParse(value: unknown): { success: boolean };
};

const schema = (name: string): RuntimeSchema | undefined => (
  Reflect.get(contracts, name) as RuntimeSchema | undefined
);

const generatedAt = '2026-08-27T01:00:00.000Z';
const createdAt = '2026-08-27T01:00:01.000Z';
const selectedAnchor = {
  legalName: '江湖科技有限公司',
  anchorKind: 'unified_credit_code',
  anchorValue: '91110108MA00JIANGHU',
  provider: 'qcc',
};
const externalSubjectAnchor = 'unified_credit_code:91110108MA00JIANGHU';

const readyPayload = {
  subject: {
    status: 'matched',
    query: '江湖科技',
    crmCustomerId: 'customer-204',
    selected: selectedAnchor,
    candidates: [],
  },
  sources: [
    {
      id: 'source-crm',
      kind: 'crm_fact',
      refId: 'customer-204@7',
      version: 7,
      fingerprint: 'a'.repeat(64),
      provider: 'jianghu-crm',
      label: '客户基本信息',
      url: null,
      subjectAnchor: 'crm_customer:customer-204',
      observedAt: '2026-08-26T08:00:00.000Z',
      retrievedAt: '2026-08-27T00:00:00.000Z',
      freshUntil: '2026-08-28T00:00:00.000Z',
      status: 'fresh',
      failureCode: null,
    },
    {
      id: 'source-qcc',
      kind: 'qcc',
      refId: 'qcc-company-204',
      version: 1,
      fingerprint: 'b'.repeat(64),
      provider: 'qcc',
      label: '企业主体信息',
      url: 'https://example.test/company/qcc-company-204',
      subjectAnchor: externalSubjectAnchor,
      observedAt: '2026-08-26T09:00:00.000Z',
      retrievedAt: '2026-08-27T00:05:00.000Z',
      freshUntil: '2026-08-28T00:05:00.000Z',
      status: 'fresh',
      failureCode: null,
    },
  ],
  sections: [
    {
      key: 'company_overview',
      title: '公司概览',
      content: '当前 CRM 客户与外部主体精确匹配。',
      sourceIds: ['source-crm', 'source-qcc'],
      asOf: '2026-08-27T00:05:00.000Z',
    },
  ],
  unknowns: [],
  failures: [],
  generator: {
    version: 'saas-204.v1',
    modelRef: 'tenant-byo-ai',
    connectorRefs: ['qcc'],
  },
};

const partialPayload = {
  ...readyPayload,
  sources: [
    readyPayload.sources[0]!,
    {
      ...readyPayload.sources[1]!,
      status: 'failed',
      freshUntil: null,
      failureCode: 'provider_timeout',
    },
  ],
  sections: [{ ...readyPayload.sections[0], sourceIds: ['source-crm'] }],
  unknowns: [{
    key: 'recent_changes',
    question: '近期股权变更是否已完成？',
    reasonCode: 'source_failed',
    sourceIds: ['source-qcc'],
  }],
  failures: [{ sourceId: 'source-qcc', code: 'provider_timeout', retryable: true }],
};

const blockedPayload = {
  subject: {
    status: 'ambiguous',
    query: '江湖科技',
    crmCustomerId: 'customer-204',
    selected: null,
    candidates: [
      selectedAnchor,
      {
        legalName: '江湖科技集团有限公司',
        anchorKind: 'provider_subject_id',
        anchorValue: 'qcc-subject-205',
        provider: 'qcc',
      },
    ],
  },
  sources: [{
    id: 'source-qcc-search',
    kind: 'qcc',
    refId: 'qcc-search-204',
    version: 1,
    fingerprint: 'c'.repeat(64),
    provider: 'qcc',
    label: '主体搜索候选',
    url: null,
    subjectAnchor: 'query:江湖科技',
    observedAt: null,
    retrievedAt: '2026-08-27T00:10:00.000Z',
    freshUntil: null,
    status: 'unavailable',
    failureCode: 'subject_ambiguous',
  }],
  sections: [],
  unknowns: [{
    key: 'subject_match',
    question: '请确认应使用哪个企业主体。',
    reasonCode: 'subject_ambiguous',
    sourceIds: ['source-qcc-search'],
  }],
  failures: [],
  generator: {
    version: 'saas-204.v1',
    modelRef: 'tenant-byo-ai',
    connectorRefs: ['qcc'],
  },
};

const readyMetadata = {
  id: 'research-brief-204',
  customerId: 'customer-204',
  matterId: 'matter-204',
  status: 'ready',
  subjectStatus: 'matched',
  sourceCount: 2,
  sectionCount: 1,
  unknownCount: 0,
  failureCount: 0,
  version: 1,
  basedOnAt: '2026-08-26T08:00:00.000Z',
  freshUntil: '2026-08-28T00:00:00.000Z',
  generatedAt,
  createdAt,
};

describe('SAAS-204 ResearchBriefSnapshot contracts', () => {
  it('accepts matched ready, matched partial, and ambiguous blocked payloads', () => {
    const payloadSchema = schema('ResearchBriefPreparedPayloadSchema');
    const metadataSchema = schema('ResearchBriefSnapshotMetadataSchema');
    expect(payloadSchema, 'ResearchBriefPreparedPayloadSchema must be exported').toBeDefined();
    expect(metadataSchema, 'ResearchBriefSnapshotMetadataSchema must be exported').toBeDefined();

    expect(payloadSchema!.safeParse(readyPayload).success).toBe(true);
    expect(payloadSchema!.safeParse(partialPayload).success).toBe(true);
    expect(payloadSchema!.safeParse(blockedPayload).success).toBe(true);
    expect(metadataSchema!.safeParse(readyMetadata).success).toBe(true);
    expect(metadataSchema!.safeParse({
      ...readyMetadata,
      status: 'partial',
      unknownCount: 1,
      failureCount: 1,
    }).success).toBe(true);
    expect(metadataSchema!.safeParse({
      ...readyMetadata,
      status: 'blocked',
      subjectStatus: 'ambiguous',
      sourceCount: 1,
      sectionCount: 0,
      unknownCount: 1,
    }).success).toBe(true);
  });

  it('rejects subject, source, and citation authority violations', () => {
    const payloadSchema = schema('ResearchBriefPreparedPayloadSchema');
    expect(payloadSchema).toBeDefined();

    expect(payloadSchema!.safeParse({
      ...blockedPayload,
      sections: readyPayload.sections,
    }).success).toBe(false);
    expect(payloadSchema!.safeParse({
      ...readyPayload,
      subject: { ...readyPayload.subject, selected: null },
    }).success).toBe(false);
    expect(payloadSchema!.safeParse({
      ...readyPayload,
      sources: [readyPayload.sources[0], { ...readyPayload.sources[1], subjectAnchor: 'provider_subject_id:wrong' }],
    }).success).toBe(false);
    expect(payloadSchema!.safeParse({
      ...readyPayload,
      sections: [{ ...readyPayload.sections[0], sourceIds: [] }],
    }).success).toBe(false);
    expect(payloadSchema!.safeParse({
      ...readyPayload,
      sources: [readyPayload.sources[0], { ...readyPayload.sources[0] }],
    }).success).toBe(false);
    expect(payloadSchema!.safeParse({
      ...readyPayload,
      sections: [{ ...readyPayload.sections[0], sourceIds: ['source-missing'] }],
    }).success).toBe(false);
    expect(payloadSchema!.safeParse({
      ...partialPayload,
      failures: [{ sourceId: 'source-missing', code: 'provider_timeout', retryable: true }],
    }).success).toBe(false);
    expect(payloadSchema!.safeParse({
      ...partialPayload,
      sources: partialPayload.sources.map((source) => (
        source.id === 'source-qcc' ? { ...source, failureCode: null } : source
      )),
    }).success).toBe(false);
    expect(payloadSchema!.safeParse({
      ...readyPayload,
      sources: [readyPayload.sources[0], { ...readyPayload.sources[1], url: 'http://example.test/company' }],
    }).success).toBe(false);
    expect(payloadSchema!.safeParse({
      ...readyPayload,
      sources: [{
        ...readyPayload.sources[0],
        observedAt: '2026-08-27T00:01:00.000Z',
        retrievedAt: '2026-08-27T00:00:00.000Z',
      }, readyPayload.sources[1]],
    }).success).toBe(false);
    expect(payloadSchema!.safeParse({
      ...readyPayload,
      sources: [{
        ...readyPayload.sources[0],
        retrievedAt: '2026-08-28T00:01:00.000Z',
        freshUntil: '2026-08-28T00:00:00.000Z',
      }, readyPayload.sources[1]],
    }).success).toBe(false);
  });

  it('rejects count, field, and total UTF-8 size overflow', () => {
    const payloadSchema = schema('ResearchBriefPreparedPayloadSchema');
    expect(payloadSchema).toBeDefined();

    expect(payloadSchema!.safeParse({
      ...blockedPayload,
      subject: {
        ...blockedPayload.subject,
        candidates: Array.from({ length: 6 }, (_, index) => ({
          ...selectedAnchor,
          anchorValue: `candidate-${index}`,
        })),
      },
    }).success).toBe(false);
    expect(payloadSchema!.safeParse({
      ...readyPayload,
      sections: Array.from({ length: 9 }, (_, index) => ({
        ...readyPayload.sections[0],
        key: index === 0 ? 'company_overview' : 'recent_changes',
        title: `Section ${index}`,
      })),
    }).success).toBe(false);
    expect(payloadSchema!.safeParse({
      ...readyPayload,
      sections: [{ ...readyPayload.sections[0], content: 'x'.repeat(4_001) }],
    }).success).toBe(false);

    const largeSources = Array.from({ length: 20 }, (_, index) => ({
      ...readyPayload.sources[0],
      id: `source-${index}`,
      refId: `ref-${index}-${'r'.repeat(180)}`,
      provider: `provider-${index}-${'p'.repeat(178)}`,
      label: `Source ${index} ${'l'.repeat(286)}`,
      subjectAnchor: `anchor-${index}-${'a'.repeat(180)}`,
      fingerprint: index.toString(16).padStart(64, '0'),
    }));
    const oversizedPayload = {
      ...readyPayload,
      sources: largeSources,
      sections: Array.from({ length: 8 }, (_, index) => ({
        ...readyPayload.sections[0],
        key: [
          'company_overview',
          'recent_changes',
          'existing_cooperation',
          'active_matters',
          'stakeholders',
          'open_hypotheses',
          'last_commitments',
          'questions_to_verify',
        ][index],
        title: `Section ${index}`,
        content: 'c'.repeat(4_000),
        sourceIds: [`source-${index}`],
      })),
      unknowns: Array.from({ length: 20 }, (_, index) => ({
        key: `unknown-${index}`,
        question: `Question ${index} ${'q'.repeat(285)}`,
        reasonCode: 'needs_confirmation',
        sourceIds: [`source-${index}`],
      })),
      failures: Array.from({ length: 20 }, (_, index) => ({
        sourceId: `source-${index}`,
        code: 'provider_timeout',
        retryable: true,
      })),
      generator: {
        ...readyPayload.generator,
        modelRef: `model-${'m'.repeat(194)}`,
        connectorRefs: Array.from({ length: 10 }, (_, index) => `connector-${index}-${'x'.repeat(185)}`),
      },
    };
    expect(payloadSchema!.safeParse(oversizedPayload).success).toBe(false);
  });

  it('rejects secret, ciphertext, prompt, raw response, and every unknown field', () => {
    const payloadSchema = schema('ResearchBriefPreparedPayloadSchema');
    expect(payloadSchema).toBeDefined();

    const forbidden = [
      { ...readyPayload, rawResponse: 'private model output' },
      { ...readyPayload, subject: { ...readyPayload.subject, token: 'credential' } },
      {
        ...readyPayload,
        subject: { ...readyPayload.subject, selected: { ...selectedAnchor, secret: 'credential' } },
      },
      {
        ...readyPayload,
        sources: [{ ...readyPayload.sources[0], contentEnc: 'ciphertext' }, readyPayload.sources[1]],
      },
      {
        ...readyPayload,
        sections: [{ ...readyPayload.sections[0], prompt: 'hidden prompt' }],
      },
      {
        ...partialPayload,
        unknowns: [{ ...partialPayload.unknowns[0], rawResponse: 'private' }],
      },
      {
        ...partialPayload,
        failures: [{ ...partialPayload.failures[0], secret: 'credential' }],
      },
      {
        ...readyPayload,
        generator: { ...readyPayload.generator, token: 'credential' },
      },
    ];
    for (const candidate of forbidden) {
      expect(payloadSchema!.safeParse(candidate).success).toBe(false);
    }
  });

  it('publishes strict metadata, list, and authorized detail response contracts', () => {
    const metadataSchema = schema('ResearchBriefSnapshotMetadataSchema');
    const detailSchema = schema('ResearchBriefSnapshotDetailSchema');
    const listSchema = schema('ResearchBriefSnapshotListResponseSchema');
    const detailResponseSchema = schema('ResearchBriefSnapshotDetailResponseSchema');
    expect(metadataSchema).toBeDefined();
    expect(detailSchema).toBeDefined();
    expect(listSchema).toBeDefined();
    expect(detailResponseSchema).toBeDefined();

    const detail = { ...readyMetadata, payload: readyPayload };
    expect(metadataSchema!.safeParse(readyMetadata).success).toBe(true);
    expect(detailSchema!.safeParse(detail).success).toBe(true);
    expect(listSchema!.safeParse({ items: [readyMetadata], nextCursor: 'cursor-204' }).success).toBe(true);
    expect(detailResponseSchema!.safeParse({ item: detail }).success).toBe(true);

    expect(metadataSchema!.safeParse({
      ...readyMetadata,
      status: 'ready',
      subjectStatus: 'ambiguous',
    }).success).toBe(false);
    expect(detailSchema!.safeParse({
      ...detail,
      sourceCount: 1,
    }).success).toBe(false);
    expect(detailSchema!.safeParse({
      ...detail,
      subjectStatus: 'unmatched',
    }).success).toBe(false);
    expect(listSchema!.safeParse({
      items: Array.from({ length: 51 }, () => readyMetadata),
      nextCursor: null,
    }).success).toBe(false);
    expect(detailResponseSchema!.safeParse({ item: detail, contentEnc: 'ciphertext' }).success).toBe(false);
    expect(detailResponseSchema!.safeParse({
      item: { ...detail, payloadFingerprint: 'd'.repeat(64) },
    }).success).toBe(false);
  });
});
