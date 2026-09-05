import { describe, expect, it } from 'vitest';
import type { PersonalWorkbenchList } from '@jianghu/domain-contracts';
import { selectPersonalMatters } from './personalWorkbench';

const entry = (id: string, fields: Partial<PersonalWorkbenchList['entries'][number]> = {}): PersonalWorkbenchList['entries'][number] => ({
  matter: { id, customerId: 'c1', title: id, kind: 'opportunity', lifecycleStatus: 'active', outcomeKey: null, primaryOwnerUserId: 'u1', priority: null, targetDate: null, archivedAt: null, version: 0 },
  customerName: '滨海集团', customerBusinessGoal: '缩短项目协作周期', salesProgress: null, nextCommitment: null, keyGap: null, ...fields,
});

describe('personal opportunity list', () => {
  it('keeps an unassessed lead on the same identity and separates arbitrary stage text from filter sentinels', () => {
    const rows = [entry('lead'), entry('named', { salesProgress: 'unassessed' }), entry('other', { salesProgress: 'all' })];
    expect(selectPersonalMatters(rows, '', 'active', 'unassessed').map(x => x.matter.id)).toEqual(['lead']);
    expect(selectPersonalMatters(rows, '', 'all', 'stage:all').map(x => x.matter.id)).toEqual(['other']);
    expect(selectPersonalMatters(rows, '协作', 'active', 'stage:unassessed').map(x => x.matter.id)).toEqual(['named']);
    expect(rows.map(x => x.matter.id)).toEqual(['lead', 'named', 'other']);
  });
  it('keeps paused and completed records discoverable while putting a manual priority first', () => {
    const rows = [entry('normal'), entry('focus'), entry('paused')];
    rows[1].matter.priority = 'high'; rows[2].matter.lifecycleStatus = 'paused';
    expect(selectPersonalMatters(rows, '', 'active', 'all').map(x => x.matter.id)).toEqual(['focus', 'normal']);
    expect(selectPersonalMatters(rows, '滨海', 'paused', 'all').map(x => x.matter.id)).toEqual(['paused']);
    expect(rows[0].matter.id).toBe('normal');
  });
});
