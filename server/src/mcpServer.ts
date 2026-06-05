// 江湖 MCP Server —— 让 AI 客户端（Claude Desktop / Workbuddy 等）查询 + 提议本平台数据。
//
// 设计：手写 JSON-RPC（不引入 @modelcontextprotocol/sdk，与 qccMcp.ts 风格一致、少依赖），
// 以 streamable-HTTP 方式挂在 Fastify 的 POST /api/mcp 下（无状态：每个请求自带 JWT，不维护 session）。
//
// 协议：实现 MCP 必需的 initialize / tools/list / tools/call，并接受 notifications/initialized 通知。
// 鉴权：路由层用 app.jwt.verify 解出 tenantId/userId（铁律：所有读写 where { tenantId }，绝不跨租户）。
// 工具分两类：
//   · 读工具（list_accounts/get_account_detail/get_win_tendency）：仅 findMany/findFirst，绝不写库。
//   · 写工具（propose_person/propose_relationship）：只写【候选层】(PersonSuggestion/RelSuggestion，status=pending)，
//     绝不直接写正式 Person/Edge。候选须经用户在前端人审采纳才上墙（PIPL 红线）。

import { randomUUID } from 'node:crypto';
import { prisma } from './prisma.js';
import { applyAction } from './mutate.js';
import { scoreFromState, ITEM_LABEL, ITEM_MAX, type ItemKey } from './g64111.js';

// 每租户 pending 候选容量上限（防外部 agent 刷爆）
const MAX_PENDING_PERSON_SUGG = 200;
const MAX_PENDING_REL_SUGG = 200;

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'jianghu', version: '0.1.0' };

// ───────────────────────── JSON-RPC 类型 ─────────────────────────

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}
interface JsonRpcResult {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}
interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}
type JsonRpcResponse = JsonRpcResult | JsonRpcError;

const ok = (id: string | number | null, result: unknown): JsonRpcResult => ({ jsonrpc: '2.0', id, result });
const err = (id: string | number | null, code: number, message: string): JsonRpcError => ({ jsonrpc: '2.0', id, error: { code, message } });

/** tools/call 的标准返回：把 JSON 以 text content 形式返回（MCP content 约定）。 */
function toolText(data: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
function toolError(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ───────────────────────── 工具定义（tools/list 用） ─────────────────────────

const TOOL_DEFS = [
  {
    name: 'list_accounts',
    description: '列出本工作区（租户）下的所有客户/Account，含客户类型、干系人数、商机数。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_account_detail',
    description: '获取某个客户的干系人概览：每个干系人的姓名/职务/组织层级/是否友商，以及该客户的关系连线（L1-L4）概览与商机列表。需提供 accountId（从 list_accounts 获得）。只读。',
    inputSchema: {
      type: 'object',
      properties: { accountId: { type: 'string', description: '客户 ID（来自 list_accounts）' } },
      required: ['accountId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_win_tendency',
    description: '计算某个商机的 G64111 趋赢力评分：返回总分（-50~100）、百分比、741 竞争策略带，以及 6必清/4优势/1决胜各分项明细。需提供 opportunityId（从 get_account_detail 获得）。只读。',
    inputSchema: {
      type: 'object',
      properties: { opportunityId: { type: 'string', description: '商机 ID（来自 get_account_detail）' } },
      required: ['opportunityId'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_person',
    description:
      '【提议·写候选】把你调研到的一个新干系人提交为「候选干系人」，进入待人审队列——不会立即出现在侦探墙上，需用户在江湖里人工采纳后才上墙。用于外部联网调研发现的、墙上还没有的人。返回候选 ID（可用于 propose_relationship 的端点）。请在 evidence 写明依据、sourceUrl 给来源链接。',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: '该干系人所属客户 ID（来自 list_accounts）' },
        name: { type: 'string', description: '姓名' },
        title: { type: 'string', description: '职务（可空）' },
        orgLevel: { type: 'number', description: '组织层级 1-4（1=高层，默认3）' },
        opportunityId: { type: 'string', description: '可选：关联的商机 ID' },
        evidence: { type: 'string', description: '依据/来源摘要（建议填写，便于人审）' },
        sourceUrl: { type: 'string', description: '可选：调研来源链接' },
        confidence: { type: 'number', description: '可选：置信度 0-1' },
      },
      required: ['accountId', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_relationship',
    description:
      '【提议·写候选】把两个干系人之间的一条关系提交为「候选关系」，进入待人审队列——不会立即画线，需用户采纳后才上墙。端点可以是已存在的干系人（kind=person，id 来自 get_account_detail）或你刚用 propose_person 提交的候选人物（kind=suggestion，id 为其返回的候选 ID）。layer：L1组织架构/L2决策权力/L3情感阵营/L4战略本质。',
    inputSchema: {
      type: 'object',
      properties: {
        opportunityId: { type: 'string', description: '该关系所属商机 ID（来自 get_account_detail）' },
        source: {
          type: 'object',
          description: '关系源端点',
          properties: { kind: { type: 'string', enum: ['person', 'suggestion'] }, id: { type: 'string' } },
          required: ['kind', 'id'],
          additionalProperties: false,
        },
        target: {
          type: 'object',
          description: '关系目标端点',
          properties: { kind: { type: 'string', enum: ['person', 'suggestion'] }, id: { type: 'string' } },
          required: ['kind', 'id'],
          additionalProperties: false,
        },
        layer: { type: 'string', enum: ['L1', 'L2', 'L3', 'L4'], description: '关系分层' },
        label: { type: 'string', description: '关系描述（如：校友/老乡/直属上级/利益关联）' },
        evidence: { type: 'string', description: '依据/来源摘要' },
        confidence: { type: 'number', description: '可选：置信度 0-1' },
      },
      required: ['opportunityId', 'source', 'target', 'label'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_pending',
    description: '列出本工作区当前待人审的候选（候选干系人 + 候选关系），便于你了解已提议过什么、避免重复提交。只读。',
    inputSchema: {
      type: 'object',
      properties: { accountId: { type: 'string', description: '可选：只看某客户的候选' } },
      additionalProperties: false,
    },
  },
  {
    name: 'upsert_account',
    description:
      '【写·直接落正式表】同步销售包（WorkBuddy）的「客户档案」到江湖，幂等 upsert（非候选）。幂等键：externalRef（销售包 customer_id，主锚）或 unifiedCreditCode（统一社会信用代码 USCC，副锚）——二者至少提供一个：先按 externalRef 命中、否则按 USCC 命中并补登 externalRef；都未命中则新建。客户档案属业务实体（非个人身份判定），直接写正式 Account 表并带 origin=workbuddy 溯源。注意：干系人本体/关系连线仍须走 propose_person / propose_relationship 候选人审（PIPL 红线）。',
    inputSchema: {
      type: 'object',
      properties: {
        externalRef: { type: 'string', description: '销售包 customer_id（幂等主锚）。与 unifiedCreditCode 至少提供一个' },
        unifiedCreditCode: { type: 'string', description: '统一社会信用代码 USCC（幂等副锚）。与 externalRef 至少提供一个' },
        name: { type: 'string', description: '客户全称（新建时必填）' },
        customerType: { type: 'number', description: '客户类型 1/2/3（1=五大六小央企能源集团，2=央国企电力建设集团，3=地方/民营能源投资建设企业）' },
        region: { type: 'string', description: '大区' },
        group: { type: 'string', description: '集团/母公司' },
        primaryOwner: { type: 'string', description: '主负责人' },
        profile: { type: 'object', description: '企业背景档案 JSON：business(工商)/group(集团关系)/bidding(招投标)/risk(风险)/ourCooperation(我方合作)/salesNote(销售背景)/aiSuggestion(AI建议)', additionalProperties: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'upsert_opportunity',
    description:
      '【写·直接落正式表】同步销售包(WorkBuddy)的「商机」到江湖，幂等 upsert(非候选)。先定位父客户(accountId / accountExternalRef=销售包 customer_id / unifiedCreditCode 三选一，该客户须已存在，否则先 upsert_account)，再按商机 externalRef 幂等：命中则更新、未命中则在该客户下新建。⚠️ winProbability(赢单概率)由销售在江湖里自填，本工具不接收、不覆盖。pipelineStage 用江湖 7 段(线索/需求引导/方案认可/客户立项/招投标/合同谈判/合同双签；"合同签约"会自动规整为"合同双签")。c3Items/c5Items 为必清项 boolean map(键用中文项名)。直接写正式 Opportunity 表并带 origin=workbuddy 溯源。',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: '父客户江湖 ID（三种定位之一）' },
        accountExternalRef: { type: 'string', description: '父客户销售包 customer_id（三种定位之一）' },
        unifiedCreditCode: { type: 'string', description: '父客户统一社会信用代码（三种定位之一）' },
        externalRef: { type: 'string', description: '商机幂等锚（销售包商机标识，如 {customer_id}#opp）' },
        name: { type: 'string', description: '商机名称（新建必填）' },
        pipelineStage: { type: 'string', description: '管线阶段(江湖 7 段之一)' },
        engageStage: { type: 'string', description: 'C4 介入阶段：需求调研立项/方案可研/预算批复/招标论证/招采执行' },
        status: { type: 'string', description: '状态 active/paused/won/lost' },
        changeMode: { type: 'string', description: '客户变化模式 G/T/EK/OC' },
        productSolution: { type: 'string', description: '我方产品/方案' },
        competitor: { type: 'string', description: '主要友商' },
        competitiveSituation: { type: 'string', description: '竞争态势 领先/胶着/落后/未识别' },
        singleSalesGoal: { type: 'string', description: '单一销售目标' },
        customerBusinessGoal: { type: 'string', description: '客户经营目标' },
        buyingMotivation: { type: 'string', description: '采购动机' },
        expectedSignDate: { type: 'string', description: '预计签约日 YYYY-MM-DD' },
        expectedAmountW: { type: 'number', description: '预计金额(万元)' },
        c3Items: { type: 'object', description: 'C3 立项材料 7 项掌握情况(boolean map，键=中文项名)', additionalProperties: true },
        c5Items: { type: 'object', description: 'C5 招采事项 5 项掌握情况(boolean map)', additionalProperties: true },
        meta: { type: 'object', description: 'JSON 兜底(BANT 辅助分等)', additionalProperties: true },
      },
      additionalProperties: false,
    },
  },
] as const;

const CUSTOMER_TYPE_LABEL: Record<number, string> = {
  1: '五大六小央企能源集团',
  2: '央国企电力建设集团',
  3: '地方/民营能源投资建设企业',
};
const LAYER_LABEL: Record<string, string> = {
  L1: 'L1 组织架构', L2: 'L2 决策权力', L3: 'L3 情感阵营', L4: 'L4 战略本质',
};
const ROLE_LABEL: Record<string, string> = {
  A: '批准人', D: '拍板人', U: '使用者', TB: '技术选型', R: '影响者/教练',
};
const SENTIMENT_LABEL: Record<string, string> = {
  star: '排他性支持', plus: '明确支持', neutral: '中立', unknown: '未知', minus: '负面/抗拒', x: '倒向对手',
};

const J = <T>(s: string | null | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };

// ───────────────────────── 工具实现（全部按 tenantId 隔离 · 只读） ─────────────────────────

/** list_accounts：本租户客户清单 + 计数。 */
async function listAccounts(tenantId: string) {
  const accounts = await prisma.account.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { persons: true, opportunities: true } } },
  });
  return {
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      customerType: a.customerType,
      customerTypeLabel: CUSTOMER_TYPE_LABEL[a.customerType] ?? `类型${a.customerType}`,
      unifiedCreditCode: a.unifiedCreditCode ?? undefined,
      personCount: a._count.persons,
      opportunityCount: a._count.opportunities,
    })),
  };
}

/** get_account_detail：某客户干系人 + 角色 + 关系概览（findFirst 双重锁定 tenantId）。 */
async function getAccountDetail(tenantId: string, accountId: string) {
  const account = await prisma.account.findFirst({
    where: { id: accountId, tenantId },
    include: {
      persons: true,
      edges: true,
      opportunities: { include: { roles: true } },
    },
  });
  if (!account) throw new Error('客户不存在或不属于当前工作区');

  // 角色覆盖（人 × 商机）：把每个人的角色/支持度按商机聚合，给出概览。
  const roleByPerson = new Map<string, { opportunityId: string; role: string; roleLabel: string; sentiment: string; sentimentLabel: string; isKeyInfluencer: boolean }[]>();
  for (const o of account.opportunities) {
    for (const r of o.roles) {
      const arr = roleByPerson.get(r.personId) ?? [];
      arr.push({
        opportunityId: o.id,
        role: r.role,
        roleLabel: ROLE_LABEL[r.role] ?? r.role,
        sentiment: r.sentiment,
        sentimentLabel: SENTIMENT_LABEL[r.sentiment] ?? r.sentiment,
        isKeyInfluencer: r.isKeyInfluencer,
      });
      roleByPerson.set(r.personId, arr);
    }
  }

  return {
    account: { id: account.id, name: account.name, customerType: account.customerType, customerTypeLabel: CUSTOMER_TYPE_LABEL[account.customerType] ?? `类型${account.customerType}` },
    persons: account.persons.map((p) => ({
      id: p.id,
      name: p.name,
      title: p.title,
      orgLevel: p.orgLevel,
      isCompetitor: p.isCompetitor,
      coachLevel: p.coachLevel ?? undefined,
      roles: roleByPerson.get(p.id) ?? [],
    })),
    relationships: account.edges.map((e) => ({
      source: e.source,
      target: e.target,
      layer: e.layer,
      layerLabel: LAYER_LABEL[e.layer] ?? e.layer,
      label: e.label,
      directed: e.directed,
      opportunityId: e.opportunityId ?? undefined,
    })),
    opportunities: account.opportunities.map((o) => ({
      id: o.id,
      name: o.name,
      pipelineStage: o.pipelineStage,
      engageStage: o.engageStage,
    })),
  };
}

/** get_win_tendency：某商机 G64111 评分（先按 tenantId 取商机及其父客户的人，再算分）。 */
async function getWinTendency(tenantId: string, opportunityId: string) {
  const opp = await prisma.opportunity.findFirst({
    where: { id: opportunityId, tenantId },
    include: {
      roles: true,
      bis: true,
      ucvs: true,
      account: { include: { persons: true } },
    },
  });
  if (!opp) throw new Error('商机不存在或不属于当前工作区');

  const account = {
    persons: opp.account.persons.map((p) => ({ id: p.id, form: J<{ family7?: Record<string, string | undefined> }>(p.form, {}) })),
  };
  const opportunity = {
    engageStage: opp.engageStage,
    c3Items: J<Record<string, boolean>>(opp.c3Items, {}),
    c5Items: J<Record<string, boolean>>(opp.c5Items, {}),
    roles: opp.roles.map((r) => ({
      personId: r.personId,
      role: r.role as any,
      sentiment: r.sentiment as any,
      confidence: r.confidence as any,
      isKeyInfluencer: r.isKeyInfluencer,
      procurementType: (r.procurementType ?? undefined) as any,
      procurementStatus: (r.procurementStatus ?? undefined) as any,
    })),
    bis: opp.bis.map((b) => ({ id: b.id, personId: b.personId, confidence: b.confidence as any })),
    ucvs: opp.ucvs.map((u) => ({ targetBiId: u.targetBiId, status: u.status as any })),
  };

  const s = scoreFromState(account, opportunity);
  const items = (Object.keys(s.items) as ItemKey[]).map((k) => ({
    key: k,
    label: ITEM_LABEL[k],
    score: s.items[k],
    max: ITEM_MAX[k],
  }));
  return {
    opportunity: { id: opp.id, name: opp.name, pipelineStage: opp.pipelineStage, engageStage: opp.engageStage },
    total: s.total,
    percent: Math.round(s.percent * 1000) / 10, // 百分比，保留一位小数
    band: s.band,
    bandLabel: s.bandLabel,
    strategy: s.strategy,
    breakdown: {
      sixClears: s.clears, // 6必清 满35
      fourPriorities: s.priorities, // 4优势 满45
      oneKey: s.key, // 1决胜 满20
    },
    items,
  };
}

// ───────────────────────── 写工具实现（只写候选层 · tenantId 隔离 · 待人审） ─────────────────────────

const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && isFinite(v) ? v : undefined);

/** propose_person：提议候选干系人 → 落 PersonSuggestion（不建正式 Person）。 */
async function proposePerson(tenantId: string, userId: string, args: Record<string, unknown>) {
  const accountId = str(args.accountId);
  const name = str(args.name, 40).trim();
  if (!accountId) throw new Error('缺少参数 accountId');
  if (!name) throw new Error('缺少参数 name');

  // tenantId 隔离：客户必须属于本租户
  const account = await prisma.account.findFirst({ where: { id: accountId, tenantId } });
  if (!account) throw new Error('客户不存在或不属于当前工作区');

  const title = str(args.title, 60);
  const orgLevel = Math.min(4, Math.max(1, Math.round(num(args.orgLevel) ?? 3)));
  const opportunityId = str(args.opportunityId) || null;
  const evidence = str(args.evidence, 500);
  const sourceUrl = str(args.sourceUrl, 500) || null;
  const confidence = Math.max(0, Math.min(1, num(args.confidence) ?? 0.5));

  // 容量上限（防滥用）
  const pendingCount = await prisma.personSuggestion.count({ where: { tenantId, status: 'pending' } });
  if (pendingCount >= MAX_PENDING_PERSON_SUGG) throw new Error(`候选干系人已达上限（${MAX_PENDING_PERSON_SUGG}），请先在江湖里处理现有候选`);

  // 应用层去重：同租户+同客户+同名+pending → 更新（取高 confidence、补 evidence），不新增
  const dup = await prisma.personSuggestion.findFirst({ where: { tenantId, accountId, name, status: 'pending' } });
  if (dup) {
    await prisma.personSuggestion.update({
      where: { id: dup.id },
      data: { title: title || dup.title, evidence: evidence || dup.evidence, sourceUrl: sourceUrl ?? dup.sourceUrl, confidence: Math.max(dup.confidence, confidence) },
    });
    return { suggestionId: dup.id, deduped: true, note: '已存在同名候选干系人（pending），已更新其依据而非新增。' };
  }

  // 提示：是否已有同名正式干系人（由人审决定合并，AI 不替判）
  const existingPerson = await prisma.person.findFirst({ where: { tenantId, accountId, name } });

  const id = 'ps_' + randomUUID().slice(0, 12);
  await prisma.personSuggestion.create({
    data: { id, tenantId, accountId, opportunityId, name, title, orgLevel, origin: 'mcp', evidence, sourceUrl, confidence, status: 'pending', proposedBy: userId },
  });
  return {
    suggestionId: id,
    note: existingPerson
      ? `⚠️ 该客户下已存在同名正式干系人（id=${existingPerson.id}）。候选已提交，请人审时判断是合并到现有还是新建，AI 不自动合并。`
      : '候选干系人已提交，等待用户人审采纳后才会出现在侦探墙上。',
  };
}

/** propose_relationship：提议候选关系 → 落 RelSuggestion（端点可为 person 或 suggestion）。 */
async function proposeRelationship(tenantId: string, _userId: string, args: Record<string, unknown>) {
  const opportunityId = str(args.opportunityId);
  if (!opportunityId) throw new Error('缺少参数 opportunityId');
  const ep = (v: unknown): { kind: string; id: string } => {
    const o = (v ?? {}) as Record<string, unknown>;
    const kind = o.kind === 'suggestion' ? 'suggestion' : 'person';
    const id = str(o.id, 40);
    return { kind, id };
  };
  const source = ep(args.source);
  const target = ep(args.target);
  const layer = ['L1', 'L2', 'L3', 'L4'].includes(str(args.layer)) ? str(args.layer) : 'L3';
  const label = str(args.label, 40).trim() || '疑似关联';
  const evidence = str(args.evidence, 500);
  const confidence = Math.max(0, Math.min(1, num(args.confidence) ?? 0.5));
  if (!source.id || !target.id) throw new Error('缺少 source/target 端点 id');
  if (source.kind === target.kind && source.id === target.id) throw new Error('source 与 target 不能相同');

  // tenantId 隔离：商机必须属于本租户
  const opp = await prisma.opportunity.findFirst({ where: { id: opportunityId, tenantId } });
  if (!opp) throw new Error('商机不存在或不属于当前工作区');

  // 校验两端点存在且属于本租户（person → Person 表；suggestion → PersonSuggestion 表）
  const checkEndpoint = async (e: { kind: string; id: string }, role: string) => {
    if (e.kind === 'person') {
      const p = await prisma.person.findFirst({ where: { id: e.id, tenantId } });
      if (!p) throw new Error(`${role}端点（正式干系人 ${e.id}）不存在或不属于当前工作区`);
    } else {
      const s = await prisma.personSuggestion.findFirst({ where: { id: e.id, tenantId } });
      if (!s) throw new Error(`${role}端点（候选干系人 ${e.id}）不存在或不属于当前工作区`);
    }
  };
  await checkEndpoint(source, 'source');
  await checkEndpoint(target, 'target');

  // 容量上限
  const pendingCount = await prisma.relSuggestion.count({ where: { tenantId, opportunityId, status: 'pending' } });
  if (pendingCount >= MAX_PENDING_REL_SUGG) throw new Error(`候选关系已达上限（${MAX_PENDING_REL_SUGG}），请先处理现有候选`);

  // 去重：同商机下，相同端点对（含 kind）+ pending
  const tag = (e: { kind: string; id: string }) => `${e.kind}:${e.id}`;
  const key = [tag(source), tag(target)].sort().join('|');
  const existing = await prisma.relSuggestion.findMany({ where: { tenantId, opportunityId, status: 'pending' } });
  for (const r of existing) {
    const k = [`${r.sourceKind}:${r.sourcePersonId}`, `${r.targetKind}:${r.targetPersonId}`].sort().join('|');
    if (k === key) return { suggestionId: r.id, deduped: true, note: '该端点对已有 pending 候选关系，未重复创建。' };
  }

  const id = 'rs_' + randomUUID().slice(0, 12);
  await prisma.relSuggestion.create({
    data: { id, tenantId, opportunityId, sourcePersonId: source.id, sourceKind: source.kind, targetPersonId: target.id, targetKind: target.kind, layer, label, confidence, origin: 'mcp', evidence, status: 'pending' },
  });
  return { suggestionId: id, note: '候选关系已提交，等待用户人审采纳后才会画到侦探墙上。' };
}

/** list_pending：列本租户待人审候选（只读）。 */
async function listPending(tenantId: string, accountId: string) {
  const personWhere: any = { tenantId, status: 'pending' };
  if (accountId) personWhere.accountId = accountId;
  const persons = await prisma.personSuggestion.findMany({ where: personWhere, orderBy: { createdAt: 'desc' }, take: 100 });

  const relWhere: any = { tenantId, status: 'pending' };
  if (accountId) {
    const opps = await prisma.opportunity.findMany({ where: { tenantId, accountId }, select: { id: true } });
    relWhere.opportunityId = { in: opps.map((o) => o.id) };
  }
  const rels = await prisma.relSuggestion.findMany({ where: relWhere, orderBy: { createdAt: 'desc' }, take: 100 });

  return {
    pendingPersons: persons.map((p) => ({ id: p.id, accountId: p.accountId, name: p.name, title: p.title, orgLevel: p.orgLevel, evidence: p.evidence, sourceUrl: p.sourceUrl ?? undefined, confidence: p.confidence })),
    pendingRelationships: rels.map((r) => ({ id: r.id, opportunityId: r.opportunityId, source: { kind: r.sourceKind, id: r.sourcePersonId }, target: { kind: r.targetKind, id: r.targetPersonId }, layer: r.layer, label: r.label, evidence: r.evidence, confidence: r.confidence })),
  };
}

// ───────────────────────── 业务实体直写工具（落正式表 · tenantId 隔离 · 带 origin 溯源） ─────────────────────────
// 与 propose_* 候选工具不同：客户档案属业务实体（非个人身份判定），可直接 upsert 正式表
//（人审边界见 docs/集成-WorkBuddy销售包对接设计.md §0）。复用 applyAction 构造 Action 落库，
// 不另写 prisma 写逻辑；幂等去重在应用层（不靠 DB unique，保持 SQLite↔Postgres 可移植）。

/** upsert_account：按 externalRef(主锚)→unifiedCreditCode(副锚) 幂等 upsert 客户档案。 */
async function upsertAccount(tenantId: string, _userId: string, args: Record<string, unknown>) {
  const externalRef = str(args.externalRef, 80).trim() || null;
  const unifiedCreditCode = str(args.unifiedCreditCode, 40).trim() || null;
  if (!externalRef && !unifiedCreditCode) throw new Error('缺少幂等锚：externalRef 或 unifiedCreditCode 至少提供一个');

  const name = str(args.name, 100).trim();
  const ct = num(args.customerType);
  const customerType = ct && [1, 2, 3].includes(ct) ? ct : undefined;
  const profile = args.profile != null && typeof args.profile === 'object' ? (args.profile as Record<string, unknown>) : undefined;

  // 幂等查找（全程 where { tenantId }）：先主锚 externalRef，再副锚 unifiedCreditCode
  let existing = externalRef ? await prisma.account.findFirst({ where: { tenantId, externalRef } }) : null;
  if (!existing && unifiedCreditCode) {
    existing = await prisma.account.findFirst({ where: { tenantId, unifiedCreditCode } });
  }

  if (existing) {
    // 命中 → UPDATE：仅 patch 入参提供的字段（避免把未传字段清空）
    const patch: Record<string, unknown> = {};
    if (name) patch.name = name;
    if (customerType) patch.customerType = customerType;
    if (unifiedCreditCode) patch.unifiedCreditCode = unifiedCreditCode;
    if (externalRef && !existing.externalRef) patch.externalRef = externalRef; // 副锚命中时补登主锚
    if (args.region !== undefined) patch.region = str(args.region, 40);
    if (args.group !== undefined) patch.group = str(args.group, 100);
    if (args.primaryOwner !== undefined) patch.primaryOwner = str(args.primaryOwner, 40);
    if (profile !== undefined) patch.profile = profile;
    await applyAction(tenantId, { type: 'UPDATE_ACCOUNT', accId: existing.id, patch });
    return { id: existing.id, updated: true, origin: 'workbuddy', note: `已按幂等锚命中现有客户「${existing.name}」并更新。` };
  }

  // 未命中 → CREATE（新建必须有 name）
  if (!name) throw new Error('未命中现有客户，新建需提供 name');
  const id = 'acc_' + randomUUID().slice(0, 12);
  await applyAction(tenantId, {
    type: 'ADD_ACCOUNT',
    account: {
      id, name,
      customerType: customerType ?? 1,
      unifiedCreditCode, externalRef,
      region: str(args.region, 40),
      group: str(args.group, 100),
      primaryOwner: str(args.primaryOwner, 40),
      profile: profile ?? {},
    },
  });
  return { id, created: true, origin: 'workbuddy', note: `已新建客户「${name}」。` };
}

/** upsert_opportunity：定位父客户 → 按商机 externalRef 幂等 upsert。守"winProbability 不由 WB 推/覆盖"。 */
async function upsertOpportunity(tenantId: string, _userId: string, args: Record<string, unknown>) {
  // 1) 定位父客户（accountId / accountExternalRef / unifiedCreditCode 三选一，全程 where{tenantId}）
  const accId = str(args.accountId, 40).trim();
  const accExtRef = str(args.accountExternalRef, 80).trim();
  const accUscc = str(args.unifiedCreditCode, 40).trim();
  let account = accId ? await prisma.account.findFirst({ where: { id: accId, tenantId } }) : null;
  if (!account && accExtRef) account = await prisma.account.findFirst({ where: { tenantId, externalRef: accExtRef } });
  if (!account && accUscc) account = await prisma.account.findFirst({ where: { tenantId, unifiedCreditCode: accUscc } });
  if (!account) throw new Error('未定位到父客户：请提供 accountId / accountExternalRef / unifiedCreditCode 之一（该客户须已存在，可先 upsert_account）');

  const name = str(args.name, 100).trim();
  const externalRef = str(args.externalRef, 80).trim() || null;

  // 2) 枚举规整（"合同签约"→"合同双签"；非法值丢弃，落库走默认/保留）
  const PIPELINE = ['线索', '需求引导', '方案认可', '客户立项', '招投标', '合同谈判', '合同双签'];
  const ENGAGE = ['需求调研立项', '方案可研', '预算批复', '招标论证', '招采执行'];
  const stageMapped = str(args.pipelineStage) === '合同签约' ? '合同双签' : str(args.pipelineStage);
  const pipelineStage = PIPELINE.includes(stageMapped) ? stageMapped : undefined;
  const engageStage = ENGAGE.includes(str(args.engageStage)) ? str(args.engageStage) : undefined;
  const status = ['active', 'paused', 'won', 'lost'].includes(str(args.status)) ? str(args.status) : undefined;
  const changeMode = ['G', 'T', 'EK', 'OC'].includes(str(args.changeMode)) ? str(args.changeMode) : undefined;
  const isObj = (v: unknown) => v != null && typeof v === 'object';

  // 3) 公共业务字段补丁——刻意不含 winProbability（守"销售自填不覆盖"，inputSchema 也未暴露该字段）
  const fields: Record<string, unknown> = {};
  if (pipelineStage) fields.pipelineStage = pipelineStage;
  if (engageStage) fields.engageStage = engageStage;
  if (status) fields.status = status;
  if (changeMode) fields.changeMode = changeMode;
  if (args.productSolution !== undefined) fields.productSolution = str(args.productSolution, 500);
  if (args.competitor !== undefined) fields.competitor = str(args.competitor, 200);
  if (args.competitiveSituation !== undefined) fields.competitiveSituation = str(args.competitiveSituation, 40);
  if (args.singleSalesGoal !== undefined) fields.singleSalesGoal = str(args.singleSalesGoal, 500);
  if (args.customerBusinessGoal !== undefined) fields.customerBusinessGoal = str(args.customerBusinessGoal, 500);
  if (args.buyingMotivation !== undefined) fields.buyingMotivation = str(args.buyingMotivation, 500);
  if (args.expectedSignDate !== undefined) fields.expectedSignDate = str(args.expectedSignDate, 20);
  const amt = num(args.expectedAmountW); if (amt !== undefined) fields.expectedAmountW = amt;
  if (isObj(args.c3Items)) fields.c3Items = args.c3Items;
  if (isObj(args.c5Items)) fields.c5Items = args.c5Items;
  if (isObj(args.meta)) fields.meta = args.meta;

  // 4) 商机幂等：本客户下按 externalRef 查
  const existing = externalRef
    ? await prisma.opportunity.findFirst({ where: { tenantId, accountId: account.id, externalRef } })
    : null;

  if (existing) {
    const patch: Record<string, unknown> = { ...fields };
    if (name) patch.name = name;
    if (externalRef && !existing.externalRef) patch.externalRef = externalRef;
    await applyAction(tenantId, { type: 'UPDATE_OPP', accId: account.id, oppId: existing.id, patch });
    return { id: existing.id, accountId: account.id, updated: true, origin: 'workbuddy', note: `已命中商机「${existing.name}」并更新（winProbability 留给销售自填，未改）。` };
  }

  if (!name) throw new Error('未命中现有商机，新建需提供 name');
  const id = 'opp_' + randomUUID().slice(0, 12);
  await applyAction(tenantId, {
    type: 'ADD_OPP', accId: account.id,
    opp: {
      id, name, externalRef,
      customerType: account.customerType,
      pipelineStage: pipelineStage ?? '线索',
      engageStage: engageStage ?? '需求调研立项',
      status: status ?? 'active',
      ...fields,
    },
  });
  return { id, accountId: account.id, created: true, origin: 'workbuddy', note: `已在客户「${account.name}」下新建商机「${name}」。` };
}

// ───────────────────────── 工具分发 ─────────────────────────

async function callTool(tenantId: string, userId: string, name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'list_accounts':
      return listAccounts(tenantId);
    case 'get_account_detail': {
      const accountId = typeof args.accountId === 'string' ? args.accountId : '';
      if (!accountId) throw new Error('缺少参数 accountId');
      return getAccountDetail(tenantId, accountId);
    }
    case 'get_win_tendency': {
      const opportunityId = typeof args.opportunityId === 'string' ? args.opportunityId : '';
      if (!opportunityId) throw new Error('缺少参数 opportunityId');
      return getWinTendency(tenantId, opportunityId);
    }
    case 'propose_person':
      return proposePerson(tenantId, userId, args);
    case 'propose_relationship':
      return proposeRelationship(tenantId, userId, args);
    case 'list_pending':
      return listPending(tenantId, typeof args.accountId === 'string' ? args.accountId : '');
    case 'upsert_account':
      return upsertAccount(tenantId, userId, args);
    case 'upsert_opportunity':
      return upsertOpportunity(tenantId, userId, args);
    default:
      throw new Error(`未知工具：${name}`);
  }
}

// ───────────────────────── 单条 JSON-RPC 消息处理 ─────────────────────────

/**
 * 处理一条 MCP JSON-RPC 消息。
 * - 通知（无 id，如 notifications/initialized）返回 null（不应有响应体）。
 * - 其余返回 JsonRpcResponse。
 * 所有数据读写通过 tenantId 隔离（铁律）；写工具用 userId 记 proposedBy。
 */
export async function handleMcpMessage(tenantId: string, userId: string, msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;
  const method = msg.method ?? '';

  // 通知：method 以 notifications/ 开头或无 id。无需响应。
  if (method.startsWith('notifications/') || (id === null && method !== '')) {
    return null;
  }

  try {
    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: '江湖 MCP：读——list_accounts 看客户、get_account_detail 看某客户干系人与关系、get_win_tendency 看商机 G64111 趋赢力评分；提议（写候选，须用户人审采纳才上墙）——propose_person 提议新干系人、propose_relationship 提议关系、list_pending 看待审候选。所有数据按你的工作区隔离。绝不会自动写入正式数据。',
        });

      case 'ping':
        return ok(id, {});

      case 'tools/list':
        return ok(id, { tools: TOOL_DEFS });

      case 'tools/call': {
        const name: string = msg.params?.name ?? '';
        const args: Record<string, unknown> = msg.params?.arguments ?? {};
        if (!name) return err(id, -32602, '缺少 tool name');
        try {
          const result = await callTool(tenantId, userId, name, args);
          return ok(id, toolText(result));
        } catch (e: any) {
          // 工具级错误用 isError content 返回（MCP 约定：工具失败不是协议错误）
          return ok(id, toolError(e?.message || '工具执行失败'));
        }
      }

      default:
        return err(id, -32601, `不支持的方法：${method}`);
    }
  } catch (e: any) {
    return err(id, -32603, e?.message || '内部错误');
  }
}

/**
 * 处理一个请求体（可能是单条消息，也可能是 JSON-RPC 批量数组）。
 * 返回值：要发回客户端的 JSON（单对象 / 数组 / null）。null 表示纯通知、无响应体（HTTP 204）。
 */
export async function handleMcpBody(tenantId: string, userId: string, body: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(body)) {
    const responses: JsonRpcResponse[] = [];
    for (const m of body) {
      const r = await handleMcpMessage(tenantId, userId, m as JsonRpcRequest);
      if (r) responses.push(r);
    }
    return responses.length ? responses : null;
  }
  if (body && typeof body === 'object') {
    return handleMcpMessage(tenantId, userId, body as JsonRpcRequest);
  }
  // 非法请求体
  return err(null, -32600, '无效的 JSON-RPC 请求');
}
