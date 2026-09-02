import { createHash } from 'node:crypto';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import type { PreparedPostMeetingSource } from './importModel.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 500_000;
const MAX_TITLE_CHARACTERS = 200;

const MIME_BY_EXTENSION: Readonly<Record<string, ReadonlySet<string>>> = {
  txt: new Set(['text/plain']),
  md: new Set(['text/markdown', 'text/plain']),
  docx: new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  pdf: new Set(['application/pdf']),
};

export class PostMeetingUploadError extends Error {
  readonly statusCode = 400;

  constructor(readonly code: string) {
    super(code);
    this.name = 'PostMeetingUploadError';
  }
}

export interface PostMeetingUploadInput {
  filename: string;
  mimetype: string;
  bytes: Buffer;
  occurredAt?: Date | null;
}

export interface PostMeetingUploadParsers {
  extractDocxText(bytes: Buffer): Promise<string>;
  extractPdfText(bytes: Buffer): Promise<string>;
}

const productionParsers: PostMeetingUploadParsers = {
  async extractDocxText(bytes) {
    return (await mammoth.extractRawText({ buffer: bytes })).value;
  },
  async extractPdfText(bytes) {
    const document = await getDocumentProxy(new Uint8Array(bytes));
    const result = await extractText(document, { mergePages: true });
    return Array.isArray(result.text) ? result.text.join('\n') : result.text;
  },
};

function normalizedFilename(filename: string): { title: string; extension: keyof typeof MIME_BY_EXTENSION } {
  const leaf = filename.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).at(-1)?.trim() ?? '';
  const dot = leaf.lastIndexOf('.');
  const extension = dot > 0 ? leaf.slice(dot + 1).toLowerCase() : '';
  if (!(extension in MIME_BY_EXTENSION)) throw new PostMeetingUploadError('post_meeting_upload_type_invalid');
  const suffix = `.${extension}`;
  const rawBase = leaf.slice(0, dot).replace(/^\.+/, '').trim();
  if (!rawBase) throw new PostMeetingUploadError('post_meeting_upload_type_invalid');
  const title = rawBase.length + suffix.length <= MAX_TITLE_CHARACTERS
    ? `${rawBase}${suffix}`
    : `${rawBase.slice(0, MAX_TITLE_CHARACTERS - suffix.length)}${suffix}`;
  return { title, extension: extension as keyof typeof MIME_BY_EXTENSION };
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new PostMeetingUploadError('post_meeting_upload_encoding_invalid');
  }
}

export async function preparePostMeetingUpload(
  input: PostMeetingUploadInput,
  parsers: PostMeetingUploadParsers = productionParsers,
): Promise<PreparedPostMeetingSource> {
  if (!Buffer.isBuffer(input.bytes) || input.bytes.length > MAX_FILE_BYTES) {
    throw new PostMeetingUploadError('post_meeting_upload_too_large');
  }
  if (input.bytes.length === 0) throw new PostMeetingUploadError('post_meeting_upload_empty');
  const { title, extension } = normalizedFilename(input.filename);
  const mimetype = input.mimetype.toLowerCase().split(';', 1)[0]?.trim() ?? '';
  if (!MIME_BY_EXTENSION[extension].has(mimetype)) {
    throw new PostMeetingUploadError('post_meeting_upload_mime_invalid');
  }
  if (input.occurredAt !== undefined
    && input.occurredAt !== null
    && Number.isNaN(input.occurredAt.getTime())) {
    throw new PostMeetingUploadError('post_meeting_upload_occurred_at_invalid');
  }

  let rawText: string;
  try {
    if (extension === 'txt' || extension === 'md') rawText = decodeUtf8(input.bytes);
    else if (extension === 'docx') rawText = await parsers.extractDocxText(input.bytes);
    else rawText = await parsers.extractPdfText(input.bytes);
  } catch (error) {
    if (error instanceof PostMeetingUploadError) throw error;
    throw new PostMeetingUploadError('post_meeting_upload_parse_failed');
  }
  const text = rawText.trim();
  if (!text) throw new PostMeetingUploadError('post_meeting_upload_empty');
  if (text.length > MAX_TEXT_CHARACTERS) {
    throw new PostMeetingUploadError('post_meeting_upload_text_too_large');
  }

  return {
    source: 'upload',
    externalRef: `upload:${createHash('sha256').update(input.bytes).digest('hex')}`,
    title,
    text,
    durationSec: 0,
    recordedAt: input.occurredAt ?? null,
    contentFingerprint: createHash('sha256').update(text).digest('hex'),
  };
}
