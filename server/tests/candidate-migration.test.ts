import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalCandidateJson,
  inspectCandidateMigration,
  projectCandidateMigrationForTenant,
} from '../src/candidates/migration.js';

const serverRoot = resolve('.');
const prismaBin = resolve('node_modules/.bin/prisma');
const tsxBin = resolve('node_modules/.bin/tsx');
const tenantA = 'candidate-tenant-a';
const tenantB = 'candidate-tenant-b';

let directory = '';
let databaseUrl = '';
let prisma: PrismaClient;

function run(command: string, args: string[]) {
  return spawnSync(command, args, {
    cwd: serverRoot,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

async function snapshotBusinessState() {
  const [personSuggestions, relSuggestions, changeProposals, reminders, evidences, candidates, persons, edges] = await Promise.all([
    prisma.personSuggestion.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true } }),
    prisma.relSuggestion.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true } }),
    prisma.changeProposal.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true } }),
    prisma.reminder.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true } }),
    prisma.evidenceEvent.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true } }),
    prisma.candidate.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true } }),
    prisma.person.findMany({ orderBy: { id: 'asc' }, select: { id: true, version: true } }),
    prisma.edge.findMany({ orderBy: { id: 'asc' }, select: { id: true } }),
  ]);
  return { personSuggestions, relSuggestions, changeProposals, reminders, evidences, candidates, persons, edges };
}

beforeAll(async () => {
  directory = await mkdtemp(resolve('prisma/.candidate-migration-test-'));
  const relativeDirectory = basename(directory);
  const databasePath = join(directory, 'candidate.db');
  databaseUrl = `file:./${relativeDirectory}/candidate.db`;
  await writeFile(databasePath, '');
  const pushed = run(prismaBin, ['db', 'push', '--schema', 'prisma/schema.prisma', '--skip-generate']);
  if (pushed.status !== 0) throw new Error(`${pushed.stdout}\n${pushed.stderr}`);

  prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  await prisma.tenant.createMany({ data: [
    { id: tenantA, name: 'Candidate Tenant A' },
    { id: tenantB, name: 'Candidate Tenant B' },
  ] });
  await prisma.user.createMany({ data: [
    { id: 'candidate-user-a', tenantId: tenantA, email: 'candidate-a@example.test', passwordHash: 'unused', name: 'Owner A', role: 'owner' },
    { id: 'candidate-user-b', tenantId: tenantB, email: 'candidate-b@example.test', passwordHash: 'unused', name: 'Owner B', role: 'owner' },
  ] });
  await prisma.account.createMany({ data: [
    { id: 'candidate-account-a', tenantId: tenantA, name: 'Account A', customerType: 1 },
    { id: 'candidate-account-b', tenantId: tenantB, name: 'Account B', customerType: 1 },
  ] });
  await prisma.opportunity.createMany({ data: [
    {
      id: 'candidate-matter-a', tenantId: tenantA, accountId: 'candidate-account-a', name: 'Matter A',
      customerType: 1, pipelineStage: 'qualify', engageStage: 'discover',
    },
    {
      id: 'candidate-matter-b', tenantId: tenantB, accountId: 'candidate-account-b', name: 'Matter B',
      customerType: 1, pipelineStage: 'qualify', engageStage: 'discover',
    },
  ] });
  await prisma.person.createMany({ data: [
    { id: 'candidate-person-a1', tenantId: tenantA, accountId: 'candidate-account-a', name: 'A One', title: 'Sponsor' },
    { id: 'candidate-person-a2', tenantId: tenantA, accountId: 'candidate-account-a', name: 'A Two', title: 'User' },
    { id: 'candidate-person-b1', tenantId: tenantB, accountId: 'candidate-account-b', name: 'B One', title: 'Owner' },
  ] });

  await prisma.personSuggestion.createMany({ data: [
    {
      id: 'ps-a-pending', tenantId: tenantA, accountId: 'candidate-account-a', opportunityId: 'candidate-matter-a',
      name: 'Pending Person', title: 'Architect', orgLevel: 2, origin: 'mcp', evidence: 'SECRET_PERSON_EVIDENCE_A',
      sourceUrl: 'https://source.example/person', confidence: 0.91, status: 'pending', proposedBy: 'candidate-user-a',
      suggestedRole: 'D', suggestedSentiment: 'plus',
    },
    {
      id: 'ps-a-accepted', tenantId: tenantA, accountId: 'candidate-account-a', opportunityId: 'candidate-matter-a',
      name: 'Accepted Person', origin: 'qcc', evidence: 'SECRET_PERSON_EVIDENCE_B', confidence: 0.72,
      status: 'accepted', proposedBy: '', resolvedPersonId: 'candidate-person-a2',
    },
    {
      id: 'ps-a-rejected-cross-creator', tenantId: tenantA, accountId: 'candidate-account-a',
      name: 'Rejected Person', origin: 'ai', evidence: 'SECRET_PERSON_EVIDENCE_C', confidence: 0.33,
      status: 'rejected', proposedBy: 'candidate-user-b',
    },
    {
      id: 'ps-a-invalid-account', tenantId: tenantA, accountId: 'candidate-account-b',
      name: 'Cross Tenant Person', origin: 'mcp', evidence: 'SECRET_PERSON_EVIDENCE_INVALID', status: 'pending',
    },
    {
      id: 'ps-b-pending', tenantId: tenantB, accountId: 'candidate-account-b', opportunityId: 'candidate-matter-b',
      name: 'Tenant B Person', origin: 'mcp', evidence: 'SECRET_PERSON_EVIDENCE_TENANT_B',
      status: 'pending', proposedBy: 'candidate-user-b',
    },
  ] });

  await prisma.relSuggestion.createMany({ data: [
    {
      id: 'rs-a-pending', tenantId: tenantA, opportunityId: 'candidate-matter-a',
      sourcePersonId: 'candidate-person-a1', targetPersonId: 'candidate-person-a2',
      sourceKind: 'person', targetKind: 'person', layer: 'L2', label: 'influences', confidence: 0.88,
      origin: 'graph', evidence: 'SECRET_REL_EVIDENCE_A', status: 'pending',
    },
    {
      id: 'rs-a-accepted', tenantId: tenantA, opportunityId: 'candidate-matter-a',
      sourcePersonId: 'ps-a-pending', targetPersonId: 'candidate-person-a2',
      sourceKind: 'suggestion', targetKind: 'person', layer: 'L3', label: 'reports_to', confidence: 0.67,
      origin: 'llm', evidence: 'SECRET_REL_EVIDENCE_B', status: 'accepted',
    },
    {
      id: 'rs-a-rejected', tenantId: tenantA, opportunityId: 'candidate-matter-a',
      sourcePersonId: 'candidate-person-a2', targetPersonId: 'candidate-person-a1',
      sourceKind: 'person', targetKind: 'person', layer: 'L1', label: 'knows', confidence: 0.4,
      origin: 'qcc', evidence: 'SECRET_REL_EVIDENCE_C', status: 'rejected',
    },
    {
      id: 'rs-a-invalid-endpoint', tenantId: tenantA, opportunityId: 'candidate-matter-a',
      sourcePersonId: 'candidate-person-a1', targetPersonId: 'candidate-person-b1',
      sourceKind: 'person', targetKind: 'person', layer: 'L4', label: 'unknown', confidence: 0.2,
      origin: 'llm', evidence: 'SECRET_REL_EVIDENCE_INVALID', status: 'pending',
    },
  ] });

  await prisma.changeProposal.createMany({ data: [
    {
      id: 'cp-a-pending', tenantId: tenantA, accountId: 'candidate-account-a', opportunityId: 'candidate-matter-a',
      entityKind: 'oppRole', entityId: 'candidate-person-a1', field: 'sentiment', oldValue: 'neutral', newValue: 'plus',
      origin: 'voice', evidence: 'SECRET_CHANGE_EVIDENCE_A', confidence: 0.82, status: 'pending',
      dedupeKey: 'cp-a-pending-key', proposedBy: 'candidate-user-a',
    },
    {
      id: 'cp-a-accepted', tenantId: tenantA, accountId: 'candidate-account-a',
      entityKind: 'person', entityId: 'candidate-person-a2', field: 'title', oldValue: 'User', newValue: 'Champion',
      origin: 'ai', evidence: 'SECRET_CHANGE_EVIDENCE_B', confidence: 0.74, status: 'accepted',
      proposedBy: 'candidate-user-b',
    },
    {
      id: 'cp-a-rejected', tenantId: tenantA, accountId: 'candidate-account-a', opportunityId: 'candidate-matter-a',
      entityKind: 'opportunity', entityId: 'candidate-matter-a', field: 'pipelineStage', oldValue: 'qualify', newValue: 'close',
      origin: 'engine', evidence: 'SECRET_CHANGE_EVIDENCE_C', confidence: 0.45, status: 'rejected', proposedBy: '',
    },
    {
      id: 'cp-a-invalid-account', tenantId: tenantA, accountId: 'candidate-account-b', opportunityId: 'candidate-matter-b',
      entityKind: 'person', entityId: 'candidate-person-b1', field: 'title', newValue: 'Invalid',
      origin: 'voice', evidence: 'SECRET_CHANGE_EVIDENCE_INVALID', confidence: 0.5, status: 'pending',
    },
  ] });

  await prisma.reminder.createMany({ data: [
    {
      id: 'rem-a-pending', tenantId: tenantA, accountId: 'candidate-account-a', accountName: 'Account A',
      opportunityId: 'candidate-matter-a', oppName: 'Matter A', kind: 'stalled', title: 'Follow up',
      detail: 'SECRET_REMINDER_DETAIL_A', severity: 'warn', dedupeKey: 'shared-reminder-key', status: 'pending',
    },
    {
      id: 'rem-a-done', tenantId: tenantA, accountId: 'candidate-account-a', accountName: 'Account A',
      opportunityId: 'candidate-matter-a', oppName: 'Matter A', kind: 'no_decider', title: 'Find decider',
      detail: 'SECRET_REMINDER_DETAIL_B', severity: 'warn', dedupeKey: 'reminder-done', status: 'done',
    },
    {
      id: 'rem-a-dismissed', tenantId: tenantA, accountId: 'candidate-account-a', accountName: 'Account A',
      kind: 'sentiment_recheck', title: 'Review sentiment', detail: 'SECRET_REMINDER_DETAIL_C', severity: 'info',
      entityId: 'candidate-person-a2', dedupeKey: 'reminder-dismissed', status: 'dismissed',
    },
    {
      id: 'rem-a-invalid-entity', tenantId: tenantA, accountId: 'candidate-account-a', accountName: 'Account A',
      opportunityId: 'candidate-matter-a', oppName: 'Matter A', kind: 'sentiment_recheck', title: 'Invalid entity',
      detail: 'SECRET_REMINDER_DETAIL_INVALID', severity: 'warn', entityId: 'candidate-person-b1',
      dedupeKey: 'reminder-invalid', status: 'pending',
    },
  ] });

  await prisma.evidenceEvent.createMany({ data: [
    {
      id: 'ev-a-pending', tenantId: tenantA, accountId: 'candidate-account-a', opportunityId: 'candidate-matter-a',
      personId: 'candidate-person-a1', signalKey: 'intro_referral', direction: 1, tier: 'strong',
      rawContent: 'SECRET_EVIDENCE_RAW_A', occurredAt: '2026-08-24', status: 'pending_review', origin: 'voice',
      createdBy: 'candidate-user-a',
    },
    {
      id: 'ev-a-pending-cross-creator', tenantId: tenantA, accountId: 'candidate-account-a', opportunityId: 'candidate-matter-a',
      personId: 'candidate-person-a2', signalKey: 'spec_alignment', direction: -1, tier: 'mid',
      rawContent: 'SECRET_EVIDENCE_RAW_B', occurredAt: '2026-08-23', status: 'pending_review', origin: 'recording',
      createdBy: 'candidate-user-b',
    },
    {
      id: 'ev-a-invalid-person', tenantId: tenantA, accountId: 'candidate-account-a', opportunityId: 'candidate-matter-a',
      personId: 'candidate-person-b1', signalKey: 'risk', direction: -1, tier: 'weak',
      rawContent: 'SECRET_EVIDENCE_RAW_INVALID', occurredAt: '2026-08-22', status: 'pending_review', origin: 'voice',
    },
    {
      id: 'ev-a-approved-not-a-candidate', tenantId: tenantA, accountId: 'candidate-account-a', opportunityId: 'candidate-matter-a',
      personId: 'candidate-person-a1', signalKey: 'approved', direction: 1, tier: 'mid',
      rawContent: 'SECRET_APPROVED_RAW', occurredAt: '2026-08-21', status: 'approved', origin: 'manual',
      createdBy: 'candidate-user-a',
    },
  ] });
}, 30_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('CORE-201 legacy candidate migration inspection', () => {
  it('projects all five sources tenant-by-tenant with canonical status, parent closure, and creator quarantine', async () => {
    const before = await snapshotBusinessState();
    const tenantProjection = await projectCandidateMigrationForTenant(prisma, tenantA);
    const report = await inspectCandidateMigration(prisma);
    const repeated = await inspectCandidateMigration(prisma);
    const after = await snapshotBusinessState();

    expect(after).toEqual(before);
    expect(report).toEqual(repeated);
    expect(report).toMatchObject({
      sourceRows: 20,
      projectedRows: 15,
      quarantinedCreatorRows: 11,
      bySource: [
        { sourceKind: 'PersonSuggestion', sourceRows: 5, projectedRows: 4, invalidRows: 1 },
        { sourceKind: 'RelSuggestion', sourceRows: 4, projectedRows: 3, invalidRows: 1 },
        { sourceKind: 'ChangeProposal', sourceRows: 4, projectedRows: 3, invalidRows: 1 },
        { sourceKind: 'Reminder', sourceRows: 4, projectedRows: 3, invalidRows: 1 },
        { sourceKind: 'EvidenceEvent', sourceRows: 3, projectedRows: 2, invalidRows: 1 },
      ],
      byStatus: [
        { status: 'pending', rows: 7 },
        { status: 'accepted', rows: 4 },
        { status: 'rejected', rows: 4 },
      ],
    });
    expect(report.sourceRows).toBe(report.projectedRows + report.invalidRows.length);
    expect(report.projectionChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(report.invalidRows.map((row) => [row.sourceKind, row.sourceId, row.reason])).toEqual([
      ['PersonSuggestion', 'ps-a-invalid-account', 'account_not_found'],
      ['RelSuggestion', 'rs-a-invalid-endpoint', 'relation_endpoint_not_found'],
      ['ChangeProposal', 'cp-a-invalid-account', 'account_not_found'],
      ['Reminder', 'rem-a-invalid-entity', 'reminder_entity_not_found'],
      ['EvidenceEvent', 'ev-a-invalid-person', 'evidence_person_not_found'],
    ]);

    const person = tenantProjection.projections.find((row) => row.legacySourceId === 'ps-a-pending');
    expect(person).toMatchObject({
      kind: 'person_create', status: 'pending', accountId: 'candidate-account-a', matterId: 'candidate-matter-a',
      targetKind: 'person', targetId: null, source: 'mcp', sourceRef: 'legacy:PersonSuggestion:ps-a-pending',
      confidence: 0.91, createdByUserId: 'candidate-user-a', visibility: 'private',
      dedupeKey: 'legacy-v1:PersonSuggestion:ps-a-pending', legacySourceKind: 'PersonSuggestion',
    });
    expect(JSON.parse(person!.payload)).toMatchObject({
      name: 'Pending Person', title: 'Architect', orgLevel: 2, sourceUrl: 'https://source.example/person',
      suggestedRole: 'D', suggestedSentiment: 'plus', legacyStatus: 'pending',
    });
    expect(canonicalCandidateJson(JSON.parse(person!.payload))).toBe(person!.payload);

    expect(tenantProjection.projections.find((row) => row.legacySourceId === 'rs-a-accepted')).toMatchObject({
      kind: 'relation_create', status: 'accepted', accountId: 'candidate-account-a', matterId: 'candidate-matter-a',
      targetKind: 'relation', source: 'llm', confidence: 0.67, createdByUserId: null,
      visibility: 'owner_admin_only',
    });
    expect(tenantProjection.projections.find((row) => row.legacySourceId === 'cp-a-pending')).toMatchObject({
      kind: 'field_change', targetKind: 'oppRole', targetId: 'candidate-person-a1', fieldKey: 'sentiment',
      oldValue: 'neutral', newValue: 'plus', createdByUserId: 'candidate-user-a', visibility: 'private',
    });
    expect(tenantProjection.projections.find((row) => row.legacySourceId === 'rem-a-done')).toMatchObject({
      kind: 'reminder', status: 'accepted', targetKind: 'matter', targetId: 'candidate-matter-a',
      createdByUserId: null, visibility: 'owner_admin_only',
    });
    expect(tenantProjection.projections.find((row) => row.legacySourceId === 'ev-a-pending')).toMatchObject({
      kind: 'evidence_create', status: 'pending', targetKind: 'person', targetId: 'candidate-person-a1',
      evidence: 'SECRET_EVIDENCE_RAW_A', source: 'voice', createdByUserId: 'candidate-user-a', visibility: 'private',
    });

    const serializedReport = JSON.stringify(report);
    for (const secret of [
      'SECRET_PERSON_EVIDENCE_A', 'SECRET_REL_EVIDENCE_A', 'SECRET_CHANGE_EVIDENCE_A',
      'SECRET_REMINDER_DETAIL_A', 'SECRET_EVIDENCE_RAW_A', 'SECRET_APPROVED_RAW',
    ]) expect(serializedReport).not.toContain(secret);
  });

  it('exposes only dry-run and verify CLI modes and never writes Candidate rows', async () => {
    const before = await snapshotBusinessState();
    const dryRun = run(tsxBin, ['scripts/migrate-candidates.ts', '--dry-run']);
    expect(dryRun.status, `${dryRun.stdout}\n${dryRun.stderr}`).toBe(0);
    expect(dryRun.stdout).toContain('"mode": "dry-run"');
    expect(dryRun.stdout).not.toContain('SECRET_');

    const verify = run(tsxBin, ['scripts/migrate-candidates.ts', '--verify']);
    expect(verify.status).toBe(1);
    expect(verify.stdout).toContain('"ok": false');

    const apply = run(tsxBin, ['scripts/migrate-candidates.ts', '--apply']);
    expect(apply.status).not.toBe(0);
    expect(`${apply.stdout}\n${apply.stderr}`).toContain('--dry-run|--verify');
    expect(await snapshotBusinessState()).toEqual(before);
  }, 30_000);
});
