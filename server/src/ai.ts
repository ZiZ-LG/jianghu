import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { denyViewer } from './scope.js';
import { deploymentOutboundPolicy, fetchOutbound } from './security/outboundUrl.js';
import type { DbClient } from './mutation/scopeGuards.js';
import { visiblePersonLogs, type ReadPrincipal } from './visibility.js';
import { pickKeyInfluencerKeeper, scoreFromState, type Confidence, type Role, type Sentiment } from './g64111.js';
import { resolveEffectiveResourceScope } from './resourceScope.js';

export interface AiContextOptions {
  includeRawLogs: boolean;
  includeForm: boolean;
}

export interface ContextManifest {
  entities: {
    accounts: number;
    opportunities: number;
    people: number;
    relationships: number;
    burningIssues: number;
    ucvs: number;
    interactionLogs: number;
  };
  fieldCategories: string[];
  excludedSensitiveCategories: string[];
}

export const AiContextOptionsSchema = z.object({
  includeRawLogs: z.boolean().default(false),
  includeForm: z.boolean().default(false),
}).strict().default({ includeRawLogs: false, includeForm: false });

const roleValues = new Set<Role>(['A', 'D', 'U', 'R', 'C']);
const sentimentValues = new Set<Sentiment>(['star', 'plus', 'neutral', 'unknown', 'minus', 'x']);
const confidenceValues = new Set<Confidence>(['共识', '明确', '推理', '不清']);
const jsonObject = (raw: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(raw || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
};
const formFieldNames = ['family', 'occupation', 'recreation', 'moneyMotivation'] as const;
const sanitizeForm = (raw: string): Record<string, unknown> => {
  const parsed = jsonObject(raw);
  const form: Record<string, unknown> = {};
  for (const key of formFieldNames) if (typeof parsed[key] === 'string') form[key] = parsed[key];
  const family7 = parsed.family7;
  if (family7 && typeof family7 === 'object' && !Array.isArray(family7)) {
    form.family7 = Object.fromEntries(Object.entries(family7).filter(([, value]) => typeof value === 'string'));
  }
  return form;
};

export class AiContextNotFoundError extends Error {}
export interface ContextManifestBinding {
  tenantId: string;
  actorUserId: string;
  opportunityId: string;
  options?: Partial<AiContextOptions>;
}

const stableSerialize = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

export const contextManifestToken = (manifest: ContextManifest, binding: ContextManifestBinding): string => {
  const options = AiContextOptionsSchema.parse(binding.options ?? {});
  const payload = {
    version: 1,
    tenantId: binding.tenantId,
    actorUserId: binding.actorUserId,
    opportunityId: binding.opportunityId,
    options,
    manifest,
  };
  return crypto.createHash('sha256').update(stableSerialize(payload)).digest('hex');
};

export async function buildServerAiContext(input: {
  tenantId: string;
  principal: ReadPrincipal;
  opportunityId: string;
  options?: Partial<AiContextOptions>;
}): Promise<{ context: any; manifest: ContextManifest }> {
  const options = AiContextOptionsSchema.parse(input.options ?? {});
  if (input.principal.tenantId !== input.tenantId) throw new AiContextNotFoundError('商机不存在');
  const scope = await resolveEffectiveResourceScope(prisma, input.principal);
  if (!scope.canReadMatter(input.opportunityId)) throw new AiContextNotFoundError('商机不存在');
  const currentPrincipal: ReadPrincipal = {
    tenantId: input.tenantId,
    userId: scope.actorUserId,
    role: scope.actorRole,
  };
  const opportunity = await prisma.opportunity.findFirst({
    where: { id: input.opportunityId, tenantId: input.tenantId, archivedAt: null, account: { tenantId: input.tenantId, archivedAt: null } },
    include: {
      account: { select: { id: true, name: true, customerType: true } },
      roles: { where: { tenantId: input.tenantId } },
      edges: { where: { tenantId: input.tenantId } },
      bis: { where: { tenantId: input.tenantId } },
      ucvs: { where: { tenantId: input.tenantId } },
      members: { where: { tenantId: input.tenantId } },
    },
  });
  if (!opportunity) throw new AiContextNotFoundError('商机不存在');

  const relatedPersonIds = new Set([
    ...opportunity.roles.map((role) => role.personId),
    ...opportunity.edges.flatMap((edge) => [edge.source, edge.target]),
    ...opportunity.bis.map((bi) => bi.personId),
    ...opportunity.members.map((member) => member.personId),
  ]);
  const accountPersons = await prisma.person.findMany({
    where: {
      tenantId: input.tenantId,
      accountId: opportunity.accountId,
      archivedAt: null,
      ...(scope.canReadAccountData(opportunity.accountId) ? {} : { id: { in: [...relatedPersonIds] } }),
    },
  });
  const accountEdges = scope.canReadAccountData(opportunity.accountId)
    ? await prisma.edge.findMany({
        where: { tenantId: input.tenantId, accountId: opportunity.accountId, opportunityId: null },
      })
    : [];

  const memberIds = new Set(opportunity.members.map((member) => member.personId));
  const peopleRows = accountPersons.filter((person) => !opportunity.memberScoped || memberIds.has(person.id));
  const allowedPersonIds = new Set(peopleRows.map((person) => person.id));
  const roles = opportunity.roles
    .filter((role) => allowedPersonIds.has(role.personId)
      && roleValues.has(role.role as Role)
      && sentimentValues.has(role.sentiment as Sentiment)
      && confidenceValues.has(role.confidence as Confidence))
    .map((role) => ({
      personId: role.personId,
      role: role.role as Role,
      sentiment: role.sentiment as Sentiment,
      confidence: role.confidence as Confidence,
      isKeyInfluencer: role.isKeyInfluencer,
      procurementType: role.procurementType as any,
      procurementStatus: role.procurementStatus as any,
    }));
  const roleByPerson = new Map(roles.map((role) => [role.personId, role]));
  const dRoles = roles.filter((role) => role.role === 'D');
  const primaryD = dRoles.find((role) => role.personId === opportunity.primaryDPersonId) ?? dRoles[0];
  const keyInfluencer = pickKeyInfluencerKeeper(roles);

  const people = peopleRows.map((person) => {
    const role = roleByPerson.get(person.id);
    return {
      id: person.id,
      name: person.name,
      title: person.title,
      isCompetitor: person.isCompetitor,
      role: role?.role ?? null,
      sentiment: role?.sentiment ?? null,
      confidence: role?.confidence ?? null,
      isPrimaryD: !!primaryD && person.id === primaryD.personId,
      isKeyInfluencer: !!keyInfluencer && person.id === keyInfluencer.personId,
      ...(options.includeForm ? { form: sanitizeForm(person.form) } : {}),
    };
  });
  const nameById = new Map(peopleRows.map((person) => [person.id, person.name]));
  const relationships = [...accountEdges, ...opportunity.edges]
    .filter((edge) => allowedPersonIds.has(edge.source) && allowedPersonIds.has(edge.target))
    .slice(0, 40)
    .map((edge) => ({
      fromId: edge.source,
      toId: edge.target,
      from: nameById.get(edge.source) ?? edge.source,
      to: nameById.get(edge.target) ?? edge.target,
      layer: edge.layer,
      label: edge.label,
    }));
  // External model contexts never receive private BI, even when the actor may view it in-app.
  const visibleBis = opportunity.bis.filter((bi) => !bi.isPrivate && allowedPersonIds.has(bi.personId));
  const biById = new Map(visibleBis.map((bi) => [bi.id, bi]));
  const bis = visibleBis.map((bi) => ({
    personId: bi.personId,
    person: nameById.get(bi.personId) ?? bi.personId,
    category: bi.category,
    description: bi.description,
  }));
  const ucvs = opportunity.ucvs.filter((ucv) => biById.has(ucv.targetBiId)).map((ucv) => {
    const bi = biById.get(ucv.targetBiId)!;
    return {
      person: nameById.get(bi.personId) ?? bi.personId,
      bi: `${bi.category}·${bi.description}`,
      description: ucv.description,
      competitorCannot: ucv.competitorCannot,
      status: ucv.status,
    };
  });
  const keyIds = new Set(roles
    .filter((role) => role.role === 'A' || role.role === 'D' || role.personId === keyInfluencer?.personId)
    .map((role) => role.personId));
  const recentInteractions: Array<{ person: string; date: string; content: string }> = [];
  if (options.includeRawLogs) {
    for (const person of peopleRows) {
      if (!keyIds.has(person.id)) continue;
      const logs = visiblePersonLogs(person.logs, currentPrincipal)
        .filter((log) => log.visibility !== 'self')
        .filter((log): log is typeof log & { date: string; content: string } => typeof log.date === 'string' && typeof log.content === 'string')
        .slice(0, 2);
      for (const log of logs) recentInteractions.push({ person: person.name, date: log.date, content: log.content });
      if (recentInteractions.length >= 30) break;
    }
  }

  const scoringAccount = {
    persons: peopleRows.map((person) => ({ id: person.id, form: options.includeForm ? sanitizeForm(person.form) : {} })),
  };
  const scoringOpportunity = {
    primaryDPersonId: opportunity.primaryDPersonId,
    engageStage: opportunity.engageStage,
    c3Items: jsonObject(opportunity.c3Items),
    c5Items: jsonObject(opportunity.c5Items),
    roles,
    bis: visibleBis.map((bi) => ({ id: bi.id, personId: bi.personId, confidence: bi.confidence as Confidence })),
    ucvs: opportunity.ucvs
      .filter((ucv) => biById.has(ucv.targetBiId))
      .map((ucv) => ({ targetBiId: ucv.targetBiId, status: ucv.status as '建议' | '获认可' | '已解决' })),
  };
  const breakdown = scoreFromState(scoringAccount, scoringOpportunity);
  const context = {
    account: { name: opportunity.account.name, customerType: opportunity.account.customerType },
    opportunity: {
      name: opportunity.name,
      pipelineStage: opportunity.pipelineStage,
      engageStage: opportunity.engageStage,
      singleSalesGoal: opportunity.singleSalesGoal,
      expectedSignDate: opportunity.expectedSignDate || null,
    },
    winTendency: { percent: breakdown.percent, total: breakdown.total, band: breakdown.band, items: breakdown.items },
    people,
    relationships,
    bis,
    ucvs,
    recentInteractions,
  };
  const manifest: ContextManifest = {
    entities: {
      accounts: 1,
      opportunities: 1,
      people: people.length,
      relationships: relationships.length,
      burningIssues: bis.length,
      ucvs: ucvs.length,
      interactionLogs: recentInteractions.length,
    },
    fieldCategories: [
      'account-summary', 'opportunity-summary', 'g64111-score', 'roles-and-sentiment',
      'relationship-metadata', 'business-issues-and-value',
      ...(options.includeForm ? ['form'] : []),
      ...(options.includeRawLogs ? ['raw-logs'] : []),
    ],
    excludedSensitiveCategories: [
      'private-bi', 'self-logs', 'outside-opportunity',
      ...(!options.includeRawLogs ? ['raw-logs'] : []),
      ...(!options.includeForm ? ['form'] : []),
    ],
  };
  return { context, manifest };
}

// ── 加密（AES-256-GCM）：用用户自己的 Key，服务端只加密代管 ──
function encryptionKey(): Buffer {
  const secret = process.env.AI_KEY_SECRET || 'dev-ai-secret-change-in-production';
  return crypto.createHash('sha256').update(secret).digest();
}
export function enc(text: string): string {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
export function dec(b64: string): string {
  if (!b64) return '';
  try {
    const buf = Buffer.from(b64, 'base64');
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return ''; }
}

// ── 提示词 ──
const SYSTEM_PROMPT = `你是资深 B2B 大客户销售策略顾问，精通「销售罗盘 / G64111」方法论。术语：
- 角色 A 批准人(经济决策/否决) · D 拍板人(本项目决策) · U 使用者 · R 影响者/技术选型/招采把关 · C 教练。竞争对手不是角色。
- 支持度：☆排他支持 / +明确支持 / =中立 / ?未知 / −负面 / x倒向对手。
- 趋赢力满分100 = 6必清(35)+4优势(45,P1多数人/P2招采关键人/P3与D密谋/P4关键影响人)+1决胜(1K与A)。P3/1K 可为负。
- 741竞争策略：≥75%绝对优势·可承诺 / 50-75%相对优势·可争取 / 25-50%相对劣势·可参与 / <25%绝对劣势·重新复盘。
请基于给定的真实商机快照，针对用户的「假设策略」给出务实、点名到人的分析。用简洁中文 Markdown，分这几节：
**① 局势判断** **② 对趋赢力的预测影响**(指出会动到哪些分项 P1/P2/P3/P4/1K 及大致方向) **③ 风险** **④ 下一步最佳行动**(具体、可执行) **⑤ 话术要点**。不超过 400 字。`;

function buildUserPrompt(ctx: any, hypothesis: string): string {
  return `# 当前商机快照\n${JSON.stringify(ctx, null, 2)}\n\n# 用户的假设策略\n${hypothesis}\n\n请按系统要求分析。`;
}

// ── 内置演示分析（无需 Key，用真实数据生成）──
export function mockAnalysis(ctx: any, hypothesis: string): string {
  const wt = ctx?.winTendency || {};
  const people: any[] = ctx?.people || [];
  const find = (r: string) => people.filter((p) => p.role === r);
  const A = find('A')[0];
  const dPeople = find('D');
  const D = dPeople.find((person) => person.isPrimaryD === true) ?? dPeople[0];
  const ki = people.find((person) => person.isKeyInfluencer === true
    && (person.role === 'U' || person.role === 'R' || person.role === 'C'));
  const traitors = people.filter((p) => p.sentiment === 'x');
  const items = wt.items || {};
  const gaps = Object.entries(items)
    .filter(([k]) => ['P2', 'P3', 'P4', '1K', 'C2', 'C6'].includes(k))
    .filter(([, v]: any) => typeof v === 'number' && v <= 0)
    .map(([k]) => k);
  const sName = (p: any) => (p ? `${p.name}(${p.role}${p.sentiment === 'x' ? '·倒戈' : p.sentiment === 'star' ? '·☆' : ''})` : '未识别');

  return `> 🧪 内置演示分析（基于真实 G64111 数据生成，非外部大模型；配置你的模型后可获得更深入的推演）

**① 局势判断**
当前趋赢力 **${Math.round((wt.percent ?? 0) * 100)}%**（${wt.band || '—'}）。批准人 A＝${sName(A)}，拍板人 D＝${sName(D)}，关键影响人＝${ki ? ki.name : '未锁定'}。${traitors.length ? `⚠️ 已有 ${traitors.map((t) => t.name).join('、')} 倒向竞争对手。` : ''}

**② 对趋赢力的预测影响**
你的假设「${hypothesis}」——${D ? `若动作绕过 D(${D.name})，P3(与D密谋, 占20分) 很可能由正转负，是最大风险敞口；` : ''}${A ? `直接触达 A(${A.name}) 若处理得当可拉升 1K(决胜20分)，但越级易引发 D 反弹。` : ''}净效果取决于 A 是否会把你推回给 D。

**③ 风险**
- 越级触达 A 会让 D 觉得被架空 → P3 可能掉到 −10~−20。
- ${traitors.length ? `${traitors[0].name} 在招采环节(P2)配合竞品，需重点防守。` : '招采关键人(P2)覆盖不足，易被对手设卡。'}

**④ 下一步最佳行动**
- 先借 ${ki ? ki.name + '(教练)' : '内线教练'} 摸清 A 的真实关注点与 BI，再谋求"D 引荐上 A"而非绕过。
- 补齐缺口项：${gaps.length ? gaps.join('、') : 'P2 招采关键人'}。
- 用样板/降本数据帮 D 拿到向 A 汇报的"政绩"，把 D 变成你上 A 的桥。

**⑤ 话术要点**
对 D：「这套能帮您做出向集团/领导可对标上报的成果，汇报材料我来备。」——给政绩、不抢功，避免越级反噬。`;
}

/** 读取并解密某租户的 AI 配置（供推断引擎复用）。无配置返回 null。 */
export async function loadAiConfig(tenantId: string, db: DbClient = prisma): Promise<{ provider: string; baseUrl: string; model: string; apiKey: string } | null> {
  const c = await db.aiConfig.findUnique({ where: { tenantId } });
  if (!c) return null;
  return { provider: c.provider, baseUrl: c.baseUrl, model: c.model, apiKey: dec(c.apiKeyEnc) };
}

export async function callLLM(cfg: { baseUrl: string; model: string; apiKey: string }, system: string, user: string, maxTokens = 900): Promise<string> {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetchOutbound(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.4, max_tokens: maxTokens, stream: false }),
  }, deploymentOutboundPolicy(), { timeoutMs: 20_000, maxResponseBytes: 1_048_576 });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || data?.message || `模型返回 HTTP ${res.status}`);
  return data?.choices?.[0]?.message?.content || '(模型无返回内容)';
}

export function aiRoutes(app: FastifyInstance) {
  const canManage = (req: any) => ['owner', 'admin'].includes(req.user.role);
  const principalOf = (req: any): ReadPrincipal => ({
    tenantId: req.user.tenantId,
    userId: req.user.userId,
    role: req.user.role,
  });

  app.get('/api/ai/config', { preHandler: [app.authenticate] }, async (req) => {
    const c = await prisma.aiConfig.findUnique({ where: { tenantId: req.user.tenantId } });
    if (!c) return { configured: false, provider: 'mock', baseUrl: '', model: '', hasKey: false };
    return { configured: c.provider === 'mock' || (!!c.baseUrl && !!c.model), provider: c.provider, baseUrl: c.baseUrl, model: c.model, hasKey: !!c.apiKeyEnc };
  });

  app.put('/api/ai/config', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可操作
    if (!canManage(req)) return reply.code(403).send({ error: '仅管理员可配置模型' });
    const p = z.object({
      provider: z.enum(['openai-compatible', 'mock']),
      baseUrl: z.string().optional(),
      model: z.string().optional(),
      apiKey: z.string().optional(),
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '参数无效' });
    const { provider, baseUrl = '', model = '', apiKey } = p.data;

    const existing = await prisma.aiConfig.findUnique({ where: { tenantId: req.user.tenantId } });
    // apiKey 为 undefined → 保留旧 key；为 '' → 清空；有值 → 加密更新
    const apiKeyEnc = apiKey === undefined ? (existing?.apiKeyEnc ?? '') : (apiKey ? enc(apiKey) : '');
    const data = { provider, baseUrl, model, apiKeyEnc };
    await prisma.aiConfig.upsert({ where: { tenantId: req.user.tenantId }, create: { tenantId: req.user.tenantId, ...data }, update: data });
    return { ok: true };
  });

  app.post('/api/ai/test', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可操作
    const c = await prisma.aiConfig.findUnique({ where: { tenantId: req.user.tenantId } });
    if (!c) return reply.code(400).send({ error: '尚未配置模型' });
    if (c.provider === 'mock') return { ok: true, message: '内置演示模式可用' };
    if (!c.baseUrl || !c.model) return reply.code(400).send({ error: '缺少 baseURL 或模型名' });
    try {
      const out = await callLLM({ baseUrl: c.baseUrl, model: c.model, apiKey: dec(c.apiKeyEnc) }, '你是连通性测试。', '回复两个字：可用', 16);
      return { ok: true, message: out.slice(0, 40) };
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message || '连接失败' });
    }
  });

  // Authoritative preflight: lets the user inspect counts/categories before any model call.
  app.post('/api/ai/context-manifest', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (denyViewer(req, reply)) return;
    const currentScope = await resolveEffectiveResourceScope(prisma, principalOf(req));
    if (currentScope.actorRole === 'viewer') return reply.code(403).send({ error: '只读成员不可操作' });
    const parsed = z.object({
      opportunityId: z.string().min(1),
      options: AiContextOptionsSchema,
    }).strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '上下文范围参数无效' });
    try {
      const built = await buildServerAiContext({
        tenantId: req.user.tenantId,
        principal: principalOf(req),
        opportunityId: parsed.data.opportunityId,
        options: parsed.data.options,
      });
      return {
        manifest: built.manifest,
        manifestToken: contextManifestToken(built.manifest, {
          tenantId: req.user.tenantId,
          actorUserId: req.user.userId,
          opportunityId: parsed.data.opportunityId,
          options: parsed.data.options,
        }),
      };
    } catch (error) {
      if (error instanceof AiContextNotFoundError) return reply.code(404).send({ error: '商机不存在' });
      throw error;
    }
  });

  app.post('/api/ai/simulate', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可操作
    const currentScope = await resolveEffectiveResourceScope(prisma, principalOf(req));
    if (currentScope.actorRole === 'viewer') return reply.code(403).send({ error: '只读成员不可操作' });
    const p = z.object({
      opportunityId: z.string().min(1),
      focusPersonId: z.string().min(1),
      hypothesis: z.string().trim().min(1).max(2_000),
      options: AiContextOptionsSchema,
      manifestToken: z.string().length(64),
      // Legacy clients may still send this field; it is deliberately ignored and never forwarded.
      context: z.unknown().optional(),
    }).strict().safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '请输入假设策略' });
    let built: Awaited<ReturnType<typeof buildServerAiContext>>;
    try {
      built = await buildServerAiContext({
        tenantId: req.user.tenantId,
        principal: principalOf(req),
        opportunityId: p.data.opportunityId,
        options: p.data.options,
      });
    } catch (error) {
      if (error instanceof AiContextNotFoundError) return reply.code(404).send({ error: '商机不存在' });
      throw error;
    }
    if (contextManifestToken(built.manifest, {
      tenantId: req.user.tenantId,
      actorUserId: req.user.userId,
      opportunityId: p.data.opportunityId,
      options: p.data.options,
    }) !== p.data.manifestToken) {
      return reply.code(409).send({ error: '数据范围已变化，请重新确认后再试' });
    }
    const focusPerson = built.context.people.find((person: any) => person.id === p.data.focusPersonId);
    if (!focusPerson) return reply.code(404).send({ error: '干系人不存在' });
    const scopedHypothesis = `围绕干系人「${focusPerson.name}」：${p.data.hypothesis}`;
    const c = await prisma.aiConfig.findUnique({ where: { tenantId: req.user.tenantId } });
    if (!c) return reply.code(400).send({ error: '请先在「AI 模型」里配置模型（或选择内置演示模式）', needConfig: true });

    if (c.provider === 'mock') {
      return { analysis: mockAnalysis(built.context, scopedHypothesis), provider: 'mock', manifest: built.manifest };
    }
    if (!c.baseUrl || !c.model) return reply.code(400).send({ error: '模型配置不完整', needConfig: true });
    try {
      const analysis = await callLLM(
        { baseUrl: c.baseUrl, model: c.model, apiKey: dec(c.apiKeyEnc) },
        SYSTEM_PROMPT, buildUserPrompt(built.context, scopedHypothesis),
      );
      return { analysis, provider: c.model, manifest: built.manifest };
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message || '推演失败，请检查模型配置' });
    }
  });
}
