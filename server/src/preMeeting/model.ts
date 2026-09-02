import { z } from 'zod';
import {
  RESEARCH_BRIEF_SECTION_KEYS,
  ResearchBriefSectionKeySchema,
  ResearchBriefPreparedPayload,
  type ResearchBriefSectionKey,
  ResearchBriefSource,
  ResearchBriefSubject,
} from '@jianghu/domain-contracts';
import { validateResearchBriefPreparedPayload } from '../researchBriefs/model.js';

const MAX_MODEL_RESPONSE_BYTES = 20_000;

const SECTION_COPY: Record<ResearchBriefSectionKey, { title: string; question: string }> = {
  company_overview: {
    title: '公司概览',
    question: '客户公司的基本情况还缺少哪些事实？',
  },
  recent_changes: {
    title: '近期变化',
    question: '近期有哪些变化需要在拜访中核实？',
  },
  existing_cooperation: {
    title: '现有合作',
    question: '双方现有合作情况还缺少哪些事实？',
  },
  active_matters: {
    title: '当前事项',
    question: '当前事项的目标、进度或约束还缺少哪些事实？',
  },
  stakeholders: {
    title: '关键干系人',
    question: '还需要确认哪些关键干系人及其角色？',
  },
  open_hypotheses: {
    title: '待验证假设',
    question: '哪些关键判断仍需要客户现场验证？',
  },
  last_commitments: {
    title: '最近承诺',
    question: '双方最近承诺及履行状态还缺少哪些事实？',
  },
  questions_to_verify: {
    title: '拜访核验问题',
    question: '本次拜访还需要补充哪些核验问题？',
  },
};

const visibleReference = z.string().min(1).max(200).refine(
  (value) => value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
);
const safeCode = z.string().min(1).max(120).regex(/^[a-z][a-z0-9._-]*$/);
const modelSectionSchema = z.object({
  key: ResearchBriefSectionKeySchema,
  content: z.string().trim().min(1).max(4_000),
  sourceIds: z.array(visibleReference).min(1).max(20),
}).strict().superRefine((value, context) => {
  if (new Set(value.sourceIds).size !== value.sourceIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceIds'], message: 'duplicate source' });
  }
});
const modelUnknownSchema = z.object({
  key: ResearchBriefSectionKeySchema,
  reasonCode: safeCode,
  sourceIds: z.array(visibleReference).max(20),
}).strict().superRefine((value, context) => {
  if (new Set(value.sourceIds).size !== value.sourceIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceIds'], message: 'duplicate source' });
  }
});
const modelResponseSchema = z.object({
  sections: z.array(modelSectionSchema).max(RESEARCH_BRIEF_SECTION_KEYS.length),
  unknowns: z.array(modelUnknownSchema).max(RESEARCH_BRIEF_SECTION_KEYS.length),
}).strict().superRefine((value, context) => {
  const sectionKeys = value.sections.map((section) => section.key);
  const unknownKeys = value.unknowns.map((unknown) => unknown.key);
  if (new Set(sectionKeys).size !== sectionKeys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sections'], message: 'duplicate section' });
  }
  if (new Set(unknownKeys).size !== unknownKeys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['unknowns'], message: 'duplicate unknown' });
  }
  const unknownSet = new Set(unknownKeys);
  if (sectionKeys.some((key) => unknownSet.has(key))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'section and unknown overlap' });
  }
});

export interface PreMeetingPreparedSource {
  metadata: ResearchBriefSource;
  content: string;
}

export interface ParsePreMeetingModelContext {
  generatedAt: Date;
  modelRef: string;
  subject: ResearchBriefSubject;
  sources: readonly PreMeetingPreparedSource[];
}

export class PreMeetingModelError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PreMeetingModelError';
  }
}

export function parsePreMeetingModelResponse(
  raw: string,
  context: ParsePreMeetingModelContext,
): ResearchBriefPreparedPayload {
  try {
    if (Buffer.byteLength(raw, 'utf8') > MAX_MODEL_RESPONSE_BYTES) throw new Error('oversized');
    const parsedJson: unknown = JSON.parse(raw);
    const response = modelResponseSchema.parse(parsedJson);
    if (!Number.isFinite(context.generatedAt.getTime())) throw new Error('timestamp');
    const sourceIds = new Set(context.sources.map((source) => source.metadata.id));
    if (sourceIds.size !== context.sources.length || context.sources.length === 0) {
      throw new Error('source set');
    }
    const referencedIds = [
      ...response.sections.flatMap((section) => section.sourceIds),
      ...response.unknowns.flatMap((unknown) => unknown.sourceIds),
    ];
    if (referencedIds.some((id) => !sourceIds.has(id))) throw new Error('dangling source');

    const explicitUnknowns = new Map(response.unknowns.map((unknown) => [unknown.key, unknown]));
    const sectionKeys = new Set(response.sections.map((section) => section.key));
    const unknowns = RESEARCH_BRIEF_SECTION_KEYS
      .filter((key) => !sectionKeys.has(key))
      .map((key) => {
        const supplied = explicitUnknowns.get(key);
        return {
          key,
          question: SECTION_COPY[key].question,
          reasonCode: supplied?.reasonCode ?? 'missing_evidence',
          sourceIds: supplied?.sourceIds ?? [],
        };
      });

    return validateResearchBriefPreparedPayload({
      subject: context.subject,
      sources: context.sources.map((source) => source.metadata),
      sections: response.sections.map((section) => ({
        ...section,
        title: SECTION_COPY[section.key].title,
        asOf: context.generatedAt.toISOString(),
      })),
      unknowns,
      failures: [],
      generator: {
        version: 'saas-204.v1',
        modelRef: context.modelRef,
        connectorRefs: [],
      },
    });
  } catch (error) {
    if (error instanceof PreMeetingModelError) throw error;
    throw new PreMeetingModelError('pre_meeting_model_output_invalid');
  }
}
