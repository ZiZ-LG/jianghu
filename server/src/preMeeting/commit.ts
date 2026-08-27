import type { CapabilityPolicy } from '@jianghu/domain-contracts';
import { AgentJobError } from '../agents/errors.js';
import type { AgentResearchBriefCommitAdapter } from '../agents/model.js';
import {
  commitResearchBriefSnapshot,
  ResearchBriefError,
} from '../researchBriefs/service.js';

interface Dependencies {
  policy: CapabilityPolicy;
}

function fail(code: string): never {
  throw new AgentJobError(code, 409);
}

export function createPreMeetingResearchBriefCommitAdapter(
  dependencies: Dependencies,
): AgentResearchBriefCommitAdapter {
  return async (context, input) => {
    if (context.definition.jobKey !== 'pre_meeting_brief'
      || context.definition.jobVersion !== 'core-206.v1'
      || context.definition.actionMode !== 'read_only'
      || !context.sourceArtifactId
      || !context.sourceFingerprint
      || context.sourceAclVersion === null) {
      fail('pre_meeting_commit_scope_invalid');
    }
    if (context.actorRole === 'viewer') throw new AgentJobError('viewer_write_denied', 403);
    const generatedAt = new Date(input.generatedAt);
    if (!Number.isFinite(generatedAt.getTime()) || generatedAt.toISOString() !== input.generatedAt) {
      fail('pre_meeting_commit_payload_invalid');
    }
    try {
      const result = await commitResearchBriefSnapshot(context.tx, {
        tenantId: context.tenantId,
        actorId: context.actorId,
        actorRole: context.actorRole,
        customerId: context.customerId,
        matterId: context.matterId,
        generationKey: `agent-run:${context.runId}`,
        generatedAt,
        payload: input.payload,
      }, dependencies.policy);
      return { kind: 'research_brief', id: result.id, version: result.version };
    } catch (error) {
      if (error instanceof ResearchBriefError) {
        throw new AgentJobError(error.code, error.statusCode);
      }
      throw error;
    }
  };
}
