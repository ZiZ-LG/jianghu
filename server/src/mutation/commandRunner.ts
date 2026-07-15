import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import type { CommandContext } from '@jianghu/domain-contracts';
import { prisma } from '../prisma.js';

export class CommandInProgressError extends Error {
  readonly commandInProgress = true;
  readonly statusCode = 409;
  constructor() { super('相同命令正在执行，请稍后重试'); }
}

export class IdempotencyConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'idempotency_key_reused';
  constructor() { super('该 Idempotency-Key 已用于不同的业务参数'); }
}

export class CommandRetryableError extends Error {
  readonly statusCode = 503;
  readonly code = 'command_retryable';
  constructor() { super('命令暂时无法完成，请使用相同 Idempotency-Key 重试'); }
}

type CommandInput = {
  kind: string;
  idempotencyKey: string;
  payload?: unknown;
  reservationToken?: string;
  /** Caller opt-in: a scoped recheck miss cancels this exact running reservation instead of recording a business failure. */
  discardReservationOnScopedError?: boolean;
};
const TRANSACTION_ATTEMPTS = 3;
const LEASE_MS = 2 * 60_000;

const REDACTED_KEYS = new Set([
  'text', 'content', 'summary', 'raw', 'rawNote', 'rawContent', 'evidence', 'note', 'form', 'logs', 'priorText', 'oldValue', 'newValue',
  'name', 'title', 'label', 'person', 'source', 'target', 'similarTo', 'accountName',
]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    REDACTED_KEYS.has(key) ? '[redacted]' : redact(item),
  ]));
}

function parseStored<T>(raw: string): T {
  return JSON.parse(raw || '{}') as T;
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error && error.name ? error.name : 'command_failed';
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalize(item)]));
}

const requestHashOf = (payload: unknown): string => createHash('sha256')
  .update(JSON.stringify(canonicalize(payload ?? null)))
  .digest('hex');

/** 在昂贵的事务外准备工作前检查已完成/执行中的同一命令，避免重放再次调用外部服务。 */
export async function readCommandReplay<T>(
  ctx: CommandContext,
  input: CommandInput,
  db: PrismaClient = prisma,
): Promise<{ replayed: true; result: T } | undefined> {
  const existing = await db.commandRun.findUnique({ where: { tenantId_actorId_kind_idempotencyKey: {
    tenantId: ctx.tenantId, actorId: ctx.actorId, kind: input.kind, idempotencyKey: input.idempotencyKey,
  } } });
  if (!existing) return undefined;
  if (existing.requestHash !== requestHashOf(input.payload)) throw new IdempotencyConflictError();
  if (existing.status === 'completed') return { replayed: true, result: parseStored<T>(existing.resultSummary) };
  if (existing.status === 'running') {
    const activeUntil = existing.leaseExpiresAt ?? new Date(existing.updatedAt.getTime() + LEASE_MS);
    if (activeUntil > new Date()) throw new CommandInProgressError();
  }
  return undefined;
}

const whereFor = (ctx: CommandContext, input: CommandInput) => ({
  tenantId_actorId_kind_idempotencyKey: {
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
  },
}) as const;

const prismaCode = (error: unknown): string | undefined => (
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
);

const isRetryableDatabaseError = (error: unknown): boolean => {
  const code = prismaCode(error);
  if (code === 'P2034' || code === 'P1008' || code === 'P2028') return true;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('database is locked') || message.includes('transaction already closed');
};

const pause = (attempt: number) => new Promise((resolve) => setTimeout(resolve, 15 * attempt));

/**
 * 在事务外调用模型前先占用命令租约。同 key 的并发请求不会重复消耗 BYO 配额；
 * 进程崩溃后租约到期可由同一请求安全接管。
 */
export async function reserveCommand<T>(
  ctx: CommandContext,
  input: CommandInput,
  db: PrismaClient = prisma,
): Promise<{ replayed: true; result: T } | { replayed: false; reservationToken: string }> {
  const where = whereFor(ctx, input);
  const requestHash = requestHashOf(input.payload);
  for (let attempt = 1; attempt <= TRANSACTION_ATTEMPTS; attempt += 1) {
    const reservationToken = randomUUID();
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
    try {
      return await db.$transaction(async (tx) => {
        const existing = await tx.commandRun.findUnique({ where });
        if (existing && existing.requestHash !== requestHash) throw new IdempotencyConflictError();
        if (existing?.status === 'completed') return { replayed: true as const, result: parseStored<T>(existing.resultSummary) };
        if (existing?.status === 'running') {
          const activeUntil = existing.leaseExpiresAt ?? new Date(existing.updatedAt.getTime() + LEASE_MS);
          if (activeUntil > now) throw new CommandInProgressError();
        }
        if (existing) {
          await tx.commandRun.update({ where: { id: existing.id }, data: {
            status: 'running', errorCode: '', resultSummary: '{}', leaseToken: reservationToken, leaseExpiresAt,
          } });
        } else {
          await tx.commandRun.create({ data: {
            tenantId: ctx.tenantId, actorId: ctx.actorId, kind: input.kind,
            idempotencyKey: input.idempotencyKey, requestHash, leaseToken: reservationToken, leaseExpiresAt,
          } });
        }
        return { replayed: false as const, reservationToken };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 10_000 });
    } catch (error) {
      if (error instanceof CommandInProgressError || error instanceof IdempotencyConflictError) throw error;
      if (prismaCode(error) === 'P2002') {
        const existing = await db.commandRun.findUnique({ where });
        if (existing && existing.requestHash !== requestHash) throw new IdempotencyConflictError();
        if (existing?.status === 'completed') return { replayed: true, result: parseStored<T>(existing.resultSummary) };
        throw new CommandInProgressError();
      }
      if (!isRetryableDatabaseError(error) || attempt === TRANSACTION_ATTEMPTS) throw new CommandRetryableError();
      await pause(attempt);
    }
  }
  throw new CommandRetryableError();
}

export async function failReservedCommand(
  ctx: CommandContext,
  input: CommandInput,
  reservationToken: string,
  error: unknown,
  db: PrismaClient = prisma,
): Promise<void> {
  await db.commandRun.updateMany({
    where: {
      tenantId: ctx.tenantId, actorId: ctx.actorId, kind: input.kind,
      idempotencyKey: input.idempotencyKey, requestHash: requestHashOf(input.payload),
      status: 'running', leaseToken: reservationToken,
    },
    data: { status: 'failed', errorCode: errorCode(error), leaseToken: '', leaseExpiresAt: null },
  });
}

/**
 * Delete only the caller's still-running reservation. Every ownership/hash/lease field is matched so this cannot
 * remove another actor's command, a completed replay, or a newer lease that took over the same idempotency key.
 */
export async function cancelReservedCommand(
  ctx: CommandContext,
  input: CommandInput,
  reservationToken: string,
  db: PrismaClient = prisma,
): Promise<boolean> {
  const removed = await db.commandRun.deleteMany({
    where: {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHashOf(input.payload),
      status: 'running',
      leaseToken: reservationToken,
    },
  });
  return removed.count === 1;
}

const isScopedNotFound = (error: unknown): boolean => (
  Boolean(error && typeof error === 'object' && 'scopedNotFound' in error && error.scopedNotFound === true)
);

export async function runCommand<T>(
  ctx: CommandContext,
  input: CommandInput,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  db: PrismaClient = prisma,
): Promise<{ replayed: boolean; result: T }> {
  const where = whereFor(ctx, input);
  const requestHash = requestHashOf(input.payload);
  for (let attempt = 1; attempt <= TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
      const existing = await tx.commandRun.findUnique({ where });
      if (existing && existing.requestHash !== requestHash) throw new IdempotencyConflictError();
      if (existing?.status === 'completed') {
        return { replayed: true, result: parseStored<T>(existing.resultSummary) };
      }
      if (existing?.status === 'running' && existing.leaseToken !== (input.reservationToken ?? '')) throw new CommandInProgressError();
      if (existing) {
        await tx.commandRun.update({ where: { id: existing.id }, data: {
          status: 'running', errorCode: '', resultSummary: '{}',
          ...(input.reservationToken ? {} : { leaseToken: '', leaseExpiresAt: null }),
        } });
      } else {
        await tx.commandRun.create({ data: {
          tenantId: ctx.tenantId,
          actorId: ctx.actorId,
          kind: input.kind,
          idempotencyKey: input.idempotencyKey,
          requestHash,
        } });
      }
      const result = await fn(tx);
      const resultSummary = JSON.stringify(redact(result));
      await tx.commandRun.update({ where, data: { status: 'completed', resultSummary, errorCode: '', leaseToken: '', leaseExpiresAt: null } });
      return { replayed: false, result };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 115_000 });
    } catch (error) {
      if (error instanceof CommandInProgressError || error instanceof IdempotencyConflictError) throw error;
      if (input.discardReservationOnScopedError && input.reservationToken && isScopedNotFound(error)) {
        await cancelReservedCommand(ctx, input, input.reservationToken, db);
        throw error;
      }
      if (prismaCode(error) === 'P2002') {
        const existing = await db.commandRun.findUnique({ where });
        if (existing && existing.requestHash !== requestHash) throw new IdempotencyConflictError();
        if (existing?.status === 'completed') return { replayed: true, result: parseStored<T>(existing.resultSummary) };
        throw new CommandInProgressError();
      }
      if (isRetryableDatabaseError(error)) {
        try {
          const existing = await db.commandRun.findUnique({ where });
          if (existing?.status === 'completed') return { replayed: true, result: parseStored<T>(existing.resultSummary) };
          if (existing?.status === 'running' && existing.leaseToken !== (input.reservationToken ?? '')) throw new CommandInProgressError();
        } catch (reconcileError) {
          if (reconcileError instanceof CommandInProgressError) throw reconcileError;
        }
        if (attempt < TRANSACTION_ATTEMPTS) { await pause(attempt); continue; }
        throw new CommandRetryableError();
      }
      try {
        const existing = await db.commandRun.findUnique({ where });
        if (!existing) {
          await db.commandRun.create({ data: {
            tenantId: ctx.tenantId, actorId: ctx.actorId, kind: input.kind,
            idempotencyKey: input.idempotencyKey, requestHash, status: 'failed', errorCode: errorCode(error),
          } });
        } else if (existing.status !== 'completed' && input.reservationToken && existing.leaseToken === input.reservationToken) {
          await db.commandRun.update({ where: { id: existing.id }, data: {
            status: 'failed', errorCode: errorCode(error), leaseToken: '', leaseExpiresAt: null,
          } });
        }
      } catch { /* 原始业务错误优先；失败摘要写入失败不覆盖它。 */ }
      throw error;
    }
  }
  throw new CommandRetryableError();
}
