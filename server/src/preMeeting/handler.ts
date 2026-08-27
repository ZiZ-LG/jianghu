import type { PrismaClient } from '@prisma/client';
import {
  AgentPreparedAuditSchema,
  ResearchBriefPreparedPayloadSchema,
  type CapabilityPolicy,
} from '@jianghu/domain-contracts';
import { callLLM, loadAiConfig } from '../ai.js';
import { AgentJobError } from '../agents/errors.js';
import {
  AgentPreparationError,
  type AgentJobHandler,
  type AgentJobHandlers,
} from '../agents/model.js';
import {
  researchBriefSnapshotId,
} from '../researchBriefs/service.js';
import {
  parsePreMeetingModelResponse,
  PreMeetingModelError,
} from './model.js';
import { loadPreMeetingSources } from './source.js';

type AiConfig = NonNullable<Awaited<ReturnType<typeof loadAiConfig>>>;

export interface PreMeetingHandlerDependencies {
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

const SYSTEM_PROMPT = `You create an evidence-cited pre-meeting brief from authorized CRM inputs.
Return one pure JSON object and no Markdown: {"sections":[],"unknowns":[]}.
Each section has exactly key, content, sourceIds. Each unknown has exactly key, reasonCode, sourceIds.
Allowed section keys: company_overview, recent_changes, existing_cooperation, active_matters, stakeholders, open_hypotheses, last_commitments, questions_to_verify.
Use only the server-issued source IDs. Every section requires at least one source ID. Never invent facts.
Do not output titles, questions, timestamps, subject metadata, source metadata, IDs other than source IDs, stage, forecast, score, key-person status or database actions.`;

function configUsable(config: AiConfig): boolean {
  return config.provider !== 'mock'
    && Boolean(config.baseUrl.trim() && config.model.trim() && config.apiKey.trim());
}

function promptFor(sources: Awaited<ReturnType<typeof loadPreMeetingSources>>): string {
  return JSON.stringify({
    SUBJECT: sources.subject,
    SOURCES: sources.sources.map((source) => ({
      id: source.metadata.id,
      kind: source.metadata.kind,
      label: source.metadata.label,
      observedAt: source.metadata.observedAt,
      content: source.content,
    })),
  });
}

function costUnits(input: string, output: string): number {
  return Math.max(1, Math.ceil(
    (Buffer.byteLength(input, 'utf8') + Buffer.byteLength(output, 'utf8')) / 1_000,
  ));
}

export function createPreMeetingHandler(
  dependencies: PreMeetingHandlerDependencies,
): AgentJobHandler {
  const configLoader = dependencies.loadAiConfig ?? ((tenantId, db) => loadAiConfig(tenantId, db));
  const complete = dependencies.callLLM ?? callLLM;
  return {
    commitPort: 'research_brief',
    async prepare(context) {
      if (context.definition.jobKey !== 'pre_meeting_brief'
        || context.definition.jobVersion !== 'core-206.v1'
        || context.definition.actionMode !== 'read_only'
        || context.matterId === null
        || context.sourceArtifactId === null) {
        throw new AgentPreparationError('pre_meeting_handler_scope_invalid');
      }
      const generatedAt = new Date();
      const sources = await loadPreMeetingSources(dependencies.db, dependencies.policy, {
        tenantId: context.tenantId,
        actorId: context.actorId,
        customerId: context.customerId,
        matterId: context.matterId,
        sourceArtifactId: context.sourceArtifactId,
        generatedAt,
        inputRefs: context.inputRefs,
      }, dependencies.decrypt ? { decrypt: dependencies.decrypt } : {});
      if (context.signal.aborted) {
        throw new AgentPreparationError('agent_timeout', { retryable: true });
      }

      let config: AiConfig | null;
      try {
        config = await configLoader(context.tenantId, dependencies.db);
      } catch {
        throw new AgentPreparationError('pre_meeting_ai_config_failed', { retryable: true });
      }
      if (!config) throw new AgentPreparationError('pre_meeting_ai_not_configured');
      if (!configUsable(config)) throw new AgentPreparationError('pre_meeting_ai_config_invalid');

      const prompt = promptFor(sources);
      let raw: string;
      try {
        raw = await complete(config, SYSTEM_PROMPT, prompt, 4_000);
      } catch {
        throw new AgentPreparationError('pre_meeting_model_failed', { retryable: true });
      }
      if (context.signal.aborted) {
        throw new AgentPreparationError('agent_timeout', { retryable: true });
      }
      let payload;
      try {
        payload = parsePreMeetingModelResponse(raw, {
          generatedAt,
          modelRef: config.model,
          subject: sources.subject,
          sources: sources.sources,
        });
      } catch (error) {
        if (error instanceof PreMeetingModelError) {
          throw new AgentPreparationError(error.code);
        }
        throw error;
      }
      const used = costUnits(prompt, raw);
      if (used > context.budgetRemaining || used > context.limits.maxCostUnits) {
        throw new AgentPreparationError('agent_budget_exceeded');
      }
      const outputId = researchBriefSnapshotId(
        context.tenantId, context.actorId, `agent-run:${context.runId}`,
      );
      const audit = AgentPreparedAuditSchema.parse({
        costUnits: used,
        evidenceRefs: [sources.evidence],
        outputRefs: [{ kind: 'research_brief', id: outputId, version: 1 }],
      });
      return {
        audit,
        privateState: { generatedAt: generatedAt.toISOString(), payload },
      };
    },

    async commit(context, prepared, rawPrivateState) {
      if (!rawPrivateState || typeof rawPrivateState !== 'object' || Array.isArray(rawPrivateState)) {
        throw new AgentJobError('pre_meeting_commit_payload_invalid', 409);
      }
      const record = rawPrivateState as Record<string, unknown>;
      if (Object.keys(record).sort().join(',') !== 'generatedAt,payload'
        || typeof record.generatedAt !== 'string') {
        throw new AgentJobError('pre_meeting_commit_payload_invalid', 409);
      }
      const generatedAt = new Date(record.generatedAt);
      const payload = ResearchBriefPreparedPayloadSchema.safeParse(record.payload);
      if (!Number.isFinite(generatedAt.getTime())
        || generatedAt.toISOString() !== record.generatedAt
        || !payload.success) {
        throw new AgentJobError('pre_meeting_commit_payload_invalid', 409);
      }
      if (!context.commitResearchBrief) {
        throw new AgentJobError('agent_research_brief_commit_unavailable', 409);
      }
      await context.commitResearchBrief({
        generatedAt: record.generatedAt,
        payload: payload.data,
      });
      return prepared;
    },
  };
}

export function productionPreMeetingHandlers(
  db: PrismaClient,
  policy: CapabilityPolicy,
): AgentJobHandlers {
  return Object.freeze({
    'pre_meeting_brief@core-206.v1': createPreMeetingHandler({ db, policy }),
  });
}
