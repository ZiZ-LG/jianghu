import type {
  AgentEvidenceRef,
  AgentInputRef,
  CapabilityPolicy,
  ResearchBriefSubject,
} from '@jianghu/domain-contracts';
import { AgentPreparationError } from '../agents/model.js';
import type { DbClient } from '../mutation/scopeGuards.js';
import { loadAuthorizedPostMeetingSource } from '../postMeeting/source.js';
import {
  researchBriefCrmFactFingerprint,
  researchBriefCuratedSummaryFingerprint,
} from '../researchBriefs/service.js';
import type { PreMeetingPreparedSource } from './model.js';

const MAX_SOURCE_BODY_BYTES = 64 * 1024;
const MAX_CURATED_BYTES = 8 * 1024;
const FRESHNESS_MS = 24 * 60 * 60 * 1_000;

export interface PreMeetingSourceInput {
  tenantId: string;
  actorId: string;
  customerId: string;
  matterId: string | null;
  sourceArtifactId: string;
  generatedAt: Date;
  inputRefs: readonly AgentInputRef[];
}

export interface PreMeetingSourceOptions {
  decrypt?: (ciphertext: string) => string;
}

export interface PreMeetingSourceBundle {
  subject: ResearchBriefSubject;
  sources: PreMeetingPreparedSource[];
  evidence: AgentEvidenceRef;
}

export async function loadPreMeetingSources(
  db: DbClient,
  policy: CapabilityPolicy,
  input: PreMeetingSourceInput,
  options: PreMeetingSourceOptions = {},
): Promise<PreMeetingSourceBundle> {
  const fail = (code: string): never => { throw new AgentPreparationError(code); };
  if (!Number.isFinite(input.generatedAt.getTime())) fail('pre_meeting_source_timestamp_invalid');
  const expectedKinds = input.matterId === null
    ? ['customer', 'source_artifact'] as const
    : ['customer', 'matter', 'source_artifact'] as const;
  if (input.inputRefs.length !== expectedKinds.length) fail('pre_meeting_source_stale');
  const ref = (kind: AgentInputRef['kind'], id: string) => {
    const matches = input.inputRefs.filter((candidate) => candidate.kind === kind && candidate.id === id);
    if (matches.length !== 1) fail('pre_meeting_source_stale');
    return matches[0]!;
  };
  const customerRef = ref('customer', input.customerId);
  const matterRef = input.matterId === null ? null : ref('matter', input.matterId);
  const sourceRef = ref('source_artifact', input.sourceArtifactId);
  if (input.inputRefs.some((candidate) => !expectedKinds.includes(candidate.kind as never))) {
    fail('pre_meeting_source_stale');
  }

  const authorized = await loadAuthorizedPostMeetingSource(db, policy, {
    tenantId: input.tenantId,
    actorId: input.actorId,
    customerId: input.customerId,
    matterId: input.matterId,
    sourceArtifactId: input.sourceArtifactId,
    expectedAclVersion: sourceRef.version,
  }, {
    ...(options.decrypt ? { decrypt: options.decrypt } : {}),
    maxBodyBytes: MAX_SOURCE_BODY_BYTES,
  });
  if (authorized.customer.version !== customerRef.version
    || authorized.matter?.version !== matterRef?.version
    || authorized.aclVersion !== sourceRef.version) {
    fail('pre_meeting_source_stale');
  }

  const customer = await db.account.findFirst({
    where: { id: input.customerId, tenantId: input.tenantId, archivedAt: null },
    select: {
      id: true, name: true, unifiedCreditCode: true, version: true,
    },
  });
  if (!customer) throw new AgentPreparationError('pre_meeting_source_stale');
  const currentCustomer = customer;
  if (currentCustomer.version !== customerRef.version) fail('pre_meeting_source_stale');

  const generatedIso = input.generatedAt.toISOString();
  const freshUntil = new Date(input.generatedAt.getTime() + FRESHNESS_MS).toISOString();
  const subjectAnchor = `crm_customer:${input.customerId}`;
  const selected = currentCustomer.unifiedCreditCode?.trim()
    ? {
        legalName: currentCustomer.name,
        anchorKind: 'unified_credit_code' as const,
        anchorValue: currentCustomer.unifiedCreditCode.trim(),
        provider: 'jianghu-crm',
      }
    : {
        legalName: currentCustomer.name,
        anchorKind: 'provider_subject_id' as const,
        anchorValue: currentCustomer.id,
        provider: 'jianghu-crm',
      };
  const subject: ResearchBriefSubject = {
    status: 'matched',
    query: currentCustomer.name,
    crmCustomerId: currentCustomer.id,
    selected,
    candidates: [],
  };

  const sources: PreMeetingPreparedSource[] = [{
    metadata: {
      id: 'crm-customer', kind: 'crm_fact', refId: `${currentCustomer.id}@${currentCustomer.version}`,
      version: currentCustomer.version,
      fingerprint: researchBriefCrmFactFingerprint({
        kind: 'customer', id: currentCustomer.id, version: currentCustomer.version,
      }),
      provider: 'jianghu-crm', label: '客户基本信息', url: null, subjectAnchor,
      observedAt: null, retrievedAt: generatedIso, freshUntil, status: 'fresh', failureCode: null,
    },
    content: JSON.stringify({
      name: currentCustomer.name,
      unifiedCreditCode: currentCustomer.unifiedCreditCode,
    }),
  }];
  if (authorized.matter) {
    sources.push({
      metadata: {
        id: 'crm-matter', kind: 'crm_fact',
        refId: `${authorized.matter.id}@${authorized.matter.version}`,
        version: authorized.matter.version,
        fingerprint: researchBriefCrmFactFingerprint({
          kind: 'matter', id: authorized.matter.id, version: authorized.matter.version,
        }),
        provider: 'jianghu-crm', label: '事项基本信息', url: null, subjectAnchor,
        observedAt: null, retrievedAt: generatedIso, freshUntil, status: 'fresh', failureCode: null,
      },
      content: JSON.stringify({
        title: authorized.matter.title,
        kind: authorized.matter.kind,
        priority: authorized.matter.priority,
        targetDate: authorized.matter.targetDate,
      }),
    });
  }
  if (Date.parse(authorized.observedAt) > input.generatedAt.getTime()) {
    fail('pre_meeting_source_timestamp_invalid');
  }
  sources.push({
    metadata: {
      id: 'source-artifact', kind: 'source_artifact', refId: authorized.id,
      version: authorized.aclVersion, fingerprint: authorized.sourceFingerprint,
      provider: 'jianghu-source-artifact', label: authorized.title.trim() || '拜访来源',
      url: null, subjectAnchor, observedAt: authorized.observedAt,
      retrievedAt: generatedIso, freshUntil, status: 'fresh', failureCode: null,
    },
    content: authorized.body,
  });

  const curatedParents = [
    { entityKind: 'account', entityId: input.customerId, id: 'curated-account', label: '客户' },
    ...(input.matterId === null ? [] : [{
      entityKind: 'opportunity', entityId: input.matterId, id: 'curated-matter', label: '事项',
    }]),
  ];
  const curatedRows = await db.curatedSummary.findMany({
    where: {
      tenantId: input.tenantId,
      OR: curatedParents.map((parent) => ({
        entityKind: parent.entityKind, entityId: parent.entityId,
      })),
    },
    select: {
      id: true, entityKind: true, entityId: true, content: true, model: true,
      basedOnAt: true, editedByHuman: true, editedBy: true, aclVersion: true,
      createdAt: true, updatedAt: true,
    },
  });
  const humanEditorIds = [...new Set(curatedRows
    .filter((row) => row.editedByHuman && row.editedBy)
    .map((row) => row.editedBy))];
  const currentEditors = humanEditorIds.length === 0 ? [] : await db.user.findMany({
    where: { tenantId: input.tenantId, id: { in: humanEditorIds } }, select: { id: true },
  });
  const currentEditorIds = new Set(currentEditors.map((editor) => editor.id));

  for (const parent of curatedParents) {
    const row = curatedRows.find((candidate) => (
      candidate.entityKind === parent.entityKind && candidate.entityId === parent.entityId
    ));
    if (!row) continue;
    const content = row.content.trim();
    const contentSafe = content.length > 0
      && Buffer.byteLength(content, 'utf8') <= MAX_CURATED_BYTES
      && row.updatedAt.getTime() <= input.generatedAt.getTime();
    const isHuman = row.editedByHuman && Boolean(row.editedBy) && currentEditorIds.has(row.editedBy);
    const isAiCache = !row.editedByHuman && row.aclVersion >= 1 && Boolean(row.model.trim());
    if (!contentSafe || (!isHuman && !isAiCache)) continue;
    const kind = isHuman ? 'curated_human' as const : 'curated_ai_cache' as const;
    sources.push({
      metadata: {
        id: parent.id, kind, refId: row.id, version: row.aclVersion,
        fingerprint: researchBriefCuratedSummaryFingerprint(row),
        provider: 'jianghu-curated',
        label: isHuman
          ? `${parent.label}人工整理输入`
          : `${parent.label}兼容资料输入 · 旧 AI 缓存（非权威）`,
        url: null, subjectAnchor, observedAt: row.updatedAt.toISOString(),
        retrievedAt: generatedIso, freshUntil, status: 'fresh', failureCode: null,
      },
      content,
    });
  }

  return {
    subject,
    sources,
    evidence: {
      sourceArtifactId: authorized.id,
      locatorId: 'pre-meeting-source',
      sourceFingerprint: authorized.sourceFingerprint,
      observedAt: authorized.observedAt,
    },
  };
}
