import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  PostMeetingUploadError,
  preparePostMeetingUpload,
  type PostMeetingUploadParsers,
} from '../src/postMeeting/upload.js';

describe('SAAS-203 bounded post-meeting upload preparation', () => {
  it('exports one parser that prepares an encrypted-ingest value without writing', async () => {
    const module = await import('../src/postMeeting/upload.js').catch(() => null);

    expect(module).not.toBeNull();
    expect(typeof module?.preparePostMeetingUpload).toBe('function');
  });

  it.each([
    ['notes.txt', 'text/plain'],
    ['notes.md', 'text/markdown'],
    ['notes.md', 'text/plain'],
  ])('prepares bounded UTF-8 %s with deterministic byte and content fingerprints', async (filename, mimetype) => {
    const bytes = Buffer.from('  governed meeting notes\n', 'utf8');
    const occurredAt = new Date('2026-08-26T12:00:00.000Z');

    await expect(preparePostMeetingUpload({ filename, mimetype, bytes, occurredAt })).resolves.toEqual({
      source: 'upload',
      externalRef: `upload:${createHash('sha256').update(bytes).digest('hex')}`,
      title: filename,
      text: 'governed meeting notes',
      durationSec: 0,
      recordedAt: occurredAt,
      contentFingerprint: createHash('sha256').update('governed meeting notes').digest('hex'),
    });
  });

  it('uses bounded DOCX and PDF text parsers without exposing raw parser values', async () => {
    const docxBytes = Buffer.from('docx fixture bytes');
    const pdfBytes = Buffer.from('%PDF fixture bytes');
    const parsers: PostMeetingUploadParsers = {
      extractDocxText: vi.fn(async () => '  DOCX extracted text  '),
      extractPdfText: vi.fn(async () => '  PDF extracted text  '),
    };

    const docx = await preparePostMeetingUpload({
      filename: 'meeting.docx',
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: docxBytes,
    }, parsers);
    const pdf = await preparePostMeetingUpload({
      filename: 'meeting.pdf', mimetype: 'application/pdf', bytes: pdfBytes,
    }, parsers);

    expect(parsers.extractDocxText).toHaveBeenCalledWith(docxBytes);
    expect(parsers.extractPdfText).toHaveBeenCalledWith(pdfBytes);
    expect(docx).toMatchObject({ text: 'DOCX extracted text', title: 'meeting.docx' });
    expect(pdf).toMatchObject({ text: 'PDF extracted text', title: 'meeting.pdf' });
    expect(JSON.stringify({ docx, pdf })).not.toContain('fixture bytes');
  });

  it.each([
    [{ filename: 'meeting.exe', mimetype: 'application/octet-stream', bytes: Buffer.from('body') }, 'post_meeting_upload_type_invalid'],
    [{ filename: 'meeting.pdf', mimetype: 'text/plain', bytes: Buffer.from('body') }, 'post_meeting_upload_mime_invalid'],
    [{ filename: 'meeting.txt', mimetype: 'application/pdf', bytes: Buffer.from('body') }, 'post_meeting_upload_mime_invalid'],
    [{ filename: 'meeting.txt', mimetype: 'text/plain', bytes: Buffer.from([0xc3, 0x28]) }, 'post_meeting_upload_encoding_invalid'],
    [{ filename: 'meeting.txt', mimetype: 'text/plain', bytes: Buffer.from('   \n') }, 'post_meeting_upload_empty'],
    [{ filename: 'meeting.txt', mimetype: 'text/plain', bytes: Buffer.alloc(10 * 1024 * 1024 + 1) }, 'post_meeting_upload_too_large'],
    [{ filename: 'meeting.txt', mimetype: 'text/plain', bytes: Buffer.from('x'.repeat(500_001)) }, 'post_meeting_upload_text_too_large'],
  ])('rejects invalid files with stable body-free code %#', async (input, code) => {
    await expect(preparePostMeetingUpload(input)).rejects.toMatchObject({ code, statusCode: 400 });
  });

  it('maps parser failures and image-only documents to stable safe errors', async () => {
    const rawError = 'SECRET parser stack with customer content';
    const failingParsers: PostMeetingUploadParsers = {
      extractDocxText: async () => { throw new Error(rawError); },
      extractPdfText: async () => '',
    };
    const docxFailure = await preparePostMeetingUpload({
      filename: 'meeting.docx',
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: Buffer.from('opaque'),
    }, failingParsers).catch((error: unknown) => error);
    const pdfFailure = await preparePostMeetingUpload({
      filename: 'meeting.pdf', mimetype: 'application/pdf', bytes: Buffer.from('opaque'),
    }, failingParsers).catch((error: unknown) => error);

    expect(docxFailure).toBeInstanceOf(PostMeetingUploadError);
    expect(docxFailure).toMatchObject({ code: 'post_meeting_upload_parse_failed', statusCode: 400 });
    expect(String(docxFailure)).not.toContain(rawError);
    expect(pdfFailure).toMatchObject({ code: 'post_meeting_upload_empty', statusCode: 400 });
  });

  it('normalizes path-like and oversized filenames while preserving the accepted extension', async () => {
    const longBase = 'a'.repeat(260);
    const result = await preparePostMeetingUpload({
      filename: `../private/${longBase}.txt`,
      mimetype: 'text/plain',
      bytes: Buffer.from('body'),
    });

    expect(result.title).toHaveLength(200);
    expect(result.title.endsWith('.txt')).toBe(true);
    expect(result.title).not.toContain('/');
    expect(result.title).not.toContain('..');
  });
});
