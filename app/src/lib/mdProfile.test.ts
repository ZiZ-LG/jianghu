import { describe, it, expect } from 'vitest';
import { renderCustomerMd, renderOpportunityMd, renderVisitMd, parseCustomerMd, parseOpportunityMd, parseVisitMd, type VersionLogEntry } from './mdProfile';
import { seedAccount } from '../data/seed';
import type { VisitNote } from '../types';

describe('mdProfile · 客户档案渲染（系统→MD）', () => {
  const md = renderCustomerMd(seedAccount, []);

  it('标题 + 客户名 + 四分类标签（type=4 EPC）', () => {
    expect(md).toContain('西部电力建设集团 · 客户档案');
    expect(md).toContain('EPC总承包商');
    expect(md).toContain('type=4');
  });

  it('ADURC 组织表用新角色口径（C 教练 / R 影响者·技术把关）', () => {
    expect(md).toContain('## 二、ADURC 组织结构');
    expect(md).toContain('孙学文');          // 原 R → 新 C（内应教练）
    expect(md).toContain('C 教练');
    expect(md).toContain('R 影响者·技术把关'); // 原 TB → 新 R（招采/流程把关）
  });

  it('项目机会索引含商机名与趋赢力百分比', () => {
    expect(md).toContain('## 四、项目机会索引');
    expect(md).toContain('西部风光储基地数字化管控平台');
    expect(md).toMatch(/\d+%/);
  });

  it('结构锚点（供块C回写）与默认版本日志 v1.0', () => {
    expect(md).toContain('<!-- f:account.roles -->');
    expect(md).toContain('v1.0');
  });
});

describe('mdProfile · 商机档案渲染（系统→MD）', () => {
  const opp = seedAccount.opportunities[0];
  const md = renderOpportunityMd(seedAccount, opp, []);

  it('商机元信息 + 完整 G64111 打分表', () => {
    expect(md).toContain('西部风光储基地数字化管控平台（商机档案）');
    expect(md).toContain('## 三、G64111 趋赢力打分');
    expect(md).toContain('| 6必清 | C1 |');
    expect(md).toContain('1决胜');
    expect(md).toContain('**合计**');
  });

  it('C3 立项 7 项掌握状态 + 741 推荐打法', () => {
    expect(md).toContain('立项原因');
    expect(md).toMatch(/已掌握|待补充/);
    expect(md).toContain('## 四、竞争态势与策略（741）');
    expect(md).toContain('推荐打法');
  });

  it('趋赢力与态势随系统实时算（与引擎一致）', () => {
    expect(md).toMatch(/趋赢力百分比.*\d+%/);
    expect(md).toMatch(/绝对优势|相对优势|相对劣势|绝对劣势/);
  });
});

describe('mdProfile · 拜访记录渲染 + 版本日志递增', () => {
  it('单条拜访 → .md', () => {
    const visit: VisitNote = {
      id: 'v1', accountId: seedAccount.id, date: '2026-06-01', topic: '信息化部技术交流',
      summary: '与钱大钧就一体化平台达成共识', participants: [{ name: '我', side: 'our' }, { name: '钱大钧', side: 'customer' }],
    };
    const md = renderVisitMd(seedAccount, visit);
    expect(md).toContain('拜访记录 · 2026-06-01 信息化部技术交流');
    expect(md).toContain('钱大钧（客户方）');
    expect(md).toContain('一体化平台达成共识');
  });

  it('版本日志按 +0.1 递增渲染', () => {
    const log: VersionLogEntry[] = [
      { version: 'v1.0', date: '2026-05-01', editor: '张三', summary: '建档', trigger: '建档' },
      { version: 'v1.1', date: '2026-06-01', editor: '张三', summary: '补全招采', trigger: '拜访' },
    ];
    const md = renderOpportunityMd(seedAccount, seedAccount.opportunities[0], log);
    expect(md).toContain('v1.1');
    expect(md).toContain('补全招采');
  });
});

describe('mdProfile · 往返保真（系统→MD→parse，块C 红线）', () => {
  it('客户字段 round-trip：大区/集团/主负责人/profile', () => {
    const acc: typeof seedAccount = {
      ...seedAccount, region: '西北', group: '某能源集团', primaryOwner: '李销售',
      profile: { business: '注册资本 5 亿', risk: '有一笔诉讼', ourCooperation: '已签框架' },
    };
    const patch = parseCustomerMd(renderCustomerMd(acc, []), acc);
    expect(patch.region).toBe('西北');
    expect(patch.group).toBe('某能源集团');
    expect(patch.primaryOwner).toBe('李销售');
    expect(patch.profile?.business).toBe('注册资本 5 亿');
    expect(patch.profile?.risk).toBe('有一笔诉讼');
    expect(patch.profile?.ourCooperation).toBe('已签框架');
  });

  it('空字段占位 ⏳ round-trip 还原为空串', () => {
    const patch = parseCustomerMd(renderCustomerMd(seedAccount, []), seedAccount); // seed 无 region
    expect(patch.region).toBe('');
  });

  it('商机 round-trip：单一目标 + C3/C5 勾选状态', () => {
    const opp = seedAccount.opportunities[0];
    const patch = parseOpportunityMd(renderOpportunityMd(seedAccount, opp, []), opp);
    expect(patch.singleSalesGoal).toBe(opp.singleSalesGoal);
    expect(patch.c3Items?.['立项原因']).toBe(true);   // seed=true
    expect(patch.c3Items?.['项目排序']).toBe(false);  // seed=false
    expect(patch.c5Items?.['评标规则']).toBe(false);  // seed=false
  });

  it('reads legacy C5 aliases for rendering but emits only authoritative keys on write-back', () => {
    const legacy = {
      ...seedAccount.opportunities[0],
      c5Items: { '竞标方家数': true, '甲方代表': true, '招标代理': false, '招标参数': true },
    } as unknown as typeof seedAccount.opportunities[0];
    const rendered = renderOpportunityMd(seedAccount, legacy, []);
    expect(rendered).toContain('| 竞标方名单/家数 | ✅ 已掌握 |');
    expect(rendered).toContain('| 甲方项目代表 | ✅ 已掌握 |');
    const edited = rendered.replace('| 评标规则 | ⏳ 待补充 |', '| 评标规则 | ✅ 已掌握 |');
    const patch = parseOpportunityMd(edited, legacy);

    expect(Object.keys(patch.c5Items ?? {}).sort()).toEqual([
      '竞标方名单/家数', '招标参数', '评标规则', '甲方项目代表', '招标代理机构',
    ].sort());
    expect(patch.c5Items).not.toHaveProperty('竞标方家数');
    expect(patch.c5Items).not.toHaveProperty('甲方代表');
    expect(patch.c5Items).not.toHaveProperty('招标代理');
    expect(patch.c5Items).toMatchObject({
      '竞标方名单/家数': true,
      '招标参数': true,
      '评标规则': true,
      '甲方项目代表': true,
      '招标代理机构': false,
    });
  });

  it('拜访 round-trip：主题 + 纪要正文', () => {
    const visit: VisitNote = { id: 'v', accountId: seedAccount.id, date: '2026-06-01', topic: '技术交流', summary: '就一体化平台达成共识，下一步排期 POC', participants: [] };
    const patch = parseVisitMd(renderVisitMd(seedAccount, visit));
    expect(patch.topic).toBe('技术交流');
    expect(patch.summary).toBe('就一体化平台达成共识，下一步排期 POC');
  });

  it('只读字段不进 patch：打分 / 客户类型 不被回写', () => {
    const opp = seedAccount.opportunities[0];
    const patch = parseOpportunityMd(renderOpportunityMd(seedAccount, opp, []), opp);
    expect('customerType' in patch).toBe(false);
    expect('winProbability' in patch).toBe(false);
    expect('competitiveSituation' in patch).toBe(false);
  });
});
