export type VisibilityRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface ReadPrincipal {
  tenantId: string;
  userId: string;
  role: VisibilityRole;
}

interface InteractionLog {
  date?: unknown;
  content?: unknown;
  sensitive?: unknown;
  visibility?: unknown;
  createdBy?: unknown;
  [key: string]: unknown;
}

/** Server-owned field ACL for Person.logs. Malformed rows fail closed. */
export function visiblePersonLogs(raw: string, principal: ReadPrincipal): InteractionLog[] {
  let rows: unknown;
  try { rows = JSON.parse(raw || '[]'); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  return rows.filter((value): value is InteractionLog => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as InteractionLog;
    if (row.visibility !== undefined && row.visibility !== 'self' && row.visibility !== 'team' && row.visibility !== 'org') return false;
    let visibility = row.visibility;
    if (visibility === undefined) {
      if (row.sensitive === true) visibility = 'team';
      else if (row.sensitive === false || row.sensitive === undefined) visibility = 'org';
      else return false; // legacy sensitive 只接受真实布尔值；畸形类型禁止降级成 org
    }
    if (visibility === 'org') return true;
    if (visibility === 'team') return principal.role !== 'viewer';
    return typeof row.createdBy === 'string' && row.createdBy === principal.userId;
  });
}

export function canReadPrivateBusinessData(principal: ReadPrincipal): boolean {
  return principal.role !== 'viewer';
}
