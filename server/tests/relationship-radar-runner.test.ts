import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { assembleProductAccess } from '@jianghu/domain-contracts';
import type { AgentRelationshipRadarCommitAdapter } from '../src/agents/model.js';
import { readableRelationshipRadar } from '../src/relationshipRadar/service.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

const jobKey = 'relationship_radar';
const jobVersion = 'saas-212.v1';
const policy = assembleProductAccess({ edition: 'internal' }).policy;

const auth = (token: string, key?: string) => ({
  authorization: `Bearer ${token}`,
  ...(key ? { 'idempotency-key': key } : {}),
});

describe('SAAS-212 relationship radar one-shot runner port', () => {
  let test: TestContext | null = null;
  afterEach(async () => test?.cleanup());

  async function setup(adapter?: AgentRelationshipRadarCommitAdapter) {
    test = await createTestContext(adapter ? { agentRelationshipRadarCommitAdapter: adapter } : {});
    await test.prisma.account.create({ data: {
      id: 'radar-runner-customer', tenantId: test.tenant.id, name: 'Sensitive customer',
      categoryKey: 'enterprise', primaryOwnerUserId: test.owner.id, version: 4,
    } });
    await test.prisma.opportunity.create({ data: {
      id: 'radar-runner-matter', tenantId: test.tenant.id, accountId: 'radar-runner-customer',
      name: 'Sensitive matter', kind: 'complex_sale', lifecycleStatus: 'active',
      customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
      primaryOwnerUserId: test.owner.id, version: 3,
    } });
    const control = await test.app.inject({
      method: 'PUT', url: `/api/agent-jobs/${jobKey}/control`,
      headers: auth(test.token, `radar-control-${randomUUID()}`),
      payload: { jobVersion, enabled: true, expectedVersion: 0 },
    });
    expect(control.statusCode, control.body).toBe(200);
    return {
      method: 'POST' as const,
      url: `/api/agent-jobs/${jobKey}/runs`,
      headers: auth(test.token, 'radar-runner-stable-key'),
      payload: {
        jobVersion,
        customerId: 'radar-runner-customer',
        matterId: 'radar-runner-matter',
        sourceArtifactId: null,
        inputRefs: [
          { kind: 'customer', id: 'radar-runner-customer', version: 4 },
          { kind: 'matter', id: 'radar-runner-matter', version: 3 },
        ],
      },
    };
  }

  it('persists one body-free immutable snapshot, replays exactly, and changes no formal CRM row', async () => {
    const request = await setup();
    const before = await Promise.all([
      test!.prisma.account.findMany(), test!.prisma.opportunity.findMany(),
      test!.prisma.person.findMany(), test!.prisma.edge.findMany(),
      test!.prisma.evidenceEvent.findMany(), test!.prisma.planAction.findMany(),
      test!.prisma.interaction.findMany(), test!.prisma.intelligenceItem.findMany(),
      test!.prisma.stakeholderFocus.findMany(),
    ]);
    const first = await test!.app.inject(request);
    const second = await test!.app.inject(request);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    const receipt = first.json<{ run: {
      id: string; status: string; outputRefs: Array<{ kind: string; id: string; version: number }>;
    }; replayed: boolean }>();
    expect(receipt).toMatchObject({ replayed: false, run: { status: 'succeeded' } });
    expect(second.json()).toMatchObject({ replayed: true, run: { id: receipt.run.id, status: 'succeeded' } });

    const snapshot = await test!.prisma.relationshipRadarSnapshot.findFirstOrThrow({
      where: { tenantId: test!.tenant.id, agentRunId: receipt.run.id },
    });
    const payload = JSON.parse(snapshot.payloadJson) as {
      signals: Array<{ id: string }>;
      interventions: Array<{ id: string }>;
      drafts: Array<{ id: string }>;
    };
    expect(payload.signals).toHaveLength(6);
    expect(payload.interventions).toHaveLength(2);
    expect(payload.drafts).toHaveLength(1);
    expect(receipt.run.outputRefs).toEqual([
      ...payload.signals.map((item) => ({ kind: 'relationship_signal', id: item.id, version: 1 })),
      ...payload.interventions.map((item) => ({ kind: 'intervention_item', id: item.id, version: 1 })),
      ...payload.drafts.map((item) => ({ kind: 'draft_action', id: item.id, version: 1 })),
    ]);
    expect(snapshot).toMatchObject({
      tenantId: test!.tenant.id,
      customerId: 'radar-runner-customer',
      matterId: 'radar-runner-matter',
      createdByUserId: test!.owner.id,
      signalCount: 6,
      interventionCount: 2,
      draftCount: 1,
      version: 1,
    });
    expect(snapshot.generationKey).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.payloadFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.sourceSetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.payloadJson).not.toContain('Sensitive customer');
    expect(snapshot.payloadJson).not.toContain('Sensitive matter');
    await expect(Promise.all([
      test!.prisma.account.findMany(), test!.prisma.opportunity.findMany(),
      test!.prisma.person.findMany(), test!.prisma.edge.findMany(),
      test!.prisma.evidenceEvent.findMany(), test!.prisma.planAction.findMany(),
      test!.prisma.interaction.findMany(), test!.prisma.intelligenceItem.findMany(),
      test!.prisma.stakeholderFocus.findMany(),
    ])).resolves.toEqual(before);
    await expect(test!.prisma.relationshipRadarSnapshot.count()).resolves.toBe(1);

    const readSideBefore = await Promise.all([
      test!.prisma.commandRun.count(), test!.prisma.agentRun.count(),
      test!.prisma.relationshipRadarSnapshot.count(), test!.prisma.auditEvent.count(),
      test!.prisma.account.count(), test!.prisma.opportunity.count(),
      test!.prisma.person.count(), test!.prisma.edge.count(),
      test!.prisma.evidenceEvent.count(), test!.prisma.planAction.count(),
      test!.prisma.interaction.count(), test!.prisma.intelligenceItem.count(),
      test!.prisma.stakeholderFocus.count(),
    ]);

    const current = await test!.app.inject({
      method: 'GET',
      url: '/api/relationship-radar?customerId=radar-runner-customer&matterId=radar-runner-matter',
      headers: auth(test!.token),
    });
    expect(current.statusCode, current.body).toBe(200);
    expect(current.json()).toMatchObject({
      status: 'ready', snapshot: { sourceState: 'current' },
      projection: { signals: expect.arrayContaining([]) },
    });
    const matterSource = payload.signals[0] as unknown as {
      sourceRefs: Array<{ entityKind: string; entityId: string; version: number; scheduleVersion: null }>;
    };
    const source = await test!.app.inject({
      method: 'POST', url: '/api/relationship-radar/source', headers: auth(test!.token),
      payload: {
        customerId: 'radar-runner-customer', matterId: 'radar-runner-matter',
        sourceRef: matterSource.sourceRefs[0],
      },
    });
    expect(source.statusCode, source.body).toBe(200);
    expect(source.json()).toMatchObject({ label: '当前事项', matterId: 'radar-runner-matter' });

    const today = await test!.app.inject({
      method: 'GET', url: '/api/today', headers: auth(test!.token),
    });
    expect(today.statusCode, today.body).toBe(200);
    const todayBody = today.json<{ sections: Array<{
      key: string;
      items: Array<{
        providerKey: string; reasonCode: string; context: { customerName: string; matterName: string | null };
        sourceRefs: Array<{ entityKind: string; entityId: string; version: number; scheduleVersion: number | null }>;
      }>;
    }> }>();
    expect(todayBody.sections.map((section) => section.key)).toEqual([
      'pending_confirmation', 'follow_up', 'completed',
    ]);
    const followUp = todayBody.sections[1]!.items;
    expect(followUp.map((item) => item.reasonCode)).toEqual([
      'matter_without_next_commitment', 'role_coverage.gap',
    ]);
    expect(followUp[1]).toMatchObject({
      providerKey: 'relationship_radar',
      context: { customerName: 'Sensitive customer', matterName: 'Sensitive matter' },
    });
    expect(followUp.some((item) => item.reasonCode === 'next_step_completeness.gap')).toBe(false);
    const todayRadarSource = await test!.app.inject({
      method: 'POST', url: '/api/today/source', headers: auth(test!.token),
      payload: {
        providerKey: 'relationship_radar',
        customerId: 'radar-runner-customer',
        matterId: 'radar-runner-matter',
        sourceRef: followUp[1]!.sourceRefs[0],
      },
    });
    expect(todayRadarSource.statusCode, todayRadarSource.body).toBe(200);
    expect(todayRadarSource.json()).toMatchObject({ label: '当前事项' });

    const admin = await test!.prisma.user.create({ data: {
      tenantId: test!.tenant.id, email: `radar-admin-${randomUUID()}@example.test`,
      passwordHash: 'unused', name: 'Admin', role: 'admin',
    } });
    const adminToken = test!.app.jwt.sign({
      userId: admin.id, tenantId: test!.tenant.id, role: 'admin',
    });
    const creatorIndependent = await test!.app.inject({
      method: 'GET',
      url: '/api/relationship-radar?customerId=radar-runner-customer&matterId=radar-runner-matter',
      headers: auth(adminToken),
    });
    expect(creatorIndependent.statusCode, creatorIndependent.body).toBe(200);
    expect(creatorIndependent.json()).toMatchObject({
      status: 'ready', snapshot: { id: snapshot.id, sourceState: 'current' },
    });
    await expect(Promise.all([
      test!.prisma.commandRun.count(), test!.prisma.agentRun.count(),
      test!.prisma.relationshipRadarSnapshot.count(), test!.prisma.auditEvent.count(),
      test!.prisma.account.count(), test!.prisma.opportunity.count(),
      test!.prisma.person.count(), test!.prisma.edge.count(),
      test!.prisma.evidenceEvent.count(), test!.prisma.planAction.count(),
      test!.prisma.interaction.count(), test!.prisma.intelligenceItem.count(),
      test!.prisma.stakeholderFocus.count(),
    ])).resolves.toEqual(readSideBefore);

    await test!.prisma.opportunity.update({
      where: { id: 'radar-runner-matter' }, data: { version: { increment: 1 } },
    });
    const changed = await test!.app.inject({
      method: 'GET',
      url: '/api/relationship-radar?customerId=radar-runner-customer&matterId=radar-runner-matter',
      headers: auth(test!.token),
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const changedBody = changed.json<{ projection: {
      signals: Array<{ status: string; severity: string }>;
      interventions: unknown[]; drafts: unknown[];
    } }>();
    expect(changedBody).toMatchObject({
      status: 'ready', snapshot: { sourceState: 'changed' },
      projection: { interventions: [], drafts: [] },
    });
    expect(changedBody.projection.signals).toHaveLength(6);
    expect(changedBody.projection.signals.every((item) => (
      item.status === 'unknown' && item.severity === 'low'
    ))).toBe(true);
    const staleSource = await test!.app.inject({
      method: 'POST', url: '/api/relationship-radar/source', headers: auth(test!.token),
      payload: {
        customerId: 'radar-runner-customer', matterId: 'radar-runner-matter',
        sourceRef: matterSource.sourceRefs[0],
      },
    });
    expect(staleSource.statusCode).toBe(409);
    expect(staleSource.json()).toMatchObject({ code: 'relationship_radar_source_changed' });
    const staleTodaySource = await test!.app.inject({
      method: 'POST', url: '/api/today/source', headers: auth(test!.token),
      payload: {
        providerKey: 'relationship_radar',
        customerId: 'radar-runner-customer', matterId: 'radar-runner-matter',
        sourceRef: matterSource.sourceRefs[0],
      },
    });
    expect(staleTodaySource.statusCode).toBe(404);
    expect(staleTodaySource.json()).toMatchObject({ code: 'relationship_radar_source_changed' });

    const expired = await readableRelationshipRadar(test!.prisma, {
      tenantId: test!.tenant.id, actorId: test!.owner.id, actorRole: 'owner',
    }, policy, {
      customerId: 'radar-runner-customer', matterId: 'radar-runner-matter',
    }, new Date(snapshot.expiresAt.getTime() + 1));
    expect(expired).toMatchObject({
      status: 'expired', snapshot: { id: snapshot.id },
    });
  });

  it('rejects viewer execution before command, run, snapshot, or audit writes', async () => {
    const request = await setup();
    const viewer = await test!.prisma.user.create({ data: {
      tenantId: test!.tenant.id, email: `radar-viewer-${randomUUID()}@example.test`,
      passwordHash: 'unused', name: 'Viewer', role: 'viewer',
    } });
    await test!.prisma.account.update({
      where: { id: 'radar-runner-customer' }, data: { primaryOwnerUserId: viewer.id },
    });
    const token = test!.app.jwt.sign({ userId: viewer.id, tenantId: test!.tenant.id, role: 'viewer' });
    const before = await Promise.all([
      test!.prisma.commandRun.count(), test!.prisma.agentRun.count(),
      test!.prisma.relationshipRadarSnapshot.count(), test!.prisma.auditEvent.count(),
    ]);
    const response = await test!.app.inject({
      ...request,
      headers: auth(token, 'radar-viewer-run'),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'viewer_write_denied' });
    await expect(Promise.all([
      test!.prisma.commandRun.count(), test!.prisma.agentRun.count(),
      test!.prisma.relationshipRadarSnapshot.count(), test!.prisma.auditEvent.count(),
    ])).resolves.toEqual(before);
  });

  it('rolls back the transaction when the narrow adapter returns mismatched outputs', async () => {
    const request = await setup(async () => []);
    const response = await test!.app.inject(request);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      run: { status: 'failed', failureCode: 'agent_relationship_radar_output_mismatch' },
    });
    await expect(test!.prisma.relationshipRadarSnapshot.count()).resolves.toBe(0);
  });
});
