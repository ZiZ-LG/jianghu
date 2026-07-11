// viewer（只读投影）门禁与归属过滤 —— 江湖-销售包集成契约 v1.0 §三/§四。
// 归属承载：销售包按 primaryOwner 推送 → 江湖以 Account.primaryOwner === User.name 对齐"销售名下客户"。
// 语义边界：仅 viewer 收紧到"名下可见"；owner/admin/member 维持租户内全员共享（协作产品语义不变）。
import { prisma } from './prisma.js';

/** viewer 名下客户 id 集合（Account.primaryOwner 与该用户姓名一致）。 */
export async function viewerAccountIds(tenantId: string, userId: string): Promise<Set<string>> {
  const u = await prisma.user.findFirst({ where: { id: userId, tenantId }, select: { name: true } });
  if (!u?.name) return new Set();
  const rows = await prisma.account.findMany({ where: { tenantId, primaryOwner: u.name }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

/** 操作口对 viewer 一律 403（"极简"指操作极简、不是门禁极简）。返回 true = 已拒绝，调用方应 return。 */
export function denyViewer(req: any, reply: any): boolean {
  if (req.user?.role === 'viewer') {
    reply.code(403).send({ error: '只读成员不可操作' });
    return true;
  }
  return false;
}

/** 读口的 viewer 归属校验（按客户）：非 viewer 直接放行。返回 false = 已回 404（不泄漏存在性）。 */
export async function viewerCanReadAccount(req: any, reply: any, accountId: string): Promise<boolean> {
  if (req.user?.role !== 'viewer') return true;
  const ids = await viewerAccountIds(req.user.tenantId, req.user.userId);
  if (ids.has(accountId)) return true;
  reply.code(404).send({ error: '客户不存在或无权限' });
  return false;
}

/** 读口的 viewer 归属校验（按商机定位所属客户）。返回 false = 已回 404。 */
export async function viewerCanReadOpp(req: any, reply: any, opportunityId: string): Promise<boolean> {
  if (req.user?.role !== 'viewer') return true;
  const opp = await prisma.opportunity.findFirst({
    where: { id: opportunityId, tenantId: req.user.tenantId },
    select: { accountId: true },
  });
  if (!opp) {
    reply.code(404).send({ error: '商机不存在或无权限' });
    return false;
  }
  return viewerCanReadAccount(req, reply, opp.accountId);
}
