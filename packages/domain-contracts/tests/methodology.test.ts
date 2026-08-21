import { describe, expect, it } from 'vitest';
import {
  METHODOLOGY_COMMAND_TYPES,
  MethodologyBindingSchema,
  MethodologyCommandReceiptSchema,
  MethodologyCommandSchema,
  MethodologyPackSchema,
  MethodologyPackVersionSchema,
  MethodologyPilotAssignmentSchema,
  MethodologyVersionStatusSchema,
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
