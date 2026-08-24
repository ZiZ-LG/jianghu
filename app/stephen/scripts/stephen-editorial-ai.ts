import { readBoundedResponseBody } from './stephen-bounded-response.ts';

export interface EditorialDraftInput {
  readonly originalTitle: string;
  readonly sourceName: string;
  readonly sourceUrl: string;
  readonly sourceExcerpt: string;
}

export interface EditorialAiConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
}

export interface EditorialDraftCopy {
  readonly mode: 'ai' | 'deterministic_fallback';
  readonly fallbackReason?: 'ai_not_configured' | 'ai_unavailable';
  readonly titleZh: string;
  readonly summaryZh: string;
  readonly whyItMattersZh: string;
  readonly salesImplicationZh: string;
  readonly roleOrgImplicationZh: string;
  readonly nextActionZh: string;
}

interface ModelPayload {
  readonly choices?: readonly {
    readonly message?: { readonly content?: unknown };
  }[];
}

const copyFields = [
  'titleZh',
  'summaryZh',
  'whyItMattersZh',
  'salesImplicationZh',
  'roleOrgImplicationZh',
  'nextActionZh',
] as const;

const DEFAULT_AI_MAX_RESPONSE_BYTES = 256_000;

function deterministicFallback(
  input: EditorialDraftInput,
  fallbackReason: NonNullable<EditorialDraftCopy['fallbackReason']>,
): EditorialDraftCopy {
  return {
    mode: 'deterministic_fallback',
    fallbackReason,
    titleZh: `官方更新候选｜${input.originalTitle}`,
    summaryZh: `${input.sourceName} 发布了这项更新。当前仅保留官方来源元数据，需人工核验原文后补充中文摘要。`,
    whyItMattersZh: '与目标用户的关联尚待人工判断，不由模型自动下结论。',
    salesImplicationZh: '请结合具体客户场景核对其对大客户销售的实际影响。',
    roleOrgImplicationZh: '请核对岗位分工、组织采用条件与适用边界。',
    nextActionZh: '阅读官方原文并补充第二项独立事实，再决定是否进入公开候选。',
  };
}

function isConfigured(config: EditorialAiConfig | undefined): config is EditorialAiConfig {
  return Boolean(
    config?.baseUrl.trim()
    && config.model.trim()
    && config.apiKey.trim(),
  );
}

function parseEditorialCopy(payload: ModelPayload): Omit<EditorialDraftCopy, 'mode'> {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('AI response is missing content');
  const value: unknown = JSON.parse(content);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('AI response is not an object');
  }
  const record = value as Record<string, unknown>;
  const selected: Record<string, string> = {};
  for (const field of copyFields) {
    const fieldValue = record[field];
    if (typeof fieldValue !== 'string' || fieldValue.trim() === '') {
      throw new Error(`AI response field is invalid: ${field}`);
    }
    selected[field] = fieldValue.trim().slice(0, 2_000);
  }
  return selected as unknown as Omit<EditorialDraftCopy, 'mode'>;
}

export async function draftEditorialCopy(
  input: EditorialDraftInput,
  options: {
    readonly config?: EditorialAiConfig;
    readonly fetchImpl?: typeof fetch;
    readonly timeoutMs?: number;
    readonly maxResponseBytes?: number;
  },
): Promise<EditorialDraftCopy> {
  if (!isConfigured(options.config)) {
    return deterministicFallback(input, 'ai_not_configured');
  }

  try {
    const baseUrl = new URL(options.config.baseUrl.endsWith('/')
      ? options.config.baseUrl
      : `${options.config.baseUrl}/`);
    if (baseUrl.protocol !== 'https:') throw new Error('AI base URL must use HTTPS');
    const endpoint = new URL('chat/completions', baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
    try {
      const response = await (options.fetchImpl ?? globalThis.fetch)(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.config.apiKey}`,
          'content-type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: options.config.model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [{
            role: 'system',
            content: [
              'You draft Chinese editorial copy from attributed official-source metadata.',
              'Return JSON with only titleZh, summaryZh, whyItMattersZh, salesImplicationZh, roleOrgImplicationZh, nextActionZh.',
              'Never decide risk, source identity, approval status, publication status, or evidence level.',
              'Do not invent facts. State when human verification is required.',
            ].join(' '),
          }, {
            role: 'user',
            content: JSON.stringify(input),
          }],
        }),
      });
      if (!response.ok) throw new Error(`AI request returned status ${response.status}`);
      const contentType = response.headers.get('content-type')?.toLocaleLowerCase() ?? '';
      if (!contentType.startsWith('application/json')) {
        throw new Error('AI response content type is invalid');
      }
      const body = await readBoundedResponseBody(
        response,
        options.maxResponseBytes ?? DEFAULT_AI_MAX_RESPONSE_BYTES,
        controller.signal,
      );
      const payload = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(body),
      ) as ModelPayload;
      const copy = parseEditorialCopy(payload);
      if (controller.signal.aborted) throw new Error('AI request timed out');
      return { mode: 'ai', ...copy };
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return deterministicFallback(input, 'ai_unavailable');
  }
}
