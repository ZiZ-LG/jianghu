import type {
  KnowledgeItem,
  PublicationAudit,
  RiskLevel,
} from '../domain.ts';
import type { SourceRegistryEntry } from './sources.ts';

export type EditorialRiskSignal =
  | 'ordinary_product_fact'
  | 'research_metadata'
  | 'customer_case'
  | 'quantified_outcome'
  | 'role_trend'
  | 'editorial_inference'
  | 'third_party_commentary'
  | 'pricing_commercial_terms'
  | 'security_privacy'
  | 'legal_regulatory'
  | 'insufficient_evidence';

export interface EditorialPipelineCandidate {
  readonly item: KnowledgeItem;
  readonly sourceId: string;
  readonly canonicalUrl: string;
  readonly fetchedAt: string;
  readonly eventKey: string;
  readonly riskSignals: readonly EditorialRiskSignal[];
  readonly sourceConflict: boolean;
}

export interface EditorialPipelineControls {
  readonly autoPublishingEnabled: boolean;
  readonly stopSwitchEngaged: boolean;
  readonly ruleVersion: string;
  readonly releaseVersion: string;
}

export const DEFAULT_PIPELINE_CONTROLS: EditorialPipelineControls = {
  autoPublishingEnabled: false,
  stopSwitchEngaged: true,
  ruleVersion: 'stephen-editorial-v1',
  releaseVersion: 'unreleased',
};

export type PipelineDisposition =
  | 'auto_ready'
  | 'manual_review'
  | 'rejected'
  | 'duplicate';

export type DuplicateReason =
  | 'normalized_url'
  | 'event_key'
  | 'source_fingerprint';

export interface PipelineDecision {
  readonly itemId: string;
  readonly sourceId: string;
  readonly riskLevel: RiskLevel;
  readonly automaticEligibility: boolean;
  readonly disposition: PipelineDisposition;
  readonly reasons: readonly string[];
  readonly fieldErrors: readonly string[];
  readonly duplicateReason?: DuplicateReason;
  readonly audit: PublicationAudit;
}

export interface PipelineAuditEvent {
  readonly action: 'evaluated' | 'duplicate_detected';
  readonly itemId: string;
  readonly sourceFingerprint: string;
  readonly occurredAt: string;
  readonly ruleVersion: string;
  readonly detail: string;
}

export interface EditorialPipelineResult {
  readonly decisions: readonly PipelineDecision[];
  readonly autoReady: readonly PipelineDecision[];
  readonly manualReview: readonly PipelineDecision[];
  readonly rejected: readonly PipelineDecision[];
  readonly duplicates: readonly PipelineDecision[];
  readonly audit: readonly PipelineAuditEvent[];
}

export interface EditorialDedupeHistory {
  readonly normalizedUrls?: ReadonlySet<string>;
  readonly eventKeys?: ReadonlySet<string>;
  readonly sourceFingerprints?: ReadonlySet<string>;
}

function normalizeText(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function stableHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function normalizeCanonicalUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    url.hostname = url.hostname.toLocaleLowerCase();
    url.pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '');
    return url.href;
  } catch {
    return '';
  }
}

export function createSourceFingerprint(candidate: EditorialPipelineCandidate) {
  return stableHash([
    normalizeText(candidate.item.title.zh),
    normalizeText(candidate.item.summary.zh),
    candidate.item.publishedAt,
  ].join('|'));
}

function requiredText(value: unknown, label: string, errors: string[]) {
  if (typeof value !== 'string' || value.trim() === '') errors.push(`${label} is required`);
}

function isIsoTimestamp(value: string) {
  return value.includes('T') && !Number.isNaN(Date.parse(value));
}

export function validateEditorialCandidate(candidate: EditorialPipelineCandidate) {
  const errors: string[] = [];
  const { item } = candidate;
  requiredText(item.id, 'item.id', errors);
  requiredText(item.slug, 'item.slug', errors);
  requiredText(item.title.zh, 'title.zh', errors);
  requiredText(item.summary.zh, 'summary.zh', errors);
  requiredText(item.whyItMatters.zh, 'whyItMatters.zh', errors);
  requiredText(item.salesImplication.zh, 'salesImplication.zh', errors);
  requiredText(item.roleOrgImplication.zh, 'roleOrgImplication.zh', errors);
  requiredText(item.nextAction.zh, 'nextAction.zh', errors);
  requiredText(candidate.sourceId, 'sourceId', errors);
  requiredText(candidate.eventKey, 'eventKey', errors);

  if (item.domains.length === 0) errors.push('domains must not be empty');
  if (item.evidence.length === 0) errors.push('evidence must not be empty');
  item.evidence.forEach((evidence, index) => {
    requiredText(evidence.id, `evidence[${index}].id`, errors);
    requiredText(evidence.sourceId, `evidence[${index}].sourceId`, errors);
    requiredText(evidence.title, `evidence[${index}].title`, errors);
    requiredText(evidence.publisher, `evidence[${index}].publisher`, errors);
    if (!isIsoTimestamp(evidence.publishedAt)) {
      errors.push(`evidence[${index}].publishedAt must be an ISO timestamp`);
    }
    const evidenceUrl = normalizeCanonicalUrl(evidence.url);
    if (!evidenceUrl || !evidenceUrl.startsWith('https://')) {
      errors.push(`evidence[${index}].url must use HTTPS`);
    }
  });
  if (!isIsoTimestamp(item.publishedAt)) errors.push('publishedAt must be an ISO timestamp');
  if (!isIsoTimestamp(item.updatedAt)) errors.push('updatedAt must be an ISO timestamp');
  if (!isIsoTimestamp(candidate.fetchedAt)) errors.push('fetchedAt must be an ISO timestamp');
  if (item.editorialStatus !== 'candidate') errors.push('pipeline intake must be candidate content');

  const normalizedUrl = normalizeCanonicalUrl(candidate.canonicalUrl);
  if (!normalizedUrl || !normalizedUrl.startsWith('https://')) {
    errors.push('canonicalUrl must use HTTPS');
  }
  if (!item.evidence.some((evidence) => evidence.sourceId === candidate.sourceId)) {
    errors.push('candidate source must appear in evidence');
  }

  return errors;
}

const highRiskSignals = new Set<EditorialRiskSignal>([
  'pricing_commercial_terms',
  'security_privacy',
  'legal_regulatory',
  'insufficient_evidence',
]);

const mediumRiskSignals = new Set<EditorialRiskSignal>([
  'customer_case',
  'quantified_outcome',
  'role_trend',
  'editorial_inference',
  'third_party_commentary',
]);

const lowRiskSignals = new Set<EditorialRiskSignal>([
  'ordinary_product_fact',
  'research_metadata',
]);

export function deriveRiskLevelFromSignals(
  riskSignals: readonly EditorialRiskSignal[],
  sourceConflict: boolean,
): RiskLevel {
  if (sourceConflict) return 'high';
  if (riskSignals.length === 0) return 'high';
  if (riskSignals.some((signal) => highRiskSignals.has(signal))) return 'high';
  if (riskSignals.some((signal) => mediumRiskSignals.has(signal))) return 'medium';
  if (riskSignals.every((signal) => lowRiskSignals.has(signal))) return 'low';
  return 'high';
}

export function deriveRiskLevel(candidate: EditorialPipelineCandidate): RiskLevel {
  return deriveRiskLevelFromSignals(candidate.riskSignals, candidate.sourceConflict);
}

function publicationAudit(
  candidate: EditorialPipelineCandidate,
  controls: EditorialPipelineControls,
  sourceFingerprint: string,
): PublicationAudit {
  return {
    sourceFingerprint,
    ruleVersion: controls.ruleVersion,
    processedAt: candidate.fetchedAt,
    releaseVersion: controls.releaseVersion,
    rollbackState: 'available',
  };
}

function automaticEligibilityReasons(
  candidate: EditorialPipelineCandidate,
  sourceById: ReadonlyMap<string, SourceRegistryEntry>,
  riskLevel: RiskLevel,
) {
  const reasons: string[] = [];
  const source = sourceById.get(candidate.sourceId);
  const evidenceSources = candidate.item.evidence.map((evidence) => sourceById.get(evidence.sourceId));
  if (candidate.item.seedContent) reasons.push('seed content requires manual approval');
  if (!source || !source.active) reasons.push('source is not active and allowlisted');
  if (source?.automaticEligibility !== 'eligible_low_risk_facts') {
    reasons.push('source requires manual review');
  }
  if (evidenceSources.some((evidenceSource) => !evidenceSource?.active)) {
    reasons.push('every evidence source must be active and allowlisted');
  }
  if (evidenceSources.some((evidenceSource) =>
    evidenceSource?.automaticEligibility !== 'eligible_low_risk_facts')) {
    reasons.push('every evidence source must permit low-risk fact automation');
  }
  if (riskLevel !== 'low') reasons.push(`${riskLevel} risk requires manual review`);
  if (candidate.sourceConflict) reasons.push('source conflict requires manual review');
  if (candidate.item.evidence.some((evidence) => !evidence.allowlisted)) {
    reasons.push('all evidence must be allowlisted');
  }
  if (candidate.item.evidence.some((evidence) => evidence.level !== 'official')) {
    reasons.push('all evidence must be official');
  }
  return reasons;
}

function evaluateCandidate(
  candidate: EditorialPipelineCandidate,
  sourceById: ReadonlyMap<string, SourceRegistryEntry>,
  controls: EditorialPipelineControls,
  sourceFingerprint: string,
): PipelineDecision {
  const fieldErrors = validateEditorialCandidate(candidate);
  const riskLevel = deriveRiskLevel(candidate);
  const eligibilityReasons = automaticEligibilityReasons(candidate, sourceById, riskLevel);
  const automaticEligibility = fieldErrors.length === 0 && eligibilityReasons.length === 0;
  const reasons = [...eligibilityReasons];

  if (fieldErrors.length > 0) {
    reasons.push('candidate fields are incomplete or invalid');
    return {
      itemId: candidate.item.id,
      sourceId: candidate.sourceId,
      riskLevel,
      automaticEligibility: false,
      disposition: 'rejected',
      reasons,
      fieldErrors,
      audit: publicationAudit(candidate, controls, sourceFingerprint),
    };
  }

  if (!controls.autoPublishingEnabled) reasons.push('automatic publishing is disabled');
  if (controls.stopSwitchEngaged) reasons.push('publishing stop switch is engaged');
  const disposition = automaticEligibility
    && controls.autoPublishingEnabled
    && !controls.stopSwitchEngaged
    ? 'auto_ready'
    : 'manual_review';

  return {
    itemId: candidate.item.id,
    sourceId: candidate.sourceId,
    riskLevel,
    automaticEligibility,
    disposition,
    reasons,
    fieldErrors,
    audit: publicationAudit(candidate, controls, sourceFingerprint),
  };
}

export function processEditorialCandidates(
  candidates: readonly EditorialPipelineCandidate[],
  sources: readonly SourceRegistryEntry[],
  controls: EditorialPipelineControls,
  history: EditorialDedupeHistory = {},
): EditorialPipelineResult {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const seenUrls = new Set(
    [...(history.normalizedUrls ?? [])]
      .map(normalizeCanonicalUrl)
      .filter(Boolean),
  );
  const seenEvents = new Set(
    [...(history.eventKeys ?? [])]
      .map(normalizeText)
      .filter(Boolean),
  );
  const seenFingerprints = new Set(history.sourceFingerprints ?? []);
  const decisions: PipelineDecision[] = [];
  const audit: PipelineAuditEvent[] = [];

  for (const candidate of candidates) {
    const normalizedUrl = normalizeCanonicalUrl(candidate.canonicalUrl);
    const normalizedEvent = normalizeText(candidate.eventKey);
    const sourceFingerprint = createSourceFingerprint(candidate);
    let duplicateReason: DuplicateReason | undefined;

    if (normalizedUrl && seenUrls.has(normalizedUrl)) duplicateReason = 'normalized_url';
    else if (normalizedEvent && seenEvents.has(normalizedEvent)) duplicateReason = 'event_key';
    else if (seenFingerprints.has(sourceFingerprint)) duplicateReason = 'source_fingerprint';

    if (duplicateReason) {
      const decision: PipelineDecision = {
        itemId: candidate.item.id,
        sourceId: candidate.sourceId,
        riskLevel: deriveRiskLevel(candidate),
        automaticEligibility: false,
        disposition: 'duplicate',
        reasons: [`duplicate detected by ${duplicateReason}`],
        fieldErrors: [],
        duplicateReason,
        audit: publicationAudit(candidate, controls, sourceFingerprint),
      };
      decisions.push(decision);
      audit.push({
        action: 'duplicate_detected',
        itemId: decision.itemId,
        sourceFingerprint,
        occurredAt: candidate.fetchedAt,
        ruleVersion: controls.ruleVersion,
        detail: duplicateReason,
      });
      continue;
    }

    if (normalizedUrl) seenUrls.add(normalizedUrl);
    if (normalizedEvent) seenEvents.add(normalizedEvent);
    seenFingerprints.add(sourceFingerprint);

    const decision = evaluateCandidate(
      candidate,
      sourceById,
      controls,
      sourceFingerprint,
    );
    decisions.push(decision);
    audit.push({
      action: 'evaluated',
      itemId: decision.itemId,
      sourceFingerprint,
      occurredAt: candidate.fetchedAt,
      ruleVersion: controls.ruleVersion,
      detail: decision.disposition,
    });
  }

  return {
    decisions,
    autoReady: decisions.filter((decision) => decision.disposition === 'auto_ready'),
    manualReview: decisions.filter((decision) => decision.disposition === 'manual_review'),
    rejected: decisions.filter((decision) => decision.disposition === 'rejected'),
    duplicates: decisions.filter((decision) => decision.disposition === 'duplicate'),
    audit,
  };
}

export function selectDeterministicAuditSample(
  decisions: readonly PipelineDecision[],
  rate: number,
) {
  if (rate <= 0) return [];
  if (rate >= 1) return [...decisions];
  const threshold = Math.floor(rate * 10_000);
  return decisions.filter((decision) => {
    const bucket = Number.parseInt(stableHash(
      `${decision.itemId}|${decision.audit.sourceFingerprint}|${decision.audit.ruleVersion}`,
    ).slice(0, 4), 16) % 10_000;
    return bucket < threshold;
  });
}

export interface PublicationLifecycleEvent {
  readonly action: 'published' | 'withdrawn' | 'rolled_back';
  readonly occurredAt: string;
  readonly actor: string;
  readonly releaseVersion: string;
  readonly reason?: string;
}

export interface PublicationRecord {
  readonly itemId: string;
  readonly status: 'published' | 'withdrawn' | 'rolled_back';
  readonly activeReleaseVersion: string;
  readonly audit: readonly PublicationLifecycleEvent[];
}

function requireLifecycleText(value: string, label: string) {
  if (!value.trim()) throw new Error(`${label} is required`);
}

export function createPublicationRecord(
  itemId: string,
  releaseVersion: string,
  occurredAt: string,
): PublicationRecord {
  requireLifecycleText(itemId, 'itemId');
  requireLifecycleText(releaseVersion, 'releaseVersion');
  if (!isIsoTimestamp(occurredAt)) throw new Error('occurredAt must be an ISO timestamp');
  return {
    itemId,
    status: 'published',
    activeReleaseVersion: releaseVersion,
    audit: [{
      action: 'published',
      occurredAt,
      actor: 'release-system',
      releaseVersion,
    }],
  };
}

export function withdrawPublication(
  record: PublicationRecord,
  reason: string,
  actor: string,
  occurredAt: string,
): PublicationRecord {
  requireLifecycleText(reason, 'withdrawal reason');
  requireLifecycleText(actor, 'actor');
  if (!isIsoTimestamp(occurredAt)) throw new Error('occurredAt must be an ISO timestamp');
  return {
    ...record,
    status: 'withdrawn',
    audit: [...record.audit, {
      action: 'withdrawn',
      occurredAt,
      actor,
      releaseVersion: record.activeReleaseVersion,
      reason,
    }],
  };
}

export function rollbackRelease(
  record: PublicationRecord,
  previousReleaseVersion: string,
  actor: string,
  occurredAt: string,
): PublicationRecord {
  requireLifecycleText(previousReleaseVersion, 'previousReleaseVersion');
  requireLifecycleText(actor, 'actor');
  if (!isIsoTimestamp(occurredAt)) throw new Error('occurredAt must be an ISO timestamp');
  return {
    ...record,
    status: 'rolled_back',
    activeReleaseVersion: previousReleaseVersion,
    audit: [...record.audit, {
      action: 'rolled_back',
      occurredAt,
      actor,
      releaseVersion: previousReleaseVersion,
      reason: `rolled back from ${record.activeReleaseVersion}`,
    }],
  };
}
