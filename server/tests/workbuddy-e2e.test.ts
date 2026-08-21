import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SyncIntelBundleArgsSchema, type SyncIntelBundleArgs } from '../src/mcp/syncBundle.js';
import type { SyncReceipt } from '../src/mcp/syncReceipt.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

type SyncBundle = SyncIntelBundleArgs['bundle'];
type PhaseAArgs = SyncIntelBundleArgs & {
  bundle: SyncBundle & Required<Pick<SyncBundle, 'opportunity' | 'visit'>>;
};

type Fixture = {
  phaseA: PhaseAArgs;
  phaseB: {
    idempotencyKey: string;
    evidence: Omit<SyncIntelBundleArgs['bundle']['evidences'][number], 'personId'>;
  };
  review: {
    personOverrides: Record<string, { name: string; title: string }>;
    relationOverride: { layer: 'L1' | 'L2' | 'L3' | 'L4'; label: string };
  };
  actionFeedback: {
    idempotencyKey: string; actionId: string; title: string;
    outcome: 'up' | 'flat' | 'down'; occurredAt: string;
  };
};

function parsePhaseA(input: unknown): PhaseAArgs {
  const parsed = SyncIntelBundleArgsSchema.parse(input);
  if (!parsed.bundle.opportunity || !parsed.bundle.visit) {
    throw new Error('INT-304 Phase A fixture requires opportunity and visit');
  }
  return parsed as PhaseAArgs;
}

const auth = (token: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  ...extra,
});

async function callMcp(context: TestContext, token: string, id: number, args: SyncIntelBundleArgs) {
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/mcp',
    headers: auth(token),
    payload: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'sync_intel_bundle', arguments: args } },
  });
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json<{ result: { content: Array<{ text: string }>; isError?: boolean } }>();
  expect(body.result.isError, body.result.content[0]?.text).not.toBe(true);
  return JSON.parse(body.result.content[0]!.text) as SyncReceipt;
}

async function journeyCounts(context: TestContext) {
  const tenantId = context.tenant.id;
  const [accounts, opportunities, visits, people, relations, evidences, syncRuns, pendingPeople, pendingRelations, pendingEvidence] = await Promise.all([
    context.prisma.account.count({ where: { tenantId } }),
    context.prisma.opportunity.count({ where: { tenantId } }),
    context.prisma.visitNote.count({ where: { tenantId } }),
    context.prisma.personSuggestion.count({ where: { tenantId } }),
    context.prisma.relSuggestion.count({ where: { tenantId } }),
    context.prisma.evidenceEvent.count({ where: { tenantId } }),
    context.prisma.syncRun.count({ where: { tenantId } }),
    context.prisma.personSuggestion.count({ where: { tenantId, status: 'pending' } }),
    context.prisma.relSuggestion.count({ where: { tenantId, status: 'pending' } }),
    context.prisma.evidenceEvent.count({ where: { tenantId, status: 'pending_review' } }),
  ]);
  return { accounts, opportunities, visits, people, relations, evidences, syncRuns, pendingPeople, pendingRelations, pendingEvidence };
}

async function pwin(context: TestContext, opportunityId: string) {
  const response = await context.app.inject({
    method: 'GET', url: `/api/pde/${opportunityId}/ev`, headers: auth(context.token),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ pwin: number }>().pwin;
}

describe('INT-304 WorkBuddy to decision-loop HTTP journey', () => {
  let context: TestContext;
  let fixture: Fixture;

  beforeEach(async () => {
    context = await createTestContext();
    const raw = JSON.parse(await readFile(new URL('./fixtures/workbuddy-sync-bundle.json', import.meta.url), 'utf8')) as
      Omit<Fixture, 'phaseA'> & { phaseA: unknown };
    fixture = { ...raw, phaseA: parsePhaseA(raw.phaseA) };
  });

  afterEach(async () => context.cleanup());

  it('syncs candidates, requires human review, updates PDE, and replays action feedback without duplicates', async () => {
    const tokenResponse = await context.app.inject({
      method: 'POST', url: '/api/access-tokens', headers: auth(context.token),
      payload: { name: 'INT-304 fictional WorkBuddy', preset: 'workbuddy_sync' },
    });
    expect(tokenResponse.statusCode, tokenResponse.body).toBe(200);
    const accessToken = tokenResponse.json<{ token: string; preset: string; scopes: string[] }>();
    expect(accessToken).toMatchObject({
      preset: 'workbuddy_sync',
      scopes: ['read', 'sync_business', 'propose_people', 'propose_relations', 'submit_evidence'],
    });

    const firstA = await callMcp(context, accessToken.token, 1, fixture.phaseA);
    expect(firstA).toMatchObject({ replayed: false, updated: [], failed: [] });
    expect(firstA.created).toEqual(expect.arrayContaining([
      `account:${fixture.phaseA.bundle.account.externalRef}`,
      `opportunity:${fixture.phaseA.bundle.opportunity.externalRef}`,
      `visit:${fixture.phaseA.bundle.visit.externalRef}`,
    ]));
    expect(firstA.proposed).toEqual(expect.arrayContaining([
      ...fixture.phaseA.bundle.people.map((person) => `person:${person.ref}`),
      ...fixture.phaseA.bundle.relations.map((relation) => `relationship:${relation.ref}`),
    ]));
    expect(firstA.skipped.every((item) => item.ref.startsWith('job:') && item.reason === 'queue unavailable')).toBe(true);

    const beforeReplayA = await journeyCounts(context);
    const replayA = await callMcp(context, accessToken.token, 2, fixture.phaseA);
    expect(replayA).toEqual({ ...firstA, replayed: true });
    expect(await journeyCounts(context)).toEqual(beforeReplayA);

    const [account, opportunity, candidates, relationCandidate, syncRunA] = await Promise.all([
      context.prisma.account.findFirstOrThrow({ where: { tenantId: context.tenant.id, externalRef: fixture.phaseA.bundle.account.externalRef } }),
      context.prisma.opportunity.findFirstOrThrow({ where: { tenantId: context.tenant.id, externalRef: fixture.phaseA.bundle.opportunity.externalRef } }),
      context.prisma.personSuggestion.findMany({ where: { tenantId: context.tenant.id }, orderBy: { name: 'asc' } }),
      context.prisma.relSuggestion.findFirstOrThrow({ where: { tenantId: context.tenant.id } }),
      context.prisma.syncRun.findUniqueOrThrow({ where: { id: firstA.syncRunId } }),
    ]);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.status === 'pending' && candidate.resolvedPersonId === null)).toBe(true);
    expect(relationCandidate).toMatchObject({ status: 'pending', sourceKind: 'suggestion', targetKind: 'suggestion' });
    expect(await context.prisma.person.count({ where: { tenantId: context.tenant.id, accountId: account.id } })).toBe(0);
    expect(await context.prisma.edge.count({ where: { tenantId: context.tenant.id, accountId: account.id } })).toBe(0);

    const storedPhaseA = JSON.stringify({ key: syncRunA.idempotencyKey, hash: syncRunA.requestHash, receipt: syncRunA.receipt });
    expect(syncRunA).toMatchObject({
      status: 'completed',
      idempotencyKey: createHash('sha256').update(fixture.phaseA.idempotencyKey).digest('hex'),
    });
    expect(syncRunA.idempotencyKey).not.toBe(fixture.phaseA.idempotencyKey);
    const { replayed: _transportReplayFlag, ...storedFirstA } = firstA;
    const storedReceiptA = JSON.parse(syncRunA.receipt) as Record<string, unknown>;
    expect(storedReceiptA).toEqual(storedFirstA);
    expect(storedReceiptA).not.toHaveProperty('replayed');
    for (const sensitive of [
      accessToken.token,
      fixture.phaseA.bundle.account.name,
      fixture.phaseA.bundle.visit.summary,
      ...fixture.phaseA.bundle.people.map((person) => person.name),
    ]) expect(storedPhaseA).not.toContain(sensitive);

    const candidateByName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
    const personItems = fixture.phaseA.bundle.people.map((person) => ({
      kind: 'person', id: candidateByName.get(person.name)!.id, decision: 'accept',
      personOverride: fixture.review.personOverrides[person.ref],
    }));
    const reviewResponse = await context.app.inject({
      method: 'POST', url: '/api/commands/inbox-batch',
      headers: auth(context.token, { 'idempotency-key': 'wb-e2e-human-review-304' }),
      payload: { items: [...personItems, {
        kind: 'rel', id: relationCandidate.id, decision: 'accept', relOverride: fixture.review.relationOverride,
      }] },
    });
    expect(reviewResponse.statusCode, reviewResponse.body).toBe(200);
    expect(reviewResponse.json()).toMatchObject({ replayed: false, items: expect.arrayContaining([
      { kind: 'rel', id: relationCandidate.id, status: 'ok' },
    ]) });

    const acceptedCandidates = await context.prisma.personSuggestion.findMany({ where: { tenantId: context.tenant.id } });
    expect(acceptedCandidates.every((candidate) => candidate.status === 'accepted' && candidate.resolvedPersonId)).toBe(true);
    const acceptedPeople = await context.prisma.person.findMany({ where: { tenantId: context.tenant.id, accountId: account.id } });
    expect(acceptedPeople.map((person) => ({ name: person.name, title: person.title }))).toEqual(expect.arrayContaining(
      Object.values(fixture.review.personOverrides),
    ));
    const acceptedRelation = await context.prisma.relSuggestion.findUniqueOrThrow({ where: { id: relationCandidate.id } });
    expect(acceptedRelation).toMatchObject({ status: 'accepted', sourceKind: 'person', targetKind: 'person', ...fixture.review.relationOverride });
    expect(await context.prisma.edge.findFirstOrThrow({ where: { tenantId: context.tenant.id, accountId: account.id } }))
      .toMatchObject({ opportunityId: opportunity.id, ...fixture.review.relationOverride });

    const evidencePerson = acceptedPeople.find((person) => person.name === fixture.review.personOverrides['fictional-person-a-304']!.name)!;
    const roleResponse = await context.app.inject({
      method: 'POST', url: '/api/mutate', headers: auth(context.token),
      payload: { action: {
        type: 'SET_ROLE', accId: account.id, oppId: opportunity.id, personId: evidencePerson.id,
        patch: { role: 'D', sentiment: 'neutral', confidence: '明确' },
      } },
    });
    expect(roleResponse.statusCode, roleResponse.body).toBe(200);
    const beforeEvidence = await pwin(context, opportunity.id);

    const phaseB = {
      idempotencyKey: fixture.phaseB.idempotencyKey,
      bundle: {
        account: fixture.phaseA.bundle.account,
        opportunity: fixture.phaseA.bundle.opportunity,
        people: [], relations: [],
        evidences: [{ ...fixture.phaseB.evidence, personId: evidencePerson.id }],
      },
    };
    const firstB = await callMcp(context, accessToken.token, 3, phaseB);
    expect(firstB).toMatchObject({ replayed: false, failed: [] });
    expect(firstB.proposed).toContain(`evidence:${fixture.phaseB.evidence.ref}`);
    const evidence = await context.prisma.evidenceEvent.findFirstOrThrow({
      where: { tenantId: context.tenant.id, opportunityId: opportunity.id, rawContent: fixture.phaseB.evidence.rawContent },
    });
    expect(evidence).toMatchObject({ personId: evidencePerson.id, status: 'pending_review', origin: 'mcp' });
    expect(await pwin(context, opportunity.id)).toBeCloseTo(beforeEvidence, 9);

    const beforeReplayB = await journeyCounts(context);
    const replayB = await callMcp(context, accessToken.token, 4, phaseB);
    expect(replayB).toEqual({ ...firstB, replayed: true });
    expect(await journeyCounts(context)).toEqual(beforeReplayB);

    const foreignTenant = await context.prisma.tenant.create({ data: { id: 'tenant-fictional-304', name: '虚构隔离租户' } });
    const foreignUser = await context.prisma.user.create({ data: {
      tenantId: foreignTenant.id, email: 'foreign-int-304@example.test', passwordHash: 'unused', name: 'Foreign', role: 'owner',
    } });
    const foreignToken = context.app.jwt.sign({ userId: foreignUser.id, tenantId: foreignTenant.id, role: 'owner' });
    const hiddenReview = await context.app.inject({
      method: 'POST', url: `/api/evidence/${evidence.id}/review`, headers: auth(foreignToken), payload: { action: 'approve' },
    });
    expect(hiddenReview.statusCode).toBe(404);
    expect(await context.prisma.evidenceEvent.findUniqueOrThrow({ where: { id: evidence.id } })).toMatchObject({ status: 'pending_review' });

    const approval = await context.app.inject({
      method: 'POST', url: `/api/evidence/${evidence.id}/review`, headers: auth(context.token), payload: { action: 'approve' },
    });
    expect(approval.statusCode, approval.body).toBe(200);
    expect(await pwin(context, opportunity.id)).toBeGreaterThan(beforeEvidence);
    const snapshot = await context.prisma.eVSnapshot.findFirstOrThrow({
      where: { tenantId: context.tenant.id, opportunityId: opportunity.id, trigger: 'evidence_review' },
    });
    const snapshotInputs = JSON.parse(snapshot.inputsJson) as any;
    expect(snapshotInputs.evidence.ids).toContain(evidence.id);
    expect(snapshotInputs.evidence.alphaByStakeholder[evidencePerson.id]).toEqual([2, 0, 0]);

    const planResponse = await context.app.inject({
      method: 'POST', url: '/api/mutate', headers: auth(context.token), payload: { action: {
        type: 'ADD_PLAN_ACTION', accId: account.id, oppId: opportunity.id,
        planAction: {
          id: fixture.actionFeedback.actionId, personId: evidencePerson.id, title: fixture.actionFeedback.title,
          startDate: fixture.actionFeedback.occurredAt, endDate: fixture.actionFeedback.occurredAt,
          half: 'am', done: false, origin: 'workbuddy',
        },
      } },
    });
    expect(planResponse.statusCode, planResponse.body).toBe(200);
    const feedbackPayload = {
      accountId: account.id, opportunityId: opportunity.id, actionId: fixture.actionFeedback.actionId,
      outcome: fixture.actionFeedback.outcome, occurredAt: fixture.actionFeedback.occurredAt,
      baseVersion: 0, expectedScheduleVersion: 0,
    };
    const beforeDeniedFeedback = {
      evidence: await context.prisma.evidenceEvent.count({ where: { tenantId: context.tenant.id } }),
      commands: await context.prisma.commandRun.count({ where: { tenantId: context.tenant.id, kind: 'action-feedback' } }),
      audits: await context.prisma.auditEvent.count({ where: { tenantId: context.tenant.id, action: 'action_feedback' } }),
    };
    const workbuddyDenied = await context.app.inject({
      method: 'POST', url: '/api/commands/action-feedback',
      headers: auth(accessToken.token, { 'idempotency-key': 'wb-token-action-denied-304' }), payload: feedbackPayload,
    });
    expect(workbuddyDenied.statusCode).toBe(401);
    const viewer = await context.prisma.user.create({ data: {
      tenantId: context.tenant.id, email: 'viewer-int-304@example.test', passwordHash: 'unused', name: 'Viewer', role: 'viewer',
    } });
    const viewerToken = context.app.jwt.sign({ userId: viewer.id, tenantId: context.tenant.id, role: 'viewer' });
    const viewerDenied = await context.app.inject({
      method: 'POST', url: '/api/commands/action-feedback',
      headers: auth(viewerToken, { 'idempotency-key': 'viewer-action-denied-304' }), payload: feedbackPayload,
    });
    expect(viewerDenied.statusCode).toBe(403);
    expect(await context.prisma.planAction.findUniqueOrThrow({ where: { id: fixture.actionFeedback.actionId } }))
      .toMatchObject({ done: false, doneAt: null });
    expect({
      evidence: await context.prisma.evidenceEvent.count({ where: { tenantId: context.tenant.id } }),
      commands: await context.prisma.commandRun.count({ where: { tenantId: context.tenant.id, kind: 'action-feedback' } }),
      audits: await context.prisma.auditEvent.count({ where: { tenantId: context.tenant.id, action: 'action_feedback' } }),
    }).toEqual(beforeDeniedFeedback);

    const feedbackHeaders = auth(context.token, { 'idempotency-key': fixture.actionFeedback.idempotencyKey });
    const firstFeedback = await context.app.inject({
      method: 'POST', url: '/api/commands/action-feedback', headers: feedbackHeaders, payload: feedbackPayload,
    });
    const replayFeedback = await context.app.inject({
      method: 'POST', url: '/api/commands/action-feedback', headers: feedbackHeaders, payload: feedbackPayload,
    });
    expect(firstFeedback.statusCode, firstFeedback.body).toBe(200);
    expect(firstFeedback.json()).toMatchObject({ replayed: false, evidenceId: expect.any(String) });
    expect(replayFeedback.statusCode, replayFeedback.body).toBe(200);
    expect(replayFeedback.json()).toEqual({ ...firstFeedback.json(), replayed: true });
    expect(await context.prisma.planAction.findUniqueOrThrow({ where: { id: fixture.actionFeedback.actionId } }))
      .toMatchObject({ tenantId: context.tenant.id, done: true, doneAt: fixture.actionFeedback.occurredAt });
    expect(await context.prisma.evidenceEvent.count({ where: {
      tenantId: context.tenant.id, id: firstFeedback.json().evidenceId,
    } })).toBe(1);

    const commandRuns = await context.prisma.commandRun.findMany({ where: {
      tenantId: context.tenant.id, kind: 'action-feedback',
    } });
    expect(commandRuns).toHaveLength(1);
    expect(commandRuns[0]).toMatchObject({
      actorId: context.owner.id, status: 'completed',
    });
    expect(JSON.parse(commandRuns[0]!.resultSummary)).toEqual({ evidenceId: firstFeedback.json().evidenceId });
    const auditRows = await context.prisma.auditEvent.findMany({ where: {
      tenantId: context.tenant.id,
      action: 'action_feedback',
      entityKind: 'commitment',
      entityId: fixture.actionFeedback.actionId,
    } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actorId: context.owner.id,
      channel: 'web',
      action: 'action_feedback',
      entityKind: 'commitment',
      entityId: fixture.actionFeedback.actionId,
      requestId: expect.any(String),
      sourceRef: firstFeedback.json().evidenceId,
      changedFields: JSON.stringify(['executionStatus', 'version', 'done', 'doneAt', 'evidenceId']),
      metadata: JSON.stringify({
        fromVersion: 0,
        toVersion: 1,
        scheduleVersion: 0,
        evidenceId: firstFeedback.json().evidenceId,
      }),
    });
    const auditTrail = JSON.stringify({ commandRuns, auditRows });
    expect(auditTrail).not.toContain(fixture.phaseA.bundle.visit.summary);
    expect(auditTrail).not.toContain(fixture.phaseB.evidence.rawContent);
    expect(auditTrail).not.toContain(fixture.actionFeedback.title);
    for (const person of Object.values(fixture.review.personOverrides)) {
      expect(auditTrail).not.toContain(person.name);
      expect(auditTrail).not.toContain(person.title);
    }
    expect(auditTrail).not.toContain(accessToken.token);
  });
});
