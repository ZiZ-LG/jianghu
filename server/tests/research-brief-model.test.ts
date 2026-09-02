import { describe, expect, it } from 'vitest';
import type { ResearchBriefPreparedPayload } from '@jianghu/domain-contracts';
import {
  canonicalResearchBriefPayload,
  deriveResearchBriefMetadata,
  hashResearchBriefPayload,
  validateResearchBriefPreparedPayload,
} from '../src/researchBriefs/model.js';

const generatedAt = new Date('2026-08-27T01:00:00.000Z');

function readyPayload(): ResearchBriefPreparedPayload {
  return {
    subject: {
      status: 'matched',
      query: '江湖科技',
      crmCustomerId: 'customer-204',
      selected: {
        legalName: '江湖科技有限公司',
        anchorKind: 'unified_credit_code',
        anchorValue: '91110108MA00JIANGHU',
        provider: 'qcc',
      },
      candidates: [],
    },
    sources: [
      {
        id: 'source-qcc', kind: 'qcc', refId: 'qcc-company-204', version: 1,
        fingerprint: 'b'.repeat(64), provider: 'qcc', label: '企业主体信息',
        url: 'https://example.test/company/qcc-company-204',
        subjectAnchor: 'unified_credit_code:91110108MA00JIANGHU',
        observedAt: '2026-08-26T09:00:00.000Z', retrievedAt: '2026-08-27T00:05:00.000Z',
        freshUntil: '2026-08-28T00:05:00.000Z', status: 'fresh', failureCode: null,
      },
      {
        id: 'source-crm', kind: 'crm_fact', refId: 'customer-204@7', version: 7,
        fingerprint: 'a'.repeat(64), provider: 'jianghu-crm', label: '客户基本信息',
        url: null, subjectAnchor: 'crm_customer:customer-204',
        observedAt: '2026-08-26T08:00:00.000Z', retrievedAt: '2026-08-27T00:00:00.000Z',
        freshUntil: '2026-08-28T00:00:00.000Z', status: 'fresh', failureCode: null,
      },
    ],
    sections: [{
      key: 'company_overview', title: '公司概览', content: '精确匹配的客户简报。',
      sourceIds: ['source-qcc', 'source-crm'], asOf: '2026-08-27T00:05:00.000Z',
    }],
    unknowns: [],
    failures: [],
    generator: { version: 'saas-204.v1', modelRef: 'tenant-byo-ai', connectorRefs: ['qcc', 'crm'] },
  };
}

describe('SAAS-204 research brief canonical model', () => {
  it('canonicalizes unordered sets and hashes equivalent payloads deterministically', () => {
    const first = readyPayload();
    const second = {
      ...readyPayload(),
      sources: [...readyPayload().sources].reverse(),
      sections: readyPayload().sections.map((section) => ({
        ...section, sourceIds: [...section.sourceIds].reverse(),
      })),
      generator: { ...readyPayload().generator, connectorRefs: ['crm', 'qcc'] },
    };

    expect(canonicalResearchBriefPayload(first)).toEqual(canonicalResearchBriefPayload(second));
    expect(hashResearchBriefPayload(first)).toBe(hashResearchBriefPayload(second));
    expect(hashResearchBriefPayload(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('derives status, counts, oldest basis, earliest expiry, and the source-set hash', () => {
    const payload = readyPayload();
    expect(deriveResearchBriefMetadata(payload, generatedAt)).toEqual({
      status: 'ready',
      subjectStatus: 'matched',
      sourceCount: 2,
      sectionCount: 1,
      unknownCount: 0,
      failureCount: 0,
      basedOnAt: new Date('2026-08-26T08:00:00.000Z'),
      freshUntil: new Date('2026-08-28T00:00:00.000Z'),
      sourceSetHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const partial = readyPayload();
    partial.sources[0] = { ...partial.sources[0]!, status: 'stale' };
    expect(deriveResearchBriefMetadata(partial, generatedAt).status).toBe('partial');

    const blocked = readyPayload();
    blocked.subject = {
      status: 'unmatched', query: '不存在的公司', crmCustomerId: 'customer-204',
      selected: null, candidates: [],
    };
    blocked.sources = [];
    blocked.sections = [];
    blocked.unknowns = [{
      key: 'subject_match', question: '请确认企业主体。', reasonCode: 'subject_unmatched', sourceIds: [],
    }];
    expect(deriveResearchBriefMetadata(blocked, generatedAt)).toMatchObject({
      status: 'blocked', subjectStatus: 'unmatched', sourceCount: 0, sectionCount: 0,
      basedOnAt: null, freshUntil: null,
    });
  });

  it('rejects any source or section timestamp later than generation', () => {
    const futureSource = readyPayload();
    futureSource.sources[0] = {
      ...futureSource.sources[0]!,
      observedAt: '2026-08-27T01:01:00.000Z',
      retrievedAt: '2026-08-27T01:01:00.000Z',
      freshUntil: '2026-08-28T01:01:00.000Z',
    };
    expect(() => deriveResearchBriefMetadata(futureSource, generatedAt)).toThrow('research_brief_timestamp_invalid');

    const futureSection = readyPayload();
    futureSection.sections[0] = { ...futureSection.sections[0]!, asOf: '2026-08-27T01:00:01.000Z' };
    expect(() => deriveResearchBriefMetadata(futureSection, generatedAt)).toThrow('research_brief_timestamp_invalid');
  });

  it('rejects duplicate and dangling citations, unresolved conclusions, and anchor mismatch', () => {
    const duplicate = readyPayload();
    duplicate.sources.push({ ...duplicate.sources[0]! });
    expect(() => validateResearchBriefPreparedPayload(duplicate)).toThrow('research_brief_payload_invalid');

    const dangling = readyPayload();
    dangling.sections[0] = { ...dangling.sections[0]!, sourceIds: ['missing-source'] };
    expect(() => validateResearchBriefPreparedPayload(dangling)).toThrow('research_brief_payload_invalid');

    const unresolved = readyPayload();
    unresolved.subject = {
      status: 'unmatched', query: 'unknown', crmCustomerId: 'customer-204', selected: null, candidates: [],
    };
    expect(() => validateResearchBriefPreparedPayload(unresolved)).toThrow('research_brief_payload_invalid');

    const anchorMismatch = readyPayload();
    anchorMismatch.sources[0] = { ...anchorMismatch.sources[0]!, subjectAnchor: 'provider_subject_id:wrong' };
    expect(() => validateResearchBriefPreparedPayload(anchorMismatch)).toThrow('research_brief_payload_invalid');
  });

  it('enforces the 50,000-byte canonical boundary after validation', () => {
    const oversized = readyPayload();
    oversized.sections = Array.from({ length: 8 }, (_, index) => ({
      key: [
        'company_overview', 'recent_changes', 'existing_cooperation', 'active_matters',
        'stakeholders', 'open_hypotheses', 'last_commitments', 'questions_to_verify',
      ][index] as ResearchBriefPreparedPayload['sections'][number]['key'],
      title: `段落 ${index}`,
      content: '界'.repeat(4_000),
      sourceIds: ['source-crm'],
      asOf: '2026-08-27T00:05:00.000Z',
    }));
    expect(() => validateResearchBriefPreparedPayload(oversized)).toThrow('research_brief_payload_invalid');
  });
});
