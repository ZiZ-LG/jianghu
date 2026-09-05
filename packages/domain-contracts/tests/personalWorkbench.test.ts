import { describe, expect, it } from 'vitest';
import { PersonalWorkbenchCommandSchema } from '../src/personalWorkbench.js';

const matter = { type: 'CREATE_PERSONAL_MATTER', customerId: 'customer', matterId: 'matter_1234567890abcdef1234567890abcdef',
  title: '  项目平台  ', customerBusinessGoal: null, salesProgress: null, priority: null };
describe('personal command transport', () => {
  it('keeps unknown goal and stage explicit, with no automatic methodology assignment', () => {
    expect(PersonalWorkbenchCommandSchema.parse(matter)).toEqual({ ...matter, title: '项目平台' });
  });
  it.each(['tenantId', 'actorId', 'assertionMode', 'pipelineStage', 'winProbability', 'acceptedByAgent'])('rejects injected %s fields', key => {
    expect(PersonalWorkbenchCommandSchema.safeParse({ ...matter, [key]: 'forged' }).success).toBe(false);
  });
  it('rejects empty updates, invalid versions and unbounded stages', () => {
    const update = { type: 'UPDATE_PERSONAL_MATTER', customerId: 'customer', matterId: 'matter', baseVersion: 0, patch: {} };
    expect(PersonalWorkbenchCommandSchema.safeParse(update).success).toBe(false);
    expect(PersonalWorkbenchCommandSchema.safeParse({ ...update, baseVersion: -1, patch: { salesProgress: '阶段' } }).success).toBe(false);
    expect(PersonalWorkbenchCommandSchema.safeParse({ ...update, patch: { salesProgress: '长'.repeat(41) } }).success).toBe(false);
  });
});
