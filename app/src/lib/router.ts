// 轻量页面级路由（契约 v1.0 §三-③ Deep link）：/account/{id}[/opp/{id}]，id 兼容江湖 id 或
// 销售包 externalRef（先精确匹配 id，再回退 externalRef——销售包可直接用自己的 customer_id 拼直链）。
// 不引 react-router：仅两级路径，history.pushState + popstate 手写同步，URL 恒规范化为江湖 id。
import type { Account } from '../types';

export interface RouteTarget { accSeg: string; oppSeg?: string }

/** 解析路径 → 目标段（未匹配数据前的原始段）。非 /account/* 路径视为 Hub（null）。 */
export function parsePath(pathname: string): RouteTarget | null {
  const m = /^\/account\/([^/]+)(?:\/opp\/([^/]+))?\/?$/.exec(pathname);
  if (!m) return null;
  try {
    return { accSeg: decodeURIComponent(m[1]), oppSeg: m[2] ? decodeURIComponent(m[2]) : undefined };
  } catch {
    return null;
  }
}

/** 由选中态构造规范路径（恒用江湖 id）。 */
export function buildPath(accId: string | null, oppId: string | null): string {
  if (!accId) return '/';
  return oppId
    ? `/account/${encodeURIComponent(accId)}/opp/${encodeURIComponent(oppId)}`
    : `/account/${encodeURIComponent(accId)}`;
}

/** 在整树里解析目标段：id 精确命中优先，externalRef 次之。返回 null = 不存在或无权限（viewer 名下不含）。 */
export function resolveRoute(accounts: Account[], target: RouteTarget): { accId: string; oppId: string | null } | null {
  const acc = accounts.find((a) => a.id === target.accSeg) ?? accounts.find((a) => !!a.externalRef && a.externalRef === target.accSeg);
  if (!acc) return null;
  if (!target.oppSeg) return { accId: acc.id, oppId: acc.opportunities[0]?.id ?? null };
  const opp = acc.opportunities.find((o) => o.id === target.oppSeg) ?? acc.opportunities.find((o) => !!o.externalRef && o.externalRef === target.oppSeg);
  // 商机段解析不到 → 客户页兜底（不因商机改名/换锚丢整条链接）
  return { accId: acc.id, oppId: opp?.id ?? acc.opportunities[0]?.id ?? null };
}
