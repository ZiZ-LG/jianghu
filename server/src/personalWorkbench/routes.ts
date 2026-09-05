import type { FastifyInstance } from 'fastify';
import { ActorRoleSchema, PersonalWorkbenchCommandSchema, PersonalWorkbenchReceiptSchema, type CapabilityPolicy, type CommandContext } from '@jianghu/domain-contracts';
import { prisma } from '../prisma.js';
import { runCommand } from '../mutation/commandRunner.js';
import { assertPersonalCommandAccess, executePersonalCommand, personalWorkbenchDetail, personalWorkbenchList } from './service.js';

const transaction = { isolationLevel: 'Serializable' as const, maxWait: 5_000, timeout: 30_000 };
function context(req: any): CommandContext {
  return { tenantId: req.user.tenantId, actorId: req.user.userId, actorRole: ActorRoleSchema.parse(req.user.role), channel: 'web', assertionMode: 'user_asserted', requestId: req.id };
}
function sendError(req: any, reply: any, error: unknown) {
  const known = error as { statusCode?: number; code?: string; scopedNotFound?: boolean };
  const status = known.scopedNotFound ? 404 : known.statusCode ?? (known.code === 'P2002' ? 409 : 503);
  req.log.warn({ code: typeof known.code === 'string' ? known.code : 'personal_workbench_failed' });
  return reply.code(status).send({ error: status === 404 ? '商机或人物不可用，请刷新后重试' : status === 409 ? '记录或依据已变化，请刷新后重试' : '请求未完成，请稍后重试',
    code: known.code?.startsWith('P') ? 'personal_workbench_conflict' : known.code ?? 'personal_workbench_failed' });
}
export function personalWorkbenchRoutes(app: FastifyInstance, policy: CapabilityPolicy) {
  app.get('/api/personal-workbench', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    try { return await prisma.$transaction(tx => personalWorkbenchList(tx, context(req), policy), transaction); }
    catch (error) { return sendError(req, reply, error); }
  });
  app.get('/api/personal-workbench/:id', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    try { return await prisma.$transaction(tx => personalWorkbenchDetail(tx, context(req), policy, req.params.id), transaction); }
    catch (error) { return sendError(req, reply, error); }
  });
  app.post('/api/commands/personal-workbench', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 200 || key !== key.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(key)) {
      return reply.code(400).send({ error: '请求标识无效', code: 'idempotency_key_invalid' });
    }
    const parsed = PersonalWorkbenchCommandSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '请检查填写的记录', code: 'personal_workbench_input_invalid' });
    const ctx = context(req), input = parsed.data;
    try {
      await prisma.$transaction(tx => assertPersonalCommandAccess(tx, ctx, policy, input), transaction);
      const result = await runCommand(ctx, { kind: 'personal-workbench', idempotencyKey: key, payload: input,
        authorizeReplay: tx => assertPersonalCommandAccess(tx, ctx, policy, input),
      }, tx => executePersonalCommand(tx, ctx, policy, input), prisma);
      return PersonalWorkbenchReceiptSchema.parse({ ...result.result, replayed: result.replayed });
    } catch (error) { return sendError(req, reply, error); }
  });
}
