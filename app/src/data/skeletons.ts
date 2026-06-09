// M2 骨架预填：按客户类型预置 A/D/U/TB/R「典型决策链」占位，新建商机时一键摆上画布，
// 把"对着白纸画组织图"变成"填空 + 删减"。岗位据 docs/G64111-评分规格.md §1 能源客户典型岗位，
// 三类客户可按行动宝典③精修（纯数据，改这里即可，无需动逻辑）。
import type { Role } from '../types';

export interface SkeletonRole {
  role: Role;
  title: string;     // 占位岗位（同时作为占位人物的 name 与 title，待用户双击改真名）
  orgLevel: number;  // 1 高层 / 2 部门 / 3 执行层 —— 决定画布分层布局
}
export interface PlacedSkeleton extends SkeletonRole { x: number; y: number; }

export const CUSTOMER_SKELETONS: Record<number, SkeletonRole[]> = {
  1: [ // ① 央企能源集团
    { role: 'A', title: '集团/二级单位分管副总', orgLevel: 1 },
    { role: 'D', title: '信息化部负责人', orgLevel: 2 },
    { role: 'TB', title: '招标采购中心', orgLevel: 3 },
    { role: 'U', title: '项目部/场站成本岗', orgLevel: 3 },
    { role: 'R', title: '信息化业务骨干', orgLevel: 3 },
  ],
  2: [ // ② 央国企电力建设集团
    { role: 'A', title: '二级单位主要领导', orgLevel: 1 },
    { role: 'D', title: '工程管理部负责人', orgLevel: 2 },
    { role: 'TB', title: '招采中心/评标专家', orgLevel: 3 },
    { role: 'U', title: '项目部计划/工程岗', orgLevel: 3 },
    { role: 'R', title: '设计院/咨询顾问', orgLevel: 3 },
  ],
  3: [ // ③ 地方/民营能源投资建设
    { role: 'A', title: '董事长/总经理', orgLevel: 1 },
    { role: 'D', title: '新能源事业部负责人', orgLevel: 2 },
    { role: 'TB', title: '采购负责人', orgLevel: 3 },
    { role: 'U', title: '场站运营岗', orgLevel: 3 },
    { role: 'R', title: '总集成商/外部顾问', orgLevel: 3 },
  ],
};

/** 按 orgLevel 分层、同层横向居中排开，摆成金字塔式组织图（坐标与 layout.ts 同口径的画布逻辑坐标）。 */
export function layoutSkeleton(roles: SkeletonRole[]): PlacedSkeleton[] {
  const byLevel = new Map<number, SkeletonRole[]>();
  for (const r of roles) {
    const arr = byLevel.get(r.orgLevel) ?? [];
    arr.push(r);
    byLevel.set(r.orgLevel, arr);
  }
  const CX = 460, X_GAP = 200, Y0 = 130, Y_GAP = 150;
  const out: PlacedSkeleton[] = [];
  for (const lvl of [...byLevel.keys()].sort((a, b) => a - b)) {
    const rs = byLevel.get(lvl)!;
    const n = rs.length;
    rs.forEach((r, i) => {
      out.push({ ...r, x: Math.round(CX + (i - (n - 1) / 2) * X_GAP), y: Y0 + (lvl - 1) * Y_GAP });
    });
  }
  return out;
}
