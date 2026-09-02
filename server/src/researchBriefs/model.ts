import { createHash } from 'node:crypto';
import {
  RESEARCH_BRIEF_SECTION_KEYS,
  ResearchBriefPreparedPayloadSchema,
  type ResearchBriefPreparedPayload,
  type ResearchBriefSnapshotStatus,
} from '@jianghu/domain-contracts';

const MAX_CANONICAL_BYTES = 50_000;

export class ResearchBriefModelError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ResearchBriefModelError';
  }
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => lexical(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parsedPayload(input: unknown): ResearchBriefPreparedPayload {
  const parsed = ResearchBriefPreparedPayloadSchema.safeParse(input);
  if (!parsed.success) throw new ResearchBriefModelError('research_brief_payload_invalid');
  return parsed.data;
}

function canonicalize(input: ResearchBriefPreparedPayload): ResearchBriefPreparedPayload {
  return {
    subject: {
      ...input.subject,
      // Candidate order is provider relevance order, not a mathematical set.
      candidates: [...input.subject.candidates],
    },
    sources: [...input.sources].sort((left, right) => lexical(left.id, right.id)),
    sections: input.sections
      .map((section) => ({ ...section, sourceIds: [...section.sourceIds].sort(lexical) }))
      .sort((left, right) => (
        RESEARCH_BRIEF_SECTION_KEYS.indexOf(left.key) - RESEARCH_BRIEF_SECTION_KEYS.indexOf(right.key)
      )),
    unknowns: input.unknowns
      .map((unknown) => ({ ...unknown, sourceIds: [...unknown.sourceIds].sort(lexical) }))
      .sort((left, right) => lexical(left.key, right.key)),
    failures: [...input.failures].sort((left, right) => lexical(
      `${left.sourceId}\0${left.code}`,
      `${right.sourceId}\0${right.code}`,
    )),
    generator: {
      ...input.generator,
      connectorRefs: [...input.generator.connectorRefs].sort(lexical),
    },
  };
}

export function validateResearchBriefPreparedPayload(input: unknown): ResearchBriefPreparedPayload {
  const canonical = canonicalize(parsedPayload(input));
  if (Buffer.byteLength(stableSerialize(canonical), 'utf8') > MAX_CANONICAL_BYTES) {
    throw new ResearchBriefModelError('research_brief_payload_invalid');
  }
  return canonical;
}

export function canonicalResearchBriefPayload(input: unknown): ResearchBriefPreparedPayload {
  return validateResearchBriefPreparedPayload(input);
}

export function serializeResearchBriefPayload(input: unknown): string {
  return stableSerialize(validateResearchBriefPreparedPayload(input));
}

export function hashResearchBriefPayload(input: unknown): string {
  return sha256(serializeResearchBriefPayload(input));
}

export interface DerivedResearchBriefMetadata {
  status: ResearchBriefSnapshotStatus;
  subjectStatus: ResearchBriefPreparedPayload['subject']['status'];
  sourceCount: number;
  sectionCount: number;
  unknownCount: number;
  failureCount: number;
  basedOnAt: Date | null;
  freshUntil: Date | null;
  sourceSetHash: string;
}

function asInstant(value: string): Date {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) {
    throw new ResearchBriefModelError('research_brief_timestamp_invalid');
  }
  return instant;
}

export function deriveResearchBriefMetadata(
  input: unknown,
  generatedAt: Date,
): DerivedResearchBriefMetadata {
  const payload = validateResearchBriefPreparedPayload(input);
  const generatedMillis = generatedAt.getTime();
  if (!Number.isFinite(generatedMillis)) {
    throw new ResearchBriefModelError('research_brief_timestamp_invalid');
  }

  const basis: Date[] = [];
  const expiries: Date[] = [];
  for (const source of payload.sources) {
    const retrievedAt = asInstant(source.retrievedAt);
    const observedAt = source.observedAt === null ? null : asInstant(source.observedAt);
    if (retrievedAt.getTime() > generatedMillis
      || (observedAt !== null && observedAt.getTime() > generatedMillis)) {
      throw new ResearchBriefModelError('research_brief_timestamp_invalid');
    }
    basis.push(observedAt ?? retrievedAt);
    if (source.freshUntil !== null) expiries.push(asInstant(source.freshUntil));
  }
  for (const section of payload.sections) {
    if (asInstant(section.asOf).getTime() > generatedMillis) {
      throw new ResearchBriefModelError('research_brief_timestamp_invalid');
    }
  }

  const status: ResearchBriefSnapshotStatus = payload.subject.status !== 'matched'
    ? 'blocked'
    : payload.sections.length > 0
      && payload.unknowns.length === 0
      && payload.failures.length === 0
      && payload.sources.every((source) => source.status === 'fresh')
      ? 'ready'
      : 'partial';

  const earliest = (values: Date[]): Date | null => values.length === 0
    ? null
    : new Date(Math.min(...values.map((value) => value.getTime())));

  return {
    status,
    subjectStatus: payload.subject.status,
    sourceCount: payload.sources.length,
    sectionCount: payload.sections.length,
    unknownCount: payload.unknowns.length,
    failureCount: payload.failures.length,
    basedOnAt: earliest(basis),
    freshUntil: earliest(expiries),
    sourceSetHash: sha256(stableSerialize(payload.sources)),
  };
}
