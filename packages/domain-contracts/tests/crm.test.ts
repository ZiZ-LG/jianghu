import { describe, expect, it } from 'vitest';
import {
  ACTION_TYPES,
  CRM_COMMAND_TYPES,
  ActionSchema,
  CommitmentCommandReceiptSchema,
  CommitmentCommandSchema,
  CommitmentV2Schema,
  CrmContextSnapshotSchema,
  CrmCommandSchema,
  CustomerCommandReceiptSchema,
  CustomerCreateCommandSchema,
  CustomerV2Schema,
  MatterOwnerAssignmentReportSchema,
  MatterV2Schema,
  QuickCaptureCommandReceiptSchema,
  QuickCaptureCommandSchema,
  RelationV2Schema,
  commitmentReceiptMatchesCommand,
} from '../src/index.js';

const NEW_CUSTOMER_ID = 'customer_00000000000000000000000000000001';
const NEW_MATTER_ID = 'matter_00000000000000000000000000000002';
const NEW_COMMITMENT_ID = 'commitment_00000000000000000000000000000003';
const NEXT_COMMITMENT_ID = 'commitment_00000000000000000000000000000004';

const TIMED_COMMITMENT_DTO = {
  id: 'legacy-plan-action-1',
  customerId: 'legacy-account-1',
  matterId: 'legacy-opportunity-1',
  personId: null,
  title: '临近时与客户确认方案交流',
  kind: 'meeting',
  ownerUserId: 'user-cao',
  executionStatus: 'planned',
  confirmationStatus: 'pending',
  scheduledAtUtc: '2026-08-25T02:00:00Z',
  dueAtUtc: null,
  timeZone: 'Asia/Shanghai',
  isAllDay: false,
  localDate: null,
  confirmationDueAtUtc: '2026-08-24T02:00:00Z',
  confirmedAtUtc: null,
  confirmedByUserId: null,
  scheduleVersion: 2,
  nextCommitmentId: null,
  source: 'manual',
  sourceRef: null,
  archivedAt: null,
  version: 5,
} as const;

const COMMITMENT_CREATE_INPUT = {
  id: NEW_COMMITMENT_ID,
  customerId: 'legacy-account-1',
  matterId: 'legacy-opportunity-1',
  personId: null,
  title: '验证客户交流时间',
  kind: 'meeting',
  ownerUserId: 'user-cao',
  confirmationStatus: 'pending',
  scheduledAtUtc: '2026-08-25T02:00:00Z',
  dueAtUtc: null,
  timeZone: 'Asia/Shanghai',
  isAllDay: false,
  localDate: null,
  confirmationDueAtUtc: '2026-08-24T02:00:00Z',
  source: 'manual',
  sourceRef: null,
} as const;

const GENERIC_CONTEXT_SNAPSHOT = {
  generatedAtUtc: '2026-08-23T23:50:00Z',
  customers: [{
    id: 'customer-1', name: '通用客户', categoryKey: null,
    primaryOwnerUserId: 'user-1', archivedAt: null, version: 2,
  }, {
    id: 'customer-2', name: '另一客户', categoryKey: 'partner',
    primaryOwnerUserId: null, archivedAt: null, version: 0,
  }],
  matters: [{
    id: 'matter-general', customerId: 'customer-1', title: '联合研究', kind: 'general',
    lifecycleStatus: 'active', outcomeKey: null, priority: null, targetDate: null,
    primaryOwnerUserId: 'user-1', archivedAt: null, version: 1,
  }, {
    id: 'matter-sales', customerId: 'customer-1', title: '设备采购', kind: 'sales_opportunity',
    lifecycleStatus: 'active', outcomeKey: null, priority: 'important', targetDate: '2026-10-01',
    primaryOwnerUserId: 'user-1', archivedAt: null, version: 3,
  }, {
    id: 'matter-other-customer', customerId: 'customer-2', title: '联合培训', kind: 'training_program',
    lifecycleStatus: 'paused', outcomeKey: null, priority: null, targetDate: null,
    primaryOwnerUserId: null, archivedAt: null, version: 0,
  }],
  people: [{
    id: 'person-1', customerId: 'customer-1', name: '李总', title: '负责人', archivedAt: null, version: 1,
  }, {
    id: 'person-2', customerId: 'customer-1', name: '王经理', title: null, archivedAt: null, version: 0,
  }, {
    id: 'person-3', customerId: 'customer-2', name: '赵老师', title: '项目负责人', archivedAt: null, version: 0,
  }],
  matterParticipants: [{
    id: 'participant-1', customerId: 'customer-1', matterId: 'matter-general', personId: 'person-1',
  }],
  relations: [{
    id: 'relation-1', customerId: 'customer-1', matterId: null,
    sourcePersonId: 'person-1', targetPersonId: 'person-2', kind: 'trusted_advisor',
    label: '可信顾问', directed: true, version: 4,
  }, {
    id: 'relation-2', customerId: 'customer-1', matterId: 'matter-sales',
    sourcePersonId: 'person-2', targetPersonId: 'person-1', kind: 'unknown_open_relation',
    label: null, directed: false, version: 0,
  }],
} as const;

describe('neutral CRM V2 contracts', () => {
  it('accepts legacy Customer ids without numeric sales classification and rejects sales-only fields', () => {
    expect(CustomerV2Schema.safeParse({
      id: 'legacy-account-1', name: '远山制造', categoryKey: 'strategic_partner',
      primaryOwnerUserId: null, archivedAt: null, version: 0,
    }).success).toBe(true);
    expect(CustomerV2Schema.safeParse({
      id: 'legacy-account-1', name: '远山制造', categoryKey: null,
      primaryOwnerUserId: null, archivedAt: null, version: 0, customerType: 1,
    }).success).toBe(false);
  });

  it('reads unknown Matter kinds while rejecting sales lifecycle and methodology fields', () => {
    expect(MatterV2Schema.safeParse({
      id: 'legacy-opportunity-1', customerId: 'legacy-account-1', title: '联合实验室筹备',
      kind: 'research_alliance', lifecycleStatus: 'active', outcomeKey: null, priority: 'important',
      targetDate: '2026-10-01', primaryOwnerUserId: null, archivedAt: null, version: 3,
    }).success).toBe(true);
    expect(MatterV2Schema.safeParse({
      id: 'legacy-opportunity-1', customerId: 'legacy-account-1', title: '联合实验室筹备',
      kind: 'sales_opportunity', lifecycleStatus: 'won', outcomeKey: 'won', priority: null,
      targetDate: null, primaryOwnerUserId: null, archivedAt: null, version: 3,
      pipelineStage: '合同双签', engageStage: '招采执行', primaryDPersonId: 'person-1',
    }).success).toBe(false);
  });

  it('does not allow an open Matter snapshot to carry a terminal outcome', () => {
    expect(MatterV2Schema.safeParse({
      id: 'legacy-opportunity-1', customerId: 'legacy-account-1', title: '仍在推进的事项',
      kind: 'sales_opportunity', lifecycleStatus: 'active', outcomeKey: 'won', priority: null,
      targetDate: null, primaryOwnerUserId: null, archivedAt: null, version: 3,
    }).success).toBe(false);
    expect(MatterV2Schema.safeParse({
      id: 'legacy-opportunity-1', customerId: 'legacy-account-1', title: '已经签约的事项',
      kind: 'sales_opportunity', lifecycleStatus: 'completed', outcomeKey: 'won', priority: null,
      targetDate: null, primaryOwnerUserId: null, archivedAt: null, version: 4,
    }).success).toBe(true);
  });

  it('accepts canonical UTC and a real IANA time zone', () => {
    expect(CommitmentV2Schema.safeParse(TIMED_COMMITMENT_DTO).success).toBe(true);
  });

  it('keeps a legacy unassigned commitment explicit instead of inventing an owner', () => {
    expect(CommitmentV2Schema.safeParse({
      ...TIMED_COMMITMENT_DTO,
      ownerUserId: null,
    }).success).toBe(true);
    expect(CrmCommandSchema.safeParse({
      type: 'CREATE_COMMITMENT',
      commitment: { ...COMMITMENT_CREATE_INPUT, ownerUserId: null },
    }).success).toBe(false);
  });

  it('rejects non-canonical offsets, invalid IANA zones, and impossible calendar dates', () => {
    expect(CommitmentV2Schema.safeParse({
      ...TIMED_COMMITMENT_DTO, scheduledAtUtc: '2026-08-25T10:00:00+08:00',
    }).success).toBe(false);
    expect(CommitmentV2Schema.safeParse({ ...TIMED_COMMITMENT_DTO, timeZone: 'Mars/Olympus' }).success).toBe(false);
    expect(MatterV2Schema.safeParse({
      id: 'legacy-opportunity-1', customerId: 'legacy-account-1', title: '无效日期', kind: 'general',
      lifecycleStatus: 'active', outcomeKey: null, priority: null, targetDate: '2026-02-31',
      primaryOwnerUserId: null, archivedAt: null, version: 0,
    }).success).toBe(false);
  });

  it('requires a pending confirmation deadline strictly before the scheduled event', () => {
    expect(CommitmentV2Schema.safeParse({ ...TIMED_COMMITMENT_DTO, confirmationDueAtUtc: null }).success).toBe(false);
    expect(CommitmentV2Schema.safeParse({
      ...TIMED_COMMITMENT_DTO, confirmationDueAtUtc: '2026-08-25T03:00:00Z',
    }).success).toBe(false);
    expect(CommitmentV2Schema.safeParse({
      ...TIMED_COMMITMENT_DTO, confirmationDueAtUtc: '2026-08-25T02:00:00Z',
    }).success).toBe(false);
  });

  it('accepts a real all-day local date without a fabricated UTC instant', () => {
    expect(CommitmentV2Schema.safeParse({
      ...TIMED_COMMITMENT_DTO,
      title: '国庆后回访', kind: 'message', confirmationStatus: 'not_required',
      scheduledAtUtc: null, dueAtUtc: null, isAllDay: true, localDate: '2026-10-08', confirmationDueAtUtc: null,
    }).success).toBe(true);
    expect(CommitmentV2Schema.safeParse({
      ...TIMED_COMMITMENT_DTO,
      scheduledAtUtc: '2026-10-08T00:00:00Z', isAllDay: true, localDate: '2026-10-08',
      confirmationStatus: 'not_required', confirmationDueAtUtc: null,
    }).success).toBe(false);
  });

  it('keeps an all-day confirmation deadline on or before the event business date', () => {
    const allDayPending = {
      ...TIMED_COMMITMENT_DTO,
      scheduledAtUtc: null,
      dueAtUtc: null,
      isAllDay: true,
      localDate: '2026-10-08',
      confirmationDueAtUtc: '2026-10-08T01:00:00Z',
    } as const;
    expect(CommitmentV2Schema.safeParse(allDayPending).success).toBe(true);
    expect(CommitmentV2Schema.safeParse({
      ...allDayPending,
      confirmationDueAtUtc: '2026-10-09T00:00:00Z',
    }).success).toBe(false);
    expect(CommitmentV2Schema.safeParse({
      ...allDayPending,
      localDate: '2026-10-08',
      timeZone: 'America/Los_Angeles',
      confirmationDueAtUtc: '2026-10-09T02:00:00Z',
    }).success).toBe(true);

    expect(CrmCommandSchema.safeParse({
      type: 'CREATE_COMMITMENT',
      commitment: {
        ...COMMITMENT_CREATE_INPUT,
        scheduledAtUtc: null,
        dueAtUtc: null,
        isAllDay: true,
        localDate: '2026-10-08',
        confirmationDueAtUtc: '2026-10-09T00:00:00Z',
      },
    }).success).toBe(false);
  });

  it('fails closed instead of throwing for malformed all-day confirmation inputs', () => {
    const allDayPending = {
      ...TIMED_COMMITMENT_DTO,
      scheduledAtUtc: null,
      dueAtUtc: null,
      isAllDay: true,
      localDate: '2026-10-08',
    } as const;
    const invalidTimeZone = { ...allDayPending, timeZone: 'Mars/Olympus' };
    const invalidDeadline = { ...allDayPending, confirmationDueAtUtc: 'bogus' };

    expect(() => CommitmentV2Schema.safeParse(invalidTimeZone)).not.toThrow();
    expect(CommitmentV2Schema.safeParse(invalidTimeZone).success).toBe(false);
    expect(() => CommitmentV2Schema.safeParse(invalidDeadline)).not.toThrow();
    expect(CommitmentV2Schema.safeParse(invalidDeadline).success).toBe(false);
  });

  it('requires confirmation metadata only for the confirmed state', () => {
    expect(CommitmentV2Schema.safeParse({
      ...TIMED_COMMITMENT_DTO, confirmationStatus: 'confirmed', confirmedAtUtc: null, confirmedByUserId: null,
    }).success).toBe(false);
    expect(CommitmentV2Schema.safeParse({
      ...TIMED_COMMITMENT_DTO, confirmationStatus: 'confirmed',
      confirmedAtUtc: '2026-08-24T01:00:00Z', confirmedByUserId: 'user-cao',
    }).success).toBe(true);
  });
});

describe('generic CRM context snapshot', () => {
  it('preserves open Relation kinds without exposing the sales layer adapter', () => {
    expect(RelationV2Schema.safeParse(GENERIC_CONTEXT_SNAPSHOT.relations[1]).success).toBe(true);
    expect(RelationV2Schema.safeParse({
      ...GENERIC_CONTEXT_SNAPSHOT.relations[1],
      layer: 'L4',
    }).success).toBe(false);
    expect(RelationV2Schema.safeParse({
      ...GENERIC_CONTEXT_SNAPSHOT.relations[1],
      role: 'D',
      sentiment: 'star',
    }).success).toBe(false);
    expect(RelationV2Schema.safeParse({
      ...GENERIC_CONTEXT_SNAPSHOT.relations[1],
      kind: '   ',
    }).success).toBe(false);
  });

  it('reads general, sales-opportunity, and unknown Matter kinds in one strict snapshot', () => {
    expect(CrmContextSnapshotSchema.safeParse(GENERIC_CONTEXT_SNAPSHOT).success).toBe(true);
    expect(CrmContextSnapshotSchema.safeParse({
      ...GENERIC_CONTEXT_SNAPSHOT,
      pipelineStage: '合同双签',
    }).success).toBe(false);
    expect(CrmContextSnapshotSchema.safeParse({
      ...GENERIC_CONTEXT_SNAPSHOT,
      matters: [{ ...GENERIC_CONTEXT_SNAPSHOT.matters[0], engageStage: '招采执行' }],
    }).success).toBe(false);
  });

  it.each([
    ['duplicate customer id', {
      ...GENERIC_CONTEXT_SNAPSHOT,
      customers: [...GENERIC_CONTEXT_SNAPSHOT.customers, GENERIC_CONTEXT_SNAPSHOT.customers[0]],
    }],
    ['missing Matter customer', {
      ...GENERIC_CONTEXT_SNAPSHOT,
      matters: [{ ...GENERIC_CONTEXT_SNAPSHOT.matters[0], customerId: 'missing-customer' }],
    }],
    ['missing Person customer', {
      ...GENERIC_CONTEXT_SNAPSHOT,
      people: [{ ...GENERIC_CONTEXT_SNAPSHOT.people[0], customerId: 'missing-customer' }],
    }],
    ['missing participant person', {
      ...GENERIC_CONTEXT_SNAPSHOT,
      matterParticipants: [{ ...GENERIC_CONTEXT_SNAPSHOT.matterParticipants[0], personId: 'missing-person' }],
    }],
    ['participant parent mismatch', {
      ...GENERIC_CONTEXT_SNAPSHOT,
      matterParticipants: [{ ...GENERIC_CONTEXT_SNAPSHOT.matterParticipants[0], matterId: 'matter-other-customer' }],
    }],
    ['missing relation endpoint', {
      ...GENERIC_CONTEXT_SNAPSHOT,
      relations: [{ ...GENERIC_CONTEXT_SNAPSHOT.relations[0], targetPersonId: 'missing-person' }],
    }],
    ['cross-customer relation endpoint', {
      ...GENERIC_CONTEXT_SNAPSHOT,
      relations: [{ ...GENERIC_CONTEXT_SNAPSHOT.relations[0], targetPersonId: 'person-3' }],
    }],
    ['relation Matter parent mismatch', {
      ...GENERIC_CONTEXT_SNAPSHOT,
      relations: [{ ...GENERIC_CONTEXT_SNAPSHOT.relations[0], matterId: 'matter-other-customer' }],
    }],
  ])('rejects a referentially open snapshot: %s', (_label, snapshot) => {
    expect(CrmContextSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });
});

describe('generic CRM commands', () => {
  it('publishes a create-only Customer command surface and a non-sensitive receipt', () => {
    const command = {
      type: 'CREATE_CUSTOMER',
      customer: {
        id: NEW_CUSTOMER_ID,
        name: '远山制造',
        categoryKey: 'strategic_partner',
        primaryOwnerUserId: 'user-cao',
      },
    } as const;
    expect(CustomerCreateCommandSchema.parse(command)).toEqual(command);
    expect(CustomerCreateCommandSchema.safeParse({
      type: 'UPDATE_CUSTOMER',
      customerId: NEW_CUSTOMER_ID,
      baseVersion: 0,
      patch: { name: '不得从创建入口更新' },
    }).success).toBe(false);
    expect(CustomerCreateCommandSchema.safeParse({
      ...command,
      customer: { ...command.customer, customerType: 1 },
    }).success).toBe(false);

    const receipt = {
      customerId: NEW_CUSTOMER_ID,
      categoryKey: 'strategic_partner',
      primaryOwnerUserId: 'user-cao',
      version: 0,
      undoable: false,
    } as const;
    expect(CustomerCommandReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(CustomerCommandReceiptSchema.safeParse({ ...receipt, name: '不得进入幂等摘要' }).success).toBe(false);
  });

  it('routes only Commitment commands and keeps replay receipts free of business text', () => {
    expect(CommitmentCommandSchema.safeParse({
      type: 'CREATE_COMMITMENT', commitment: COMMITMENT_CREATE_INPUT,
    }).success).toBe(true);
    expect(CommitmentCommandSchema.safeParse({
      type: 'CREATE_CUSTOMER', customer: { id: NEW_CUSTOMER_ID, name: '远山制造' },
    }).success).toBe(false);
    const receipt = {
      commitmentId: NEW_COMMITMENT_ID,
      customerId: 'legacy-account-1',
      matterId: 'legacy-opportunity-1',
      executionStatus: 'planned',
      confirmationStatus: 'pending',
      version: 0,
      scheduleVersion: 0,
      nextCommitmentId: null,
      linkedFromCommitmentId: null,
      undoable: false,
      repairCommands: ['RESCHEDULE_COMMITMENT', 'CANCEL_COMMITMENT'],
    };
    expect(CommitmentCommandReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(CommitmentCommandReceiptSchema.safeParse({ ...receipt, title: '不得进入幂等摘要' }).success).toBe(false);
    const command = CommitmentCommandSchema.parse({
      type: 'CREATE_COMMITMENT', commitment: COMMITMENT_CREATE_INPUT,
    });
    expect(commitmentReceiptMatchesCommand(CommitmentCommandReceiptSchema.parse(receipt), command)).toBe(true);
    expect(commitmentReceiptMatchesCommand(CommitmentCommandReceiptSchema.parse({
      ...receipt, commitmentId: NEXT_COMMITMENT_ID,
    }), command)).toBe(false);
    expect(commitmentReceiptMatchesCommand(CommitmentCommandReceiptSchema.parse({
      ...receipt, repairCommands: [],
    }), command)).toBe(false);
  });

  it('composes inline Customer and Commitment creation without permitting partial or cross-customer payloads', () => {
    const commitment = {
      type: 'CREATE_COMMITMENT' as const,
      commitment: {
        ...COMMITMENT_CREATE_INPUT,
        customerId: NEW_CUSTOMER_ID,
        matterId: null,
        personId: null,
        kind: 'follow_up',
        source: 'manual_quick_capture',
        sourceRef: null,
        hypothesisRef: null,
      },
    };
    const createInline = {
      customer: {
        mode: 'create' as const,
        command: {
          type: 'CREATE_CUSTOMER' as const,
          customer: {
            id: NEW_CUSTOMER_ID,
            name: '远山制造',
            categoryKey: null,
            primaryOwnerUserId: 'user-cao',
          },
        },
      },
      commitment,
    };
    expect(QuickCaptureCommandSchema.parse(createInline)).toEqual(createInline);
    expect(QuickCaptureCommandSchema.safeParse({
      ...createInline,
      commitment: {
        ...commitment,
        commitment: { ...commitment.commitment, customerId: 'legacy-account-1' },
      },
    }).success).toBe(false);
    expect(QuickCaptureCommandSchema.safeParse({
      ...createInline,
      commitment: {
        ...commitment,
        commitment: { ...commitment.commitment, matterId: 'legacy-opportunity-1' },
      },
    }).success).toBe(false);
    expect(QuickCaptureCommandSchema.safeParse({
      ...createInline,
      commitment: {
        ...commitment,
        commitment: { ...commitment.commitment, title: '下'.repeat(201) },
      },
    }).success).toBe(false);
    expect(QuickCaptureCommandSchema.safeParse({
      ...createInline,
      commitment: {
        ...commitment,
        commitment: { ...commitment.commitment, title: '下'.repeat(200) },
      },
    }).success).toBe(true);

    const existing = {
      customer: { mode: 'existing' as const, customerId: 'legacy-account-1' },
      commitment: {
        ...commitment,
        commitment: { ...commitment.commitment, customerId: 'legacy-account-1' },
      },
    };
    expect(QuickCaptureCommandSchema.safeParse(existing).success).toBe(true);
    expect(QuickCaptureCommandSchema.safeParse({
      ...existing,
      commitment: { type: 'COMPLETE_COMMITMENT', customerId: 'legacy-account-1' },
    }).success).toBe(false);

    const receipt = {
      customer: {
        customerId: NEW_CUSTOMER_ID,
        categoryKey: null,
        primaryOwnerUserId: 'user-cao',
        version: 0,
        undoable: false,
      },
      commitment: {
        commitmentId: NEW_COMMITMENT_ID,
        customerId: NEW_CUSTOMER_ID,
        matterId: null,
        executionStatus: 'planned',
        confirmationStatus: 'not_required',
        version: 0,
        scheduleVersion: 0,
        nextCommitmentId: null,
        linkedFromCommitmentId: null,
        undoable: false,
        repairCommands: ['RESCHEDULE_COMMITMENT', 'CANCEL_COMMITMENT'],
      },
    };
    expect(QuickCaptureCommandReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(QuickCaptureCommandReceiptSchema.safeParse({ ...receipt, title: '不得进入幂等摘要' }).success).toBe(false);
  });

  it('keeps Quick Capture provenance and schedule fields authoritative', () => {
    const valid = {
      customer: { mode: 'existing' as const, customerId: 'legacy-account-1' },
      commitment: {
        type: 'CREATE_COMMITMENT' as const,
        commitment: {
          ...COMMITMENT_CREATE_INPUT,
          customerId: 'legacy-account-1',
          matterId: null,
          personId: null,
          kind: 'follow_up',
          scheduledAtUtc: '2026-08-25T02:00:00Z',
          dueAtUtc: null,
          isAllDay: false,
          localDate: null,
          source: 'manual_quick_capture',
          sourceRef: null,
        },
      },
    };
    expect(QuickCaptureCommandSchema.safeParse(valid).success).toBe(true);
    for (const patch of [
      { kind: 'meeting' },
      { source: 'imported' },
      { sourceRef: 'forged-source' },
      { scheduledAtUtc: null },
      { dueAtUtc: '2026-08-25T03:00:00Z' },
      { isAllDay: true, localDate: '2026-08-25', scheduledAtUtc: null },
    ]) {
      expect(QuickCaptureCommandSchema.safeParse({
        ...valid,
        commitment: {
          ...valid.commitment,
          commitment: { ...valid.commitment.commitment, ...patch },
        },
      }).success).toBe(false);
    }
  });

  it('bounds new Customer names at the shared command boundary', () => {
    const customer = {
      id: NEW_CUSTOMER_ID,
      name: '客'.repeat(120),
      categoryKey: null,
      primaryOwnerUserId: 'user-cao',
    };
    expect(CustomerCreateCommandSchema.safeParse({ type: 'CREATE_CUSTOMER', customer }).success).toBe(true);
    expect(CustomerCreateCommandSchema.safeParse({
      type: 'CREATE_CUSTOMER',
      customer: { ...customer, name: '客'.repeat(121) },
    }).success).toBe(false);
  });

  it('lives beside, rather than widening, the 51-command legacy Action contract', () => {
    expect(ACTION_TYPES).toHaveLength(51);
    expect(ActionSchema.options).toHaveLength(51);
    expect(CRM_COMMAND_TYPES).toEqual([
      'CREATE_CUSTOMER', 'UPDATE_CUSTOMER', 'ARCHIVE_CUSTOMER', 'RESTORE_CUSTOMER',
      'CREATE_MATTER', 'UPDATE_MATTER', 'TRANSFER_MATTER_OWNER', 'TRANSITION_MATTER_LIFECYCLE', 'REOPEN_MATTER',
      'ARCHIVE_MATTER', 'RESTORE_MATTER',
      'ADD_MATTER_PARTICIPANT', 'REMOVE_MATTER_PARTICIPANT',
      'CREATE_COMMITMENT', 'RESCHEDULE_COMMITMENT', 'CONFIRM_COMMITMENT',
      'DECLINE_COMMITMENT', 'COMPLETE_COMMITMENT', 'CANCEL_COMMITMENT',
      'MARK_COMMITMENT_MISSED', 'CREATE_NEXT_COMMITMENT', 'RECORD_COMMITMENT_RESULT',
    ]);
    expect(CrmCommandSchema.options).toHaveLength(22);
  });

  it('accepts one real fixture for every generic command', () => {
    const validCommands = [
      { type: 'CREATE_CUSTOMER', customer: { id: NEW_CUSTOMER_ID, name: '远山制造' } },
      { type: 'UPDATE_CUSTOMER', customerId: 'legacy-account-1', baseVersion: 1, patch: { name: '远山制造集团' } },
      { type: 'ARCHIVE_CUSTOMER', customerId: 'legacy-account-1', baseVersion: 2, reason: '停止合作' },
      { type: 'RESTORE_CUSTOMER', customerId: 'legacy-account-1', baseVersion: 3 },
      { type: 'CREATE_MATTER', matter: { id: NEW_MATTER_ID, customerId: 'legacy-account-1', title: '第一次需求交流' } },
      { type: 'UPDATE_MATTER', customerId: 'legacy-account-1', matterId: 'legacy-opportunity-1', baseVersion: 1, patch: { title: '方案交流' } },
      {
        type: 'TRANSFER_MATTER_OWNER', customerId: 'legacy-account-1', matterId: 'legacy-opportunity-1',
        baseVersion: 2, fromOwnerUserId: null, toOwnerUserId: 'user-cao',
      },
      {
        type: 'TRANSITION_MATTER_LIFECYCLE', customerId: 'legacy-account-1', matterId: 'legacy-opportunity-1', baseVersion: 2,
        transition: { from: 'active', to: 'paused', outcomeKey: null, reason: '等待客户预算' },
      },
      {
        type: 'REOPEN_MATTER', customerId: 'legacy-account-1', matterId: 'legacy-opportunity-1', baseVersion: 3,
        expectedLifecycleStatus: 'completed', reopenTo: 'active', reason: '客户项目重新启动',
      },
      { type: 'ARCHIVE_MATTER', customerId: 'legacy-account-1', matterId: 'legacy-opportunity-1', baseVersion: 4, reason: '历史归档' },
      { type: 'RESTORE_MATTER', customerId: 'legacy-account-1', matterId: 'legacy-opportunity-1', baseVersion: 5 },
      { type: 'ADD_MATTER_PARTICIPANT', customerId: 'legacy-account-1', matterId: 'legacy-opportunity-1', personId: 'legacy-person-1' },
      { type: 'REMOVE_MATTER_PARTICIPANT', customerId: 'legacy-account-1', matterId: 'legacy-opportunity-1', personId: 'legacy-person-1' },
      { type: 'CREATE_COMMITMENT', commitment: COMMITMENT_CREATE_INPUT },
      {
        type: 'RESCHEDULE_COMMITMENT', customerId: 'legacy-account-1', commitmentId: 'legacy-plan-action-1',
        baseVersion: 3, expectedScheduleVersion: 2,
        schedule: {
          scheduledAtUtc: '2026-08-26T02:00:00Z', dueAtUtc: null, timeZone: 'Asia/Shanghai',
          isAllDay: false, localDate: null, confirmationDueAtUtc: '2026-08-25T02:00:00Z', requiresConfirmation: true,
        },
      },
      { type: 'CONFIRM_COMMITMENT', customerId: 'legacy-account-1', commitmentId: 'legacy-plan-action-1', baseVersion: 4, expectedScheduleVersion: 3, confirmedAtUtc: '2026-08-25T01:00:00Z' },
      { type: 'DECLINE_COMMITMENT', customerId: 'legacy-account-1', commitmentId: 'legacy-plan-action-1', baseVersion: 4, expectedScheduleVersion: 3, declinedAtUtc: '2026-08-25T01:00:00Z' },
      { type: 'COMPLETE_COMMITMENT', customerId: 'legacy-account-1', commitmentId: 'legacy-plan-action-1', baseVersion: 4, expectedScheduleVersion: 3, completedAtUtc: '2026-08-26T03:00:00Z' },
      { type: 'CANCEL_COMMITMENT', customerId: 'legacy-account-1', commitmentId: 'legacy-plan-action-1', baseVersion: 4, expectedScheduleVersion: 3, canceledAtUtc: '2026-08-25T01:00:00Z', reason: '客户取消' },
      { type: 'MARK_COMMITMENT_MISSED', customerId: 'legacy-account-1', commitmentId: 'legacy-plan-action-1', baseVersion: 4, expectedScheduleVersion: 3, missedAtUtc: '2026-08-26T03:00:00Z' },
      {
        type: 'CREATE_NEXT_COMMITMENT', previousCommitmentId: 'legacy-plan-action-1', expectedPreviousVersion: 4,
        commitment: { ...COMMITMENT_CREATE_INPUT, id: NEXT_COMMITMENT_ID, title: '发送确认后的方案材料' },
      },
      {
        type: 'RECORD_COMMITMENT_RESULT', customerId: 'legacy-account-1', commitmentId: 'legacy-plan-action-1',
        baseVersion: 5, expectedScheduleVersion: 3, result: '客户确认下周继续评审',
      },
    ];
    for (const command of validCommands) expect(CrmCommandSchema.safeParse(command).success, command.type).toBe(true);
  });

  it('keeps first-use Customer and Matter creation free of irrelevant nullable fields', () => {
    expect(CrmCommandSchema.parse({
      type: 'CREATE_CUSTOMER', customer: { id: NEW_CUSTOMER_ID, name: '远山制造' },
    })).toEqual({
      type: 'CREATE_CUSTOMER',
      customer: { id: NEW_CUSTOMER_ID, name: '远山制造', categoryKey: null, primaryOwnerUserId: null },
    });
    expect(CrmCommandSchema.parse({
      type: 'CREATE_MATTER', matter: { id: NEW_MATTER_ID, customerId: 'legacy-account-1', title: '第一次需求交流' },
    })).toEqual({
      type: 'CREATE_MATTER',
      matter: {
        id: NEW_MATTER_ID, customerId: 'legacy-account-1', title: '第一次需求交流',
        kind: 'general', lifecycleStatus: 'active', outcomeKey: null, priority: null,
        targetDate: null, primaryOwnerUserId: null,
      },
    });
  });

  it('always creates a new Matter open and without an outcome', () => {
    expect(CrmCommandSchema.safeParse({
      type: 'CREATE_MATTER',
      matter: {
        id: NEW_MATTER_ID,
        customerId: 'legacy-account-1',
        title: '伪装成新建的历史结果',
        lifecycleStatus: 'completed',
        outcomeKey: 'won',
      },
    }).success).toBe(false);
    expect(CrmCommandSchema.safeParse({
      type: 'CREATE_MATTER',
      matter: {
        id: NEW_MATTER_ID,
        customerId: 'legacy-account-1',
        title: '仍在推进却伪带结果',
        lifecycleStatus: 'active',
        outcomeKey: 'won',
      },
    }).success).toBe(false);
  });

  it('requires opaque ids for new entities while retaining legacy ids in read DTOs and references', () => {
    expect(CrmCommandSchema.safeParse({ type: 'CREATE_CUSTOMER', customer: { id: 'c', name: '短 ID 客户' } }).success).toBe(false);
    expect(CrmCommandSchema.safeParse({ type: 'CREATE_MATTER', matter: { id: 'm', customerId: 'legacy-account-1', title: '短 ID 事项' } }).success).toBe(false);
    expect(CrmCommandSchema.safeParse({
      type: 'CREATE_COMMITMENT', commitment: { ...COMMITMENT_CREATE_INPUT, id: 'x' },
    }).success).toBe(false);
    expect(CustomerV2Schema.safeParse({
      id: 'legacy-account-1', name: '旧客户', categoryKey: null,
      primaryOwnerUserId: null, archivedAt: null, version: 0,
    }).success).toBe(true);
  });

  it('accepts unknown Matter kinds but rejects sales-only fields', () => {
    expect(CrmCommandSchema.safeParse({
      type: 'CREATE_MATTER', matter: {
        id: NEW_MATTER_ID, customerId: 'legacy-account-1', title: '生态伙伴联合推广',
        kind: 'partner_campaign', lifecycleStatus: 'active', outcomeKey: null,
        priority: null, targetDate: null, primaryOwnerUserId: 'user-cao',
      },
    }).success).toBe(true);
    expect(CrmCommandSchema.safeParse({
      type: 'CREATE_MATTER', matter: {
        id: NEW_MATTER_ID, customerId: 'legacy-account-1', title: '销售项目', kind: 'sales_opportunity',
        lifecycleStatus: 'active', outcomeKey: null, priority: null, targetDate: null,
        primaryOwnerUserId: 'user-cao', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项',
      },
    }).success).toBe(false);
    expect(CrmCommandSchema.safeParse({
      type: 'CREATE_COMMITMENT', commitment: { ...COMMITMENT_CREATE_INPUT, gapItem: 'C4', scripts: '固定话术' },
    }).success).toBe(false);
  });

  it('keeps lifecycle and ownership changes out of the generic Matter patch', () => {
    for (const matterPatch of [
      { lifecycleStatus: 'active' }, { outcomeKey: 'won' }, { primaryOwnerUserId: 'user-other' },
    ]) {
      expect(CrmCommandSchema.safeParse({
        type: 'UPDATE_MATTER', customerId: 'legacy-account-1', matterId: 'legacy-opportunity-1',
        baseVersion: 2, patch: matterPatch,
      }).success).toBe(false);
    }
  });

  it('requires an explicit owner change and Matter version for ownership transfer', () => {
    expect(CrmCommandSchema.safeParse({
      type: 'TRANSFER_MATTER_OWNER', customerId: 'legacy-account-1', matterId: 'legacy-opportunity-1',
      baseVersion: 2, fromOwnerUserId: null, toOwnerUserId: 'user-cao',
    }).success).toBe(true);
    expect(CrmCommandSchema.safeParse({
      type: 'TRANSFER_MATTER_OWNER', customerId: 'legacy-account-1', matterId: 'legacy-opportunity-1',
      fromOwnerUserId: null, toOwnerUserId: 'user-cao',
    }).success).toBe(false);
    expect(CrmCommandSchema.safeParse({
      type: 'TRANSFER_MATTER_OWNER', customerId: 'legacy-account-1', matterId: 'legacy-opportunity-1',
      baseVersion: 2, fromOwnerUserId: 'user-cao', toOwnerUserId: 'user-cao',
    }).success).toBe(false);
    expect(CrmCommandSchema.safeParse({
      type: 'TRANSFER_MATTER_OWNER', customerId: 'legacy-account-1', matterId: 'legacy-opportunity-1',
      baseVersion: 2, fromOwnerUserId: null, toOwnerUserId: null,
    }).success).toBe(false);
  });

  it('publishes an actionable owner queue contract with the transfer CAS version', () => {
    expect(MatterOwnerAssignmentReportSchema.safeParse({
      pageMatterCount: 1,
      pageAssignedCount: 0,
      pageUnassignedCount: 1,
      queue: [{
        tenantId: 'tenant-1', customerId: 'customer-1', matterId: 'matter-1', baseVersion: 4,
        currentOwnerUserId: null, suggestedOwnerUserId: 'user-1', reason: 'account_owner_suggestion',
      }],
      nextCursor: null,
    }).success).toBe(true);
    expect(MatterOwnerAssignmentReportSchema.safeParse({
      pageMatterCount: 1,
      pageAssignedCount: 0,
      pageUnassignedCount: 1,
      queue: [{
        tenantId: 'tenant-1', customerId: 'customer-1', matterId: 'matter-1',
        currentOwnerUserId: null, suggestedOwnerUserId: 'user-1', reason: 'account_owner_suggestion',
      }],
      nextCursor: null,
    }).success).toBe(false);
    expect(MatterOwnerAssignmentReportSchema.safeParse({
      pageMatterCount: 2, pageAssignedCount: 0, pageUnassignedCount: 1, queue: [], nextCursor: null,
    }).success).toBe(false);
    expect(MatterOwnerAssignmentReportSchema.safeParse({
      pageMatterCount: 1, pageAssignedCount: 0, pageUnassignedCount: 1, queue: [], nextCursor: null,
    }).success).toBe(false);
  });

  it('requires an explicit legal lifecycle transition and an audited reopen reason', () => {
    expect(CrmCommandSchema.safeParse({
      type: 'TRANSITION_MATTER_LIFECYCLE', customerId: 'legacy-account-1', matterId: 'legacy-opportunity-1', baseVersion: 2,
      transition: { from: 'completed', to: 'active', outcomeKey: null, reason: '隐式重开' },
    }).success).toBe(false);
    expect(CrmCommandSchema.safeParse({
      type: 'TRANSITION_MATTER_LIFECYCLE', customerId: 'legacy-account-1', matterId: 'legacy-opportunity-1', baseVersion: 2,
      transition: { from: 'active', to: 'active', outcomeKey: null, reason: null },
    }).success).toBe(false);
    expect(CrmCommandSchema.safeParse({
      type: 'REOPEN_MATTER', customerId: 'legacy-account-1', matterId: 'legacy-opportunity-1', baseVersion: 2,
      expectedLifecycleStatus: 'completed', reopenTo: 'active', reason: '',
    }).success).toBe(false);
  });

  it('rejects cross-customer and self-referential next-commitment links', () => {
    expect(CrmCommandSchema.safeParse({
      type: 'CREATE_NEXT_COMMITMENT', customerId: 'different-customer',
      previousCommitmentId: 'legacy-plan-action-1', expectedPreviousVersion: 4,
      commitment: { ...COMMITMENT_CREATE_INPUT, id: NEXT_COMMITMENT_ID },
    }).success).toBe(false);
    expect(CrmCommandSchema.safeParse({
      type: 'CREATE_NEXT_COMMITMENT', previousCommitmentId: NEXT_COMMITMENT_ID, expectedPreviousVersion: 4,
      commitment: { ...COMMITMENT_CREATE_INPUT, id: NEXT_COMMITMENT_ID },
    }).success).toBe(false);
  });

  it('requires schedule-version concurrency and consistent confirmation scheduling', () => {
    expect(CrmCommandSchema.safeParse({
      type: 'RESCHEDULE_COMMITMENT', customerId: 'legacy-account-1', commitmentId: 'legacy-plan-action-1', baseVersion: 3,
      schedule: {
        scheduledAtUtc: '2026-08-26T02:00:00Z', dueAtUtc: null, timeZone: 'Asia/Shanghai',
        isAllDay: false, localDate: null, confirmationDueAtUtc: '2026-08-25T02:00:00Z', requiresConfirmation: true,
      },
    }).success).toBe(false);
    expect(CrmCommandSchema.safeParse({
      type: 'RESCHEDULE_COMMITMENT', customerId: 'legacy-account-1', commitmentId: 'legacy-plan-action-1',
      baseVersion: 3, expectedScheduleVersion: 2,
      schedule: {
        scheduledAtUtc: '2026-08-26T02:00:00Z', dueAtUtc: null, timeZone: 'Asia/Shanghai',
        isAllDay: false, localDate: null, confirmationDueAtUtc: '2026-08-25T02:00:00Z', requiresConfirmation: false,
      },
    }).success).toBe(false);
  });
});
