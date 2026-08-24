import { describe, expect, it } from 'vitest';

import { draftEditorialCopy } from '../../scripts/stephen-editorial-ai';

const input = {
  originalTitle: 'A verified official product update',
  sourceName: 'Official source',
  sourceUrl: 'https://example.com/official-update',
  sourceExcerpt: 'The official source describes a product capability.',
};

describe('SAAS-605 optional editorial AI boundary', () => {
  it('uses a deterministic attributed fallback when no model key exists', async () => {
    const result = await draftEditorialCopy(input, {});

    expect(result.mode).toBe('deterministic_fallback');
    expect(result.fallbackReason).toBe('ai_not_configured');
    expect(result.summaryZh).toContain('Official source');
    expect(result.summaryZh).toContain('需人工核验');
  });

  it('falls back without exposing the key when the model request fails', async () => {
    const failingFetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    const result = await draftEditorialCopy(input, {
      config: {
        baseUrl: 'https://model.example/v1',
        model: 'editorial-model',
        apiKey: 'TOP_SECRET_EDITORIAL_KEY',
      },
      fetchImpl: failingFetch,
    });

    expect(result.mode).toBe('deterministic_fallback');
    expect(result.fallbackReason).toBe('ai_unavailable');
    expect(JSON.stringify(result)).not.toContain('TOP_SECRET_EDITORIAL_KEY');
  });

  it('accepts only editorial copy fields and ignores model attempts to set governance state', async () => {
    const modelFetch = (async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            titleZh: '官方更新候选',
            summaryZh: '这是待人工核验的候选摘要。',
            whyItMattersZh: '需要结合目标用户场景判断。',
            salesImplicationZh: '需要销售人员核对客户相关性。',
            roleOrgImplicationZh: '需要核对岗位与组织影响。',
            nextActionZh: '阅读原文并补充第二项事实。',
            riskLevel: 'low',
            sourceId: 'unapproved-source',
            editorialStatus: 'approved',
          }),
        },
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const result = await draftEditorialCopy(input, {
      config: {
        baseUrl: 'https://model.example/v1',
        model: 'editorial-model',
        apiKey: 'secret',
      },
      fetchImpl: modelFetch,
    });

    expect(result).toEqual({
      mode: 'ai',
      titleZh: '官方更新候选',
      summaryZh: '这是待人工核验的候选摘要。',
      whyItMattersZh: '需要结合目标用户场景判断。',
      salesImplicationZh: '需要销售人员核对客户相关性。',
      roleOrgImplicationZh: '需要核对岗位与组织影响。',
      nextActionZh: '阅读原文并补充第二项事实。',
    });
    expect('riskLevel' in result).toBe(false);
    expect('sourceId' in result).toBe(false);
    expect('editorialStatus' in result).toBe(false);
  });

  it('keeps the timeout active while reading the model response body', async () => {
    const slowBodyFetch = (async (_input: URL | RequestInfo, init?: RequestInit) => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return {
          choices: [{ message: { content: JSON.stringify({
            titleZh: '不应采用的慢响应',
            summaryZh: '不应采用的慢响应。',
            whyItMattersZh: '不应采用。',
            salesImplicationZh: '不应采用。',
            roleOrgImplicationZh: '不应采用。',
            nextActionZh: '不应采用。',
          }) } }],
        };
      },
    } as Response)) as typeof fetch;
    const result = await draftEditorialCopy(input, {
      config: {
        baseUrl: 'https://model.example/v1',
        model: 'editorial-model',
        apiKey: 'secret',
      },
      fetchImpl: slowBodyFetch,
      timeoutMs: 1,
    });

    expect(result.mode).toBe('deterministic_fallback');
    expect(result.fallbackReason).toBe('ai_unavailable');
  });
});
