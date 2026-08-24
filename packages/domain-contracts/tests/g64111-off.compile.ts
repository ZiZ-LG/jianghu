import type {
  CommitmentV2,
  CrmCommandInput,
  CrmContextSnapshot,
  CustomerV2,
  MatterV2,
} from '../src/index.js';

export const lightweightCreateFixture: CrmCommandInput = {
  type: 'CREATE_MATTER',
  matter: {
    id: 'matter_00000000000000000000000000000002',
    customerId: 'customer-1',
    title: '只需标题的通用事项',
  },
};

export const g64111OffFixture: {
  customer: CustomerV2;
  matter: MatterV2;
  commitment: CommitmentV2;
} = {
  customer: {
    id: 'customer-1',
    name: '通用客户',
    categoryKey: null,
    primaryOwnerUserId: 'user-1',
    archivedAt: null,
    version: 0,
  },
  matter: {
    id: 'matter-1',
    customerId: 'customer-1',
    title: '通用事项',
    kind: 'general',
    lifecycleStatus: 'active',
    outcomeKey: null,
    priority: null,
    targetDate: null,
    primaryOwnerUserId: 'user-1',
    archivedAt: null,
    version: 0,
  },
  commitment: {
    id: 'commitment-1',
    customerId: 'customer-1',
    matterId: 'matter-1',
    personId: null,
    title: '确认下一步',
    kind: 'message',
    ownerUserId: 'user-1',
    executionStatus: 'planned',
    confirmationStatus: 'not_required',
    scheduledAtUtc: null,
    dueAtUtc: '2026-08-25T02:00:00Z',
    timeZone: 'Asia/Shanghai',
    isAllDay: false,
    localDate: null,
    confirmationDueAtUtc: null,
    confirmedAtUtc: null,
    confirmedByUserId: null,
    scheduleVersion: 0,
    nextCommitmentId: null,
    source: 'manual',
    sourceRef: null,
    archivedAt: null,
    version: 0,
  },
};

export const g64111OffContextFixture: CrmContextSnapshot = {
  generatedAtUtc: '2026-08-23T23:50:00Z',
  customers: [g64111OffFixture.customer],
  matters: [g64111OffFixture.matter],
  people: [{
    id: 'person-1', customerId: 'customer-1', name: '联系人', title: null,
    archivedAt: null, version: 0,
  }],
  matterParticipants: [{
    id: 'participant-1', customerId: 'customer-1', matterId: 'matter-1', personId: 'person-1',
  }],
  relations: [{
    id: 'relation-1', customerId: 'customer-1', matterId: 'matter-1',
    sourcePersonId: 'person-1', targetPersonId: 'person-1', kind: 'introduced_by',
    label: null, directed: false, version: 0,
  }],
};
