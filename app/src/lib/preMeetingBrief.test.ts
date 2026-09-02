import { describe, expect, it } from 'vitest';
import {
  AgentJobCardSchema,
  AgentRunReceiptSchema,
  ResearchBriefSnapshotDetailResponseSchema,
  ResearchBriefSnapshotListResponseSchema,
} from '@jianghu/domain-contracts';
import {
  buildPreMeetingRunInput,
  parsePreMeetingBriefDetail,
  parsePreMeetingBriefList,
  parsePreMeetingJobCards,
  parsePreMeetingRuns,
  preMeetingRunOutcome,
  stablePreMeetingRunSubmission,
} from './preMeetingBrief';

const job = AgentJobCardSchema.parse({
  jobKey: 'pre_meeting_brief', jobVersion: 'core-206.v1',
  purpose: 'brief', triggers: ['manual', 'event'],
  scopeManifest: {
    customer: 'required', matter: 'optional', sourceArtifact: 'optional',
    allowedSourceKinds: ['transcript', 'uploaded_file', 'note', 'external_reference'],
    allowedInputRefKinds: ['customer', 'matter', 'source_artifact'],
  },
  actionMode: 'read_only',
  evidencePolicy: { required: true, minimumRefs: 1, maximumRefs: 20, requireSourceFingerprint: true },
  outputRefKinds: ['research_brief'], modelRef: 'tenant-byo-ai', connectorRefs: [],
  budget: { maxInputRefs: 50, maxEvidenceRefs: 20, maxOutputRefs: 10, maxCostUnits: 1_000 },
  timeoutMs: 30_000, maxAttempts: 2,
  available: true, enabled: true, controlState: 'valid', controlVersion: 2,
  limits: { maxCostUnits: 1_000, timeoutMs: 30_000, maxAttempts: 2 },
});

const source = {
  id: 'source-205', customerId: 'customer-205', matterId: 'matter-205',
  title: '客户访谈', kind: 'note' as const, fingerprint: 'a'.repeat(64),
  aclVersion: 3, version: 3, occurredAt: '2026-08-27T06:00:00.000Z',
};

const detail = ResearchBriefSnapshotDetailResponseSchema.parse({ item: {
  id: 'rbs_205', customerId: 'customer-205', matterId: 'matter-205',
  status: 'partial', subjectStatus: 'matched', sourceCount: 1, sectionCount: 1,
  unknownCount: 1, failureCount: 0, version: 1,
  basedOnAt: '2026-08-27T06:00:00.000Z', freshUntil: '2026-08-28T08:00:00.000Z',
  generatedAt: '2026-08-27T08:00:00.000Z', createdAt: '2026-08-27T08:01:00.000Z',
  payload: {
    subject: {
      status: 'matched', query: '海岳能源', crmCustomerId: 'customer-205',
      selected: {
        legalName: '海岳能源', anchorKind: 'provider_subject_id',
        anchorValue: 'customer-205', provider: 'jianghu-crm',
      }, candidates: [],
    },
    sources: [{
      id: 'source-artifact', kind: 'source_artifact', refId: 'source-205', version: 3,
      fingerprint: 'a'.repeat(64), provider: 'jianghu-source-artifact', label: '客户访谈',
      url: null, subjectAnchor: 'crm_customer:customer-205',
      observedAt: '2026-08-27T06:00:00.000Z', retrievedAt: '2026-08-27T08:00:00.000Z',
      freshUntil: '2026-08-28T08:00:00.000Z', status: 'fresh', failureCode: null,
    }],
    sections: [{
      key: 'questions_to_verify', title: '拜访核验问题', content: '确认预算审批人。',
      sourceIds: ['source-artifact'], asOf: '2026-08-27T08:00:00.000Z',
    }],
    unknowns: [{
      key: 'stakeholders', question: '还需要确认哪些关键干系人及其角色？',
      reasonCode: 'insufficient_evidence', sourceIds: ['source-artifact'],
    }],
    failures: [],
    generator: { version: 'saas-204.v1', modelRef: 'tenant-model', connectorRefs: [] },
  },
} });

describe('SAAS-205 pre-meeting UI domain', () => {
  it('builds one exact anchored run and rejects stale or mismatched selections', () => {
    const input = buildPreMeetingRunInput({
      job,
      customer: { id: 'customer-205', version: 4, archivedAt: null },
      matter: { id: 'matter-205', customerId: 'customer-205', version: 2, archivedAt: null },
      source,
    });
    expect(input).toEqual({
      jobVersion: 'core-206.v1', customerId: 'customer-205', matterId: 'matter-205',
      sourceArtifactId: 'source-205',
      inputRefs: [
        { kind: 'customer', id: 'customer-205', version: 4 },
        { kind: 'matter', id: 'matter-205', version: 2 },
        { kind: 'source_artifact', id: 'source-205', version: 3 },
      ],
    });
    expect(() => buildPreMeetingRunInput({
      job,
      customer: { id: 'customer-205', version: 4, archivedAt: new Date().toISOString() },
      matter: { id: 'matter-205', customerId: 'customer-205', version: 2, archivedAt: null },
      source,
    })).toThrow('pre_meeting_customer_invalid');
    expect(() => buildPreMeetingRunInput({
      job,
      customer: { id: 'customer-205', version: 4, archivedAt: null },
      matter: { id: 'matter-other', customerId: 'customer-other', version: 2, archivedAt: null },
      source,
    })).toThrow('pre_meeting_matter_invalid');
    expect(() => buildPreMeetingRunInput({
      job,
      customer: { id: 'customer-205', version: 4, archivedAt: null },
      matter: { id: 'matter-205', customerId: 'customer-205', version: 2, archivedAt: null },
      source: { ...source, matterId: 'matter-other' },
    })).toThrow('pre_meeting_source_invalid');
  });

  it('reuses an idempotency key only for the identical canonical request', () => {
    const request = buildPreMeetingRunInput({
      job,
      customer: { id: 'customer-205', version: 4, archivedAt: null },
      matter: { id: 'matter-205', customerId: 'customer-205', version: 2, archivedAt: null },
      source,
    });
    let key = 0;
    const createKey = () => `key-${++key}`;
    const first = stablePreMeetingRunSubmission(request, null, createKey);
    const replay = stablePreMeetingRunSubmission(request, first, createKey);
    const changed = stablePreMeetingRunSubmission({
      ...request,
      inputRefs: request.inputRefs.map((ref) => ref.kind === 'source_artifact'
        ? { ...ref, version: ref.version + 1 } : ref),
    }, first, createKey);
    expect(replay).toBe(first);
    expect(changed.idempotencyKey).toBe('key-2');
  });

  it('strictly parses job/run/snapshot envelopes and rejects extra fields', () => {
    expect(parsePreMeetingJobCards({ items: [job] }).items).toEqual([job]);
    const run = AgentRunReceiptSchema.parse({
      replayed: false,
      run: {
        id: 'run-205', jobKey: 'pre_meeting_brief', jobVersion: 'core-206.v1',
        actionMode: 'read_only', trigger: 'manual', status: 'succeeded',
        customerId: 'customer-205', matterId: 'matter-205', sourceArtifactId: 'source-205',
        actorId: 'actor-205', attemptCount: 1, maxAttempts: 2,
        budgetLimit: 1000, costUsed: 1, timeoutMs: 30000,
        authorizationFingerprint: 'b'.repeat(64), modelRef: 'tenant-byo-ai', connectorRefs: [],
        inputRefs: [
          { kind: 'customer', id: 'customer-205', version: 4 },
          { kind: 'matter', id: 'matter-205', version: 2 },
          { kind: 'source_artifact', id: 'source-205', version: 3 },
        ],
        evidenceRefs: [{
          sourceArtifactId: 'source-205', locatorId: 'pre-meeting-source',
          sourceFingerprint: 'a'.repeat(64), observedAt: '2026-08-27T06:00:00.000Z',
        }],
        outputRefs: [{ kind: 'research_brief', id: 'rbs_205', version: 1 }],
        failureCode: '', createdAt: '2026-08-27T08:00:00.000Z',
        startedAt: '2026-08-27T08:00:00.000Z', completedAt: '2026-08-27T08:01:00.000Z', version: 2,
      },
    });
    expect(parsePreMeetingRuns({ items: [run.run], nextCursor: null }).items).toEqual([run.run]);
    const { payload: _payload, ...metadata } = detail.item;
    expect(parsePreMeetingBriefList(ResearchBriefSnapshotListResponseSchema.parse({
      items: [metadata], nextCursor: null,
    })).items[0]?.id).toBe('rbs_205');
    expect(parsePreMeetingBriefDetail(detail, 'rbs_205')).toEqual(detail.item);
    expect(() => parsePreMeetingBriefDetail({ ...detail, extra: true }, 'rbs_205'))
      .toThrow('invalid_pre_meeting_response');
  });

  it('requires one exact snapshot output for success and exposes bounded retry outcomes', () => {
    const succeeded = AgentRunReceiptSchema.parse({
      replayed: false,
      run: {
        id: 'run-ok', jobKey: 'pre_meeting_brief', jobVersion: 'core-206.v1', actionMode: 'read_only',
        trigger: 'manual', status: 'succeeded', customerId: 'customer-205', matterId: 'matter-205',
        sourceArtifactId: 'source-205', actorId: 'actor', attemptCount: 1, maxAttempts: 2,
        budgetLimit: 1000, costUsed: 1, timeoutMs: 30000, authorizationFingerprint: 'b'.repeat(64),
        modelRef: 'tenant-byo-ai', connectorRefs: [], inputRefs: [
          { kind: 'customer', id: 'customer-205', version: 4 },
          { kind: 'matter', id: 'matter-205', version: 2 },
          { kind: 'source_artifact', id: 'source-205', version: 3 },
        ], evidenceRefs: [{ sourceArtifactId: 'source-205', locatorId: 'pre-meeting-source', sourceFingerprint: 'a'.repeat(64), observedAt: '2026-08-27T06:00:00.000Z' }],
        outputRefs: [{ kind: 'research_brief', id: 'rbs_205', version: 1 }], failureCode: '',
        createdAt: '2026-08-27T08:00:00.000Z', startedAt: '2026-08-27T08:00:00.000Z', completedAt: '2026-08-27T08:01:00.000Z', version: 2,
      },
    }).run;
    expect(preMeetingRunOutcome(succeeded)).toEqual({
      briefId: 'rbs_205', errorCode: '', canRetry: false,
    });
    expect(preMeetingRunOutcome({
      ...succeeded, status: 'failed', outputRefs: [], failureCode: 'pre_meeting_model_failed',
    })).toEqual({ briefId: null, errorCode: 'pre_meeting_model_failed', canRetry: true });
    expect(() => preMeetingRunOutcome({ ...succeeded, outputRefs: [] }))
      .toThrow('invalid_pre_meeting_response');
  });
});
