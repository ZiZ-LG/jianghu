import type { Prisma } from '@prisma/client';
import type {
  AgentInputRef,
  AgentJobControlLimits,
  AgentJobDefinition,
  AgentOutputRef,
  AgentPreparedAudit,
  PostMeetingCandidateBatch,
} from '@jianghu/domain-contracts';

export interface AgentPreparationContext {
  tenantId: string;
  actorId: string;
  requestId: string | null;
  runId: string;
  definition: AgentJobDefinition;
  limits: AgentJobControlLimits;
  customerId: string;
  matterId: string | null;
  sourceArtifactId: string | null;
  inputRefs: readonly AgentInputRef[];
  attempt: number;
  budgetRemaining: number;
  signal: AbortSignal;
}

export interface AgentCommitContext {
  tenantId: string;
  actorId: string;
  requestId: string | null;
  runId: string;
  definition: AgentJobDefinition;
  customerId: string;
  matterId: string | null;
  sourceArtifactId: string | null;
  inputRefs: readonly AgentInputRef[];
  authorizationFingerprint: string;
  commitCandidateBatch?: (batch: PostMeetingCandidateBatch) => Promise<AgentOutputRef>;
  signal: AbortSignal;
}

export interface AgentCandidateCommitAdapterContext extends Omit<
  AgentCommitContext,
  'commitCandidateBatch' | 'signal'
> {
  tx: Prisma.TransactionClient;
  /** Current body-free SourceArtifact authority from the commit authorization snapshot. */
  sourceFingerprint: string | null;
  sourceAclVersion: number | null;
}

/** Trusted infrastructure adapter; handlers receive only the narrow callback above. */
export type AgentCandidateCommitAdapter = (
  context: AgentCandidateCommitAdapterContext,
  batch: PostMeetingCandidateBatch,
) => Promise<AgentOutputRef>;

/**
 * Request-local preparation data may contain authorized source bodies or raw
 * provider output. Only `audit` is eligible for persistence; `privateState`
 * exists solely for the matching in-process commit call.
 */
export interface AgentPreparationEnvelope {
  audit: AgentPreparedAudit;
  privateState: unknown;
}

export type AgentPreparationResult = AgentPreparedAudit | AgentPreparationEnvelope;

/**
 * Preparation receives only a body-free context and AbortSignal. The trusted,
 * code-registered commit adapter is deliberately separate and also receives no
 * Prisma/formal writer. Owning SAAS tasks must add a reviewed narrow port rather
 * than exposing a generic transaction here.
 */
export interface AgentJobHandler {
  prepare(context: AgentPreparationContext): Promise<AgentPreparationResult>;
  commit(
    context: AgentCommitContext,
    prepared: AgentPreparedAudit,
    privateState?: unknown,
  ): Promise<AgentPreparedAudit>;
}

export type AgentJobHandlers = Readonly<Record<string, AgentJobHandler>>;

export class AgentPreparationError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly costUnits: number;

  constructor(code: string, options: { retryable?: boolean; costUnits?: number } = {}) {
    super(code);
    this.name = 'AgentPreparationError';
    this.code = /^[a-z][a-z0-9._-]{0,119}$/.test(code) ? code : 'agent_preparation_failed';
    this.retryable = options.retryable === true;
    this.costUnits = Number.isSafeInteger(options.costUnits) && (options.costUnits ?? 0) >= 0
      ? options.costUnits ?? 0
      : 0;
  }
}

export function agentHandlerKey(definition: Pick<AgentJobDefinition, 'jobKey' | 'jobVersion'>): string {
  return `${definition.jobKey}@${definition.jobVersion}`;
}

export function registeredAgentHandler(
  handlers: AgentJobHandlers,
  definition: AgentJobDefinition,
): AgentJobHandler | null {
  const key = agentHandlerKey(definition);
  if (!Object.prototype.hasOwnProperty.call(handlers, key)) return null;
  const value = handlers[key];
  return value && typeof value.prepare === 'function' && typeof value.commit === 'function'
    ? value
    : null;
}
