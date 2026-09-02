import { createHash } from 'node:crypto';
import type { CapabilityPolicy } from '@jianghu/domain-contracts';
import { AgentJobError } from '../agents/errors.js';
import type { AgentRelationshipRadarCommitAdapter } from '../agents/model.js';
import { canonicalRelationshipRadarPayload } from './migration.js';
import { loadRelationshipRadarFacts } from './handler.js';
import { buildRelationshipRadarSnapshot } from './rules.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function fail(code: string): never {
  throw new AgentJobError(code, 409);
}

function snapshotId(tenantId: string, actorId: string, generationKey: string): string {
  return `rrs_${sha256(JSON.stringify([
    'relationship-radar-snapshot-v1', tenantId, actorId, generationKey,
  ])).slice(0, 32)}`;
}

function same(value: unknown, expected: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(expected);
}

export function createRelationshipRadarCommitAdapter(
  dependencies: { policy: CapabilityPolicy },
): AgentRelationshipRadarCommitAdapter {
  return async (context, input) => {
    if (context.definition.jobKey !== 'relationship_radar'
      || context.definition.jobVersion !== 'saas-212.v1'
      || context.definition.actionMode !== 'draft'
      || context.matterId === null
      || context.actorRole === 'viewer') {
      if (context.actorRole === 'viewer') throw new AgentJobError('viewer_write_denied', 403);
      fail('relationship_radar_commit_scope_invalid');
    }
    const generatedAt = new Date(input.generatedAt);
    if (!Number.isFinite(generatedAt.getTime())
      || generatedAt.toISOString() !== input.generatedAt
      || input.payload.generatedAtUtc !== input.generatedAt
      || input.payload.customerId !== context.customerId
      || input.payload.matterId !== context.matterId
      || !/^[a-f0-9]{64}$/.test(input.sourceSetHash)) {
      fail('relationship_radar_commit_payload_invalid');
    }

    const facts = await loadRelationshipRadarFacts(context.tx, {
      tenantId: context.tenantId,
      actorId: context.actorId,
      actorRole: context.actorRole,
    }, dependencies.policy, context.customerId, context.matterId, generatedAt);
    const current = buildRelationshipRadarSnapshot(facts);
    const payloadJson = canonicalRelationshipRadarPayload(input.payload);
    const currentPayloadJson = canonicalRelationshipRadarPayload(current.payload);
    if (input.sourceSetHash !== current.sourceSetHash
      || payloadJson !== currentPayloadJson
      || !same(current.outputRefs, [
        ...input.payload.signals.map((item) => ({
          kind: 'relationship_signal' as const, id: item.id, version: 1,
        })),
        ...input.payload.interventions.map((item) => ({
          kind: 'intervention_item' as const, id: item.id, version: 1,
        })),
        ...input.payload.drafts.map((item) => ({
          kind: 'draft_action' as const, id: item.id, version: 1,
        })),
      ])) {
      fail('relationship_radar_source_changed');
    }

    const generationKey = sha256(`agent-run:${context.runId}`);
    const id = snapshotId(context.tenantId, context.actorId, generationKey);
    const existing = await context.tx.relationshipRadarSnapshot.findFirst({
      where: { tenantId: context.tenantId, agentRunId: context.runId },
    });
    if (existing) {
      if (existing.id !== id
        || existing.createdByUserId !== context.actorId
        || existing.customerId !== context.customerId
        || existing.matterId !== context.matterId
        || existing.generationKey !== generationKey
        || existing.payloadJson !== payloadJson
        || existing.payloadFingerprint !== sha256(payloadJson)
        || existing.sourceSetHash !== input.sourceSetHash
        || existing.ruleVersion !== input.payload.ruleVersion
        || existing.generatedAt.toISOString() !== input.payload.generatedAtUtc
        || existing.expiresAt.toISOString() !== input.payload.expiresAtUtc
        || existing.version !== 1) {
        fail('relationship_radar_snapshot_conflict');
      }
      return current.outputRefs;
    }

    await context.tx.relationshipRadarSnapshot.create({ data: {
      id,
      tenantId: context.tenantId,
      customerId: context.customerId,
      matterId: context.matterId,
      createdByUserId: context.actorId,
      agentRunId: context.runId,
      generationKey,
      payloadJson,
      payloadFingerprint: sha256(payloadJson),
      sourceSetHash: input.sourceSetHash,
      signalCount: input.payload.signals.length,
      interventionCount: input.payload.interventions.length,
      draftCount: input.payload.drafts.length,
      ruleVersion: input.payload.ruleVersion,
      generatedAt,
      expiresAt: new Date(input.payload.expiresAtUtc),
    } });
    return current.outputRefs;
  };
}
