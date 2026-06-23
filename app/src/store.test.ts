// 乐观锁（#3 多人协作冲突检测）前端契约单测：
// ① injectBaseVersion 在 dispatch 前正确取出实体当前 version 作 baseVersion；
// ② reducer 对 UPDATE_PERSON/OPP/EDGE 乐观自增 version，保持本地与服务端步调一致。
import { describe, it, expect } from 'vitest';
import { reducer, injectBaseVersion, type Action, type StoreState } from './store';
import type { Account } from './types';

function baseState(): StoreState {
  const acc: Account = {
    id: 'acc1', name: 'A', customerType: 1,
    persons: [{
      id: 'p1', name: '张三', title: '', orgLevel: 3,
      form: { family: '', occupation: '', recreation: '', moneyMotivation: '', family7: {} },
      logs: [], x: 0, y: 0, version: 3,
    }],
    baseEdges: [{ id: 'e1', source: 'p1', target: 'p2', layer: 'L1', label: '', version: 5 }],
    opportunities: [{
      id: 'opp1', accountId: 'acc1', name: 'O', customerType: 1,
      pipelineStage: '线索', engageStage: '需求调研立项', singleSalesGoal: '',
      c3Items: {}, c5Items: {}, roles: [], bis: [], ucvs: [],
      edges: [{ id: 'e2', source: 'p1', target: 'p3', layer: 'L2', label: '', version: 7 }],
      version: 9,
    }],
  };
  return { accounts: [acc] };
}

describe('乐观锁 · injectBaseVersion（dispatch 前取当前版本）', () => {
  it('UPDATE_PERSON 注入 person 当前 version', () => {
    const a = injectBaseVersion(baseState(), { type: 'UPDATE_PERSON', accId: 'acc1', personId: 'p1', patch: { name: '李四' } });
    expect((a as Extract<Action, { type: 'UPDATE_PERSON' }>).baseVersion).toBe(3);
  });
  it('UPDATE_OPP 注入 opp 当前 version', () => {
    const a = injectBaseVersion(baseState(), { type: 'UPDATE_OPP', accId: 'acc1', oppId: 'opp1', patch: { name: 'X' } });
    expect((a as Extract<Action, { type: 'UPDATE_OPP' }>).baseVersion).toBe(9);
  });
  it('UPDATE_EDGE 从 baseEdges 命中并取 version', () => {
    const a = injectBaseVersion(baseState(), { type: 'UPDATE_EDGE', accId: 'acc1', oppId: 'opp1', edgeId: 'e1', patch: { label: 'x' } });
    expect((a as Extract<Action, { type: 'UPDATE_EDGE' }>).baseVersion).toBe(5);
  });
  it('UPDATE_EDGE 从商机 edges 命中并取 version', () => {
    const a = injectBaseVersion(baseState(), { type: 'UPDATE_EDGE', accId: 'acc1', oppId: 'opp1', edgeId: 'e2', patch: { label: 'x' } });
    expect((a as Extract<Action, { type: 'UPDATE_EDGE' }>).baseVersion).toBe(7);
  });
  it('实体不存在时 baseVersion 为 undefined（后端走兼容路径，不误判冲突）', () => {
    const a = injectBaseVersion(baseState(), { type: 'UPDATE_PERSON', accId: 'acc1', personId: 'nope', patch: {} });
    expect((a as Extract<Action, { type: 'UPDATE_PERSON' }>).baseVersion).toBeUndefined();
  });
  it('非 UPDATE 类 action 原样返回（引用不变）', () => {
    const action: Action = { type: 'DELETE_PERSON', accId: 'acc1', personId: 'p1' };
    expect(injectBaseVersion(baseState(), action)).toBe(action);
  });
});

describe('乐观锁 · reducer 乐观自增 version', () => {
  it('UPDATE_PERSON 应用 patch 并 version+1', () => {
    const s = reducer(baseState(), { type: 'UPDATE_PERSON', accId: 'acc1', personId: 'p1', patch: { name: '李四' } });
    const p = s.accounts[0].persons[0];
    expect(p.name).toBe('李四');
    expect(p.version).toBe(4);
  });
  it('UPDATE_OPP version+1', () => {
    const s = reducer(baseState(), { type: 'UPDATE_OPP', accId: 'acc1', oppId: 'opp1', patch: { name: 'X' } });
    expect(s.accounts[0].opportunities[0].version).toBe(10);
  });
  it('UPDATE_EDGE（baseEdges）version+1，其余边不动', () => {
    const s = reducer(baseState(), { type: 'UPDATE_EDGE', accId: 'acc1', oppId: 'opp1', edgeId: 'e1', patch: { label: 'x' } });
    expect(s.accounts[0].baseEdges[0].version).toBe(6);
    expect(s.accounts[0].opportunities[0].edges[0].version).toBe(7); // e2 未改
  });
  it('UPDATE_EDGE（商机 edges）version+1', () => {
    const s = reducer(baseState(), { type: 'UPDATE_EDGE', accId: 'acc1', oppId: 'opp1', edgeId: 'e2', patch: { label: 'x' } });
    expect(s.accounts[0].opportunities[0].edges[0].version).toBe(8);
  });
  it('version 缺省（本地新建实体）时按 0 起增为 1', () => {
    const st = baseState();
    delete (st.accounts[0].persons[0] as { version?: number }).version;
    const s = reducer(st, { type: 'UPDATE_PERSON', accId: 'acc1', personId: 'p1', patch: {} });
    expect(s.accounts[0].persons[0].version).toBe(1);
  });
});
