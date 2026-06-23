import { describe, it, expect } from 'vitest';
import { renderCustomerMd, renderOpportunityMd, renderVisitMd, type VersionLogEntry } from './mdProfile';
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
