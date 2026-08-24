import {
  EVIDENCE_LEVELS,
  KNOWLEDGE_DOMAINS,
  type EvidenceRef,
  type KnowledgeItem,
  type LocalizedText,
  type SeedCandidate,
} from '../domain';
import { sourceRegistry, type SourceRegistryEntry } from './sources';

function requireText(value: unknown, message: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(message);
  }
}

function validateLocalizedText(value: LocalizedText) {
  requireText(value?.zh, 'Chinese content is required');
  if (value.en !== undefined) {
    requireText(value.en, 'English content must not be blank when provided');
  }
}

function validateIsoDate(value: string, label: string) {
  requireText(value, `${label} must be an ISO timestamp`);
  if (!value.includes('T') || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}

function validateEvidence(evidence: EvidenceRef) {
  requireText(evidence.id, 'evidence id is required');
  requireText(evidence.sourceId, 'evidence sourceId is required');
  requireText(evidence.title, 'evidence title is required');
  requireText(evidence.publisher, 'evidence publisher is required');
  validateIsoDate(evidence.publishedAt, 'evidence publishedAt');

  let url: URL;
  try {
    url = new URL(evidence.url);
  } catch {
    throw new Error('evidence URL must use HTTP(S)');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('evidence URL must use HTTP(S)');
  }
  if (!(EVIDENCE_LEVELS as readonly string[]).includes(evidence.level)) {
    throw new Error('evidence level is invalid');
  }
  if (evidence.language !== 'zh' && evidence.language !== 'en') {
    throw new Error('evidence language is invalid');
  }
}

function validateItemFields(item: KnowledgeItem) {
  requireText(item.id, 'item id is required');
  requireText(item.slug, 'item slug is required');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.slug)) {
    throw new Error('item slug is invalid');
  }

  validateLocalizedText(item.title);
  validateLocalizedText(item.summary);
  validateLocalizedText(item.whyItMatters);
  validateLocalizedText(item.salesImplication);
  validateLocalizedText(item.roleOrgImplication);
  validateLocalizedText(item.nextAction);

  if (item.domains.length === 0) {
    throw new Error('domains must not be empty');
  }
  if (item.domains.some((domain) => !(KNOWLEDGE_DOMAINS as readonly string[]).includes(domain))) {
    throw new Error('knowledge domain is invalid');
  }
  if (item.evidence.length === 0) {
    throw new Error('evidence must not be empty');
  }
  item.evidence.forEach(validateEvidence);

  validateIsoDate(item.publishedAt, 'publishedAt');
  validateIsoDate(item.updatedAt, 'updatedAt');
  validateIsoDate(item.audit.processedAt, 'audit processedAt');
  requireText(item.audit.sourceFingerprint, 'audit sourceFingerprint is required');
  requireText(item.audit.ruleVersion, 'audit ruleVersion is required');
  requireText(item.audit.releaseVersion, 'audit releaseVersion is required');

  if (item.publicationMode === 'allowlisted_low_risk_auto') {
    if (item.seedContent) {
      throw new Error('seed content requires manual approval');
    }
    if (item.riskLevel !== 'low') {
      throw new Error('automatic publication requires low risk');
    }
    if (item.evidence.some((evidence) => !evidence.allowlisted)) {
      throw new Error('automatic publication requires allowlisted evidence');
    }
    if (item.evidence.some((evidence) => evidence.level !== 'official')) {
      throw new Error('automatic publication requires official evidence');
    }
  }
}

function validateUniqueItems(items: readonly KnowledgeItem[]) {
  const ids = new Set<string>();
  const slugs = new Set<string>();

  for (const item of items) {
    validateItemFields(item);
    if (ids.has(item.id)) {
      throw new Error(`duplicate item id: ${item.id}`);
    }
    if (slugs.has(item.slug)) {
      throw new Error(`duplicate item slug: ${item.slug}`);
    }
    ids.add(item.id);
    slugs.add(item.slug);
  }
}

export function validateKnowledgeItems(items: readonly KnowledgeItem[]) {
  validateUniqueItems(items);
  if (items.some((item) => item.editorialStatus !== 'approved')) {
    throw new Error('public collection contains non-approved item');
  }
}

export function validateSeedCandidates(
  items: readonly SeedCandidate[],
  sources: readonly SourceRegistryEntry[] = sourceRegistry,
) {
  validateUniqueItems(items);

  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const mainlandSourceIds = new Set(
    sources
      .filter((source) => source.originRegion === 'mainland_china')
      .map((source) => source.id),
  );
  const mainlandItemIds = new Set<string>();
  const conclusionScopes = new Set(['single_authority', 'cross_organization', 'editorial_synthesis']);

  for (const item of items) {
    if (!item.seedContent || item.editorialStatus !== 'candidate') {
      throw new Error('seed review collection requires candidate seed content');
    }
    if (item.publicationMode !== 'manual') {
      throw new Error('seed content requires manual approval');
    }
    if (item.review.status !== 'pending_owner_review') {
      throw new Error('seed candidate is not pending owner review');
    }
    validateIsoDate(item.review.verifiedAt, 'review verifiedAt');
    if (item.tags.length === 0) {
      throw new Error('seed candidate tags must not be empty');
    }
    if (item.evidence.some((evidence) => !evidence.allowlisted)) {
      throw new Error('seed candidate evidence must be allowlisted');
    }
    if (item.evidence.some((evidence) => !sourceById.has(evidence.sourceId))) {
      throw new Error(`${item.id} evidence source is not registered`);
    }
    if (!conclusionScopes.has(item.conclusionScope)) {
      throw new Error(`${item.id} conclusion scope is invalid`);
    }
    if (item.supportingFacts.length < 2) {
      throw new Error(`${item.id} requires at least two supporting facts`);
    }

    const evidenceById = new Map(item.evidence.map((evidence) => [evidence.id, evidence]));
    const factStatements = new Set<string>();
    const supportingSourceIds = new Set<string>();
    for (const fact of item.supportingFacts) {
      requireText(fact.id, `${item.id} supporting fact id is required`);
      requireText(fact.statement, `${item.id} supporting fact statement is required`);
      const normalizedStatement = fact.statement.trim();
      if (factStatements.has(normalizedStatement)) {
        throw new Error(`${item.id} supporting facts must be unique`);
      }
      factStatements.add(normalizedStatement);
      if (fact.evidenceIds.length === 0) {
        throw new Error(`${item.id} supporting fact requires evidence`);
      }
      for (const evidenceId of fact.evidenceIds) {
        const evidence = evidenceById.get(evidenceId);
        if (!evidence) {
          throw new Error(`${item.id} supporting fact references missing evidence`);
        }
        supportingSourceIds.add(evidence.sourceId);
        if (mainlandSourceIds.has(evidence.sourceId)) {
          mainlandItemIds.add(item.id);
        }
      }
    }
    if (item.conclusionScope === 'cross_organization' && supportingSourceIds.size < 2) {
      throw new Error(`${item.id} cross-organization conclusion requires two sources`);
    }

    requireText(item.deeperAnalysis.mechanism, `${item.id} mechanism is required`);
    requireText(item.deeperAnalysis.businessValue, `${item.id} business value is required`);
    requireText(item.deeperAnalysis.boundary, `${item.id} boundary is required`);

    const authoredChinese = [
      item.title.zh,
      item.summary.zh,
      item.whyItMatters.zh,
      item.salesImplication.zh,
      item.roleOrgImplication.zh,
      item.nextAction.zh,
      item.review.verificationNotes,
      ...item.supportingFacts.map((fact) => fact.statement),
      item.deeperAnalysis.mechanism,
      item.deeperAnalysis.businessValue,
      item.deeperAnalysis.boundary,
    ].join('\n');
    if (authoredChinese.includes('代理')) {
      throw new Error(`${item.id} must keep Agent terminology in English`);
    }
  }

  if (items.length === 30) {
    const pureAiTechnologyCount = items
      .filter((item) => item.seedCategory === 'ai_technology').length;
    if (pureAiTechnologyCount / items.length >= 0.2) {
      throw new Error('pure AI technology content must stay below 20%');
    }
    if (mainlandItemIds.size < Math.ceil(items.length * 0.25)) {
      throw new Error('Mainland China-supported content must reach at least 25%');
    }
  }
}
