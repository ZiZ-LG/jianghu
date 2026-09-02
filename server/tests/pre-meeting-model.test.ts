import { describe, expect, it } from 'vitest';
import type { ResearchBriefSource, ResearchBriefSubject } from '@jianghu/domain-contracts';
import {
  parsePreMeetingModelResponse,
  PreMeetingModelError,
  type PreMeetingPreparedSource,
} from '../src/preMeeting/model.js';

const generatedAt = new Date('2026-08-27T08:00:00.000Z');
const subject: ResearchBriefSubject = {
  status: 'matched',
  query: '海岳能源',
  crmCustomerId: 'customer-205',
  selected: {
    legalName: '海岳能源',
    anchorKind: 'unified_credit_code',
    anchorValue: '91110108SAAS205',
    provider: 'jianghu-crm',
  },
  candidates: [],
};

function source(
  id: string,
  kind: ResearchBriefSource['kind'],
  label: string,
): PreMeetingPreparedSource {
  return {
    metadata: {
      id,
      kind,
      refId: `${id}-ref`,
      version: 1,
      fingerprint: 'a'.repeat(64),
      provider: 'jianghu-crm',
      label,
      url: null,
      subjectAnchor: 'crm_customer:customer-205',
      observedAt: '2026-08-27T06:00:00.000Z',
      retrievedAt: '2026-08-27T07:00:00.000Z',
      freshUntil: '2026-08-28T07:00:00.000Z',
      status: 'fresh',
      failureCode: null,
    },
    content: `${label}正文`,
  };
}

const sources = [
  source('crm-customer', 'crm_fact', '客户基本信息'),
  source('source-artifact', 'source_artifact', '客户访谈'),
  source('curated-ai', 'curated_ai_cache', '兼容资料输入 · 旧 AI 缓存（非权威）'),
];

function parse(raw: unknown) {
  return parsePreMeetingModelResponse(
    typeof raw === 'string' ? raw : JSON.stringify(raw),
    { generatedAt, modelRef: 'tenant-model', subject, sources },
  );
}

describe('SAAS-205 strict pre-meeting model response', () => {
  it('builds a server-owned canonical payload and deterministic unknowns', () => {
    const payload = parse({
      sections: [
        {
          key: 'company_overview',
          content: '客户主营新能源项目，当前事项处于需求澄清阶段。',
          sourceIds: ['crm-customer', 'source-artifact'],
        },
        {
          key: 'questions_to_verify',
          content: '确认预算审批人与下一次技术交流时间。',
          sourceIds: ['source-artifact'],
        },
      ],
      unknowns: [{
        key: 'stakeholders',
        reasonCode: 'insufficient_evidence',
        sourceIds: ['source-artifact'],
      }],
    });

    expect(payload.subject).toEqual(subject);
    expect(payload.sources).toHaveLength(sources.length);
    expect(payload.sources).toEqual(expect.arrayContaining(sources.map((item) => item.metadata)));
    expect(JSON.stringify(payload)).not.toContain('旧 AI 缓存（非权威）正文');
    expect(payload.generator).toEqual({
      version: 'saas-204.v1',
      modelRef: 'tenant-model',
      connectorRefs: [],
    });
    expect(payload.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'company_overview',
        title: '公司概览',
        asOf: generatedAt.toISOString(),
      }),
      expect.objectContaining({
        key: 'questions_to_verify',
        title: '拜访核验问题',
        asOf: generatedAt.toISOString(),
      }),
    ]));
    expect(payload.unknowns).toHaveLength(6);
    expect(payload.unknowns).toContainEqual({
      key: 'stakeholders',
      question: '还需要确认哪些关键干系人及其角色？',
      reasonCode: 'insufficient_evidence',
      sourceIds: ['source-artifact'],
    });
    expect(payload.unknowns).toContainEqual(expect.objectContaining({
      key: 'recent_changes',
      reasonCode: 'missing_evidence',
    }));
  });

  it.each([
    ['Markdown 包裹', '```json\n{"sections":[],"unknowns":[]}\n```'],
    ['模型注入标题', { sections: [{ key: 'company_overview', title: '伪造标题', content: '内容', sourceIds: ['crm-customer'] }], unknowns: [] }],
    ['模型注入时间', { sections: [{ key: 'company_overview', content: '内容', sourceIds: ['crm-customer'], asOf: generatedAt.toISOString() }], unknowns: [] }],
    ['模型注入主题', { subject, sections: [], unknowns: [] }],
    ['未知字段', { sections: [], unknowns: [], extra: true }],
    ['未知章节', { sections: [{ key: 'forecast', content: '内容', sourceIds: ['crm-customer'] }], unknowns: [] }],
    ['悬空引用', { sections: [{ key: 'company_overview', content: '内容', sourceIds: ['missing'] }], unknowns: [] }],
    ['重复引用', { sections: [{ key: 'company_overview', content: '内容', sourceIds: ['crm-customer', 'crm-customer'] }], unknowns: [] }],
    ['重复章节', { sections: [
      { key: 'company_overview', content: '内容一', sourceIds: ['crm-customer'] },
      { key: 'company_overview', content: '内容二', sourceIds: ['source-artifact'] },
    ], unknowns: [] }],
    ['章节与未知冲突', {
      sections: [{ key: 'company_overview', content: '内容', sourceIds: ['crm-customer'] }],
      unknowns: [{ key: 'company_overview', reasonCode: 'insufficient_evidence', sourceIds: [] }],
    }],
    ['超长正文', { sections: [{ key: 'company_overview', content: '甲'.repeat(4_001), sourceIds: ['crm-customer'] }], unknowns: [] }],
  ])('fails closed for %s', (_label, raw) => {
    expect(() => parse(raw)).toThrowError(PreMeetingModelError);
    try {
      parse(raw);
    } catch (error) {
      expect(error).toMatchObject({ code: 'pre_meeting_model_output_invalid' });
    }
  });

  it('rejects oversized UTF-8 output before JSON parsing can widen the boundary', () => {
    const raw = JSON.stringify({
      sections: [],
      unknowns: [{
        key: 'company_overview',
        reasonCode: 'insufficient_evidence',
        sourceIds: [],
        padding: '界'.repeat(20_000),
      }],
    });
    expect(() => parse(raw)).toThrowError(expect.objectContaining({
      code: 'pre_meeting_model_output_invalid',
    }));
  });
});
