import { z } from 'zod';
import { UtcInstantSchema } from './crm.js';
import {
  InterventionItemSchema,
  InterventionSourceRefSchema,
  InterventionSuggestedActionSchema,
  InterventionTargetSchema,
} from './interventions.js';

export const RELATIONSHIP_RADAR_DIMENSIONS = [
  'interaction_freshness',
  'single_threaded_contact',
  'role_coverage',
  'visible_warm_paths',
  'evidence_freshness',
  'next_step_completeness',
] as const;

export const RELATIONSHIP_RADAR_STATUSES = ['healthy', 'attention', 'gap', 'unknown'] as const;
export const RELATIONSHIP_RADAR_SEVERITIES = ['info', 'low', 'medium', 'high'] as const;
export const RELATIONSHIP_RADAR_RULE_VERSION = 'saas-212.relationship-radar.v1' as const;
export const RELATIONSHIP_RADAR_PROVIDER_KEY = 'relationship_radar' as const;
export const RELATIONSHIP_RADAR_TTL_MS = 24 * 60 * 60 * 1_000;

export const RelationshipRadarDimensionSchema = z.enum(RELATIONSHIP_RADAR_DIMENSIONS);
export const RelationshipRadarStatusSchema = z.enum(RELATIONSHIP_RADAR_STATUSES);
export const RelationshipRadarSeveritySchema = z.enum(RELATIONSHIP_RADAR_SEVERITIES);

const safeId = z.string().trim().min(1).max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/);
const openKey = z.string().trim().min(1).max(120).regex(/^[a-z][a-z0-9._-]*$/);
const explanation = z.string().trim().min(1).max(500);

function sourceKey(source: z.infer<typeof InterventionSourceRefSchema>): string {
  return `${source.entityKind}\0${source.entityId}\0${source.version}\0${source.scheduleVersion ?? ''}`;
}

function uniqueSources(
  sources: readonly z.infer<typeof InterventionSourceRefSchema>[],
): boolean {
  return new Set(sources.map(sourceKey)).size === sources.length;
}

const signalObject = z.object({
  id: safeId,
  dimension: RelationshipRadarDimensionSchema,
  status: RelationshipRadarStatusSchema,
  severity: RelationshipRadarSeveritySchema,
  reasonCode: openKey,
  explanation,
  sourceRefs: z.array(InterventionSourceRefSchema).min(1).max(8),
  observedAtUtc: UtcInstantSchema,
  ruleVersion: z.literal(RELATIONSHIP_RADAR_RULE_VERSION),
  expiresAtUtc: UtcInstantSchema,
  suggestedAction: InterventionSuggestedActionSchema,
}).strict();

export const RelationshipSignalSchema = signalObject.superRefine((value, ctx) => {
  const allowed = value.status === 'healthy'
    ? value.severity === 'info'
    : value.status === 'attention'
      ? value.severity === 'low' || value.severity === 'medium'
      : value.status === 'gap'
        ? value.severity === 'medium'
        : value.severity === 'low';
  if (!allowed) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['severity'],
      message: 'Relationship signal status and severity are inconsistent',
    });
  }
  if (!uniqueSources(value.sourceRefs)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceRefs'],
      message: 'Relationship signal sources must be unique exact revisions',
    });
  }
});

export const RelationshipRadarActionDraftSchema = z.object({
  id: safeId,
  state: z.literal('uncommitted'),
  actionType: z.literal('CREATE_COMMITMENT'),
  customerId: z.string().min(1),
  matterId: z.string().min(1),
  target: InterventionTargetSchema,
  sourceRefs: z.array(InterventionSourceRefSchema).min(1).max(8),
  prefill: z.object({
    title: z.string().trim().min(1).max(120),
  }).strict(),
  reasonCode: openKey,
  explanation,
  observedAtUtc: UtcInstantSchema,
  ruleVersion: z.literal(RELATIONSHIP_RADAR_RULE_VERSION),
  expiresAtUtc: UtcInstantSchema,
}).strict().superRefine((value, ctx) => {
  if (value.target.entityKind !== 'matter'
    || value.target.customerId !== value.customerId
    || value.target.matterId !== value.matterId
    || value.target.entityId !== value.matterId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target'],
      message: 'Relationship radar draft requires the exact Matter target',
    });
  }
  if (!uniqueSources(value.sourceRefs)
    || !value.sourceRefs.some((source) => sourceKey(source) === sourceKey({
      entityKind: value.target.entityKind,
      entityId: value.target.entityId,
      version: value.target.version,
      scheduleVersion: value.target.scheduleVersion,
    }))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceRefs'],
      message: 'Relationship radar draft requires its exact target revision',
    });
  }
});

const signalFor = (dimension: typeof RELATIONSHIP_RADAR_DIMENSIONS[number]) => (
  RelationshipSignalSchema.refine((value) => value.dimension === dimension, {
    message: `Expected ${dimension}`,
    path: ['dimension'],
  })
);

const relationshipRadarSignalsSchema = z.tuple([
  signalFor('interaction_freshness'),
  signalFor('single_threaded_contact'),
  signalFor('role_coverage'),
  signalFor('visible_warm_paths'),
  signalFor('evidence_freshness'),
  signalFor('next_step_completeness'),
]);

export const RelationshipRadarSnapshotPayloadSchema = z.object({
  customerId: z.string().min(1),
  matterId: z.string().min(1),
  generatedAtUtc: UtcInstantSchema,
  expiresAtUtc: UtcInstantSchema,
  ruleVersion: z.literal(RELATIONSHIP_RADAR_RULE_VERSION),
  signals: relationshipRadarSignalsSchema,
  interventions: z.array(InterventionItemSchema).max(6),
  drafts: z.array(RelationshipRadarActionDraftSchema).max(1),
}).strict().superRefine((value, ctx) => {
  const generatedAt = Date.parse(value.generatedAtUtc);
  const expiresAt = Date.parse(value.expiresAtUtc);
  if (expiresAt - generatedAt !== RELATIONSHIP_RADAR_TTL_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAtUtc'],
      message: 'Relationship radar snapshots expire exactly 24 hours after generation',
    });
  }

  const identities = [
    ...value.signals.map((item) => item.id),
    ...value.interventions.map((item) => item.id),
    ...value.drafts.map((item) => item.id),
  ];
  if (new Set(identities).size !== identities.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['signals'], message: 'Radar output ids must be unique' });
  }

  value.signals.forEach((item, index) => {
    if (item.observedAtUtc !== value.generatedAtUtc
      || item.expiresAtUtc !== value.expiresAtUtc
      || item.ruleVersion !== value.ruleVersion
      || item.severity === 'high') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['signals', index],
        message: 'V1 signals must share snapshot time/rule and cannot be high severity',
      });
    }
  });

  const signalByReason = new Map(value.signals.map((item) => [item.reasonCode, item]));
  value.interventions.forEach((item, index) => {
    const signal = signalByReason.get(item.reasonCode);
    if (item.providerKey !== RELATIONSHIP_RADAR_PROVIDER_KEY
      || item.observedAtUtc !== value.generatedAtUtc
      || item.ruleVersion !== value.ruleVersion
      || item.context.customerName !== '当前客户'
      || item.context.matterName !== '当前事项'
      || !signal
      || (signal.status !== 'attention' && signal.status !== 'gap')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['interventions', index],
        message: 'Radar interventions must be generic and correspond to an actionable signal',
      });
    }
  });

  const nextStepSignal = value.signals[5];
  value.drafts.forEach((item, index) => {
    if (item.customerId !== value.customerId
      || item.matterId !== value.matterId
      || item.observedAtUtc !== value.generatedAtUtc
      || item.expiresAtUtc !== value.expiresAtUtc
      || item.ruleVersion !== value.ruleVersion
      || item.reasonCode !== nextStepSignal.reasonCode
      || nextStepSignal.status !== 'gap') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['drafts', index],
        message: 'Radar drafts are allowed only for the current next-step gap',
      });
    }
  });
  if ((nextStepSignal.status === 'gap') !== (value.drafts.length === 1)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['drafts'],
      message: 'Next-step gaps require exactly one uncommitted draft',
    });
  }
});

export const RelationshipRadarSnapshotMetadataSchema = z.object({
  id: safeId,
  generatedAtUtc: UtcInstantSchema,
  expiresAtUtc: UtcInstantSchema,
  ruleVersion: z.literal(RELATIONSHIP_RADAR_RULE_VERSION),
  version: z.number().int().min(1).max(2_147_483_647),
  sourceState: z.enum(['current', 'changed']),
}).strict();

const responseAnchor = {
  customerId: z.string().min(1),
  matterId: z.string().min(1),
};

export const RelationshipRadarResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('missing'), ...responseAnchor }).strict(),
  z.object({
    status: z.literal('expired'),
    ...responseAnchor,
    snapshot: RelationshipRadarSnapshotMetadataSchema,
  }).strict(),
  z.object({
    status: z.literal('ready'),
    ...responseAnchor,
    snapshot: RelationshipRadarSnapshotMetadataSchema,
    projection: RelationshipRadarSnapshotPayloadSchema,
  }).strict(),
]);

export const RelationshipRadarQuerySchema = z.object({
  customerId: z.string().trim().min(1).max(500),
  matterId: z.string().trim().min(1).max(500),
}).strict();

export const RelationshipRadarSourceRequestSchema = RelationshipRadarQuerySchema.extend({
  sourceRef: InterventionSourceRefSchema,
}).strict();

export type RelationshipRadarDimension = z.infer<typeof RelationshipRadarDimensionSchema>;
export type RelationshipRadarStatus = z.infer<typeof RelationshipRadarStatusSchema>;
export type RelationshipRadarSeverity = z.infer<typeof RelationshipRadarSeveritySchema>;
export type RelationshipSignal = z.infer<typeof RelationshipSignalSchema>;
export type RelationshipRadarActionDraft = z.infer<typeof RelationshipRadarActionDraftSchema>;
export type RelationshipRadarSnapshotPayload = z.infer<typeof RelationshipRadarSnapshotPayloadSchema>;
export type RelationshipRadarSnapshotMetadata = z.infer<typeof RelationshipRadarSnapshotMetadataSchema>;
export type RelationshipRadarResponse = z.infer<typeof RelationshipRadarResponseSchema>;
export type RelationshipRadarQuery = z.infer<typeof RelationshipRadarQuerySchema>;
export type RelationshipRadarSourceRequest = z.infer<typeof RelationshipRadarSourceRequestSchema>;
