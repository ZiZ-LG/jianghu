import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INTELLIGENCE_FOCUS_MIGRATION_MARKER,
  applyIntelligenceFocusMigration,
  inspectIntelligenceFocusSchemaState,
  reportIntelligenceFocusMigration,
  verifyIntelligenceFocusMigration,
} from '../src/intelligenceFocus/migration.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('SAAS-206 IntelligenceItem and StakeholderFocus migration', () => {
  let test: TestContext;

  beforeEach(async () => { test = await createTestContext(); });
  afterEach(async () => test.cleanup());

  it('marks an exact empty expansion without backfilling intelligence, focus, Evidence, Candidate, or formal CRM', async () => {
    await expect(inspectIntelligenceFocusSchemaState(test.prisma)).resolves.toBe('expanded');
    const formalCountsBefore = await Promise.all([
      test.prisma.account.count(),
      test.prisma.opportunity.count(),
      test.prisma.person.count(),
      test.prisma.edge.count(),
      test.prisma.planAction.count(),
      test.prisma.evidenceEvent.count(),
      test.prisma.candidate.count(),
      test.prisma.researchBriefSnapshot.count(),
    ]);
    await expect(reportIntelligenceFocusMigration(test.prisma)).resolves.toMatchObject({
      ok: true,
      markerPresent: false,
      intelligenceItems: 0,
      stakeholderFocuses: 0,
      conflicts: [],
    });
    await expect(applyIntelligenceFocusMigration(test.prisma)).resolves.toMatchObject({
      ok: true,
      markerPresent: true,
      intelligenceItems: 0,
      stakeholderFocuses: 0,
      writes: 1,
    });
    await expect(verifyIntelligenceFocusMigration(test.prisma)).resolves.toMatchObject({
      ok: true,
      markerPresent: true,
      conflicts: [],
    });
    await expect(test.prisma.intelligenceItem.count()).resolves.toBe(0);
    await expect(test.prisma.stakeholderFocus.count()).resolves.toBe(0);
    await expect(Promise.all([
      test.prisma.account.count(),
      test.prisma.opportunity.count(),
      test.prisma.person.count(),
      test.prisma.edge.count(),
      test.prisma.planAction.count(),
      test.prisma.evidenceEvent.count(),
      test.prisma.candidate.count(),
      test.prisma.researchBriefSnapshot.count(),
    ])).resolves.toEqual(formalCountsBefore);
  });

  it('requires both portable tables and the SAAS-204 predecessor foundation', async () => {
    const dependencyMissing = {
      $queryRawUnsafe: async () => [
        { name: 'Tenant' },
        { name: 'DataMigrationState' },
        { name: 'IntelligenceItem' },
        { name: 'StakeholderFocus' },
      ],
    };
    await expect(inspectIntelligenceFocusSchemaState(
      dependencyMissing as unknown as Parameters<typeof inspectIntelligenceFocusSchemaState>[0],
    )).resolves.toBe('uninitialized');

    const onlyOneTable = {
      $queryRawUnsafe: async () => [
        { name: 'Tenant' },
        { name: 'DataMigrationState' },
        { name: 'ResearchBriefSnapshot' },
        { name: 'IntelligenceItem' },
      ],
    };
    await expect(inspectIntelligenceFocusSchemaState(
      onlyOneTable as unknown as Parameters<typeof inspectIntelligenceFocusSchemaState>[0],
    )).resolves.toBe('partial');
  });

  it('rolls the marker back when apply is interrupted', async () => {
    await expect(applyIntelligenceFocusMigration(test.prisma, { failAfterWrites: 1 }))
      .rejects.toThrow('injected Intelligence/Focus migration failure');
    await expect(test.prisma.dataMigrationState.findUnique({
      where: { key: INTELLIGENCE_FOCUS_MIGRATION_MARKER },
    })).resolves.toBeNull();
  });

  it('accepts canonical method-neutral rows and rejects semantic or marker drift', async () => {
    await test.prisma.account.create({ data: {
      id: 'intelligence-account', tenantId: test.tenant.id, name: 'Intelligence account',
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: 'intelligence-matter', tenantId: test.tenant.id, accountId: 'intelligence-account',
      name: 'Intelligence matter', customerType: 1, pipelineStage: 'lead', engageStage: 'unknown',
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.person.create({ data: {
      id: 'intelligence-person', tenantId: test.tenant.id, accountId: 'intelligence-account',
      name: 'Intelligence person', title: 'Sponsor',
    } });
    await test.prisma.matterParticipant.create({ data: {
      id: 'intelligence-participant', tenantId: test.tenant.id, accountId: 'intelligence-account',
      opportunityId: 'intelligence-matter', personId: 'intelligence-person',
    } });
    await test.prisma.interaction.create({ data: {
      id: 'intelligence-interaction', tenantId: test.tenant.id, accountId: 'intelligence-account',
      matterId: 'intelligence-matter', sourceArtifactId: 'source-ref', activityKind: 'meeting',
      occurredAt: new Date('2026-08-27T09:00:00.000Z'), confirmedByUserId: test.owner.id,
      version: 2,
    } });
    await test.prisma.intelligenceItem.create({ data: {
      id: 'intelligence-valid', tenantId: test.tenant.id, customerId: 'intelligence-account',
      matterId: 'intelligence-matter', assertionType: 'reported',
      statement: '客户转述的待验证信息', sourceKind: 'interaction',
      sourceDescription: '会议纪要', sourceRefId: 'intelligence-interaction', sourceRefVersion: 2,
      learnedAt: new Date('2026-08-27T10:00:00.000Z'), confidence: 0.7,
      targetRefs: '[{"kind":"matter","id":"intelligence-matter"},{"kind":"person","id":"intelligence-person"}]',
      createdByUserId: test.owner.id,
    } });
    await test.prisma.stakeholderFocus.create({ data: {
      id: 'focus-valid', tenantId: test.tenant.id, customerId: 'intelligence-account',
      matterId: 'intelligence-matter', personId: 'intelligence-person',
      desiredChange: '确认回款周期', rationale: '当前需要验证该假设',
      evidenceGap: '缺少当事人一手确认',
      basisRefs: '[{"kind":"intelligence_item","id":"intelligence-valid","version":0}]',
      validUntil: new Date('2026-09-10T10:00:00.000Z'), activeMatterKey: 'intelligence-matter',
      confirmedByUserId: test.owner.id, confirmedAt: new Date('2026-08-27T10:05:00.000Z'),
    } });

    await expect(reportIntelligenceFocusMigration(test.prisma)).resolves.toMatchObject({
      ok: true, intelligenceItems: 1, stakeholderFocuses: 1, conflicts: [],
    });
    await expect(applyIntelligenceFocusMigration(test.prisma)).resolves.toMatchObject({ ok: true });

    await test.prisma.intelligenceItem.update({
      where: { id: 'intelligence-valid' }, data: { targetRefs: '[{"kind":"matter","id":"wrong-matter"}]' },
    });
    await expect(verifyIntelligenceFocusMigration(test.prisma)).resolves.toMatchObject({
      ok: false,
      conflicts: expect.arrayContaining([
        `${test.tenant.id}:intelligence:intelligence-valid:target_closure_invalid`,
      ]),
    });
    await test.prisma.intelligenceItem.update({
      where: { id: 'intelligence-valid' },
      data: { targetRefs: '[{"kind":"matter","id":"intelligence-matter"},{"kind":"person","id":"intelligence-person"}]' },
    });
    await test.prisma.stakeholderFocus.update({
      where: { id: 'focus-valid' }, data: { activeMatterKey: 'other-matter' },
    });
    await expect(verifyIntelligenceFocusMigration(test.prisma)).resolves.toMatchObject({
      ok: false,
      conflicts: expect.arrayContaining([
        `${test.tenant.id}:focus:focus-valid:active_key_invalid`,
      ]),
    });
    await test.prisma.stakeholderFocus.update({
      where: { id: 'focus-valid' }, data: { activeMatterKey: 'intelligence-matter' },
    });
    await test.prisma.dataMigrationState.update({
      where: { key: INTELLIGENCE_FOCUS_MIGRATION_MARKER }, data: { details: '{}' },
    });
    await expect(verifyIntelligenceFocusMigration(test.prisma)).resolves.toMatchObject({
      ok: false,
      conflicts: ['intelligence_focus_marker_invalid'],
    });
  });
});
