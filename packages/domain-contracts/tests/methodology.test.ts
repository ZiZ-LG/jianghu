import { describe, expect, it } from 'vitest';
import {
  G64111_BUILTIN_PACK_KEY,
  G64111_BUILTIN_SOURCE_TEMPLATE_REF,
  G64111_BUILTIN_TEMPLATE_KEY,
  G64111MethodologyReadModelSchema,
  METHODOLOGY_COMMAND_TYPES,
  MethodologyActionTemplateSchema,
  MethodologyBindingSchema,
  MethodologyCommandReceiptSchema,
  MethodologyCommandSchema,
  MethodologyEvaluationSchema,
  MethodologyFieldDefinitionSchema,
  MethodologyMigrationRunSchema,
  MethodologyPackSchema,
  MethodologyPackVersionSchema,
  MethodologyPilotAssignmentSchema,
  MethodologyRoleAssignmentSchema,
  MethodologyRoleDefinitionSchema,
  MethodologyRuleDefinitionSchema,
  MethodologyStageDefinitionSchema,
  MethodologyStageStateSchema,
  MethodologyStorageBindingKindSchema,
  MethodologyValueSchema,
  MethodologyVersionStatusSchema,
  isG64111Active,
} from '../src/index.js';

const PACK_ID = 'methodologypack_00000000000000000000000000000001';
const VERSION_ID = 'methodologyversion_00000000000000000000000000000002';
const BINDING_ID = 'methodologybinding_00000000000000000000000000000003';
const PILOT_ID = 'methodologypilot_00000000000000000000000000000004';

describe('CORE-110 methodology foundation contracts', () => {
  it('keeps methodology commands outside the neutral CRM command union', () => {
    expect(METHODOLOGY_COMMAND_TYPES).toEqual([
      'MATERIALIZE_BUILTIN_METHODOLOGY',
      'ACTIVATE_METHODOLOGY_BINDING',
      'UNBIND_METHODOLOGY',
      'ASSIGN_METHODOLOGY_PILOT',
    ]);
  });

  it('accepts strict tenant-projected Pack and immutable Version snapshots', () => {
    expect(MethodologyPackSchema.safeParse({
      id: PACK_ID,
      key: 'platform.general_followup',
      name: '通用跟进方法',
      sourceTemplateRef: 'builtin:general-followup:1',
      currentPublishedVersionId: VERSION_ID,
      archivedAt: null,
      version: 0,
    }).success).toBe(true);
    expect(MethodologyPackVersionSchema.safeParse({
      id: VERSION_ID,
      packId: PACK_ID,
      versionKey: '1.0.0',
      status: 'published',
      engineRef: 'none:1',
      contentHash: 'a'.repeat(64),
      learningContentRef: null,
      sourceTemplateRef: 'builtin:general-followup:1',
      createdByUserId: 'user-owner',
      createdAt: '2026-08-21T22:00:00Z',
      publishedByUserId: 'user-owner',
      publishedAt: '2026-08-21T22:00:00Z',
    }).success).toBe(true);
    expect(MethodologyPackVersionSchema.safeParse({
      id: VERSION_ID,
      packId: PACK_ID,
      versionKey: '1.0.0',
      status: 'published',
      engineRef: 'none:1',
      contentHash: 'not-a-hash',
      learningContentRef: null,
      sourceTemplateRef: null,
      createdByUserId: 'user-owner',
      createdAt: '2026-08-21T22:00:00Z',
      publishedByUserId: null,
      publishedAt: null,
    }).success).toBe(false);
    expect(MethodologyVersionStatusSchema.options).toEqual([
      'draft', 'validated', 'piloting', 'published', 'deprecated', 'archived',
    ]);
  });

  it('requires opaque ids when materializing a server-owned template snapshot', () => {
    expect(MethodologyCommandSchema.safeParse({
      type: 'MATERIALIZE_BUILTIN_METHODOLOGY',
      templateKey: 'platform.general_followup.v1',
      packId: PACK_ID,
      versionId: VERSION_ID,
    }).success).toBe(true);
    expect(MethodologyCommandSchema.safeParse({
      type: 'MATERIALIZE_BUILTIN_METHODOLOGY',
      templateKey: 'platform.general_followup.v1',
      packId: 'pack-short',
      versionId: VERSION_ID,
    }).success).toBe(false);
  });

  it('requires Matter CAS and an explicit expected active pointer for activation and unbind', () => {
    expect(MethodologyCommandSchema.parse({
      type: 'ACTIVATE_METHODOLOGY_BINDING',
      bindingId: BINDING_ID,
      customerId: 'customer-1',
      matterId: 'matter-1',
      versionId: VERSION_ID,
      baseMatterVersion: 4,
      expectedActiveBindingId: null,
    })).toEqual({
      type: 'ACTIVATE_METHODOLOGY_BINDING',
      bindingId: BINDING_ID,
      customerId: 'customer-1',
      matterId: 'matter-1',
      versionId: VERSION_ID,
      baseMatterVersion: 4,
      expectedActiveBindingId: null,
      decisionProfileRef: null,
    });
    expect(MethodologyCommandSchema.safeParse({
      type: 'ACTIVATE_METHODOLOGY_BINDING',
      bindingId: BINDING_ID,
      customerId: 'customer-1',
      matterId: 'matter-1',
      versionId: VERSION_ID,
      expectedActiveBindingId: null,
    }).success).toBe(false);
    expect(MethodologyCommandSchema.safeParse({
      type: 'UNBIND_METHODOLOGY',
      customerId: 'customer-1',
      matterId: 'matter-1',
      baseMatterVersion: 5,
      expectedActiveBindingId: BINDING_ID,
    }).success).toBe(true);
    expect(MethodologyCommandSchema.safeParse({
      type: 'UNBIND_METHODOLOGY',
      customerId: 'customer-1',
      matterId: 'matter-1',
      baseMatterVersion: 5,
      expectedActiveBindingId: null,
    }).success).toBe(false);
  });

  it('models Binding history and Pilot assignment without an active boolean', () => {
    expect(MethodologyBindingSchema.safeParse({
      id: BINDING_ID,
      customerId: 'customer-1',
      matterId: 'matter-1',
      packId: PACK_ID,
      versionId: VERSION_ID,
      decisionProfileRef: null,
      createdByUserId: 'user-owner',
      createdAt: '2026-08-21T22:00:00Z',
    }).success).toBe(true);
    expect(MethodologyBindingSchema.safeParse({
      id: BINDING_ID,
      customerId: 'customer-1',
      matterId: 'matter-1',
      packId: PACK_ID,
      versionId: VERSION_ID,
      decisionProfileRef: null,
      createdByUserId: 'user-owner',
      createdAt: '2026-08-21T22:00:00Z',
      active: true,
    }).success).toBe(false);

    expect(MethodologyCommandSchema.safeParse({
      type: 'ASSIGN_METHODOLOGY_PILOT',
      pilotAssignmentId: PILOT_ID,
      customerId: 'customer-1',
      matterId: 'matter-1',
      candidateVersionId: VERSION_ID,
      baselineBindingId: BINDING_ID,
      baseMatterVersion: 5,
    }).success).toBe(true);
    expect(MethodologyPilotAssignmentSchema.safeParse({
      id: PILOT_ID,
      customerId: 'customer-1',
      matterId: 'matter-1',
      candidatePackId: PACK_ID,
      candidateVersionId: VERSION_ID,
      baselineBindingId: BINDING_ID,
      matterVersion: 5,
      status: 'active',
      assignedByUserId: 'user-owner',
      assignedAt: '2026-08-21T22:00:00Z',
      completedAt: null,
    }).success).toBe(true);
  });

  it('keeps replay receipts free of names, template content, and PDE payloads', () => {
    const receipt = {
      action: 'binding_activated',
      matterId: 'matter-1',
      bindingId: BINDING_ID,
      activeMethodologyBindingId: BINDING_ID,
      matterVersion: 5,
    };
    expect(MethodologyCommandReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(MethodologyCommandReceiptSchema.safeParse({
      ...receipt,
      packName: '不进入幂等摘要',
    }).success).toBe(false);
  });
});

describe('CORE-111 methodology data contracts', () => {
  const definitionBase = {
    packId: PACK_ID,
    versionId: VERSION_ID,
  };
  const instanceBase = {
    matterId: 'matter-1',
    bindingId: BINDING_ID,
    packId: PACK_ID,
    versionId: VERSION_ID,
  };

  it('requires one explicit storage authority and migration metadata for every legacy field', () => {
    expect(MethodologyStorageBindingKindSchema.options).toEqual([
      'core_path', 'methodology_value', 'legacy_path',
    ]);
    expect(MethodologyFieldDefinitionSchema.safeParse({
      id: 'field-current-stage',
      ...definitionBase,
      key: 'matter.current_stage',
      targetKind: 'matter',
      dataType: 'stage_key',
      valueDomainJson: JSON.stringify({ values: ['discover', 'validate'] }),
      required: false,
      missingValuePolicy: 'unconfigured',
      storageBindingKind: 'legacy_path',
      storageBindingPath: 'Opportunity.pipelineStage',
      legacyStopDate: '2026-12-31',
      legacyConsumersJson: JSON.stringify(['server/src/state.ts']),
      position: 0,
    }).success).toBe(true);
    expect(MethodologyFieldDefinitionSchema.safeParse({
      id: 'field-current-stage',
      ...definitionBase,
      key: 'matter.current_stage',
      targetKind: 'matter',
      dataType: 'stage_key',
      valueDomainJson: '{}',
      required: false,
      missingValuePolicy: 'unconfigured',
      storageBindingKind: 'legacy_path',
      storageBindingPath: 'Opportunity.pipelineStage',
      legacyStopDate: null,
      legacyConsumersJson: '[]',
      position: 0,
    }).success).toBe(false);
    expect(MethodologyFieldDefinitionSchema.safeParse({
      id: 'field-note',
      ...definitionBase,
      key: 'followup.note',
      targetKind: 'matter',
      dataType: 'string',
      valueDomainJson: {},
      required: false,
      missingValuePolicy: 'null',
      storageBindingKind: 'methodology_value',
      storageBindingPath: 'MethodologyValue(followup.note)',
      legacyStopDate: null,
      legacyConsumersJson: '[]',
      position: 1,
    }).success).toBe(false);
  });

  it('keeps Stage, Role, Rule and Action definitions structured while complex clauses remain JSON strings', () => {
    expect(MethodologyStageDefinitionSchema.safeParse({
      id: 'stage-discover', ...definitionBase, key: 'discover', name: '发现', position: 0,
      entryConditionsJson: '[]', exitConditionsJson: JSON.stringify([{ field: 'need', operator: 'present' }]),
    }).success).toBe(true);
    expect(MethodologyRoleDefinitionSchema.safeParse({
      id: 'role-sponsor', ...definitionBase, key: 'sponsor', name: '发起人', appliesTo: 'person',
      constraintsJson: '{}', minimumAssignments: 0, maximumAssignments: 2, position: 0,
    }).success).toBe(true);
    expect(MethodologyRoleDefinitionSchema.safeParse({
      id: 'role-invalid', ...definitionBase, key: 'invalid', name: '错误角色', appliesTo: 'person',
      constraintsJson: '{}', minimumAssignments: 2, maximumAssignments: 1, position: 0,
    }).success).toBe(false);
    expect(MethodologyRuleDefinitionSchema.safeParse({
      id: 'rule-risk', ...definitionBase, key: 'risk', operator: 'weighted_sum',
      inputRefsJson: JSON.stringify(['field.need']), weightsJson: JSON.stringify({ 'field.need': 1 }),
      thresholdsJson: JSON.stringify({ high: 0.8 }), outputKey: 'risk.score', position: 0,
    }).success).toBe(true);
    expect(MethodologyActionTemplateSchema.safeParse({
      id: 'action-confirm', ...definitionBase, key: 'confirm-need', gapKey: 'need_missing',
      title: '确认需求', script: '请补充需求依据', evidenceRequirementsJson: JSON.stringify(['meeting_note']),
      position: 0,
    }).success).toBe(true);
  });

  it('anchors StageState, RoleAssignment and Value to one immutable binding/version snapshot', () => {
    expect(MethodologyStageStateSchema.safeParse({
      id: 'stage-state-1', ...instanceBase, stageKey: 'discover',
      enteredAt: '2026-08-21T22:00:00Z', humanOverride: true, overrideReason: '人工确认',
      evidenceIdsJson: JSON.stringify(['evidence-1']), updatedByUserId: 'user-owner',
      updatedAt: '2026-08-21T22:00:00Z',
    }).success).toBe(true);
    expect(MethodologyRoleAssignmentSchema.safeParse({
      id: 'role-assignment-1', ...instanceBase, roleKey: 'sponsor', personId: 'person-1',
      source: 'manual', reviewStatus: 'confirmed', evidenceIdsJson: '[]',
      assignedByUserId: 'user-owner', assignedAt: '2026-08-21T22:00:00Z',
    }).success).toBe(true);
    expect(MethodologyValueSchema.safeParse({
      id: 'value-1', ...instanceBase, fieldKey: 'followup.note', targetKind: 'matter', targetId: 'matter-1',
      normalizedValueJson: JSON.stringify('下一步约见'), source: 'manual', reviewStatus: 'confirmed',
      evidenceIdsJson: JSON.stringify(['evidence-1']), updatedByUserId: 'user-owner',
      updatedAt: '2026-08-21T22:00:00Z',
    }).success).toBe(true);
    expect(MethodologyValueSchema.safeParse({
      id: 'value-1', ...instanceBase, fieldKey: 'followup.note', targetKind: 'matter', targetId: 'matter-1',
      normalizedValueJson: 'not-json', source: 'manual', reviewStatus: 'confirmed',
      evidenceIdsJson: '[]', updatedByUserId: 'user-owner', updatedAt: '2026-08-21T22:00:00Z',
    }).success).toBe(false);
  });

  it('requires replay-complete evaluation snapshots with JSON strings and bidirectional hashes', () => {
    const evaluation = {
      id: 'evaluation-1', ...instanceBase, trigger: 'manual', inputsJson: JSON.stringify({ need: true }),
      resultJson: JSON.stringify({ score: 1 }), evidenceIdsJson: JSON.stringify(['evidence-1']),
      aclVersion: 1, packVersionKey: '1.0.0', engineRef: 'declarative-v1:1',
      inputsHash: 'a'.repeat(64), resultHash: 'b'.repeat(64),
      createdByUserId: 'user-owner', createdAt: '2026-08-21T22:00:00Z',
    };
    expect(MethodologyEvaluationSchema.safeParse(evaluation).success).toBe(true);
    expect(MethodologyEvaluationSchema.safeParse({ ...evaluation, inputsJson: { need: true } }).success).toBe(false);
    expect(MethodologyEvaluationSchema.safeParse({ ...evaluation, inputsHash: 'A'.repeat(64) }).success).toBe(false);
  });

  it('models migration dry-run, mapping, conflicts, confirmation, execution and rollback without executing them', () => {
    const planned = {
      id: 'migration-run-1', matterId: 'matter-1', sourceBindingId: BINDING_ID,
      sourcePackId: PACK_ID, sourceVersionId: VERSION_ID,
      targetPackId: 'pack-target', targetVersionId: 'version-target', matterVersion: 7,
      status: 'planned', dryRunJson: JSON.stringify({ affected: 1 }), mappingJson: '{}', conflictsJson: '[]',
      confirmationJson: '{}', executionJson: '{}', rollbackJson: '{}',
      confirmedByUserId: null, confirmedAt: null, executedByUserId: null, executedAt: null,
      rolledBackByUserId: null, rolledBackAt: null, createdByUserId: 'user-owner',
      createdAt: '2026-08-21T22:00:00Z',
    };
    expect(MethodologyMigrationRunSchema.safeParse(planned).success).toBe(true);
    expect(MethodologyMigrationRunSchema.safeParse({
      ...planned, status: 'confirmed', confirmedByUserId: null, confirmedAt: null,
    }).success).toBe(false);
    expect(MethodologyMigrationRunSchema.safeParse({
      ...planned, dryRunJson: { affected: 1 },
    }).success).toBe(false);
  });
});

describe('SAAS-210 optional G64111 read contract', () => {
  const installation = {
    packId: PACK_ID,
    versionId: VERSION_ID,
    packKey: G64111_BUILTIN_PACK_KEY,
    packName: 'G64111 趋赢力',
    sourceTemplateRef: G64111_BUILTIN_SOURCE_TEMPLATE_REF,
    versionKey: '1.0.0',
    engineRef: 'g64111:0.1.0',
  };
  const activeBinding = {
    bindingId: BINDING_ID,
    customerId: 'customer-1',
    matterId: 'matter-1',
    packId: PACK_ID,
    versionId: VERSION_ID,
    packKey: G64111_BUILTIN_PACK_KEY,
    packName: 'G64111 趋赢力',
    sourceTemplateRef: G64111_BUILTIN_SOURCE_TEMPLATE_REF,
    versionKey: '1.0.0',
    engineRef: 'g64111:0.1.0',
  };
  const readModel = {
    generatedAtUtc: '2026-09-03T12:00:00.000Z',
    commandsEnabled: true,
    canManage: true,
    installation,
    matters: [{
      customerId: 'customer-1',
      customerName: '中性客户',
      matterId: 'matter-1',
      matterTitle: '中性事项',
      matterKind: 'sales_opportunity',
      matterVersion: 3,
      activeBinding,
    }],
  };

  it('publishes stable built-in identity constants and recognizes only the exact binding identity', () => {
    expect(G64111_BUILTIN_TEMPLATE_KEY).toBe('g64111');
    expect(G64111_BUILTIN_PACK_KEY).toBe('platform.g64111');
    expect(G64111_BUILTIN_SOURCE_TEMPLATE_REF).toBe('builtin:g64111:1');
    expect(isG64111Active(activeBinding)).toBe(true);
    expect(isG64111Active({ ...activeBinding, packKey: 'tenant.lookalike' })).toBe(false);
    expect(isG64111Active({ ...activeBinding, sourceTemplateRef: 'tenant:copy:1' })).toBe(false);
    expect(isG64111Active(null)).toBe(false);
  });

  it('accepts a strict neutral projection and rejects proprietary or forecast fields', () => {
    expect(G64111MethodologyReadModelSchema.parse(readModel)).toEqual(readModel);
    for (const forbidden of [
      'primaryDPersonId', 'roles', 'c3Items', 'c5Items', 'pipelineStage', 'engageStage', 'score', 'winProbability',
    ]) {
      expect(G64111MethodologyReadModelSchema.safeParse({
        ...readModel,
        matters: [{ ...readModel.matters[0], [forbidden]: 'poison' }],
      }).success).toBe(false);
    }
  });

  it('rejects duplicate Matters and inconsistent binding parents', () => {
    expect(G64111MethodologyReadModelSchema.safeParse({
      ...readModel,
      matters: [...readModel.matters, { ...readModel.matters[0] }],
    }).success).toBe(false);
    expect(G64111MethodologyReadModelSchema.safeParse({
      ...readModel,
      matters: [{
        ...readModel.matters[0],
        activeBinding: { ...activeBinding, matterId: 'matter-other' },
      }],
    }).success).toBe(false);
    expect(G64111MethodologyReadModelSchema.safeParse({
      ...readModel,
      matters: [{
        ...readModel.matters[0],
        activeBinding: { ...activeBinding, customerId: 'customer-other' },
      }],
    }).success).toBe(false);
  });

  it('rejects an installation whose pack/version identity is inconsistent with G64111', () => {
    expect(G64111MethodologyReadModelSchema.safeParse({
      ...readModel,
      installation: { ...installation, packKey: 'platform.copy' },
    }).success).toBe(false);
    expect(G64111MethodologyReadModelSchema.safeParse({
      ...readModel,
      installation: { ...installation, sourceTemplateRef: 'builtin:copy:1' },
    }).success).toBe(false);
    expect(G64111MethodologyReadModelSchema.safeParse({
      ...readModel,
      installation: null,
    }).success).toBe(false);
  });
});
