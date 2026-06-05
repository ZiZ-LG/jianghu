// 新节点增量避让布局：在固定网格候选位中跳过"已被已有节点占用"的位，返回不重叠的新坐标。
// 不改动任何已有节点（增量避让，见 docs/录入情报-设计方案.md §7 V3）。
// 前后端同口径（见 app/src/lib/layout.ts）；竞品节点固定在左下角(90,440)、不走主网格也不参与避让。
const GX = 150, GY = 135, X0 = 220, Y0 = 150, MIN_DIST = 100, MAX_SLOTS = 400;

export function nextFreeSlot(occupied: { x: number; y: number }[]): { x: number; y: number } {
  for (let i = 0; i < MAX_SLOTS; i++) {
    const x = X0 + (i % 4) * GX, y = Y0 + Math.floor(i / 4) * GY;
    if (!occupied.some((o) => Math.hypot(o.x - x, o.y - y) < MIN_DIST)) return { x, y };
  }
  return { x: X0, y: Y0 + Math.ceil(MAX_SLOTS / 4) * GY }; // 兜底：网格全占满则堆到底部
}
