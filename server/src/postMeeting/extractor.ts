import { createHash } from 'node:crypto';
import { PostMeetingCandidateBatchSchema, type PostMeetingCandidateBatch } from '@jianghu/domain-contracts';
import { z } from 'zod';
import { AgentPreparationError } from '../agents/model.js';
import type { PostMeetingPersonContext } from './source.js';

const logicalRef = z.string().trim().min(1).max(80)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const quote = z.string().trim().min(1).max(2_000);
const confidence = z.number().finite().min(0).max(1);
const shortText = z.string().trim().min(1).max(200);
const optionalShortText = z.string().trim().max(200).nullable();
const openKey = z.string().trim().min(1).max(80);

const modelEvidence = {
  ref: logicalRef,
  quote,
  confidence,
} satisfies z.ZodRawShape;

const modelPersonEndpoint = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing_person'), personId: z.string().trim().min(1).max(500) }).strict(),
  z.object({ kind: z.literal('new_person'), personRef: logicalRef }).strict(),
]);

const modelItem = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('person'), ...modelEvidence,
    name: shortText, title: optionalShortText,
  }).strict(),
  z.object({
    kind: z.literal('relation'), ...modelEvidence,
    sourcePerson: modelPersonEndpoint,
    targetPerson: modelPersonEndpoint,
    layer: z.enum(['L1', 'L2', 'L3', 'L4']),
    label: optionalShortText,
  }).strict(),
  z.object({
    kind: z.literal('field'), ...modelEvidence,
    target: z.union([
      z.object({ kind: z.literal('customer'), field: z.enum(['name', 'categoryKey']) }).strict(),
      z.object({
        kind: z.literal('matter'),
        field: z.enum(['title', 'kind', 'priority', 'targetDate']),
      }).strict(),
    ]),
    proposedValue: z.string().trim().max(500).nullable(),
  }).strict(),
  z.object({
    kind: z.literal('evidence'), ...modelEvidence,
    person: modelPersonEndpoint,
    signalKey: openKey,
    direction: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    tier: z.enum(['weak', 'mid', 'strong']),
    occurredAt: z.string().datetime({ offset: true }).refine((value) => value.endsWith('Z')),
  }).strict(),
  z.object({
    kind: z.literal('commitment'), ...modelEvidence,
    personId: z.string().trim().min(1).max(500).nullable(),
    title: shortText,
    kindKey: openKey,
    confirmationStatus: z.enum(['not_required', 'pending']),
    scheduledAtUtc: z.string().datetime({ offset: true }).refine((value) => value.endsWith('Z')).nullable(),
    dueAtUtc: z.string().datetime({ offset: true }).refine((value) => value.endsWith('Z')).nullable(),
    timeZone: z.string().trim().min(1).max(100),
    isAllDay: z.boolean(),
    localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    confirmationDueAtUtc: z.string().datetime({ offset: true }).refine((value) => value.endsWith('Z')).nullable(),
  }).strict(),
]);

const modelResponse = z.object({
  items: z.array(modelItem).min(1).max(20),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    if (seen.has(item.ref)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items', index, 'ref'],
        message: 'logical references must be unique',
      });
    }
    seen.add(item.ref);
  }
});

type ModelItem = z.infer<typeof modelItem>;
type ModelEndpoint = z.infer<typeof modelPersonEndpoint>;

export interface PostMeetingExtractionContext {
  tenantId: string;
  actorId: string;
  runId: string;
  customerId: string;
  matterId: string | null;
  sourceArtifactId: string;
  body: string;
  people: readonly PostMeetingPersonContext[];
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function invalid(): never {
  throw new AgentPreparationError('post_meeting_model_output_invalid');
}

function itemRef(index: number): string {
  return `item-${String(index + 1).padStart(3, '0')}`;
}

function locatorFor(body: string, sourceQuote: string, ref: string): string {
  const start = body.indexOf(sourceQuote);
  if (start < 0) invalid();
  return `${ref}:chars:${start}-${start + sourceQuote.length}`;
}

function commitmentId(context: PostMeetingExtractionContext, ref: string): string {
  return `commit_${sha256(JSON.stringify([
    context.tenantId, context.runId, context.sourceArtifactId, ref,
  ])).slice(0, 32)}`;
}

/** Parse pure JSON and normalize every model-controlled value into fixed server anchors. */
export function parsePostMeetingModelResponse(
  raw: string,
  context: PostMeetingExtractionContext,
): PostMeetingCandidateBatch {
  let parsed: z.infer<typeof modelResponse>;
  try {
    if (Buffer.byteLength(raw, 'utf8') > 256 * 1024) invalid();
    parsed = modelResponse.parse(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof AgentPreparationError) throw error;
    invalid();
  }

  const existingPersonIds = new Set(context.people.map((person) => person.id));
  const newPersonRefs = new Map<string, string>();
  parsed.items.forEach((item, index) => {
    if (item.kind === 'person') newPersonRefs.set(item.ref, itemRef(index));
  });

  const endpoint = (value: ModelEndpoint) => {
    if (value.kind === 'existing_person') {
      if (!existingPersonIds.has(value.personId)) invalid();
      return { kind: 'existing_person' as const, personId: value.personId };
    }
    const resolved = newPersonRefs.get(value.personRef);
    if (!resolved) invalid();
    return { kind: 'new_person' as const, itemRef: resolved };
  };

  const normalized = parsed.items.map((item: ModelItem, index) => {
    const ref = itemRef(index);
    const common = {
      itemRef: ref,
      sourceLocator: locatorFor(context.body, item.quote, ref),
      sourceQuote: item.quote,
      confidence: item.confidence,
    };
    if (item.kind === 'person') {
      return {
        kind: 'person' as const,
        ...common,
        person: { name: item.name, title: item.title },
      };
    }
    if (item.kind === 'relation') {
      return {
        kind: 'relation' as const,
        ...common,
        sourcePerson: endpoint(item.sourcePerson),
        targetPerson: endpoint(item.targetPerson),
        layer: item.layer,
        label: item.label,
      };
    }
    if (item.kind === 'field') {
      return {
        kind: 'field' as const,
        ...common,
        target: item.target,
        proposedValue: item.proposedValue,
      };
    }
    if (item.kind === 'evidence') {
      return {
        kind: 'evidence' as const,
        ...common,
        person: endpoint(item.person),
        signalKey: item.signalKey,
        direction: item.direction,
        tier: item.tier,
        occurredAt: item.occurredAt,
      };
    }
    if (item.personId !== null && !existingPersonIds.has(item.personId)) invalid();
    return {
      kind: 'commitment' as const,
      ...common,
      command: {
        type: 'CREATE_COMMITMENT' as const,
        commitment: {
          id: commitmentId(context, ref),
          customerId: context.customerId,
          matterId: context.matterId,
          personId: item.personId,
          title: item.title,
          kind: item.kindKey,
          ownerUserId: context.actorId,
          confirmationStatus: item.confirmationStatus,
          scheduledAtUtc: item.scheduledAtUtc,
          dueAtUtc: item.dueAtUtc,
          timeZone: item.timeZone,
          isAllDay: item.isAllDay,
          localDate: item.localDate,
          confirmationDueAtUtc: item.confirmationDueAtUtc,
          source: 'review_batch_candidate',
          sourceRef: `post-meeting:${context.runId}:${ref}`,
        },
      },
    };
  });

  const batch = PostMeetingCandidateBatchSchema.safeParse({
    customerId: context.customerId,
    matterId: context.matterId,
    sourceArtifactId: context.sourceArtifactId,
    items: normalized,
  });
  if (!batch.success) invalid();
  return batch.data;
}
