import type { RelSuggestion } from '@prisma/client';
import type { CapabilityPolicy } from '@jianghu/domain-contracts';
import type { DbClient } from './mutation/scopeGuards.js';
import { activePersonWhere } from './activePerson.js';
import {
  createSensitiveAccessEvaluator,
  candidateDescriptor,
} from './sensitiveAccess.js';
import type { ReadPrincipal } from './visibility.js';

const endpointKey = (kind: 'person' | 'suggestion', id: string) => `${kind}:${id}`;

export interface ScopedRelSuggestion {
  row: RelSuggestion;
  sourceName: string;
  targetName: string;
}

/**
 * Resolve pending relationship candidates against their own Opportunity Account.
 * Historical malformed rows are omitted only: this function never repairs or deletes them.
 */
export async function resolveScopedRelSuggestions(
  db: DbClient,
  tenantId: string,
  rows: readonly RelSuggestion[],
  security?: { principal: ReadPrincipal; capabilityPolicy: CapabilityPolicy },
): Promise<ScopedRelSuggestion[]> {
  if (rows.length === 0) return [];

  const opportunityIds = [...new Set(rows.map((row) => row.opportunityId))];
  const formalIds = new Set<string>();
  const suggestionIds = new Set<string>();
  for (const row of rows) {
    if (row.sourceKind === 'person') formalIds.add(row.sourcePersonId);
    else if (row.sourceKind === 'suggestion') suggestionIds.add(row.sourcePersonId);
    if (row.targetKind === 'person') formalIds.add(row.targetPersonId);
    else if (row.targetKind === 'suggestion') suggestionIds.add(row.targetPersonId);
  }

  const evaluator = security
    ? await createSensitiveAccessEvaluator(db, security.principal, security.capabilityPolicy)
    : null;
  const candidateAclWhere = evaluator
    ? await evaluator.metadataWhere('candidate', 'read')
    : {};

  const [opportunities, persons, candidateMetadata] = await Promise.all([
    db.opportunity.findMany({
      where: { tenantId, id: { in: opportunityIds } },
      select: { id: true, accountId: true },
    }),
    db.person.findMany({
      where: { tenantId, id: { in: [...formalIds] }, ...activePersonWhere },
      select: { id: true, accountId: true, name: true },
    }),
    !security || suggestionIds.size === 0 ? [] : db.candidate.findMany({
      where: {
        tenantId,
        legacySourceKind: 'PersonSuggestion',
        legacySourceId: { in: [...suggestionIds] },
        ...candidateAclWhere,
      },
      select: {
        id: true, tenantId: true, kind: true, status: true, accountId: true, matterId: true,
        createdByUserId: true, visibility: true, aclVersion: true, legacySourceId: true,
      },
    }),
  ]);

  const readableSuggestionIds: string[] = [];
  if (evaluator) {
    const decisions = await evaluator.authorizeMany(candidateMetadata.map(candidateDescriptor), 'read');
    for (const [index, row] of candidateMetadata.entries()) {
      if (decisions[index]?.allowed && row.kind === 'person_create' && row.legacySourceId) {
        readableSuggestionIds.push(row.legacySourceId);
      }
    }
  }
  const suggestions = readableSuggestionIds.length === 0 ? [] : await db.personSuggestion.findMany({
    where: { tenantId, id: { in: readableSuggestionIds } },
    select: { id: true, accountId: true, opportunityId: true, name: true },
  });

  const candidateOpportunityIds = [...new Set(suggestions.flatMap((row) => row.opportunityId ? [row.opportunityId] : []))];
  const candidateOpportunities = candidateOpportunityIds.length
    ? await db.opportunity.findMany({
      where: { tenantId, id: { in: candidateOpportunityIds } },
      select: { id: true, accountId: true },
    })
    : [];
  const allOpportunities = [...opportunities, ...candidateOpportunities];
  const accountIds = [...new Set(allOpportunities.map((row) => row.accountId))];
  const accounts = accountIds.length
    ? await db.account.findMany({ where: { tenantId, id: { in: accountIds } }, select: { id: true } })
    : [];

  const validAccountIds = new Set(accounts.map((row) => row.id));
  const opportunityAccount = new Map(allOpportunities.map((row) => [row.id, row.accountId]));
  const personByKey = new Map(persons.map((row) => [endpointKey('person', row.id), row]));
  const suggestionByKey = new Map(suggestions.map((row) => [endpointKey('suggestion', row.id), row]));

  const resolveEndpoint = (kind: string, id: string, expectedAccountId: string): string | null => {
    if (kind === 'person') {
      const person = personByKey.get(endpointKey('person', id));
      return person?.accountId === expectedAccountId ? person.name : null;
    }
    if (kind !== 'suggestion') return null;
    const suggestion = suggestionByKey.get(endpointKey('suggestion', id));
    if (!suggestion || suggestion.accountId !== expectedAccountId) return null;
    if (suggestion.opportunityId && opportunityAccount.get(suggestion.opportunityId) !== expectedAccountId) return null;
    return `${suggestion.name}（候选）`;
  };

  const scoped: ScopedRelSuggestion[] = [];
  for (const row of rows) {
    const expectedAccountId = opportunityAccount.get(row.opportunityId);
    if (!expectedAccountId || !validAccountIds.has(expectedAccountId)) continue;
    const sourceName = resolveEndpoint(row.sourceKind, row.sourcePersonId, expectedAccountId);
    const targetName = resolveEndpoint(row.targetKind, row.targetPersonId, expectedAccountId);
    if (sourceName === null || targetName === null) continue;
    scoped.push({ row, sourceName, targetName });
  }
  return scoped;
}
