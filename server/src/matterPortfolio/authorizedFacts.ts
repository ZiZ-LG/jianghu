import type { Prisma } from '@prisma/client';
import type { CommandContext, IntelligenceItemView, StakeholderFocusView } from '@jianghu/domain-contracts';
import type { DbClient } from '../mutation/scopeGuards.js';
import {
  sourceArtifactDescriptor,
  type SensitiveAccessEvaluator,
} from '../sensitiveAccess.js';
import {
  SOURCE_ARTIFACT_METADATA_SELECT,
  sourceArtifactMetadataIsValid,
  type SourceArtifactMetadata,
} from '../sourceArtifacts/service.js';
import {
  projectIntelligenceItem,
  projectStakeholderFocus,
} from '../intelligenceFocus/model.js';
import {
  projectHypothesisEvidenceLink,
  projectSalesHypothesis,
  projectSalesHypothesisRevision,
} from '../hypotheses/model.js';
import type {
  MatterPortfolioHypothesisFact,
  MatterPortfolioIntelligenceFact,
} from './model.js';

const intelligenceSelect = {
  id: true,
  tenantId: true,
  customerId: true,
  matterId: true,
  assertionType: true,
  statement: true,
  sourceKind: true,
  sourceDescription: true,
  sourceRefId: true,
  sourceRefVersion: true,
  occurredAt: true,
  learnedAt: true,
  confidence: true,
  targetRefs: true,
  createdByUserId: true,
  version: true,
  archivedAt: true,
  archivedByUserId: true,
  archiveReason: true,
  createdAt: true,
  updatedAt: true,
} as const;

const focusSelect = {
  id: true,
  tenantId: true,
  customerId: true,
  matterId: true,
  personId: true,
  desiredChange: true,
  rationale: true,
  evidenceGap: true,
  basisRefs: true,
  validUntil: true,
  activeMatterKey: true,
  confirmedByUserId: true,
  confirmedAt: true,
  retiredByUserId: true,
  retiredAt: true,
  retireReason: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

const hypothesisSelect = {
  id: true,
  tenantId: true,
  customerId: true,
  matterId: true,
  personId: true,
  status: true,
  ownerUserId: true,
  nextReviewAt: true,
  currentRevisionId: true,
  legacyStrategyRiskId: true,
  createdByUserId: true,
  statusConfirmedByUserId: true,
  statusConfirmedAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

const revisionSelect = {
  id: true,
  tenantId: true,
  hypothesisId: true,
  revisionNumber: true,
  claim: true,
  reason: true,
  expectedSignals: true,
  falsificationConditions: true,
  origin: true,
  createdByUserId: true,
  createdAt: true,
} as const;

const linkSelect = {
  id: true,
  tenantId: true,
  hypothesisId: true,
  hypothesisRevisionId: true,
  evidenceId: true,
  evidenceVersion: true,
  direction: true,
  verificationCommitmentId: true,
  linkedByUserId: true,
  linkedAt: true,
} as const;

type IntelligenceRow = Prisma.IntelligenceItemGetPayload<{ select: typeof intelligenceSelect }>;
type FocusRow = Prisma.StakeholderFocusGetPayload<{ select: typeof focusSelect }>;
type HypothesisRow = Prisma.SalesHypothesisGetPayload<{ select: typeof hypothesisSelect }>;
type RevisionRow = Prisma.SalesHypothesisRevisionGetPayload<{ select: typeof revisionSelect }>;
type LinkRow = Prisma.HypothesisEvidenceLinkGetPayload<{ select: typeof linkSelect }>;

interface MatterParent {
  id: string;
  customerId: string;
}

interface ReadableSourceIndex {
  interactionById: Map<string, { accountId: string; matterId: string | null; version: number; sourceArtifactId: string }>;
  artifactById: Map<string, SourceArtifactMetadata>;
  readableArtifactIds: Set<string>;
  approvedEvidenceKeys: Set<string>;
}

export interface MatterPortfolioAuthorizedFacts {
  latestIntelligence: Map<string, MatterPortfolioIntelligenceFact>;
  focusPeople: Map<string, string>;
  hypotheses: Map<string, MatterPortfolioHypothesisFact[]>;
}

const pairKey = (customerId: string, matterId: string): string => `${customerId}\u0000${matterId}`;
const personKey = (customerId: string, matterId: string, personId: string): string => (
  `${customerId}\u0000${matterId}\u0000${personId}`
);
const relationKey = (customerId: string, matterId: string, relationId: string): string => (
  `${customerId}\u0000${matterId}\u0000${relationId}`
);
const evidenceKey = (customerId: string, matterId: string, evidenceId: string): string => (
  `${customerId}\u0000${matterId}\u0000${evidenceId}`
);

function parseIntelligence(row: IntelligenceRow): IntelligenceItemView | null {
  try {
    return projectIntelligenceItem(row);
  } catch {
    return null;
  }
}

function parseFocus(row: FocusRow, now: Date): StakeholderFocusView | null {
  try {
    return projectStakeholderFocus(row, now);
  } catch {
    return null;
  }
}

function currentUser(userIds: ReadonlySet<string>, userId: string | null): boolean {
  return userId === null || userIds.has(userId);
}

function sourceReferenceIds(
  intelligence: readonly IntelligenceItemView[],
  focus: readonly StakeholderFocusView[],
) {
  const interactionIds = new Set<string>();
  const evidenceIds = new Set<string>();
  for (const item of intelligence) {
    if (item.source.kind === 'interaction' && item.source.refId) interactionIds.add(item.source.refId);
    if (item.source.kind === 'evidence' && item.source.refId) evidenceIds.add(item.source.refId);
  }
  for (const item of focus) {
    for (const basis of item.basisRefs) {
      if (basis.kind === 'interaction') interactionIds.add(basis.id);
      if (basis.kind === 'evidence') evidenceIds.add(basis.id);
    }
  }
  return { interactionIds: [...interactionIds], evidenceIds: [...evidenceIds] };
}

async function readableSourceIndex(
  db: DbClient,
  ctx: CommandContext,
  evaluator: SensitiveAccessEvaluator,
  interactionIds: readonly string[],
  evidenceIds: readonly string[],
): Promise<ReadableSourceIndex> {
  const [interactions, evidence] = await Promise.all([
    interactionIds.length === 0 ? Promise.resolve([]) : db.interaction.findMany({
      where: { tenantId: ctx.tenantId, id: { in: [...interactionIds] } },
      select: {
        id: true, accountId: true, matterId: true, version: true, sourceArtifactId: true,
      },
    }),
    evidenceIds.length === 0 ? Promise.resolve([]) : db.evidenceEvent.findMany({
      where: { tenantId: ctx.tenantId, id: { in: [...evidenceIds] }, status: 'approved' },
      select: { id: true, accountId: true, opportunityId: true },
    }),
  ]);
  const artifactIds = [...new Set(interactions.map((row) => row.sourceArtifactId))];
  const artifacts: SourceArtifactMetadata[] = artifactIds.length === 0 ? [] : await db.sourceArtifact.findMany({
    where: { tenantId: ctx.tenantId, id: { in: artifactIds } },
    select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
  const structurallyValid = artifacts.filter((artifact) => (
    sourceArtifactMetadataIsValid(artifact)
    && artifact.retentionState !== 'deleted'
    && artifact.retentionState !== 'degraded'
  ));
  const access = await evaluator.authorizeMany(
    structurallyValid.map(sourceArtifactDescriptor),
    'read',
  );
  return {
    interactionById: new Map(interactions.map((row) => [row.id, row])),
    artifactById: new Map(structurallyValid.map((artifact) => [artifact.id, artifact])),
    readableArtifactIds: new Set(structurallyValid.flatMap((artifact, index) => (
      access[index]?.allowed ? [artifact.id] : []
    ))),
    approvedEvidenceKeys: new Set(evidence.map((row) => (
      evidenceKey(row.accountId, row.opportunityId, row.id)
    ))),
  };
}

function sourceIsReadable(
  item: IntelligenceItemView,
  sources: ReadableSourceIndex,
): boolean {
  const source = item.source;
  if (source.kind === 'manual') return source.refId === null && source.refVersion === null;
  if (source.refId === null || source.refVersion === null) return false;
  if (source.kind === 'evidence') {
    return source.refVersion === 0
      && sources.approvedEvidenceKeys.has(evidenceKey(item.customerId, item.matterId, source.refId));
  }
  const interaction = sources.interactionById.get(source.refId);
  if (!interaction || interaction.accountId !== item.customerId || interaction.matterId !== item.matterId
    || interaction.version !== source.refVersion
    || !sources.readableArtifactIds.has(interaction.sourceArtifactId)) return false;
  const artifact = sources.artifactById.get(interaction.sourceArtifactId);
  return Boolean(artifact
    && artifact.accountId === item.customerId
    && artifact.matterId === item.matterId);
}

function basisIsReadable(
  focus: StakeholderFocusView,
  validIntelligence: ReadonlyMap<string, IntelligenceItemView>,
  sources: ReadableSourceIndex,
): boolean {
  return focus.basisRefs.every((basis) => {
    if (basis.kind === 'intelligence_item') {
      const intelligence = validIntelligence.get(basis.id);
      return Boolean(intelligence
        && intelligence.customerId === focus.customerId
        && intelligence.matterId === focus.matterId
        && intelligence.version === basis.version);
    }
    if (basis.kind === 'evidence') {
      return basis.version === 0
        && sources.approvedEvidenceKeys.has(evidenceKey(focus.customerId, focus.matterId, basis.id));
    }
    const interaction = sources.interactionById.get(basis.id);
    const artifact = interaction ? sources.artifactById.get(interaction.sourceArtifactId) : undefined;
    return Boolean(interaction
      && interaction.accountId === focus.customerId
      && interaction.matterId === focus.matterId
      && interaction.version === basis.version
      && sources.readableArtifactIds.has(interaction.sourceArtifactId)
      && artifact?.accountId === focus.customerId
      && artifact.matterId === focus.matterId);
  });
}

/**
 * Loads all body-free portfolio facts with a fixed number of tenant-scoped queries.
 * Corrupt, stale or inaccessible candidates are omitted so they can never elevate urgency.
 */
export async function loadMatterPortfolioAuthorizedFacts(
  db: DbClient,
  ctx: CommandContext,
  evaluator: SensitiveAccessEvaluator,
  matters: readonly MatterParent[],
  now: Date,
): Promise<MatterPortfolioAuthorizedFacts> {
  const matterIds = matters.map((matter) => matter.id);
  const customerIds = [...new Set(matters.map((matter) => matter.customerId))];
  const activePairs = new Set(matters.map((matter) => pairKey(matter.customerId, matter.id)));
  const reviewCutoff = new Date(now.getTime() + 7 * 86_400_000);
  if (matterIds.length === 0) {
    return { latestIntelligence: new Map(), focusPeople: new Map(), hypotheses: new Map() };
  }

  const [activeIntelligenceRows, focusRows, hypothesisRows] = await Promise.all([
    db.intelligenceItem.findMany({
      where: {
        tenantId: ctx.tenantId,
        matterId: { in: matterIds },
        customerId: { in: customerIds },
        archivedAt: null,
      },
      orderBy: [{ learnedAt: 'desc' }, { id: 'desc' }],
      select: intelligenceSelect,
    }),
    db.stakeholderFocus.findMany({
      where: {
        tenantId: ctx.tenantId,
        matterId: { in: matterIds },
        customerId: { in: customerIds },
        retiredAt: null,
        activeMatterKey: { not: null },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      select: focusSelect,
    }),
    db.salesHypothesis.findMany({
      where: {
        tenantId: ctx.tenantId,
        matterId: { in: matterIds },
        customerId: { in: customerIds },
        status: { in: ['untested', 'testing'] },
        nextReviewAt: { not: null, lte: reviewCutoff },
      },
      orderBy: [{ nextReviewAt: 'asc' }, { id: 'asc' }],
      select: hypothesisSelect,
    }),
  ]);
  const parsedFocus = focusRows.flatMap((row) => {
    const view = parseFocus(row, now);
    return view ? [{ row, view }] : [];
  });
  const activeIntelligenceIds = new Set(activeIntelligenceRows.map((row) => row.id));
  const archivedBasisIds = [...new Set(parsedFocus.flatMap(({ view }) => (
    view.basisRefs.flatMap((basis) => (
      basis.kind === 'intelligence_item' && !activeIntelligenceIds.has(basis.id) ? [basis.id] : []
    ))
  )))];
  const archivedBasisRows: IntelligenceRow[] = archivedBasisIds.length === 0
    ? []
    : await db.intelligenceItem.findMany({
        where: {
          tenantId: ctx.tenantId,
          id: { in: archivedBasisIds },
          archivedAt: { not: null },
        },
        orderBy: [{ learnedAt: 'desc' }, { id: 'desc' }],
        select: intelligenceSelect,
      });
  const intelligenceRows = [...activeIntelligenceRows, ...archivedBasisRows];
  const [revisionRows, linkRows]: [RevisionRow[], LinkRow[]] = hypothesisRows.length === 0
    ? [[], []]
    : await Promise.all([
        db.salesHypothesisRevision.findMany({
          where: { tenantId: ctx.tenantId, hypothesisId: { in: hypothesisRows.map((row) => row.id) } },
          orderBy: [{ hypothesisId: 'asc' }, { revisionNumber: 'asc' }],
          select: revisionSelect,
        }),
        db.hypothesisEvidenceLink.findMany({
          where: {
            tenantId: ctx.tenantId,
            hypothesisRevisionId: { in: hypothesisRows.map((row) => row.currentRevisionId) },
          },
          orderBy: [{ hypothesisRevisionId: 'asc' }, { linkedAt: 'asc' }, { id: 'asc' }],
          select: linkSelect,
        }),
      ]);

  const parsedIntelligence = intelligenceRows.flatMap((row) => {
    const view = parseIntelligence(row);
    return view ? [{ row, view }] : [];
  });
  const personIds = new Set<string>();
  const relationIds = new Set<string>();
  const userIds = new Set<string>();
  for (const { row, view } of parsedIntelligence) {
    userIds.add(row.createdByUserId);
    if (row.archivedByUserId) userIds.add(row.archivedByUserId);
    for (const target of view.targets) {
      if (target.kind === 'person') personIds.add(target.id);
      if (target.kind === 'relation') relationIds.add(target.id);
    }
  }
  for (const { row } of parsedFocus) {
    userIds.add(row.confirmedByUserId);
    if (row.retiredByUserId) userIds.add(row.retiredByUserId);
    personIds.add(row.personId);
  }
  for (const row of hypothesisRows) {
    if (row.personId) personIds.add(row.personId);
    if (row.ownerUserId) userIds.add(row.ownerUserId);
    if (row.createdByUserId) userIds.add(row.createdByUserId);
    if (row.statusConfirmedByUserId) userIds.add(row.statusConfirmedByUserId);
  }
  for (const revision of revisionRows) if (revision.createdByUserId) userIds.add(revision.createdByUserId);
  for (const link of linkRows) userIds.add(link.linkedByUserId);
  const refs = sourceReferenceIds(
    parsedIntelligence.map(({ view }) => view),
    parsedFocus.map(({ view }) => view),
  );

  const linkEvidenceIds = linkRows.map((link) => link.evidenceId);
  const verificationCommitmentIds = [...new Set(linkRows.flatMap((link) => (
    link.verificationCommitmentId ? [link.verificationCommitmentId] : []
  )))];
  const [users, participants, relations, sources, verificationCommitments] = await Promise.all([
    userIds.size === 0 ? Promise.resolve([]) : db.user.findMany({
      where: { tenantId: ctx.tenantId, id: { in: [...userIds] } }, select: { id: true },
    }),
    personIds.size === 0 ? Promise.resolve([]) : db.matterParticipant.findMany({
      where: {
        tenantId: ctx.tenantId,
        opportunityId: { in: matterIds },
        accountId: { in: customerIds },
        personId: { in: [...personIds] },
        person: { tenantId: ctx.tenantId, archivedAt: null, mergedIntoPersonId: null },
        opportunity: { tenantId: ctx.tenantId, archivedAt: null },
        account: { tenantId: ctx.tenantId, archivedAt: null },
      },
      select: {
        accountId: true,
        opportunityId: true,
        personId: true,
        person: { select: { accountId: true } },
        opportunity: { select: { accountId: true } },
      },
    }),
    relationIds.size === 0 ? Promise.resolve([]) : db.edge.findMany({
      where: {
        tenantId: ctx.tenantId,
        id: { in: [...relationIds] },
        accountId: { in: customerIds },
        opportunityId: { in: matterIds },
      },
      select: { id: true, accountId: true, opportunityId: true },
    }),
    readableSourceIndex(
      db,
      ctx,
      evaluator,
      refs.interactionIds,
      [...new Set([...refs.evidenceIds, ...linkEvidenceIds])],
    ),
    verificationCommitmentIds.length === 0 ? Promise.resolve([]) : db.planAction.findMany({
      where: {
        tenantId: ctx.tenantId,
        id: { in: verificationCommitmentIds },
        archivedAt: null,
      },
      select: {
        id: true,
        accountId: true,
        opportunityId: true,
        hypothesisId: true,
        hypothesisRevisionId: true,
      },
    }),
  ]);
  const currentUsers = new Set(users.map((user) => user.id));
  const participantKeys = new Set(participants.flatMap((participant) => (
    participant.person.accountId === participant.accountId
      && participant.opportunity.accountId === participant.accountId
      && activePairs.has(pairKey(participant.accountId, participant.opportunityId))
      ? [personKey(participant.accountId, participant.opportunityId, participant.personId)]
      : []
  )));
  const relationKeys = new Set(relations.flatMap((relation) => (
    relation.opportunityId
      ? [relationKey(relation.accountId, relation.opportunityId, relation.id)]
      : []
  )));
  const verificationById = new Map(verificationCommitments.map((commitment) => [commitment.id, commitment]));
  const validIntelligence = new Map<string, IntelligenceItemView>();
  for (const { row, view } of parsedIntelligence) {
    if (!activePairs.has(pairKey(view.customerId, view.matterId))
      || !currentUser(currentUsers, row.createdByUserId)
      || !currentUser(currentUsers, row.archivedByUserId)
      || !sourceIsReadable(view, sources)) continue;
    const validTargets = view.targets.every((target) => {
      if (target.kind === 'customer') return target.id === view.customerId;
      if (target.kind === 'matter') return target.id === view.matterId;
      if (target.kind === 'person') {
        return participantKeys.has(personKey(view.customerId, view.matterId, target.id));
      }
      return relationKeys.has(relationKey(view.customerId, view.matterId, target.id));
    });
    if (validTargets) validIntelligence.set(view.id, view);
  }

  const latestIntelligence = new Map<string, MatterPortfolioIntelligenceFact>();
  for (const { view } of parsedIntelligence) {
    if (view.status !== 'active' || latestIntelligence.has(view.matterId)
      || validIntelligence.get(view.id) !== view) continue;
    latestIntelligence.set(view.matterId, {
      id: view.id,
      version: view.version,
      learnedAtUtc: view.learnedAt,
    });
  }

  const focusPeople = new Map<string, string>();
  for (const { row, view } of parsedFocus) {
    if (view.status !== 'active' || focusPeople.has(view.matterId)
      || !activePairs.has(pairKey(view.customerId, view.matterId))
      || !currentUser(currentUsers, row.confirmedByUserId)
      || !currentUser(currentUsers, row.retiredByUserId)
      || !participantKeys.has(personKey(view.customerId, view.matterId, view.personId))
      || !basisIsReadable(view, validIntelligence, sources)) continue;
    focusPeople.set(view.matterId, view.personId);
  }

  const revisionsByHypothesis = new Map<string, RevisionRow[]>();
  for (const revision of revisionRows) {
    const values = revisionsByHypothesis.get(revision.hypothesisId) ?? [];
    values.push(revision);
    revisionsByHypothesis.set(revision.hypothesisId, values);
  }
  const linksByRevision = new Map<string, LinkRow[]>();
  for (const link of linkRows) {
    const values = linksByRevision.get(link.hypothesisRevisionId) ?? [];
    values.push(link);
    linksByRevision.set(link.hypothesisRevisionId, values);
  }
  const hypotheses = new Map<string, MatterPortfolioHypothesisFact[]>();
  for (const row of hypothesisRows) {
    if (!activePairs.has(pairKey(row.customerId, row.matterId))
      || !currentUser(currentUsers, row.ownerUserId)
      || !currentUser(currentUsers, row.createdByUserId)
      || !currentUser(currentUsers, row.statusConfirmedByUserId)
      || (row.personId !== null
        && !participantKeys.has(personKey(row.customerId, row.matterId, row.personId)))) continue;
    const history = revisionsByHypothesis.get(row.id) ?? [];
    const revisionViews = [];
    let validHistory = history.length > 0;
    for (const [index, revision] of history.entries()) {
      if (revision.tenantId !== ctx.tenantId
        || revision.hypothesisId !== row.id
        || revision.revisionNumber !== index + 1
        || !currentUser(currentUsers, revision.createdByUserId)) {
        validHistory = false;
        break;
      }
      try {
        revisionViews.push(projectSalesHypothesisRevision(revision));
      } catch {
        validHistory = false;
        break;
      }
    }
    const currentRevision = revisionViews.at(-1);
    if (!validHistory || !currentRevision || currentRevision.id !== row.currentRevisionId) continue;
    const currentLinks = linksByRevision.get(row.currentRevisionId) ?? [];
    if (currentLinks.length > 50 || !currentLinks.every((link) => {
      if (link.tenantId !== ctx.tenantId
        || link.hypothesisId !== row.id
        || link.hypothesisRevisionId !== row.currentRevisionId
        || !currentUser(currentUsers, link.linkedByUserId)
        || !sources.approvedEvidenceKeys.has(evidenceKey(row.customerId, row.matterId, link.evidenceId))) {
        return false;
      }
      if (link.verificationCommitmentId) {
        const commitment = verificationById.get(link.verificationCommitmentId);
        if (!commitment
          || commitment.accountId !== row.customerId
          || commitment.opportunityId !== row.matterId
          || commitment.hypothesisId !== row.id
          || commitment.hypothesisRevisionId !== row.currentRevisionId) return false;
      }
      try {
        projectHypothesisEvidenceLink(link);
        return true;
      } catch {
        return false;
      }
    })) continue;
    try {
      const view = projectSalesHypothesis(row, currentRevision);
      const values = hypotheses.get(view.matterId) ?? [];
      values.push({
        id: view.id,
        version: view.version,
        status: view.status,
        personId: view.personId,
        nextReviewAtUtc: view.nextReviewAt,
      });
      hypotheses.set(view.matterId, values);
    } catch {
      // Invalid stored hypotheses are omitted and therefore cannot elevate portfolio urgency.
    }
  }

  return { latestIntelligence, focusPeople, hypotheses };
}
