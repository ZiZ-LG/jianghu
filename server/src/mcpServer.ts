// 江湖 只读 MCP Server —— 让 AI 客户端（Claude Desktop 等）查询本平台数据。
//
// 设计：手写 JSON-RPC（不引入 @modelcontextprotocol/sdk，与 qccMcp.ts 风格一致、少依赖），
// 以 streamable-HTTP 方式挂在 Fastify 的 POST /api/mcp 下（无状态：每个请求自带 JWT，不维护 session）。
//
// 协议：实现 MCP 必需的 initialize / tools/list / tools/call，并接受 notifications/initialized 通知。
// 鉴权：路由层用 app.jwt.verify 解出 tenantId（铁律：所有查询 where { tenantId }，绝不跨租户）。
// 只读：本批工具仅 prisma.*.findMany / findFirst，绝不写库。

import { prisma } from './prisma.js';
import { scoreFromState, ITEM_LABEL, ITEM_MAX, type ItemKey } from './g64111.js';

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

// ───────────────────────── 工具分发 ─────────────────────────

async function callTool(tenantId: string, name: string, args: Record<string, unknown>) {
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
    default:
      throw new Error(`未知工具：${name}`);
  }
}

// ───────────────────────── 单条 JSON-RPC 消息处理 ─────────────────────────

/**
 * 处理一条 MCP JSON-RPC 消息。
 * - 通知（无 id，如 notifications/initialized）返回 null（不应有响应体）。
 * - 其余返回 JsonRpcResponse。
 * 所有数据查询通过 tenantId 隔离（铁律）。
 */
export async function handleMcpMessage(tenantId: string, msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
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
          instructions: '江湖 只读 MCP：用 list_accounts 看客户，get_account_detail 看某客户干系人与关系，get_win_tendency 看某商机的 G64111 趋赢力评分。所有数据按你的工作区隔离。',
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
          const result = await callTool(tenantId, name, args);
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
export async function handleMcpBody(tenantId: string, body: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(body)) {
    const responses: JsonRpcResponse[] = [];
    for (const m of body) {
      const r = await handleMcpMessage(tenantId, m as JsonRpcRequest);
      if (r) responses.push(r);
    }
    return responses.length ? responses : null;
  }
  if (body && typeof body === 'object') {
    return handleMcpMessage(tenantId, body as JsonRpcRequest);
  }
  // 非法请求体
  return err(null, -32600, '无效的 JSON-RPC 请求');
}
