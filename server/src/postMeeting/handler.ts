import { createHash } from 'node:crypto';
import {
  AgentPreparedAuditSchema,
  PostMeetingCandidateBatchSchema,
  type CapabilityPolicy,
  type PostMeetingCandidateBatch,
} from '@jianghu/domain-contracts';
import type { PrismaClient } from '@prisma/client';
import { callLLM, loadAiConfig } from '../ai.js';
import { AgentJobError } from '../agents/errors.js';
import {
  AgentPreparationError,
  type AgentJobHandler,
  type AgentJobHandlers,
} from '../agents/model.js';
import { parsePostMeetingModelResponse } from './extractor.js';
import { loadAuthorizedPostMeetingSource } from './source.js';

type AiConfig = NonNullable<Awaited<ReturnType<typeof loadAiConfig>>>;

export interface PostMeetingHandlerDependencies {
  db: PrismaClient;
  policy: CapabilityPolicy;
  loadAiConfig?: (tenantId: string, db: PrismaClient) => Promise<AiConfig | null>;
  callLLM?: (
    config: Pick<AiConfig, 'baseUrl' | 'model' | 'apiKey'>,
    system: string,
    user: string,
    maxTokens?: number,
  ) => Promise<string>;
  decrypt?: (ciphertext: string) => string;
}

interface PrivateState {
  batch: PostMeetingCandidateBatch;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export function postMeetingReviewBatchId(tenantId: string, runId: string): string {
  return `review_batch_${sha256(JSON.stringify([
    tenantId, 'post-meeting-review-batch-v1', runId,
  ])).slice(0, 32)}`;
}

const SYSTEM_PROMPT = `You extract evidence-backed CRM review candidates from one authorized meeting source.
Return one pure JSON object and no Markdown: {"items":[...]}. Use only these kinds: person, relation, field, evidence, commitment.
Every item requires ref, quote copied exactly from SOURCE_BODY, and confidence from 0 to 1.
Never output tenant/customer/matter/source IDs, formal entity IDs, database actions, customerType, stage, forecast or key-person status.
Existing person IDs may only be copied from ALLOWED_PEOPLE. New-person links use personRef matching a person item's ref.
Customer fields: name or categoryKey. Matter fields: title, kind, priority or targetDate.
At most 20 items. Unknown keys are forbidden. If nothing is supported by an exact quote, return no invented content.`;

function userPrompt(source: Awaited<ReturnType<typeof loadAuthorizedPostMeetingSource>>): string {
  return JSON.stringify({
    CUSTOMER: source.customer,
    MATTER: source.matter,
    ALLOWED_PEOPLE: source.people,
    SOURCE: {
      id: source.id,
      kind: source.artifactKind,
      title: source.title,
      occurredAt: source.occurredAt,
    },
    SOURCE_BODY: source.body,
  });
}

function configIsUsable(config: AiConfig): boolean {
  return Boolean(config.baseUrl.trim() && config.model.trim() && config.apiKey.trim());
}

function costUnits(input: string, output: string): number {
  return Math.max(1, Math.ceil((Buffer.byteLength(input, 'utf8') + Buffer.byteLength(output, 'utf8')) / 1_000));
}

export function createPostMeetingHandler(dependencies: PostMeetingHandlerDependencies): AgentJobHandler {
  const configLoader = dependencies.loadAiConfig ?? ((tenantId, db) => loadAiConfig(tenantId, db));
  const complete = dependencies.callLLM ?? callLLM;
  return {
    async prepare(context) {
      if (context.definition.jobKey !== 'post_meeting_extract'
        || context.definition.jobVersion !== 'core-206.v1'
        || context.definition.actionMode !== 'candidate'
        || context.sourceArtifactId === null) {
        throw new AgentPreparationError('post_meeting_handler_scope_invalid');
      }
      const sourceRef = context.inputRefs.find((ref) => (
        ref.kind === 'source_artifact' && ref.id === context.sourceArtifactId
      ));
      if (!sourceRef) throw new AgentPreparationError('post_meeting_handler_scope_invalid');
      const source = await loadAuthorizedPostMeetingSource(
        dependencies.db,
        dependencies.policy,
        {
          tenantId: context.tenantId,
          actorId: context.actorId,
          customerId: context.customerId,
          matterId: context.matterId,
          sourceArtifactId: context.sourceArtifactId,
          expectedAclVersion: sourceRef.version,
        },
        dependencies.decrypt ? { decrypt: dependencies.decrypt } : {},
      );
      if (context.signal.aborted) {
        throw new AgentPreparationError('agent_timeout', { retryable: true });
      }

      let config: AiConfig | null;
      try {
        config = await configLoader(context.tenantId, dependencies.db);
      } catch {
        throw new AgentPreparationError('post_meeting_ai_config_failed', { retryable: true });
      }
      if (!config) throw new AgentPreparationError('post_meeting_ai_not_configured');
      if (!configIsUsable(config)) throw new AgentPreparationError('post_meeting_ai_config_invalid');

      const prompt = userPrompt(source);
      let raw: string;
      try {
        raw = await complete(config, SYSTEM_PROMPT, prompt, 4_000);
      } catch {
        throw new AgentPreparationError('post_meeting_model_failed', { retryable: true });
      }
      if (context.signal.aborted) {
        throw new AgentPreparationError('agent_timeout', { retryable: true });
      }
      const batch = parsePostMeetingModelResponse(raw, {
        tenantId: context.tenantId,
        actorId: context.actorId,
        runId: context.runId,
        customerId: context.customerId,
        matterId: context.matterId,
        sourceArtifactId: context.sourceArtifactId,
        body: source.body,
        people: source.people,
      });
      const used = costUnits(prompt, raw);
      if (used > context.budgetRemaining || used > context.limits.maxCostUnits) {
        throw new AgentPreparationError('agent_budget_exceeded');
      }
      const audit = AgentPreparedAuditSchema.parse({
        costUnits: used,
        evidenceRefs: batch.items.map((item) => ({
          sourceArtifactId: source.id,
          locatorId: item.sourceLocator,
          sourceFingerprint: source.sourceFingerprint,
          observedAt: source.observedAt,
        })),
        outputRefs: [{
          kind: 'review_batch',
          id: postMeetingReviewBatchId(context.tenantId, context.runId),
          version: 0,
        }],
      });
      return { audit, privateState: { batch } satisfies PrivateState };
    },

    async commit(context, prepared, rawPrivateState) {
      if (!rawPrivateState || typeof rawPrivateState !== 'object' || Array.isArray(rawPrivateState)) {
        throw new AgentJobError('agent_candidate_batch_invalid', 409);
      }
      const record = rawPrivateState as Record<string, unknown>;
      if (Object.keys(record).length !== 1 || !Object.prototype.hasOwnProperty.call(record, 'batch')) {
        throw new AgentJobError('agent_candidate_batch_invalid', 409);
      }
      const batch = PostMeetingCandidateBatchSchema.safeParse(record.batch);
      if (!batch.success
        || batch.data.customerId !== context.customerId
        || batch.data.matterId !== context.matterId
        || batch.data.sourceArtifactId !== context.sourceArtifactId) {
        throw new AgentJobError('agent_candidate_batch_invalid', 409);
      }
      if (!context.commitCandidateBatch) {
        throw new AgentJobError('agent_candidate_commit_unavailable', 409);
      }
      await context.commitCandidateBatch(batch.data);
      return prepared;
    },
  };
}

export function productionPostMeetingHandlers(
  db: PrismaClient,
  policy: CapabilityPolicy,
): AgentJobHandlers {
  return Object.freeze({
    'post_meeting_extract@core-206.v1': createPostMeetingHandler({ db, policy }),
  });
}
