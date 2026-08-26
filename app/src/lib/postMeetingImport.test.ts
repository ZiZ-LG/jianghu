import { describe, expect, it } from 'vitest';
import {
  buildPostMeetingRunInput,
  exactPostMeetingImportReceipt,
  postMeetingRunOutcome,
  reconcilePostMeetingSourceSelection,
  stableFeishuImportSubmission,
  stablePostMeetingLifecycleSubmission,
  stableUploadImportSubmission,
} from './postMeetingImport';

const anchor = { customerId: 'customer-1', matterId: 'matter-1' };
const source = {
  id: 'source-1', ...anchor, title: '客户会谈.md', kind: 'uploaded_file' as const,
  fingerprint: 'b'.repeat(64), aclVersion: 4, version: 4,
  occurredAt: '2026-08-25T18:00:00.000Z',
};

function uploadFile(name: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    size: bytes.byteLength,
    type: 'text/markdown',
    arrayBuffer: async () => bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  };
}

describe('post-meeting source import state', () => {
  it('keeps a Feishu transport key only for the exact link and mount', () => {
    let sequence = 0;
    const createKey = () => `command-${++sequence}`;
    const first = stableFeishuImportSubmission({
      url: 'https://team.feishu.cn/minutes/minute_token_001', ...anchor,
    }, null, createKey);
    const replay = stableFeishuImportSubmission({
      url: 'https://team.feishu.cn/minutes/minute_token_001', ...anchor,
    }, first, createKey);
    const changedLink = stableFeishuImportSubmission({
      url: 'https://team.feishu.cn/minutes/minute_token_002', ...anchor,
    }, first, createKey);
    const changedMount = stableFeishuImportSubmission({
      url: 'https://team.feishu.cn/minutes/minute_token_001',
      customerId: anchor.customerId,
      matterId: 'matter-2',
    }, first, createKey);

    expect(replay).toBe(first);
    expect(first.idempotencyKey).toBe('command-1');
    expect(changedLink.idempotencyKey).toBe('command-2');
    expect(changedMount.idempotencyKey).toBe('command-3');
  });

  it('hashes upload bytes and never reuses a key after content or mount changes', async () => {
    let sequence = 0;
    const createKey = () => `upload-${++sequence}`;
    const first = await stableUploadImportSubmission({
      file: uploadFile('meeting.md', 'alpha'), metadata: anchor,
    }, null, createKey);
    const replay = await stableUploadImportSubmission({
      file: uploadFile('meeting.md', 'alpha'), metadata: anchor,
    }, first, createKey);
    const changedContent = await stableUploadImportSubmission({
      file: uploadFile('meeting.md', 'bravo'), metadata: anchor,
    }, first, createKey);
    const changedMount = await stableUploadImportSubmission({
      file: uploadFile('meeting.md', 'alpha'),
      metadata: { customerId: anchor.customerId, matterId: 'matter-2' },
    }, first, createKey);

    expect(replay).toBe(first);
    expect(first.fileDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(changedContent.idempotencyKey).toBe('upload-2');
    expect(changedContent.fileDigest).not.toBe(first.fileDigest);
    expect(changedMount.idempotencyKey).toBe('upload-3');
  });

  it('accepts only the exact imported source mount and rejects secret/body fields', () => {
    expect(exactPostMeetingImportReceipt(
      { source, replayed: false }, anchor, 'uploaded_file',
    )).toEqual({
      source, replayed: false,
    });
    expect(() => exactPostMeetingImportReceipt({
      source: { ...source, matterId: 'matter-2' }, replayed: false,
    }, anchor, 'uploaded_file')).toThrow('invalid_post_meeting_import_response');
    expect(() => exactPostMeetingImportReceipt({
      source: { ...source, kind: 'transcript' }, replayed: false,
    }, anchor, 'uploaded_file')).toThrow('invalid_post_meeting_import_response');
    expect(() => exactPostMeetingImportReceipt({
      source, replayed: false, transcript: 'private source body',
    }, anchor, 'uploaded_file')).toThrow('invalid_post_meeting_import_response');
  });

  it('builds the existing anchored Job request from current exact versions', () => {
    expect(buildPostMeetingRunInput({
      job: { jobKey: 'post_meeting_extract', jobVersion: 'core-206.v1', available: true, enabled: true },
      customer: { id: anchor.customerId, version: 2, archivedAt: null },
      matter: { id: anchor.matterId, customerId: anchor.customerId, version: 3, archivedAt: null },
      source,
    })).toEqual({
      jobVersion: 'core-206.v1', customerId: anchor.customerId, matterId: anchor.matterId,
      sourceArtifactId: source.id,
      inputRefs: [
        { kind: 'customer', id: anchor.customerId, version: 2 },
        { kind: 'matter', id: anchor.matterId, version: 3 },
        { kind: 'source_artifact', id: source.id, version: 4 },
      ],
    });
    expect(() => buildPostMeetingRunInput({
      job: { jobKey: 'post_meeting_extract', jobVersion: 'core-206.v1', available: true, enabled: true },
      customer: { id: anchor.customerId, version: 2, archivedAt: null },
      matter: { id: 'matter-2', customerId: anchor.customerId, version: 3, archivedAt: null },
      source,
    })).toThrow('post_meeting_anchor_mismatch');
  });

  it('retains the exact source after a failed Job and exposes a deliberate retry', () => {
    expect(postMeetingRunOutcome(source, {
      status: 'failed', failureCode: 'tenant_model_config_missing', outputRefs: [],
    })).toEqual({
      selectedSourceId: source.id,
      reviewBatchId: null,
      errorCode: 'tenant_model_config_missing',
      canRetry: true,
    });
    expect(postMeetingRunOutcome(source, {
      status: 'succeeded', failureCode: '',
      outputRefs: [{ kind: 'review_batch', id: 'batch-1', version: 0 }],
    })).toEqual({
      selectedSourceId: source.id,
      reviewBatchId: 'batch-1',
      errorCode: '',
      canRetry: false,
    });
  });

  it('refreshes or clears the selected source after lifecycle changes', () => {
    expect(reconcilePostMeetingSourceSelection([source], source.id, null)).toBe(source.id);
    expect(reconcilePostMeetingSourceSelection([], source.id, null)).toBe('');
    expect(reconcilePostMeetingSourceSelection([
      { ...source, id: 'source-2' }, source,
    ], '', source.id)).toBe(source.id);
  });

  it('keeps lifecycle idempotency stable per action, source and ACL version', () => {
    let sequence = 0;
    const createKey = () => `lifecycle-${++sequence}`;
    const first = stablePostMeetingLifecycleSubmission({
      action: 'degrade', sourceId: source.id, expectedAclVersion: source.aclVersion,
    }, null, createKey);
    expect(stablePostMeetingLifecycleSubmission({
      action: 'degrade', sourceId: source.id, expectedAclVersion: source.aclVersion,
    }, first, createKey)).toBe(first);
    expect(stablePostMeetingLifecycleSubmission({
      action: 'delete', sourceId: source.id, expectedAclVersion: source.aclVersion,
    }, first, createKey).idempotencyKey).toBe('lifecycle-2');
  });
});
