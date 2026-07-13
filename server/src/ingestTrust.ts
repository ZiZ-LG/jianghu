import { ActionSchema, AssertionModeSchema, type Action, type CommandContext } from '@jianghu/domain-contracts';
import { z } from 'zod';

export { AssertionModeSchema };

const ExplicitTrustMetadataSchema = z.object({
  kind: z.literal('explicit'),
  confidence: z.number().min(0).max(1),
}).passthrough();

const PROTECTED_FORMAL_ENTITY_KINDS = new Set([
  'person',
  'edge',
  'oppRole',
  'opportunity',
  'bi',
  'ucv',
]);

/** Missing, malformed, inferred, or low-confidence metadata always fails closed. */
export function hasExplicitTrustMetadata(item: unknown): boolean {
  const parsed = ExplicitTrustMetadataSchema.safeParse(item);
  return parsed.success && parsed.data.confidence >= 0.6;
}

/** Protected formal records may only be asserted directly by an authenticated web user. */
export function canWriteFormal(ctx: CommandContext, entityKind: string): boolean {
  if (!PROTECTED_FORMAL_ENTITY_KINDS.has(entityKind)) return true;
  return isTrustedHumanAssertion(ctx);
}

/** MCP can only gain human trust from server-verified scope plus non-empty provenance. */
export function isTrustedHumanAssertion(ctx: CommandContext): boolean {
  if (ctx.assertionMode !== 'user_asserted') return false;
  if (ctx.channel === 'web') return true;
  return ctx.channel === 'mcp'
    && ctx.scopes?.includes('human_command') === true
    && Boolean(ctx.sourceRef?.trim())
    && Boolean(ctx.sourceExcerpt?.trim());
}

export function effectiveEvidenceStatus(ctx: CommandContext): 'approved' | 'pending_review' {
  return isTrustedHumanAssertion(ctx)
    ? 'approved'
    : 'pending_review';
}

type EvidenceOrigin = NonNullable<Extract<Action, { type: 'ADD_EVIDENCE' }>['evidence']['origin']>;

export function effectiveEvidenceOrigin(
  ctx: CommandContext,
  requestedOrigin?: EvidenceOrigin,
): EvidenceOrigin {
  if (effectiveEvidenceStatus(ctx) === 'approved') return 'manual';
  if (ctx.channel === 'mcp') return 'mcp';
  if (ctx.channel === 'worker') return 'worker';
  if (ctx.channel === 'system') return 'system';
  return requestedOrigin === 'voice' || requestedOrigin === 'recording'
    ? requestedOrigin
    : 'ai';
}

/** Server-owned evidence trust fields replace any caller-supplied values before persistence. */
export function normalizeActionTrust(ctx: CommandContext, action: Action): Action {
  if (action.type !== 'ADD_EVIDENCE') return action;
  // Web may replay/restore a server-produced machine Evidence. Preserve that lower-trust provenance;
  // caller input may lower trust, but can never promote machine content to approved/manual.
  const requestedMachineOrigin = action.evidence.origin && action.evidence.origin !== 'manual'
    ? action.evidence.origin
    : undefined;
  const preserveMachineProvenance = effectiveEvidenceStatus(ctx) === 'approved' && requestedMachineOrigin;
  return ActionSchema.parse({
    ...action,
    evidence: {
      ...action.evidence,
      status: preserveMachineProvenance ? 'pending_review' : effectiveEvidenceStatus(ctx),
      origin: preserveMachineProvenance
        ? requestedMachineOrigin
        : effectiveEvidenceOrigin(ctx, action.evidence.origin),
    },
  });
}
