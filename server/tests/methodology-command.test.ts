import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createG64111Adapter } from '../src/g64111.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

const PACK_ID = 'methodologypack_11111111111111111111111111111111';
const VERSION_ID = 'methodologyversion_22222222222222222222222222222222';
const BINDING_ID = 'methodologybinding_33333333333333333333333333333333';
const PILOT_ID = 'methodologypilot_44444444444444444444444444444444';
const G64111_PACK_ID = 'methodologypack_64111641116411164111641116411164';
const G64111_VERSION_ID = 'methodologyversion_64111641116411164111641116411164';

const auth = (token: string, key: string) => ({
  authorization: `Bearer ${token}`,
  'idempotency-key': key,
});

async function command(
  context: TestContext,
  key: string,
  payload: any,
  token = context.token,
) {
  return context.app.inject({
    method: 'POST',
    url: '/api/commands/methodology',
    headers: auth(token, key),
    payload,
  });
}

const materializePayload = (packId = PACK_ID, versionId = VERSION_ID) => ({
  type: 'MATERIALIZE_BUILTIN_METHODOLOGY',
  templateKey: 'general-followup',
  packId,
  versionId,
});

const materializeG64111Payload = () => ({
  type: 'MATERIALIZE_BUILTIN_METHODOLOGY',
  templateKey: 'g64111',
  packId: G64111_PACK_ID,
  versionId: G64111_VERSION_ID,
});

async function seedMatter(context: TestContext, suffix: string) {
  const customerId = `methodology-customer-${suffix}`;
  const matterId = `methodology-matter-${suffix}`;
  const personAId = `methodology-person-a-${suffix}`;
  const personBId = `methodology-person-b-${suffix}`;
  await context.prisma.account.create({ data: {
    id: customerId,
    tenantId: context.tenant.id,
    name: 'Methodology customer',
    customerType: 1,
  } });
  await context.prisma.opportunity.create({ data: {
    id: matterId,
    tenantId: context.tenant.id,
    accountId: customerId,
    name: 'Methodology matter',
    customerType: 1,
    pipelineStage: '线索',
    engageStage: '需求调研立项',
    memberScoped: true,
  } });
  await context.prisma.person.createMany({ data: [
    { id: personAId, tenantId: context.tenant.id, accountId: customerId, name: 'A', title: 'A' },
    { id: personBId, tenantId: context.tenant.id, accountId: customerId, name: 'B', title: 'B' },
  ] });
  await context.prisma.edge.create({ data: {
    id: `methodology-edge-${suffix}`,
    tenantId: context.tenant.id,
    accountId: customerId,
    opportunityId: matterId,
    source: personAId,
    target: personBId,
    kind: 'works_with',
    layer: 'L1',
    label: '协作',
  } });
  await context.prisma.planAction.create({ data: {
    id: `methodology-action-${suffix}`,
    tenantId: context.tenant.id,
    accountId: customerId,
    opportunityId: matterId,
    personId: personAId,
    title: '下一步',
    ownerUserId: context.owner.id,
    localDate: '2026-08-22',
    createdBy: context.owner.id,
  } });
  await context.prisma.evidenceEvent.create({ data: {
    id: `methodology-evidence-${suffix}`,
    tenantId: context.tenant.id,
    accountId: customerId,
    opportunityId: matterId,
    personId: personAId,
    signalKey: 'manual-check',
    direction: 1,
    tier: 'mid',
    rawContent: '人工确认的正式证据',
    occurredAt: '2026-08-21',
    status: 'approved',
    origin: 'manual',
    createdBy: context.owner.id,
  } });
  return { customerId, matterId, personAId, personBId };
}

async function materialize(context: TestContext, key = 'methodology-materialize-stable') {
  const response = await command(context, key, materializePayload());
  expect(response.statusCode, response.body).toBe(200);
  return response;
}

const originalCapability = process.env.METHODOLOGY_COMMANDS_ENABLED;

beforeEach(() => {
  process.env.METHODOLOGY_COMMANDS_ENABLED = '1';
});

afterEach(() => {
  if (originalCapability === undefined) delete process.env.METHODOLOGY_COMMANDS_ENABLED;
  else process.env.METHODOLOGY_COMMANDS_ENABLED = originalCapability;
});

describe('CORE-110 methodology command path', () => {
  it('materializes one tenant-owned immutable built-in snapshot and replays safely', async () => {
    const context = await createTestContext();
    try {
      const first = await materialize(context);
      const replay = await command(context, 'methodology-materialize-stable', materializePayload());
      expect(first.json()).toEqual({
        action: 'template_materialized',
        packId: PACK_ID,
        versionId: VERSION_ID,
        replayed: false,
      });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toEqual({ ...first.json(), replayed: true });
      const reusedKey = await command(
        context,
        'methodology-materialize-stable',
        materializePayload(
          'methodologypack_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          'methodologyversion_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        ),
      );
      expect(reusedKey.statusCode).toBe(409);
      expect(reusedKey.json()).toMatchObject({ code: 'idempotency_key_reused' });

      const pack = await context.prisma.methodologyPack.findUniqueOrThrow({ where: { id: PACK_ID } });
      const version = await context.prisma.methodologyPackVersion.findUniqueOrThrow({ where: { id: VERSION_ID } });
      expect(pack).toMatchObject({
        tenantId: context.tenant.id,
        key: 'platform.general_followup',
        name: '通用跟进方法',
        sourceTemplateRef: 'builtin:general-followup:1',
        currentPublishedVersionId: VERSION_ID,
        createdByUserId: context.owner.id,
      });
      expect(version).toMatchObject({
        tenantId: context.tenant.id,
        packId: PACK_ID,
        versionKey: '1.0.0',
        status: 'published',
        engineRef: 'none:1',
        sourceTemplateRef: 'builtin:general-followup:1',
        createdByUserId: context.owner.id,
        publishedByUserId: context.owner.id,
      });
      expect(version.contentHash).toMatch(/^[0-9a-f]{64}$/);

      const duplicate = await command(context, 'methodology-materialize-duplicate', materializePayload(
        'methodologypack_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'methodologyversion_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ));
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({ code: 'methodology_template_already_materialized' });
      expect(await context.prisma.methodologyPack.count({ where: { tenantId: context.tenant.id } })).toBe(1);
      expect(await context.prisma.methodologyPackVersion.count({ where: { tenantId: context.tenant.id } })).toBe(1);
      expect(await context.prisma.auditEvent.count({
        where: { tenantId: context.tenant.id, action: 'methodology_template_materialized' },
      })).toBe(1);
    } finally {
      await context.cleanup();
    }
  });

  it('materializes G64111 as one published definition snapshot without copying engine formulas', async () => {
    const context = await createTestContext();
    try {
      const response = await command(context, 'methodology-g64111-materialize', materializeG64111Payload());
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        action: 'template_materialized',
        packId: G64111_PACK_ID,
        versionId: G64111_VERSION_ID,
        replayed: false,
      });

      const pack = await context.prisma.methodologyPack.findUniqueOrThrow({ where: { id: G64111_PACK_ID } });
      const version = await context.prisma.methodologyPackVersion.findUniqueOrThrow({
        where: { id: G64111_VERSION_ID },
      });
      expect(pack).toMatchObject({
        tenantId: context.tenant.id,
        key: 'platform.g64111',
        name: 'G64111 趋赢力',
        sourceTemplateRef: 'builtin:g64111:1',
        currentPublishedVersionId: G64111_VERSION_ID,
      });
      expect(version).toMatchObject({
        tenantId: context.tenant.id,
        packId: G64111_PACK_ID,
        versionKey: '1.0.0',
        status: 'published',
        engineRef: 'g64111:0.1.0',
        sourceTemplateRef: 'builtin:g64111:1',
        publishedByUserId: context.owner.id,
      });

      const fields = await context.prisma.methodologyFieldDefinition.findMany({
        where: { tenantId: context.tenant.id, packId: G64111_PACK_ID, versionId: G64111_VERSION_ID },
        orderBy: { position: 'asc' },
      });
      expect(fields.map((field) => [field.key, field.storageBindingKind, field.storageBindingPath])).toEqual([
        ['g64111.primary_d', 'legacy_path', 'Opportunity.primaryDPersonId'],
        ['g64111.pipeline_stage', 'legacy_path', 'Opportunity.pipelineStage'],
        ['g64111.engage_stage', 'legacy_path', 'Opportunity.engageStage'],
        ['g64111.c3_items', 'legacy_path', 'Opportunity.c3Items'],
        ['g64111.c5_items', 'legacy_path', 'Opportunity.c5Items'],
        ['g64111.roles', 'legacy_path', 'OppRole[]'],
        ['g64111.burning_issues', 'legacy_path', 'BurningIssue[]'],
        ['g64111.unique_value_claims', 'legacy_path', 'UCV[]'],
        ['g64111.person_form_family7', 'legacy_path', 'Person.form.family7'],
      ]);
      expect(fields.every((field) => field.legacyStopDate === '2026-12-31')).toBe(true);
      expect(fields.every((field) => {
        const consumers = JSON.parse(field.legacyConsumersJson) as unknown;
        return Array.isArray(consumers) && consumers.length > 0;
      })).toBe(true);
      const engageStageConsumers = JSON.parse(
        fields.find((field) => field.key === 'g64111.engage_stage')!.legacyConsumersJson,
      ) as string[];
      expect(engageStageConsumers).toEqual(expect.arrayContaining([
        'app:g64111-adapter',
        'server:g64111-adapter',
      ]));
      expect(engageStageConsumers).not.toContain('app:pde-adapter:CORE-113');
      expect(engageStageConsumers).not.toContain('server:pde-assembler:CORE-113');
      expect(createG64111Adapter({
        engineRef: version.engineRef,
        storageBindings: fields.map((field) => ({
          key: field.key,
          storageBindingKind: field.storageBindingKind,
          storageBindingPath: field.storageBindingPath,
        })),
      }).engineRef).toBe(version.engineRef);

      const roles = await context.prisma.methodologyRoleDefinition.findMany({
        where: { tenantId: context.tenant.id, packId: G64111_PACK_ID, versionId: G64111_VERSION_ID },
        orderBy: { position: 'asc' },
      });
      expect(roles.map((role) => role.key)).toEqual(['A', 'D', 'U', 'R', 'C']);
      expect(await context.prisma.methodologyStageDefinition.count({
        where: { tenantId: context.tenant.id, packId: G64111_PACK_ID, versionId: G64111_VERSION_ID },
      })).toBe(7);
      expect(await context.prisma.methodologyRuleDefinition.count({
        where: { tenantId: context.tenant.id, packId: G64111_PACK_ID, versionId: G64111_VERSION_ID },
      })).toBe(0);
      expect(await context.prisma.methodologyActionTemplate.count({
        where: { tenantId: context.tenant.id, packId: G64111_PACK_ID, versionId: G64111_VERSION_ID },
      })).toBe(0);
    } finally {
      await context.cleanup();
    }
  });

  it('activates with Matter CAS and unbinds without deleting core or binding history', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedMatter(context, 'binding');
      await materialize(context);
      await context.prisma.industryPack.create({ data: {
        id: 'pde-profile-local',
        tenantId: context.tenant.id,
        packKey: 'digital-energy',
        schemaVersion: '1.1',
        payload: '{}',
        active: true,
      } });
      const activatePayload = {
        type: 'ACTIVATE_METHODOLOGY_BINDING',
        bindingId: BINDING_ID,
        customerId: tree.customerId,
        matterId: tree.matterId,
        versionId: VERSION_ID,
        baseMatterVersion: 0,
        expectedActiveBindingId: null,
        decisionProfileRef: 'pde-profile-local',
      };
      const activated = await command(context, 'methodology-activate-stable', activatePayload);
      const replay = await command(context, 'methodology-activate-stable', activatePayload);
      expect(activated.statusCode, activated.body).toBe(200);
      expect(activated.json()).toEqual({
        action: 'binding_activated',
        matterId: tree.matterId,
        bindingId: BINDING_ID,
        activeMethodologyBindingId: BINDING_ID,
        matterVersion: 1,
        replayed: false,
      });
      expect(replay.json()).toEqual({ ...activated.json(), replayed: true });
      expect(await context.prisma.opportunity.findUniqueOrThrow({ where: { id: tree.matterId } })).toMatchObject({
        activeMethodologyBindingId: BINDING_ID,
        version: 1,
      });
      expect(await context.prisma.methodologyBinding.findUniqueOrThrow({ where: { id: BINDING_ID } })).toMatchObject({
        tenantId: context.tenant.id,
        opportunityId: tree.matterId,
        packId: PACK_ID,
        versionId: VERSION_ID,
        decisionProfileRef: 'pde-profile-local',
      });

      const stale = await command(context, 'methodology-activate-stale', {
        ...activatePayload,
        bindingId: 'methodologybinding_cccccccccccccccccccccccccccccccc',
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'methodology_matter_version_conflict' });
      expect(await context.prisma.methodologyBinding.count({ where: { tenantId: context.tenant.id } })).toBe(1);

      const beforeCore = {
        customers: await context.prisma.account.count({ where: { tenantId: context.tenant.id } }),
        matters: await context.prisma.opportunity.count({ where: { tenantId: context.tenant.id } }),
        people: await context.prisma.person.count({ where: { tenantId: context.tenant.id } }),
        relations: await context.prisma.edge.count({ where: { tenantId: context.tenant.id } }),
        commitments: await context.prisma.planAction.count({ where: { tenantId: context.tenant.id } }),
        evidence: await context.prisma.evidenceEvent.count({ where: { tenantId: context.tenant.id } }),
      };
      const unbound = await command(context, 'methodology-unbind-stable', {
        type: 'UNBIND_METHODOLOGY',
        customerId: tree.customerId,
        matterId: tree.matterId,
        baseMatterVersion: 1,
        expectedActiveBindingId: BINDING_ID,
      });
      const unboundReplay = await command(context, 'methodology-unbind-stable', {
        type: 'UNBIND_METHODOLOGY',
        customerId: tree.customerId,
        matterId: tree.matterId,
        baseMatterVersion: 1,
        expectedActiveBindingId: BINDING_ID,
      });
      expect(unbound.statusCode, unbound.body).toBe(200);
      expect(unbound.json()).toEqual({
        action: 'methodology_unbound',
        matterId: tree.matterId,
        previousBindingId: BINDING_ID,
        activeMethodologyBindingId: null,
        matterVersion: 2,
        replayed: false,
      });
      expect(unboundReplay.json()).toEqual({ ...unbound.json(), replayed: true });
      expect(await context.prisma.opportunity.findUniqueOrThrow({ where: { id: tree.matterId } })).toMatchObject({
        activeMethodologyBindingId: null,
        version: 2,
      });
      expect(await context.prisma.methodologyBinding.count({ where: { tenantId: context.tenant.id } })).toBe(1);
      expect({
        customers: await context.prisma.account.count({ where: { tenantId: context.tenant.id } }),
        matters: await context.prisma.opportunity.count({ where: { tenantId: context.tenant.id } }),
        people: await context.prisma.person.count({ where: { tenantId: context.tenant.id } }),
        relations: await context.prisma.edge.count({ where: { tenantId: context.tenant.id } }),
        commitments: await context.prisma.planAction.count({ where: { tenantId: context.tenant.id } }),
        evidence: await context.prisma.evidenceEvent.count({ where: { tenantId: context.tenant.id } }),
      }).toEqual(beforeCore);
    } finally {
      await context.cleanup();
    }
  });

  it('keeps pilots beside the primary binding and rejects every cross-tenant reference', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedMatter(context, 'pilot');
      await materialize(context);
      const activate = await command(context, 'methodology-pilot-baseline', {
        type: 'ACTIVATE_METHODOLOGY_BINDING',
        bindingId: BINDING_ID,
        customerId: tree.customerId,
        matterId: tree.matterId,
        versionId: VERSION_ID,
        baseMatterVersion: 0,
        expectedActiveBindingId: null,
        decisionProfileRef: null,
      });
      expect(activate.statusCode, activate.body).toBe(200);

      const pilot = await command(context, 'methodology-pilot-stable', {
        type: 'ASSIGN_METHODOLOGY_PILOT',
        pilotAssignmentId: PILOT_ID,
        customerId: tree.customerId,
        matterId: tree.matterId,
        candidateVersionId: VERSION_ID,
        baselineBindingId: BINDING_ID,
        baseMatterVersion: 1,
      });
      expect(pilot.statusCode, pilot.body).toBe(200);
      expect(pilot.json()).toEqual({
        action: 'pilot_assigned',
        matterId: tree.matterId,
        pilotAssignmentId: PILOT_ID,
        candidateVersionId: VERSION_ID,
        activeMethodologyBindingId: BINDING_ID,
        matterVersion: 1,
        replayed: false,
      });
      expect(await context.prisma.opportunity.findUniqueOrThrow({ where: { id: tree.matterId } })).toMatchObject({
        activeMethodologyBindingId: BINDING_ID,
        version: 1,
      });

      const foreignTenantId = `tenant-foreign-${randomUUID()}`;
      const foreignUserId = `user-foreign-${randomUUID()}`;
      const foreignCustomerId = `customer-foreign-${randomUUID()}`;
      const foreignMatterId = `matter-foreign-${randomUUID()}`;
      const foreignPackId = 'methodologypack_55555555555555555555555555555555';
      const foreignVersionId = 'methodologyversion_66666666666666666666666666666666';
      const foreignBindingId = 'methodologybinding_77777777777777777777777777777777';
      await context.prisma.tenant.create({ data: { id: foreignTenantId, name: 'Foreign tenant' } });
      await context.prisma.user.create({ data: {
        id: foreignUserId,
        tenantId: foreignTenantId,
        email: `foreign-${randomUUID()}@example.test`,
        passwordHash: 'unused',
        name: 'Foreign owner',
        role: 'owner',
      } });
      await context.prisma.account.create({ data: {
        id: foreignCustomerId,
        tenantId: foreignTenantId,
        name: 'Foreign customer',
        customerType: 1,
      } });
      await context.prisma.opportunity.create({ data: {
        id: foreignMatterId,
        tenantId: foreignTenantId,
        accountId: foreignCustomerId,
        name: 'Foreign matter',
        customerType: 1,
        pipelineStage: '线索',
        engageStage: '需求调研立项',
      } });
      await context.prisma.methodologyPack.create({ data: {
        id: foreignPackId,
        tenantId: foreignTenantId,
        key: 'foreign.methodology',
        name: 'Foreign methodology',
        currentPublishedVersionId: foreignVersionId,
        createdByUserId: foreignUserId,
      } });
      await context.prisma.methodologyPackVersion.create({ data: {
        id: foreignVersionId,
        tenantId: foreignTenantId,
        packId: foreignPackId,
        versionKey: '1.0.0',
        status: 'published',
        engineRef: 'none:1',
        contentHash: 'f'.repeat(64),
        createdByUserId: foreignUserId,
        publishedByUserId: foreignUserId,
        publishedAt: new Date(),
      } });
      await context.prisma.methodologyBinding.create({ data: {
        id: foreignBindingId,
        tenantId: foreignTenantId,
        opportunityId: foreignMatterId,
        packId: foreignPackId,
        versionId: foreignVersionId,
        createdByUserId: foreignUserId,
      } });
      await context.prisma.industryPack.create({ data: {
        id: 'pde-profile-foreign',
        tenantId: foreignTenantId,
        packKey: 'foreign-profile',
        schemaVersion: '1.0',
        payload: '{}',
      } });

      const foreignVersion = await command(context, 'methodology-foreign-version', {
        type: 'ASSIGN_METHODOLOGY_PILOT',
        pilotAssignmentId: 'methodologypilot_88888888888888888888888888888888',
        customerId: tree.customerId,
        matterId: tree.matterId,
        candidateVersionId: foreignVersionId,
        baselineBindingId: BINDING_ID,
        baseMatterVersion: 1,
      });
      expect(foreignVersion.statusCode).toBe(404);

      const foreignBaseline = await command(context, 'methodology-foreign-baseline', {
        type: 'ASSIGN_METHODOLOGY_PILOT',
        pilotAssignmentId: 'methodologypilot_99999999999999999999999999999999',
        customerId: tree.customerId,
        matterId: tree.matterId,
        candidateVersionId: VERSION_ID,
        baselineBindingId: foreignBindingId,
        baseMatterVersion: 1,
      });
      expect(foreignBaseline.statusCode).toBe(404);

      const foreignProfile = await command(context, 'methodology-foreign-profile', {
        type: 'ACTIVATE_METHODOLOGY_BINDING',
        bindingId: 'methodologybinding_dddddddddddddddddddddddddddddddd',
        customerId: tree.customerId,
        matterId: tree.matterId,
        versionId: VERSION_ID,
        baseMatterVersion: 1,
        expectedActiveBindingId: BINDING_ID,
        decisionProfileRef: 'pde-profile-foreign',
      });
      expect(foreignProfile.statusCode).toBe(404);

      const foreignMatter = await command(context, 'methodology-foreign-matter', {
        type: 'ACTIVATE_METHODOLOGY_BINDING',
        bindingId: 'methodologybinding_abababababababababababababababab',
        customerId: foreignCustomerId,
        matterId: foreignMatterId,
        versionId: foreignVersionId,
        baseMatterVersion: 0,
        expectedActiveBindingId: null,
        decisionProfileRef: null,
      });
      expect(foreignMatter.statusCode).toBe(404);
      expect(await context.prisma.methodologyPilotAssignment.count({
        where: { tenantId: context.tenant.id },
      })).toBe(1);
      expect(await context.prisma.methodologyBinding.count({
        where: { tenantId: context.tenant.id },
      })).toBe(1);
    } finally {
      await context.cleanup();
    }
  });

  it('rejects malformed setup, unpublished versions, and inactive decision profiles', async () => {
    const context = await createTestContext();
    try {
      const missingKey = await context.app.inject({
        method: 'POST',
        url: '/api/commands/methodology',
        headers: { authorization: `Bearer ${context.token}` },
        payload: materializePayload(),
      });
      expect(missingKey.statusCode).toBe(400);

      const malformed = await command(context, 'methodology-malformed-request', {
        type: 'MATERIALIZE_BUILTIN_METHODOLOGY',
        templateKey: 'general-followup',
        packId: 'predictable-id',
        versionId: VERSION_ID,
      });
      expect(malformed.statusCode).toBe(400);

      const unknownTemplate = await command(context, 'methodology-unknown-template', {
        ...materializePayload(),
        templateKey: 'not-installed',
      });
      expect(unknownTemplate.statusCode).toBe(400);
      expect(unknownTemplate.json()).toMatchObject({ code: 'unknown_methodology_template' });
      expect(await context.prisma.methodologyPack.count({ where: { tenantId: context.tenant.id } })).toBe(0);

      await context.prisma.user.update({ where: { id: context.owner.id }, data: { role: 'admin' } });
      await materialize(context, 'methodology-admin-materialize');
      const tree = await seedMatter(context, 'negative-paths');
      const draftVersionId = 'methodologyversion_cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';
      await context.prisma.methodologyPackVersion.create({ data: {
        id: draftVersionId,
        tenantId: context.tenant.id,
        packId: PACK_ID,
        versionKey: '1.1.0-draft',
        status: 'draft',
        engineRef: 'none:1',
        contentHash: 'd'.repeat(64),
        createdByUserId: context.owner.id,
      } });
      await context.prisma.industryPack.create({ data: {
        id: 'pde-profile-inactive',
        tenantId: context.tenant.id,
        packKey: 'inactive-profile',
        schemaVersion: '1.0',
        payload: '{}',
        active: false,
      } });

      const draftVersion = await command(context, 'methodology-draft-version', {
        type: 'ACTIVATE_METHODOLOGY_BINDING',
        bindingId: 'methodologybinding_cececececececececececececececece',
        customerId: tree.customerId,
        matterId: tree.matterId,
        versionId: draftVersionId,
        baseMatterVersion: 0,
        expectedActiveBindingId: null,
        decisionProfileRef: null,
      });
      expect(draftVersion.statusCode).toBe(409);
      expect(draftVersion.json()).toMatchObject({ code: 'methodology_version_not_bindable' });

      const inactiveProfile = await command(context, 'methodology-inactive-profile', {
        type: 'ACTIVATE_METHODOLOGY_BINDING',
        bindingId: 'methodologybinding_cfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcf',
        customerId: tree.customerId,
        matterId: tree.matterId,
        versionId: VERSION_ID,
        baseMatterVersion: 0,
        expectedActiveBindingId: null,
        decisionProfileRef: 'pde-profile-inactive',
      });
      expect(inactiveProfile.statusCode).toBe(404);
      expect(await context.prisma.methodologyBinding.count({ where: { tenantId: context.tenant.id } })).toBe(0);
      expect(await context.prisma.opportunity.findUniqueOrThrow({ where: { id: tree.matterId } })).toMatchObject({
        activeMethodologyBindingId: null,
        version: 0,
      });
    } finally {
      await context.cleanup();
    }
  });

  it('fails closed before reservation when capability or current manager role is absent', async () => {
    const context = await createTestContext();
    try {
      process.env.METHODOLOGY_COMMANDS_ENABLED = '0';
      const disabled = await command(context, 'methodology-disabled-command', materializePayload());
      expect(disabled.statusCode).toBe(503);
      expect(disabled.json()).toMatchObject({ code: 'methodology_commands_disabled' });

      process.env.METHODOLOGY_COMMANDS_ENABLED = '1';
      const member = await context.prisma.user.create({ data: {
        tenantId: context.tenant.id,
        email: `methodology-member-${randomUUID()}@example.test`,
        passwordHash: 'unused',
        name: 'Member',
        role: 'member',
      } });
      const memberToken = context.app.jwt.sign({
        userId: member.id,
        tenantId: context.tenant.id,
        role: 'owner',
      });
      const forgedOldRole = await command(
        context,
        'methodology-old-role-token',
        materializePayload(),
        memberToken,
      );
      expect(forgedOldRole.statusCode).toBe(403);

      await context.prisma.user.update({ where: { id: context.owner.id }, data: { role: 'member' } });
      const downgraded = await command(context, 'methodology-downgraded-owner', materializePayload());
      expect(downgraded.statusCode).toBe(403);
      expect(await context.prisma.methodologyPack.count({ where: { tenantId: context.tenant.id } })).toBe(0);
      expect(await context.prisma.methodologyPackVersion.count({ where: { tenantId: context.tenant.id } })).toBe(0);
      expect(await context.prisma.commandRun.count({ where: { tenantId: context.tenant.id } })).toBe(0);
      expect(await context.prisma.auditEvent.count({ where: { tenantId: context.tenant.id } })).toBe(0);
    } finally {
      await context.cleanup();
    }
  });
});
