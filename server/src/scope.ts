// 旧函数名兼容层。所有 Customer/Matter 读门禁统一委托当前数据库状态的 effective scope。
import { prisma } from './prisma.js';
import { resolveEffectiveResourceScope } from './resourceScope.js';
import type { ReadPrincipal } from './visibility.js';

function requestPrincipal(req: any): ReadPrincipal | null {
  const user = req?.user;
  if (!user || typeof user.tenantId !== 'string' || typeof user.userId !== 'string') return null;
  return {
    tenantId: user.tenantId,
    userId: user.userId,
    // Resolver revalidates the current role. This value is only a typed transport placeholder.
    role: user.role === 'owner' || user.role === 'admin' || user.role === 'member' || user.role === 'viewer'
      ? user.role
      : 'viewer',
  };
}

/** Legacy adapter: returns the Customers whose full data the current actor may read. */
export async function viewerAccountIds(tenantId: string, userId: string): Promise<Set<string>> {
  const scope = await resolveEffectiveResourceScope(prisma, { tenantId, userId, role: 'viewer' });
  return new Set(scope.fullAccountIds);
}

/** 操作口对 viewer 一律 403（"极简"指操作极简、不是门禁极简）。返回 true = 已拒绝，调用方应 return。 */
export function denyViewer(req: any, reply: any): boolean {
  if (req.user?.role === 'viewer') {
    reply.code(403).send({ error: '只读成员不可操作' });
    return true;
  }
  return false;
}

/** Full Customer-data check. Returns false after a generic 404 to avoid existence disclosure. */
export async function viewerCanReadAccount(req: any, reply: any, accountId: string): Promise<boolean> {
  const principal = requestPrincipal(req);
  if (principal) {
    const scope = await resolveEffectiveResourceScope(prisma, principal);
    if (scope.canReadAccountData(accountId)) return true;
  }
  reply.code(404).send({ error: '客户不存在或无权限' });
  return false;
}

/** Matter check. Returns false after a generic 404 to avoid existence disclosure. */
export async function viewerCanReadOpp(req: any, reply: any, opportunityId: string): Promise<boolean> {
  const principal = requestPrincipal(req);
  if (principal) {
    const scope = await resolveEffectiveResourceScope(prisma, principal);
    if (scope.canReadMatter(opportunityId)) return true;
  }
  reply.code(404).send({ error: '商机不存在或无权限' });
  return false;
}
