import { describe, expect, it } from 'vitest';
import { ACTION_TYPES, ActionSchema, ActorRoleSchema } from '../src/index.js';

const EXPECTED_ACTION_TYPES = [
  'ADD_ACCOUNT', 'UPDATE_ACCOUNT', 'DELETE_ACCOUNT',
  'ADD_OPP', 'UPDATE_OPP', 'DELETE_OPP',
  'ADD_PERSON', 'UPDATE_PERSON', 'MOVE_PERSON', 'DELETE_PERSON', 'ADD_LOG',
  'SET_ROLE', 'REMOVE_ROLE', 'ADD_OPP_MEMBER', 'REMOVE_OPP_MEMBER',
  'ADD_EDGE', 'UPDATE_EDGE', 'DELETE_EDGE',
  'ADD_BI', 'UPDATE_BI', 'DELETE_BI',
  'ADD_UCV', 'UPDATE_UCV', 'DELETE_UCV',
  'ADD_VISIT', 'UPDATE_VISIT', 'DELETE_VISIT',
  'ADD_NOTE', 'UPDATE_NOTE', 'DELETE_NOTE',
  'ADD_PLAN_ACTION', 'UPDATE_PLAN_ACTION', 'DELETE_PLAN_ACTION', 'TOGGLE_PLAN_ACTION',
  'ADD_MILESTONE', 'UPDATE_MILESTONE', 'DELETE_MILESTONE',
  'ADD_OPP_STAGE', 'UPDATE_OPP_STAGE', 'DELETE_OPP_STAGE',
  'ADD_STRATEGY_CARD', 'UPDATE_STRATEGY_CARD', 'DELETE_STRATEGY_CARD',
  'ADD_STRATEGY_RISK', 'UPDATE_STRATEGY_RISK', 'DELETE_STRATEGY_RISK',
  'ADD_STRATEGY_RESOURCE', 'UPDATE_STRATEGY_RESOURCE', 'DELETE_STRATEGY_RESOURCE',
  'ADD_EVIDENCE', 'DELETE_EVIDENCE',
] as const;

describe('ActionSchema', () => {
  it('covers exactly the 51 server mutation commands', () => {
    expect(ACTION_TYPES).toEqual(EXPECTED_ACTION_TYPES);
    expect(ACTION_TYPES).toHaveLength(51);
    expect(ActionSchema.options).toHaveLength(51);
  });

  it('rejects missing required entity fields', () => {
    expect(ActionSchema.safeParse({ type: 'ADD_PERSON', person: {} }).success).toBe(false);
  });

  it('accepts explicit stable ownership and rejects bulk person log replacement', () => {
    expect(ActionSchema.safeParse({ type: 'UPDATE_ACCOUNT', accId: 'a', patch: { primaryOwner: '同名', primaryOwnerUserId: 'user-1' } }).success).toBe(true);
    expect(ActionSchema.safeParse({ type: 'UPDATE_PERSON', accId: 'a', personId: 'p', patch: { logs: [] } }).success).toBe(false);
  });

  it('rejects the legacy TB role', () => {
    expect(ActionSchema.safeParse({
      type: 'SET_ROLE',
      accId: 'a',
      oppId: 'o',
      personId: 'p',
      patch: { role: 'TB' },
    }).success).toBe(false);
  });

  it('rejects machine-origin evidence forged as approved', () => {
    expect(ActionSchema.safeParse({
      type: 'ADD_EVIDENCE',
      accId: 'a',
      oppId: 'o',
      evidence: {
        id: 'e',
        personId: 'p',
        signalKey: 'decision_support',
        direction: 1,
        tier: 'strong',
        rawContent: 'model-derived claim',
        occurredAt: '2026-07-12',
        status: 'approved',
        origin: 'ai',
      },
    }).success).toBe(false);
  });

  it('rejects unknown fields recursively', () => {
    expect(ActionSchema.safeParse({
      type: 'ADD_PERSON',
      accId: 'a',
      person: {
        id: 'p',
        name: 'Person',
        title: 'Director',
        form: {
          family: '',
          occupation: '',
          recreation: '',
          moneyMotivation: '',
          family7: { '籍贯': '', forged: 'hidden' },
        },
      },
    }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: 'DELETE_ACCOUNT', accId: 'a', forged: true }).success).toBe(false);
    expect(ActionSchema.safeParse({
      type: 'UPDATE_OPP', accId: 'a', oppId: 'o', patch: { meta: { forged: () => 'not JSON' } },
    }).success).toBe(false);
    expect(ActionSchema.safeParse({
      type: 'ADD_NOTE', accId: 'a', note: { id: 'n', accountId: 'other-account', content: 'note' },
    }).success).toBe(false);
  });

  it.each([
    ['ADD_VISIT', { type: 'ADD_VISIT', accId: 'a', visit: { id: 'v', date: '2026-07-12', topic: 'Visit', summary: 'Summary', createdBy: 'forged-user' } }],
    ['ADD_NOTE', { type: 'ADD_NOTE', accId: 'a', note: { id: 'n', content: 'Note', createdBy: 'forged-user' } }],
    ['ADD_PLAN_ACTION', { type: 'ADD_PLAN_ACTION', accId: 'a', oppId: 'o', planAction: { id: 'pa', title: 'Plan', startDate: '2026-07-12', endDate: '2026-07-12', half: 'am', done: false, createdBy: 'forged-user' } }],
  ])('rejects server-owned createdBy in %s', (_type, action) => {
    expect(ActionSchema.safeParse(action).success).toBe(false);
  });

  it('rejects client-supplied account _mcpOrigin provenance', () => {
    expect(ActionSchema.safeParse({
      type: 'ADD_ACCOUNT',
      account: {
        id: 'a',
        name: 'Account',
        customerType: 2,
        profile: { business: 'Business', _mcpOrigin: { source: 'client', at: 'forged', needsReview: false } },
      },
    }).success).toBe(false);
  });

  it('accepts representative valid commands, including an account-level edge', () => {
    const valid = [
      { type: 'ADD_ACCOUNT', account: { id: 'a', name: 'Account', customerType: 2 } },
      { type: 'SET_ROLE', accId: 'a', oppId: 'o', personId: 'p', patch: { role: 'R', sentiment: 'plus' } },
      { type: 'ADD_EDGE', accId: 'a', edge: { id: 'e', source: 'p1', target: 'p2', layer: 'L1', label: '汇报' } },
      {
        type: 'ADD_EVIDENCE', accId: 'a', oppId: 'o',
        evidence: { id: 'e', personId: 'p', signalKey: 'signal', direction: 1, tier: 'mid', status: 'approved', origin: 'manual' },
      },
      {
        type: 'ADD_EVIDENCE', accId: 'a', oppId: 'o',
        evidence: { id: 'e2', personId: 'p', signalKey: 'signal', direction: -1, tier: 'weak', status: 'pending_review', origin: 'recording' },
      },
    ];
    for (const action of valid) expect(ActionSchema.safeParse(action).success).toBe(true);
  });
});

describe('ActorRoleSchema', () => {
  it('accepts only trusted application roles', () => {
    expect(ActorRoleSchema.safeParse('owner').success).toBe(true);
    expect(ActorRoleSchema.safeParse('root').success).toBe(false);
  });
});
