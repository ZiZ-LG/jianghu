import {
  capabilityPolicyAllows,
  isG64111Active,
  type G64111MethodologyReadModel,
  type ProductAccess,
} from '@jianghu/domain-contracts';
import type { RouteTarget } from './router';

export function canUseG64111Matter(
  access: ProductAccess,
  model: G64111MethodologyReadModel | null,
  customerId: string,
  matterId: string,
): boolean {
  if (access.shell === 'internal_legacy') return true;
  if (!capabilityPolicyAllows(access.policy, { entitlement: 'methodology.g64111' }) || !model) return false;
  const matter = model.matters.find((candidate) => (
    candidate.customerId === customerId && candidate.matterId === matterId
  ));
  return Boolean(matter && isG64111Active(matter.activeBinding));
}

export function invokeG64111ForMatter<T>(
  access: ProductAccess,
  model: G64111MethodologyReadModel | null,
  customerId: string,
  matterId: string,
  compute: () => T,
): T | null {
  return canUseG64111Matter(access, model, customerId, matterId) ? compute() : null;
}

export function selectG64111Accounts<
  TAccount extends { id: string; opportunities: TMatter[] },
  TMatter extends { id: string },
>(
  access: ProductAccess,
  model: G64111MethodologyReadModel | null,
  accounts: TAccount[],
): TAccount[] {
  if (access.shell === 'internal_legacy') return accounts;
  if (!model || !capabilityPolicyAllows(access.policy, { entitlement: 'methodology.g64111' })) return [];
  return accounts.flatMap((account) => {
    const opportunities = account.opportunities.filter((matter) => (
      canUseG64111Matter(access, model, account.id, matter.id)
    ));
    return opportunities.length > 0 ? [{ ...account, opportunities } as TAccount] : [];
  });
}

export function resolveG64111LegacyRoute<
  TMatter extends { id: string; externalRef?: string },
  TAccount extends { id: string; externalRef?: string; opportunities: TMatter[] },
>(
  access: ProductAccess,
  model: G64111MethodologyReadModel | null,
  accounts: TAccount[],
  target: RouteTarget,
): { accId: string; oppId: string } | null {
  if (access.shell === 'internal_legacy') {
    const account = accounts.find((candidate) => candidate.id === target.accSeg)
      ?? accounts.find((candidate) => candidate.externalRef === target.accSeg);
    if (!account) return null;
    const matter = target.oppSeg
      ? account.opportunities.find((candidate) => candidate.id === target.oppSeg)
        ?? account.opportunities.find((candidate) => candidate.externalRef === target.oppSeg)
      : account.opportunities[0];
    return matter ? { accId: account.id, oppId: matter.id } : null;
  }

  // Commercial frozen workrooms are Matter-specific. Account-only links and
  // stale/unknown Matter segments must not fall back to some other opportunity.
  if (!target.oppSeg) return null;
  const account = accounts.find((candidate) => candidate.id === target.accSeg)
    ?? accounts.find((candidate) => candidate.externalRef === target.accSeg);
  const matter = account?.opportunities.find((candidate) => candidate.id === target.oppSeg)
    ?? account?.opportunities.find((candidate) => candidate.externalRef === target.oppSeg);
  if (!account || !matter || !canUseG64111Matter(access, model, account.id, matter.id)) return null;
  return { accId: account.id, oppId: matter.id };
}
