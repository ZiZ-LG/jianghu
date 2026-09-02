import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  ActorRoleSchema,
  PostMeetingFeishuImportRequestSchema,
  PostMeetingSourceImportReceiptSchema,
  PostMeetingUploadMetadataSchema,
  type CapabilityPolicy,
  type CommandContext,
} from '@jianghu/domain-contracts';
import { prisma } from '../prisma.js';
import { failReservedCommand, reserveCommand, runCommand } from '../mutation/commandRunner.js';
import {
  authorizePostMeetingImportMount,
  commitPostMeetingSource,
  PostMeetingImportError,
  readImportedPostMeetingSource,
} from './importService.js';
import {
  PostMeetingUploadError,
  preparePostMeetingUpload,
  type PostMeetingUploadInput,
} from './upload.js';
import {
  parseFeishuMinuteToken,
  prepareFeishuPostMeetingSource,
  productionFeishuImportProvider,
  type FeishuImportProvider,
} from './feishuImport.js';
import { resolveFeishuAccessToken } from '../recordingCredentials.js';

const MIN_IDEMPOTENCY_KEY = 8;
const MAX_IDEMPOTENCY_KEY = 200;

function context(req: any): CommandContext {
  return {
    tenantId: req.user.tenantId,
    actorId: req.user.userId,
    actorRole: ActorRoleSchema.parse(req.user.role),
    channel: 'web',
    requestId: req.id,
    assertionMode: 'raw_append',
  };
}

function idempotencyKey(req: any): string | null {
  const value = req.headers['idempotency-key'];
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return key.length >= MIN_IDEMPOTENCY_KEY && key.length <= MAX_IDEMPOTENCY_KEY ? key : null;
}

async function singleMultipartFile(req: any): Promise<PostMeetingUploadInput> {
  let uploaded: PostMeetingUploadInput | null = null;
  try {
    for await (const part of req.parts()) {
      if (part.type !== 'file' || uploaded) {
        throw new PostMeetingUploadError('post_meeting_upload_parts_invalid');
      }
      const bytes = await part.toBuffer();
      if (part.file?.truncated) throw new PostMeetingUploadError('post_meeting_upload_too_large');
      uploaded = {
        filename: part.filename ?? '',
        mimetype: part.mimetype ?? '',
        bytes,
      };
    }
  } catch (error) {
    if (error instanceof PostMeetingUploadError) throw error;
    throw new PostMeetingUploadError('post_meeting_upload_parts_invalid');
  }
  if (!uploaded) throw new PostMeetingUploadError('post_meeting_upload_missing');
  return uploaded;
}

function sendImportFailure(reply: any, error: unknown) {
  if (error instanceof PostMeetingUploadError) {
    return reply.code(error.statusCode).send({ error: '上传文件无效', code: error.code });
  }
  if (error instanceof PostMeetingImportError) {
    const message = error.statusCode === 404 ? '客户、事项或来源不存在' : '来源导入失败';
    return reply.code(error.statusCode).send({ error: message, code: error.code });
  }
  if (error && typeof error === 'object' && 'statusCode' in error
    && typeof error.statusCode === 'number') {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : 'command_failed';
    return reply.code(error.statusCode).send({ error: '来源导入命令失败', code });
  }
  throw error;
}

export interface PostMeetingImportRouteOptions {
  feishuImportProvider?: FeishuImportProvider;
}

export function postMeetingImportRoutes(
  app: FastifyInstance,
  policy: CapabilityPolicy,
  options: PostMeetingImportRouteOptions = {},
): void {
  const feishuProvider = options.feishuImportProvider ?? productionFeishuImportProvider;
  app.post('/api/post-meeting/import/upload', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (req.user.role === 'viewer') {
      return reply.code(403).send({ error: '只读成员不可导入', code: 'viewer_write_denied' });
    }
    const key = idempotencyKey(req);
    if (!key) {
      return reply.code(400).send({
        error: '缺少有效的 Idempotency-Key', code: 'idempotency_key_required',
      });
    }
    const metadata = PostMeetingUploadMetadataSchema.safeParse(req.query);
    if (!metadata.success) {
      return reply.code(400).send({ error: '上传参数无效', code: 'post_meeting_upload_metadata_invalid' });
    }

    const ctx = context(req);
    const mount = {
      customerId: metadata.data.customerId,
      matterId: metadata.data.matterId,
    };
    try {
      await prisma.$transaction((tx) => authorizePostMeetingImportMount(tx, ctx, policy, mount), {
        isolationLevel: 'Serializable',
      });
      const file = await singleMultipartFile(req);
      const prepared = await preparePostMeetingUpload({
        ...file,
        occurredAt: metadata.data.occurredAt ? new Date(metadata.data.occurredAt) : null,
      });
      const identity = { source: prepared.source, externalRef: prepared.externalRef } as const;
      const payload = {
        ...mount,
        occurredAt: prepared.recordedAt?.toISOString() ?? null,
        title: prepared.title,
        sourceKind: prepared.source,
        externalRef: prepared.externalRef,
        contentFingerprint: prepared.contentFingerprint,
      };
      const commandInput = {
        kind: 'post-meeting-import-upload',
        idempotencyKey: key,
        payload,
        discardReservationOnScopedError: true,
        authorizeReplay: async (tx: Prisma.TransactionClient) => {
          await readImportedPostMeetingSource(tx, ctx, policy, mount, identity);
        },
      };
      const reservation = await reserveCommand<{
        artifactId: string;
        businessReplayed: boolean;
      }>(ctx, commandInput);
      if (reservation.replayed) {
        const source = await prisma.$transaction((tx) => (
          readImportedPostMeetingSource(tx, ctx, policy, mount, identity)
        ), { isolationLevel: 'Serializable' });
        return PostMeetingSourceImportReceiptSchema.parse({ source, replayed: true });
      }
      const command = await runCommand(ctx, {
        ...commandInput,
        reservationToken: reservation.reservationToken,
      }, async (tx) => {
        const committed = await commitPostMeetingSource(tx, ctx, policy, mount, prepared);
        return { artifactId: committed.source.id, businessReplayed: committed.businessReplayed };
      });
      const source = await prisma.$transaction((tx) => (
        readImportedPostMeetingSource(tx, ctx, policy, mount, identity)
      ), { isolationLevel: 'Serializable' });
      return PostMeetingSourceImportReceiptSchema.parse({
        source,
        replayed: command.replayed || command.result.businessReplayed,
      });
    } catch (error) {
      return sendImportFailure(reply, error);
    }
  });

  app.post('/api/post-meeting/import/feishu', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (req.user.role === 'viewer') {
      return reply.code(403).send({ error: '只读成员不可导入', code: 'viewer_write_denied' });
    }
    const key = idempotencyKey(req);
    if (!key) {
      return reply.code(400).send({
        error: '缺少有效的 Idempotency-Key', code: 'idempotency_key_required',
      });
    }
    const request = PostMeetingFeishuImportRequestSchema.safeParse(req.body);
    if (!request.success) {
      return reply.code(400).send({ error: '飞书妙记参数无效', code: 'post_meeting_feishu_request_invalid' });
    }

    const ctx = context(req);
    const mount = { customerId: request.data.customerId, matterId: request.data.matterId };
    const minuteToken = parseFeishuMinuteToken(request.data.url);
    const identity = { source: 'feishu' as const, externalRef: `feishu:${minuteToken}` };
    const payload = { ...mount, sourceKind: 'feishu', externalRef: identity.externalRef };
    const commandInput = {
      kind: 'post-meeting-import-feishu',
      idempotencyKey: key,
      payload,
      discardReservationOnScopedError: true,
      authorizeReplay: async (tx: Prisma.TransactionClient) => {
        await readImportedPostMeetingSource(tx, ctx, policy, mount, identity);
      },
    };
    try {
      await prisma.$transaction((tx) => authorizePostMeetingImportMount(tx, ctx, policy, mount), {
        isolationLevel: 'Serializable',
      });
      const reservation = await reserveCommand<{
        artifactId: string;
        businessReplayed: boolean;
      }>(ctx, commandInput);
      if (reservation.replayed) {
        const source = await prisma.$transaction((tx) => (
          readImportedPostMeetingSource(tx, ctx, policy, mount, identity)
        ), { isolationLevel: 'Serializable' });
        return PostMeetingSourceImportReceiptSchema.parse({ source, replayed: true });
      }

      let prepared;
      try {
        const accessToken = await resolveFeishuAccessToken(
          prisma, ctx.tenantId, ctx.actorId, feishuProvider,
        );
        prepared = await prepareFeishuPostMeetingSource({
          input: request.data.url,
          accessToken,
          provider: feishuProvider,
        });
      } catch (error) {
        await failReservedCommand(ctx, commandInput, reservation.reservationToken, error);
        throw error;
      }
      const command = await runCommand(ctx, {
        ...commandInput,
        reservationToken: reservation.reservationToken,
      }, async (tx) => {
        const committed = await commitPostMeetingSource(tx, ctx, policy, mount, prepared);
        return { artifactId: committed.source.id, businessReplayed: committed.businessReplayed };
      });
      const source = await prisma.$transaction((tx) => (
        readImportedPostMeetingSource(tx, ctx, policy, mount, identity)
      ), { isolationLevel: 'Serializable' });
      return PostMeetingSourceImportReceiptSchema.parse({
        source,
        replayed: command.replayed || command.result.businessReplayed,
      });
    } catch (error) {
      return sendImportFailure(reply, error);
    }
  });
}
