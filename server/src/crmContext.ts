import type { FastifyInstance } from 'fastify';
import {
  ActorRoleSchema,
  CrmContextSnapshotSchema,
  type CrmContextSnapshot,
} from '@jianghu/domain-contracts';
import { activePersonWhere } from './activePerson.js';
import type { DbClient } from './mutation/scopeGuards.js';
import { prisma } from './prisma.js';
import { resolveEffectiveResourceScope } from './resourceScope.js';
import type { ReadPrincipal } from './visibility.js';

/**
 * Commercial CRM read projection. Keep every select neutral: this route must not
 * acquire a dependency on sales stages, methodology roles, G64111, PDE, or source bodies.
 */
export async function buildCrmContextSnapshot(
  principal: ReadPrincipal,
  now = new Date(),
  db: DbClient = prisma,
): Promise<CrmContextSnapshot> {
  const scope = await resolveEffectiveResourceScope(db, principal);
  const customerIds = [...scope.accountIds];
  const fullCustomerIds = [...scope.fullAccountIds];
  const matterIds = [...scope.matterIds];

  if (customerIds.length === 0) {
    return CrmContextSnapshotSchema.parse({
      generatedAtUtc: now.toISOString(),
      customers: [],
      matters: [],
      people: [],
      matterParticipants: [],
      relations: [],
    });
  }

  const relationScope = [
    ...(fullCustomerIds.length > 0
      ? [{ accountId: { in: fullCustomerIds }, opportunityId: null }]
      : []),
    ...(matterIds.length > 0
      ? [{ opportunityId: { in: matterIds } }]
      : []),
  ];

  const [customerRows, matterRows, participantRows, relationRows] = await Promise.all([
    db.account.findMany({
      where: { tenantId: principal.tenantId, archivedAt: null, id: { in: customerIds } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        categoryKey: true,
        primaryOwnerUserId: true,
        version: true,
      },
    }),
    matterIds.length === 0
      ? Promise.resolve([])
      : db.opportunity.findMany({
          where: {
            tenantId: principal.tenantId,
            archivedAt: null,
            id: { in: matterIds },
            accountId: { in: customerIds },
            account: { tenantId: principal.tenantId, archivedAt: null },
          },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            accountId: true,
            name: true,
            kind: true,
            lifecycleStatus: true,
            outcomeKey: true,
            priority: true,
            targetDate: true,
            primaryOwnerUserId: true,
            version: true,
          },
        }),
    matterIds.length === 0
      ? Promise.resolve([])
      : db.matterParticipant.findMany({
          where: {
            tenantId: principal.tenantId,
            accountId: { in: customerIds },
            opportunityId: { in: matterIds },
          },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            accountId: true,
            opportunityId: true,
            personId: true,
          },
        }),
    relationScope.length === 0
      ? Promise.resolve([])
      : db.edge.findMany({
          where: {
            tenantId: principal.tenantId,
            accountId: { in: customerIds },
            account: { tenantId: principal.tenantId, archivedAt: null },
            OR: relationScope,
          },
          orderBy: { id: 'asc' },
          select: {
            id: true,
            accountId: true,
            opportunityId: true,
            source: true,
            target: true,
            kind: true,
            label: true,
            directed: true,
            version: true,
          },
        }),
  ]);

  const customers = customerRows.map((row) => ({
    id: row.id,
    name: row.name,
    categoryKey: row.categoryKey,
    primaryOwnerUserId: scope.canReadAccountData(row.id) ? row.primaryOwnerUserId : null,
    archivedAt: null,
    version: row.version,
  }));
  const customerById = new Map(customers.map((customer) => [customer.id, customer]));

  const matters = matterRows
    .filter((row) => customerById.has(row.accountId) && scope.canReadMatter(row.id))
    .map((row) => ({
      id: row.id,
      customerId: row.accountId,
      title: row.name,
      kind: row.kind,
      lifecycleStatus: row.lifecycleStatus,
      outcomeKey: row.outcomeKey,
      priority: row.priority,
      targetDate: row.targetDate,
      primaryOwnerUserId: row.primaryOwnerUserId,
      archivedAt: null,
      version: row.version,
    }));
  const matterById = new Map(matters.map((matter) => [matter.id, matter]));

  const referencedPersonIds = new Set<string>();
  for (const participant of participantRows) referencedPersonIds.add(participant.personId);
  for (const relation of relationRows) {
    referencedPersonIds.add(relation.source);
    referencedPersonIds.add(relation.target);
  }
  const personScope = [
    ...(fullCustomerIds.length > 0 ? [{ accountId: { in: fullCustomerIds } }] : []),
    ...(referencedPersonIds.size > 0 ? [{ id: { in: [...referencedPersonIds] } }] : []),
  ];
  const personRows = personScope.length === 0
    ? []
    : await db.person.findMany({
        where: {
          tenantId: principal.tenantId,
          accountId: { in: customerIds },
          ...activePersonWhere,
          OR: personScope,
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          accountId: true,
          name: true,
          title: true,
          version: true,
        },
      });

  const people = personRows
    .filter((row) => customerById.has(row.accountId))
    .map((row) => ({
      id: row.id,
      customerId: row.accountId,
      name: row.name,
      title: row.title.trim() || null,
      archivedAt: null,
      version: row.version,
    }));
  const personById = new Map(people.map((person) => [person.id, person]));

  const matterParticipants = participantRows
    .filter((row) => {
      const matter = matterById.get(row.opportunityId);
      const person = personById.get(row.personId);
      return matter?.customerId === row.accountId
        && person?.customerId === row.accountId;
    })
    .map((row) => ({
      id: row.id,
      customerId: row.accountId,
      matterId: row.opportunityId,
      personId: row.personId,
    }));

  const relations = relationRows
    .filter((row) => {
      if (!row.kind.trim()) return false;
      const source = personById.get(row.source);
      const target = personById.get(row.target);
      if (source?.customerId !== row.accountId || target?.customerId !== row.accountId) return false;
      if (row.opportunityId === null) return scope.canReadAccountData(row.accountId);
      return matterById.get(row.opportunityId)?.customerId === row.accountId;
    })
    .map((row) => ({
      id: row.id,
      customerId: row.accountId,
      matterId: row.opportunityId,
      sourcePersonId: row.source,
      targetPersonId: row.target,
      kind: row.kind,
      label: row.label.trim() || null,
      directed: row.directed,
      version: row.version,
    }));

  return CrmContextSnapshotSchema.parse({
    generatedAtUtc: now.toISOString(),
    customers,
    matters,
    people,
    matterParticipants,
    relations,
  });
}

export function crmContextRoutes(app: FastifyInstance): void {
  app.get('/api/crm/context', { preHandler: [app.authenticate] }, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return buildCrmContextSnapshot({
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      role: ActorRoleSchema.parse(req.user.role),
    });
  });
}
