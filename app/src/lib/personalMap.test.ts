import { describe, expect, it } from 'vitest';
import type { PersonalWorkbenchDetail } from '@jianghu/domain-contracts';
import { RELATIONSHIP_WORKSPACE_FIXTURE as workspace } from '../testFixtures/relationshipWorkspace';
import { personalActionCommand } from './personalMap';

export const personalDetail: PersonalWorkbenchDetail = {
  opportunity: { matter: workspace.matter, customerBusinessGoal: '减少协作等待', salesProgress: null },
  workspace, participants: workspace.people.map(person => ({ personId: person.id, version: 0, decisionRole: null, basis: null, basisState: 'unverified' })),
  availablePeople: workspace.people, commitments: [],
};
const input = { id: 'commitment_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', actorUserId: 'owner-208', personId: 'person-a-208', title: '核实评审时间',
  expectedSignal: '得到明确的评审邀请', localDateTime: '2026-09-06T15:00', timeZone: 'Asia/Shanghai' };

describe('personal action confirmation', () => {
  it('keeps the exact matter, person, purpose, time and signal without changing source data', () => {
    const before = JSON.stringify(personalDetail);
    const command = personalActionCommand(personalDetail, input);
    expect(command.commitment).toMatchObject({ customerId: workspace.customer.id, matterId: workspace.matter.id, personId: input.personId,
      title: input.title, expectedSignal: input.expectedSignal, scheduledAtUtc: '2026-09-06T07:00:00.000Z', hypothesisRef: null });
    expect(JSON.stringify(personalDetail)).toBe(before);
  });
  it('rejects a missing object, mismatched hypothesis and ambiguous daylight-saving time', () => {
    expect(() => personalActionCommand(personalDetail, { ...input, personId: 'hidden-person' })).toThrow('人物已不在当前商机');
    expect(() => personalActionCommand(personalDetail, { ...input, personId: 'person-b-208', hypothesisId: 'hypothesis-208' })).toThrow('判断与行动对象不一致');
    expect(() => personalActionCommand(personalDetail, { ...input, expectedSignal: ' ' })).toThrow('希望得到的结果');
    expect(() => personalActionCommand(personalDetail, { ...input, timeZone: 'America/Los_Angeles', localDateTime: '2026-11-01T01:30' })).toThrow();
  });
  it('binds a verification action to the selected hypothesis revision without confirming the hypothesis', () => {
    const result = personalActionCommand(personalDetail, { ...input, hypothesisId: 'hypothesis-208' });
    expect(result.commitment.hypothesisRef).toEqual({ hypothesisId: 'hypothesis-208', hypothesisRevisionId: 'revision-208' });
    expect(result.commitment.kind).toBe('verification');
    expect(personalDetail.workspace.hypotheses[0].hypothesis.status).toBe('testing');
  });
});
