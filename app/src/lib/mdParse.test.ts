import { describe, it, expect } from 'vitest';
import type { Account, Opportunity, VisitNote } from '../types';
import { renderCustomerMd, renderOpportunityMd, renderVisitMd } from './mdProfile';
import { parseCustomerMd, parseOpportunityMd, parseVisitMd, diffCustomer, diffOpportunity, diffVisit } from './mdParse';
import { seedAccount } from '../data/seed';

// 字段齐全的 fixture：用于严格往返保真测试（render → parse 必须无损还原归一值）。
// p1=关键人(D，渲染 FORM 段) / p2=普通使用者(U，不渲染 FORM)。
function fixture(): Account {
  return {
    id: 'a1', name: '测试电力集团', customerType: 4,
    region: '西北大区', group: '母公司甲', primaryOwner: '张销售',
    profile: { business: '注册一个亿', group: '控股乙', bidding: '在招三个', risk: '暂无风险', ourCooperation: '已签两单', salesNote: '战略客户', aiSuggestion: 'AI参考保留勿丢' },
    persons: [
      { id: 'p1', name: '王拍板', title: '总工', orgLevel: 1, form: { family: '', occupation: '二十年电力', recreation: '高尔夫', moneyMotivation: '求晋升', family7: { 籍贯: '陕西', 年纪: '五十' } }, logs: [], x: 0, y: 0, version: 3 },
      { id: 'p2', name: '李使用', title: '工程师', orgLevel: 3, form: { family: '', occupation: '', recreation: '', moneyMotivation: '', family7: {} }, logs: [], x: 0, y: 0, version: 0 },
    ],
    baseEdges: [],
    opportunities: [{
      id: 'o1', accountId: 'a1', name: '一期管控平台', customerType: 4,
      pipelineStage: '招投标', engageStage: '招标论证',
      singleSalesGoal: '拿下一期项目', customerBusinessGoal: '整体降本', buyingMotivation: '考核压力',
      competitor: '友商甲', competitiveSituation: '领先',
      winProbability: 60, expectedSignDate: '2026-09-01', expectedAmountW: 800, productSolution: '一体化平台方案',
      c3Items: { 立项原因: true, 项目预算: true }, c5Items: { 招标参数: true },
      roles: [
        { personId: 'p1', role: 'D', sentiment: 'plus', confidence: '明确' },
        { personId: 'p2', role: 'U', sentiment: 'neutral', confidence: '推理' },
      ],
      bis: [], ucvs: [], edges: [], version: 5,
    }],
  };
}

describe('mdParse · 往返保真（render → parse 无损还原，幂等红线）', () => {
  const acc = fixture();
  const opp = acc.opportunities[0];

  it('客户：region/group/primaryOwner + profile 六字段还原', () => {
    const p = parseCustomerMd(renderCustomerMd(acc, []));
    expect(p.account).toEqual({ region: '西北大区', group: '母公司甲', primaryOwner: '张销售' });
    expect(p.profile).toEqual({ business: '注册一个亿', group: '控股乙', bidding: '在招三个', risk: '暂无风险', ourCooperation: '已签两单', salesNote: '战略客户' });
  });

  it('关键人 FORM 还原 + 携带锚点 version；非关键人不出 FORM 段', () => {
    const p = parseCustomerMd(renderCustomerMd(acc, []));
    expect(p.forms).toHaveLength(1);
    const f = p.forms[0];
    expect(f.id).toBe('p1');
    expect(f.version).toBe(3);
    expect(f.occupation).toBe('二十年电力');
    expect(f.recreation).toBe('高尔夫');
    expect(f.moneyMotivation).toBe('求晋升');
    expect(f.family7['籍贯']).toBe('陕西');
    expect(f.family7['年纪']).toBe('五十');
    expect(f.family7['配偶']).toBe(''); // 未填 → 占位符归一为空
  });

  it('商机：meta 文本/枚举/数值 + c3/c5 勾选 + productSolution + version 还原', () => {
    const p = parseOpportunityMd(renderOpportunityMd(acc, opp, []));
    expect(p.version).toBe(5);
    expect(p.meta.singleSalesGoal).toBe('拿下一期项目');
    expect(p.meta.customerBusinessGoal).toBe('整体降本');
    expect(p.meta.buyingMotivation).toBe('考核压力');
    expect(p.meta.competitor).toBe('友商甲');
    expect(p.meta.competitiveSituation).toBe('领先');
    expect(p.meta.winProbability).toBe(60);
    expect(p.meta.expectedSignDate).toBe('2026-09-01');
    expect(p.meta.expectedAmountW).toBe(800);
    expect(p.strategy.productSolution).toBe('一体化平台方案');
    expect(p.c3['立项原因']).toBe(true);
    expect(p.c3['项目名称']).toBe(false); // 未勾
    expect(p.c5['招标参数']).toBe(true);
    expect(p.c5['评标规则']).toBe(false);
  });

  it('拜访：topic + 多行 summary 还原', () => {
    const visit: VisitNote = { id: 'v1', accountId: 'a1', date: '2026-06-10', topic: '技术交流会', summary: '第一段共识。\n第二段待跟进。', participants: [{ name: '我', side: 'our' }, { name: '王拍板', side: 'customer' }] };
    const p = parseVisitMd(renderVisitMd(acc, visit));
    expect(p.topic).toBe('技术交流会');
    expect(p.summary).toBe('第一段共识。\n第二段待跟进。');
  });
});

describe('mdParse · 编辑后 diff 生成正确 Action', () => {
  it('改 region → 单个 UPDATE_ACCOUNT patch.region', () => {
    const acc = fixture();
    const edited = renderCustomerMd(acc, []).replace('**大区**：西北大区', '**大区**：华北大区');
    const { actions } = diffCustomer(acc, edited);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'UPDATE_ACCOUNT', accId: 'a1', patch: { region: '华北大区' } });
  });

  it('改 profile.business → patch.profile 整体替换且保留未解析的 aiSuggestion', () => {
    const acc = fixture();
    const edited = renderCustomerMd(acc, []).replace('注册一个亿', '注册两个亿');
    const { actions } = diffCustomer(acc, edited);
    expect(actions).toHaveLength(1);
    const patch = (actions[0] as any).patch;
    expect(patch.profile.business).toBe('注册两个亿');
    expect(patch.profile.aiSuggestion).toBe('AI参考保留勿丢'); // 关键：合并落库不丢未解析字段
    expect(patch.profile.salesNote).toBe('战略客户');
  });

  it('改关键人 FORM → UPDATE_PERSON patch.form 带 baseVersion，保留 family 原字段', () => {
    const acc = fixture();
    const edited = renderCustomerMd(acc, []).replace('二十年电力', '二十五年新能源');
    const { actions } = diffCustomer(acc, edited);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'UPDATE_PERSON', personId: 'p1', baseVersion: 3 });
    const form = (actions[0] as any).patch.form;
    expect(form.occupation).toBe('二十五年新能源');
    expect(form.family7['籍贯']).toBe('陕西'); // 未改的还在
    expect(form.recreation).toBe('高尔夫');
  });

  it('改商机文本 → UPDATE_OPP 带 baseVersion=5', () => {
    const acc = fixture(); const opp = acc.opportunities[0];
    const edited = renderOpportunityMd(acc, opp, []).replace('拿下一期项目', '拿下整个三期');
    const { actions } = diffOpportunity(acc, opp, edited);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'UPDATE_OPP', oppId: 'o1', baseVersion: 5, patch: { singleSalesGoal: '拿下整个三期' } });
  });

  it('勾选 C3 项 → patch.c3Items 合并已有 true 项', () => {
    const acc = fixture(); const opp = acc.opportunities[0];
    const edited = renderOpportunityMd(acc, opp, []).replace(/(\| 项目名称 \| )⏳ 待补充/, '$1✅ 已掌握');
    const { actions } = diffOpportunity(acc, opp, edited);
    expect(actions).toHaveLength(1);
    const c3 = (actions[0] as any).patch.c3Items;
    expect(c3['项目名称']).toBe(true);  // 新勾
    expect(c3['立项原因']).toBe(true);  // 原有保留
    expect(c3['项目预算']).toBe(true);  // 原有保留
  });

  it('改赢单概率（数值）→ patch.winProbability', () => {
    const acc = fixture(); const opp = acc.opportunities[0];
    const edited = renderOpportunityMd(acc, opp, []).replace('**赢单概率(销售自评)**：60%', '**赢单概率(销售自评)**：85%');
    const { actions } = diffOpportunity(acc, opp, edited);
    expect((actions[0] as any).patch.winProbability).toBe(85);
  });

  it('改拜访纪要 → UPDATE_VISIT patch.summary', () => {
    const acc = fixture();
    const visit: VisitNote = { id: 'v1', accountId: 'a1', date: '2026-06-10', topic: '技术交流会', summary: '初次接触', participants: [{ name: '我', side: 'our' }] };
    const edited = renderVisitMd(acc, visit).replace('初次接触', '深入交流并达成意向');
    const { actions } = diffVisit(acc, visit, edited);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'UPDATE_VISIT', visitId: 'v1', patch: { summary: '深入交流并达成意向' } });
  });
});

describe('mdParse · 安全性：未编辑无 diff / 占位符不误写', () => {
  it('系统生成的 MD 原样回写 → 零 Action（客户/商机/拜访）', () => {
    const acc = fixture(); const opp = acc.opportunities[0];
    expect(diffCustomer(acc, renderCustomerMd(acc, [])).actions).toEqual([]);
    expect(diffOpportunity(acc, opp, renderOpportunityMd(acc, opp, [])).actions).toEqual([]);
    const visit: VisitNote = { id: 'v1', accountId: 'a1', date: '2026-06-10', topic: 'x', summary: 'y', participants: [] };
    expect(diffVisit(acc, visit, renderVisitMd(acc, visit)).actions).toEqual([]);
  });

  it('占位符「⏳ 待补充」原样保留 → 不会被当成空值写回（buyingMotivation 留空场景）', () => {
    const acc = fixture();
    acc.opportunities[0].buyingMotivation = ''; // 渲染为占位符
    const opp = acc.opportunities[0];
    const md = renderOpportunityMd(acc, opp, []);
    expect(md).toContain('⏳ 待补充');
    expect(diffOpportunity(acc, opp, md).actions).toEqual([]); // 占位符往返不产生 diff
  });

  it('seedAccount 原样回写无 diff（集成回归：解析不抛错、字段不错配）', () => {
    expect(diffCustomer(seedAccount, renderCustomerMd(seedAccount, [])).actions).toEqual([]);
    for (const o of seedAccount.opportunities) {
      expect(diffOpportunity(seedAccount, o, renderOpportunityMd(seedAccount, o, [])).actions).toEqual([]);
    }
  });
});
