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
//     绝不直接写正式 Person/Edge。候选须经用户在前端人审采纳才上图（PIPL 红线）。

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ACCOUNT_PROFILE_FIELDS,
  ActionSchema,
  capabilityPolicyAllows,
  capabilityRequirementForActionType,
  type CommandContext,
} from '@jianghu/domain-contracts';
import { prisma } from './prisma.js';
import { applyAction } from './mutate.js';
import { C5_ITEMS, scoreFromState, ITEM_LABEL, ITEM_MAX, type ItemKey } from './g64111.js';
import { activePersonWhere } from './activePerson.js';
import { createFieldProposal } from './proposals.js';
import { enqueueEnrichJob, enqueueSuggestJob, enqueueProfileJob } from './jobs.js';
import { resolveScopedRelSuggestions } from './suggestionScope.js';
import { syncIntelBundle } from './mcp/syncBundle.js';
import { ALL_ACCESS_SCOPES, scopesForCurrentRole, type AccessScope } from './accessToken.js';
import { resolveEffectiveResourceScope } from './resourceScope.js';

// 每租户 pending 候选容量上限（防外部 agent 刷爆）
const MAX_PENDING_PERSON_SUGG = 200;
const MAX_PENDING_REL_SUGG = 200;

const applyMcpAction = async (ctx: CommandContext, input: unknown, policyInput?: unknown): Promise<void> => {
  const action = ActionSchema.parse(input);
  const requirement = capabilityRequirementForActionType(action.type);
  if (!requirement || !capabilityPolicyAllows(policyInput, requirement)) throw new Error('能力未启用');
  await applyAction(ctx, action);
};

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'jianghu', version: '0.1.0' };
const ACCOUNT_PROFILE_TOOL_PROPERTIES = Object.fromEntries(
  ACCOUNT_PROFILE_FIELDS.map((field) => [field, { type: 'string' as const }]),
);
const C5_ITEM_TOOL_PROPERTIES = Object.fromEntries(
  C5_ITEMS.map((field) => [field, { type: 'boolean' as const }]),
);

// ───────────────────────── JSON-RPC 类型 ─────────────────────────

const JsonRpcIdSchema = z.union([z.string(), z.number().finite(), z.null()]);
const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema.optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
}).strict();
const ToolCallParamsSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
}).strict();
type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;
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

const TOOL_SCHEMAS = [
  {
    name: 'sync_intel_bundle',
    description: '【推荐·原子同步】一次同步客户、商机、拜访原文及人物/关系/证据候选；按 idempotencyKey 返回可重放 SyncReceipt。',
    inputSchema: {
      type: 'object',
      properties: {
        idempotencyKey: { type: 'string', minLength: 8, maxLength: 200, pattern: '^[A-Za-z0-9][A-Za-z0-9._:#/-]*$', description: '同一次业务同步重试时必须保持不变；只允许不含姓名/正文的 opaque ID' },
        bundle: {
          type: 'object',
          properties: {
            account: {
              type: 'object',
              properties: {
                id: { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S', description: '仅兼容旧工具：必须是本租户已存在 Account.id' },
                externalRef: { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' },
                unifiedCreditCode: { type: 'string', minLength: 1, maxLength: 40, pattern: '\\S' },
                name: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
                customerType: { type: 'integer', minimum: 1, maximum: 4 },
                region: { type: 'string', maxLength: 40 }, group: { type: 'string', maxLength: 100 },
                primaryOwner: { type: 'string', maxLength: 40 }, primaryOwnerUserId: { type: ['string', 'null'], maxLength: 100 },
                profile: { type: 'object', properties: ACCOUNT_PROFILE_TOOL_PROPERTIES, additionalProperties: false },
              },
              required: ['name'], additionalProperties: false,
            },
            opportunity: {
              type: 'object', properties: {
                externalRef: { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' },
                name: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
                pipelineStage: { type: 'string', enum: ['线索', '需求引导', '方案认可', '客户立项', '招投标', '合同谈判', '合同双签'] },
                engageStage: { type: 'string', enum: ['需求调研立项', '方案可研', '预算批复', '招标论证', '招采执行'] },
                status: { type: 'string', enum: ['active', 'paused', 'won', 'lost'] },
                changeMode: { type: ['string', 'null'], enum: ['G', 'T', 'EK', 'OC', null] },
                productSolution: { type: 'string', maxLength: 500 }, competitor: { type: 'string', maxLength: 200 },
                competitiveSituation: { type: 'string', enum: ['', '领先', '胶着', '落后', '未识别'] },
                singleSalesGoal: { type: 'string', maxLength: 500 },
                customerBusinessGoal: { type: ['string', 'null'], maxLength: 500 }, buyingMotivation: { type: ['string', 'null'], maxLength: 500 },
                expectedSignDate: { type: 'string', maxLength: 20 }, expectedAmountW: { type: 'number' },
                c3Items: { type: 'object', additionalProperties: { type: 'boolean' } },
                c5Items: { type: 'object', properties: C5_ITEM_TOOL_PROPERTIES, additionalProperties: false },
                meta: { type: 'object', not: { required: ['_mcpOrigin'] }, additionalProperties: true },
              }, required: ['externalRef', 'name'], additionalProperties: false,
            },
            visit: {
              type: 'object', properties: {
                externalRef: { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' },
                opportunityId: { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' },
                date: { type: 'string', minLength: 1, maxLength: 20, pattern: '\\S' },
                summary: { type: 'string', minLength: 1, maxLength: 5000, pattern: '\\S' }, topic: { type: 'string', maxLength: 200 },
                participants: { type: 'array', maxItems: 50, items: {
                  type: 'object', properties: {
                    name: { type: 'string', minLength: 1, maxLength: 40, pattern: '\\S' },
                    side: { type: 'string', enum: ['our', 'customer'] },
                  },
                  required: ['name', 'side'], additionalProperties: false,
                } },
              }, required: ['externalRef', 'date', 'summary'], additionalProperties: false,
            },
            people: { type: 'array', maxItems: 100, items: {
              type: 'object', properties: {
                ref: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9][A-Za-z0-9._:#/-]*$' },
                name: { type: 'string', minLength: 1, maxLength: 40, pattern: '\\S' },
                title: { type: 'string', maxLength: 60 }, orgLevel: { type: 'integer', minimum: 1, maximum: 4 },
                evidence: { type: 'string', maxLength: 500 }, confidence: { type: 'number', minimum: 0, maximum: 1 },
              }, required: ['ref', 'name'], additionalProperties: false,
            } },
            relations: { type: 'array', maxItems: 100, items: {
              type: 'object', properties: {
                ref: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9][A-Za-z0-9._:#/-]*$' },
                sourceRef: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9][A-Za-z0-9._:#/-]*$' },
                targetRef: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9][A-Za-z0-9._:#/-]*$' },
                layer: { type: 'string', enum: ['L1', 'L2', 'L3', 'L4'] }, label: { type: 'string' },
                evidence: { type: 'string', maxLength: 500 }, confidence: { type: 'number', minimum: 0, maximum: 1 },
              }, required: ['ref', 'sourceRef', 'targetRef', 'label'], additionalProperties: false,
            } },
            evidences: { type: 'array', maxItems: 100, items: {
              type: 'object', properties: {
                ref: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9][A-Za-z0-9._:#/-]*$' },
                personId: { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' },
                signalKey: { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' },
                direction: { type: 'number', enum: [-1, 0, 1] }, tier: { type: 'string', enum: ['weak', 'mid', 'strong'] },
                rawContent: { type: 'string', maxLength: 2000 }, occurredAt: { type: 'string', maxLength: 20 },
              }, required: ['ref', 'personId', 'signalKey'], additionalProperties: false,
            } },
          },
          required: ['account'], additionalProperties: false,
        },
      },
      required: ['idempotencyKey', 'bundle'],
      additionalProperties: false,
    },
  },
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
      '【提议·写候选】把你调研到的一个新干系人提交为「候选干系人」，进入待人审队列——不会立即出现在关系地图上，需用户在江湖里人工采纳后才上图。用于外部联网调研发现的、图上还没有的人。返回候选 ID（可用于 propose_relationship 的端点）。请在 evidence 写明依据、sourceUrl 给来源链接。',
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
        suggestedRole: { type: 'string', description: '可选：建议 ADURC 角色 A/D/U/R/C——采纳为正式干系人时一并落该商机的角色（需配合 opportunityId）' },
        suggestedSentiment: { type: 'string', description: '可选：建议支持度 star/plus/neutral/unknown/minus/x' },
      },
      required: ['accountId', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_relationship',
    description:
      '【提议·写候选】把两个干系人之间的一条关系提交为「候选关系」，进入待人审队列——不会立即画线，需用户采纳后才上图。端点可以是已存在的干系人（kind=person，id 来自 get_account_detail）或你刚用 propose_person 提交的候选人物（kind=suggestion，id 为其返回的候选 ID）。layer：L1组织架构/L2决策权力/L3情感阵营/L4战略本质。',
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
        customerType: { type: 'number', description: '客户类型 1/2/3/4（1=央企发电集团/五大六小，2=地方能源国企，3=分布式头部民企，4=EPC总承包商）' },
        region: { type: 'string', description: '大区' },
        group: { type: 'string', description: '集团/母公司' },
        primaryOwner: { type: 'string', description: '主负责人' },
        primaryOwnerUserId: { type: ['string', 'null'], description: '主负责人稳定 User.id；不得用姓名推断' },
        profile: { type: 'object', description: '企业背景档案 JSON：business(工商)/group(集团关系)/bidding(招投标)/risk(风险)/ourCooperation(我方合作)/salesNote(销售背景)/aiSuggestion(AI建议)', properties: ACCOUNT_PROFILE_TOOL_PROPERTIES, additionalProperties: false },
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
        c3Items: { type: 'object', description: 'C3 立项材料 7 项掌握情况(boolean map，键=中文项名)', additionalProperties: { type: 'boolean' } },
        c5Items: { type: 'object', description: 'C5 招采事项 5 项掌握情况(boolean map)', properties: C5_ITEM_TOOL_PROPERTIES, additionalProperties: false },
        meta: { type: 'object', description: 'JSON 兜底(BANT 辅助分等)', additionalProperties: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'append_visit_note',
    description:
      '【写·直接落正式表】把销售包(WorkBuddy)提炼的「拜访记录」同步进江湖，按 externalRef 幂等(非候选)。先定位父客户(accountId / accountExternalRef / unifiedCreditCode 三选一，须已存在)，可选定位商机(opportunityId / opportunityExternalRef，限该客户下)。date(YYYY-MM-DD) 与 summary 必填。participants 形如 [{name, side:"our"|"customer"}]。直接写正式 VisitNote 表并带 origin=workbuddy 溯源。注意：拜访记录里提及的新干系人仍须另走 propose_person 候选人审(PIPL)。',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: '父客户江湖 ID（三种定位之一）' },
        accountExternalRef: { type: 'string', description: '父客户销售包 customer_id（三种定位之一）' },
        unifiedCreditCode: { type: 'string', description: '父客户统一社会信用代码（三种定位之一）' },
        opportunityId: { type: 'string', description: '可选：关联商机江湖 ID（限本客户下）' },
        opportunityExternalRef: { type: 'string', description: '可选：关联商机销售包锚（限本客户下）' },
        externalRef: { type: 'string', description: '拜访记录幂等锚（销售包文件名/hash）' },
        date: { type: 'string', description: '拜访日期 YYYY-MM-DD（必填）' },
        summary: { type: 'string', description: '拜访纪要正文（必填）' },
        topic: { type: 'string', description: '主题' },
        participants: { type: 'array', description: '参与人 [{name, side:our|customer}]', items: { type: 'object', properties: { name: { type: 'string' }, side: { type: 'string', enum: ['our', 'customer'] } }, additionalProperties: false } },
      },
      required: ['date', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_opportunity_roles',
    description:
      '【写·评分状态】为某商机批量设置 ADURC 决策链角色（A批准人/D拍板人/U使用者/R影响者·技术把关/C教练）。P4 仅限非 A/D 且全商机单选，服务端设置新 P4 时自动解除旧 P4；主 D 必须由用户在江湖确认，MCP 不自动指定。⚠️ 只能对【已存在的正式干系人】设角色——候选人物须先经 propose_person + 用户人审采纳（或用 propose_person 带 suggestedRole，采纳时自动落角色）。G64111 趋赢力由江湖引擎据此实时算，不接收/不存死分。商机定位：opportunityId，或 opportunityExternalRef + 父客户。',
    inputSchema: {
      type: 'object',
      properties: {
        opportunityId: { type: 'string', description: '商机江湖 ID（定位一）' },
        opportunityExternalRef: { type: 'string', description: '商机销售包锚（定位二，需配父客户）' },
        accountId: { type: 'string', description: '父客户 ID' },
        accountExternalRef: { type: 'string', description: '父客户销售包 customer_id' },
        unifiedCreditCode: { type: 'string', description: '父客户 USCC' },
        roles: {
          type: 'array', description: '角色数组',
          items: {
            type: 'object',
            properties: {
              personId: { type: 'string', description: '正式干系人 ID（或用 personName）' },
              personName: { type: 'string', description: '正式干系人姓名（在父客户下匹配）' },
              role: { type: 'string', description: 'A/D/U/R/C' },
              sentiment: { type: 'string', description: 'star/plus/neutral/unknown/minus/x' },
              isKeyInfluencer: { type: 'boolean', description: '是否 P4 关键影响人' },
              procurementType: { type: 'string', description: 'purchasing/agency/ownerRep' },
              procurementStatus: { type: 'string', description: 'collude/verbal/none' },
              confidence: { type: 'string', description: '共识/明确/推理/不清' },
            },
            additionalProperties: false,
          },
        },
      },
      required: ['roles'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_burning_issue',
    description:
      '【写·评分状态】记录某干系人（通常是 D 拍板人）的「燃眉之急 BI」，按 (商机, 干系人, category) 幂等。干系人须为正式 Person（候选须先采纳）。供 G64111 的 C2/C6 计分。',
    inputSchema: {
      type: 'object',
      properties: {
        opportunityId: { type: 'string' },
        opportunityExternalRef: { type: 'string' },
        accountId: { type: 'string' },
        accountExternalRef: { type: 'string' },
        unifiedCreditCode: { type: 'string' },
        personId: { type: 'string', description: '正式干系人 ID（或 personName）' },
        personName: { type: 'string' },
        description: { type: 'string', description: 'BI 描述（必填）' },
        category: { type: 'string', description: '类别（考核压力/降本KPI/个人晋升…默认 其他）' },
        confidence: { type: 'string', description: '共识/明确/推理/不清' },
        isPrivate: { type: 'boolean', description: '是否私人痛点（默认 true）' },
      },
      required: ['description'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_ucv',
    description:
      '【写·评分状态】记录针对某 BI 的「独特价值 UCV」，按 (商机, targetBi) 幂等。定位 BI：targetBiId，或 personId/personName + category。供 G64111 的 C6 决胜计分。',
    inputSchema: {
      type: 'object',
      properties: {
        opportunityId: { type: 'string' },
        opportunityExternalRef: { type: 'string' },
        accountId: { type: 'string' },
        accountExternalRef: { type: 'string' },
        unifiedCreditCode: { type: 'string' },
        targetBiId: { type: 'string', description: '目标 BI 的 ID（定位一）' },
        personId: { type: 'string', description: '定位二：干系人 ID + category 找其 BI' },
        personName: { type: 'string' },
        category: { type: 'string' },
        description: { type: 'string', description: 'UCV 描述（必填）' },
        competitorCannot: { type: 'string', description: '对手给不了的点' },
        status: { type: 'string', description: '建议/获认可/已解决（默认 建议）' },
      },
      required: ['description'],
      additionalProperties: false,
    },
  },
] as const;

type ToolName = (typeof TOOL_SCHEMAS)[number]['name'];

const TOOL_SCOPE_REQUIREMENTS: Readonly<Record<ToolName, readonly AccessScope[]>> = {
  sync_intel_bundle: ['sync_business'],
  list_accounts: ['read'],
  get_account_detail: ['read'],
  get_win_tendency: ['read'],
  propose_person: ['propose_people'],
  propose_relationship: ['propose_relations'],
  list_pending: ['read'],
  upsert_account: ['sync_business'],
  upsert_opportunity: ['sync_business'],
  append_visit_note: ['sync_business'],
  set_opportunity_roles: ['human_command'],
  set_burning_issue: ['human_command'],
  set_ucv: ['human_command'],
};

// 权限声明随工具定义发布；tools/list 与 tools/call 共享同一份声明，避免漏加门禁。
const TOOL_DEFS = TOOL_SCHEMAS.map((definition) => ({
  ...definition,
  requiredScopes: TOOL_SCOPE_REQUIREMENTS[definition.name],
}));

function contextScopes(ctx: CommandContext): readonly AccessScope[] {
  if (ctx.scopes) {
    const allowed = new Set<string>(ALL_ACCESS_SCOPES);
    return ctx.scopes.filter((scope): scope is AccessScope => allowed.has(scope));
  }
  // 仅供进程内调用/旧单测兼容；HTTP 路径始终由 mcpAuthenticate 显式注入 scopes。
  return ctx.actorRole === 'viewer' ? scopesForCurrentRole('viewer') : ALL_ACCESS_SCOPES;
}

function dynamicSyncScopes(args: Record<string, unknown>): AccessScope[] {
  const bundle = args.bundle && typeof args.bundle === 'object' && !Array.isArray(args.bundle)
    ? args.bundle as Record<string, unknown>
    : {};
  const required: AccessScope[] = [];
  if (Array.isArray(bundle.people) && bundle.people.length > 0) required.push('propose_people');
  if (Array.isArray(bundle.relations) && bundle.relations.length > 0) required.push('propose_relations');
  if (Array.isArray(bundle.evidences) && bundle.evidences.length > 0) required.push('submit_evidence');
  return required;
}

function requiredScopesForCall(name: string, args: Record<string, unknown>): readonly AccessScope[] | null {
  const definition = TOOL_DEFS.find((tool) => tool.name === name);
  if (!definition) return null;
  return name === 'sync_intel_bundle'
    ? [...definition.requiredScopes, ...dynamicSyncScopes(args)]
    : definition.requiredScopes;
}

function canCallTool(ctx: CommandContext, name: string, args: Record<string, unknown>): boolean | null {
  const required = requiredScopesForCall(name, args);
  if (!required) return null;
  const granted = new Set(contextScopes(ctx));
  return required.every((scope) => granted.has(scope));
}

const CUSTOMER_TYPE_LABEL: Record<number, string> = {
  1: '央企发电集团（五大六小）',
  2: '地方能源国企',
  3: '分布式头部民企',
  4: 'EPC总承包商',
};
const LAYER_LABEL: Record<string, string> = {
  L1: 'L1 组织架构', L2: 'L2 决策权力', L3: 'L3 情感阵营', L4: 'L4 战略本质',
};
const ROLE_LABEL: Record<string, string> = {
  A: '批准人', D: '拍板人', U: '使用者', R: '影响者·技术把关', C: '教练',
};
const SENTIMENT_LABEL: Record<string, string> = {
  star: '排他性支持', plus: '明确支持', neutral: '中立', unknown: '未知', minus: '负面/抗拒', x: '倒向对手',
};

const J = <T>(s: string | null | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };

// ───────────────────────── 工具实现（全部按 tenantId 隔离 · 只读） ─────────────────────────

/** list_accounts：本租户客户清单 + 计数。 */
async function listAccounts(ctx: CommandContext) {
  const { tenantId } = ctx;
  const scope = await resolveEffectiveResourceScope(prisma, {
    tenantId,
    userId: ctx.actorId,
    role: ctx.actorRole,
  });
  const accounts = await prisma.account.findMany({
    where: { tenantId, archivedAt: null, id: { in: [...scope.accountIds] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, customerType: true },
  });
  const fullAccounts = scope.fullAccountIds.size === 0 ? [] : await prisma.account.findMany({
    where: { tenantId, archivedAt: null, id: { in: [...scope.fullAccountIds] } },
    select: {
      id: true,
      externalRef: true,
      unifiedCreditCode: true,
      _count: {
        select: {
          persons: { where: { tenantId, ...activePersonWhere } },
          opportunities: { where: { tenantId, archivedAt: null } },
        },
      },
    },
  });
  const fullById = new Map(fullAccounts.map((account) => [account.id, account]));
  return {
    accounts: accounts.map((account) => {
      const full = fullById.get(account.id);
      return {
        id: account.id,
        name: account.name,
        customerType: account.customerType,
        customerTypeLabel: CUSTOMER_TYPE_LABEL[account.customerType] ?? `类型${account.customerType}`,
        ...(full ? {
          externalRef: full.externalRef ?? undefined, // 为空 = 江湖原生建、WorkBuddy 尚未加工（认领判据）
          unifiedCreditCode: full.unifiedCreditCode ?? undefined,
          personCount: full._count.persons,
          opportunityCount: full._count.opportunities,
        } : {}),
      };
    }),
  };
}

/** get_account_detail：某客户干系人 + 角色 + 关系概览（findFirst 双重锁定 tenantId）。 */
async function getAccountDetail(ctx: CommandContext, accountId: string) {
  const { tenantId } = ctx;
  const scope = await resolveEffectiveResourceScope(prisma, {
    tenantId,
    userId: ctx.actorId,
    role: ctx.actorRole,
  });
  if (!scope.canReadAccountData(accountId)) throw new Error('客户不存在或不属于当前工作区');
  const account = await prisma.account.findFirst({
    where: { id: accountId, tenantId, archivedAt: null },
    include: {
      persons: { where: { tenantId, ...activePersonWhere } },
      edges: { where: { tenantId } },
      opportunities: {
        where: { tenantId, archivedAt: null },
        include: { roles: { where: { tenantId } } },
      },
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
    account: { id: account.id, name: account.name, externalRef: account.externalRef ?? undefined, customerType: account.customerType, customerTypeLabel: CUSTOMER_TYPE_LABEL[account.customerType] ?? `类型${account.customerType}` },
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
      primaryDPersonId: o.primaryDPersonId && o.roles.some((role) => role.personId === o.primaryDPersonId && role.role === 'D')
        ? o.primaryDPersonId
        : null,
      externalRef: o.externalRef ?? undefined, // 供 WorkBuddy 按 {customer_id}#opp 反查商机 id（propose_person 的 opportunityId）
      pipelineStage: o.pipelineStage,
      engageStage: o.engageStage,
    })),
  };
}

/** get_win_tendency：某商机 G64111 评分（先按 tenantId 取商机及其父客户的人，再算分）。 */
async function getWinTendency(ctx: CommandContext, opportunityId: string) {
  const { tenantId } = ctx;
  const scope = await resolveEffectiveResourceScope(prisma, {
    tenantId,
    userId: ctx.actorId,
    role: ctx.actorRole,
  });
  if (!scope.canReadMatter(opportunityId)) throw new Error('商机不存在或不属于当前工作区');
  const opp = await prisma.opportunity.findFirst({
    where: {
      id: opportunityId,
      tenantId,
      archivedAt: null,
      account: { tenantId, archivedAt: null },
    },
    include: {
      roles: { where: { tenantId } },
      bis: { where: { tenantId } },
      ucvs: { where: { tenantId } },
      account: { select: { id: true } },
    },
  });
  if (!opp) throw new Error('商机不存在或不属于当前工作区');

  const relatedPersonIds = new Set([
    ...opp.roles.map((role) => role.personId),
    ...opp.bis.map((bi) => bi.personId),
  ]);
  const persons = await prisma.person.findMany({
    where: {
      tenantId,
      accountId: opp.accountId,
      ...activePersonWhere,
      ...(scope.canReadAccountData(opp.accountId) ? {} : { id: { in: [...relatedPersonIds] } }),
    },
    select: { id: true, form: true },
  });

  const account = {
    persons: persons.map((p) => ({ id: p.id, form: J<{ family7?: Record<string, string | undefined> }>(p.form, {}) })),
  };
  // 与 state/PDE 的 viewer 字段 ACL 一致：私人 BI 及其依赖 UCV 不得通过精确分数侧信道泄漏。
  const visibleBis = scope.actorRole === 'viewer' ? opp.bis.filter((bi) => !bi.isPrivate) : opp.bis;
  const visibleBiIds = new Set(visibleBis.map((bi) => bi.id));
  const visibleUcvs = opp.ucvs.filter((ucv) => visibleBiIds.has(ucv.targetBiId));
  const opportunity = {
    primaryDPersonId: opp.primaryDPersonId,
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
    bis: visibleBis.map((b) => ({ id: b.id, personId: b.personId, confidence: b.confidence as any })),
    ucvs: visibleUcvs.map((u) => ({ targetBiId: u.targetBiId, status: u.status as any })),
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
const proposalValue = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value ?? null);

async function proposeMachineFieldChanges(ctx: CommandContext, input: {
  accountId: string;
  opportunityId?: string;
  entityKind: string;
  entityId: string;
  current: Record<string, unknown>;
  patch: Record<string, unknown>;
  evidence?: string;
}): Promise<number> {
  let count = 0;
  for (const [field, value] of Object.entries(input.patch)) {
    const oldValue = proposalValue(input.current[field]);
    const newValue = proposalValue(value);
    if (oldValue === newValue) continue;
    await createFieldProposal(ctx.tenantId, {
      accountId: input.accountId,
      opportunityId: input.opportunityId,
      entityKind: input.entityKind,
      entityId: input.entityId,
      field,
      oldValue,
      newValue,
      origin: 'mcp',
      evidence: input.evidence || `WorkBuddy 同步：${input.entityKind}.${field} 疑似变化`,
      confidence: 0.6,
      proposedBy: ctx.actorId,
    });
    count += 1;
  }
  return count;
}

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
  if (opportunityId) {
    const opportunity = await prisma.opportunity.findFirst({ where: { id: opportunityId, tenantId, accountId } });
    if (!opportunity) throw new Error('商机不存在或不属于该客户');
  }
  const evidence = str(args.evidence, 500);
  const sourceUrl = str(args.sourceUrl, 500) || null;
  const confidence = Math.max(0, Math.min(1, num(args.confidence) ?? 0.5));
  const suggestedRole = ['A', 'D', 'U', 'R', 'C'].includes(str(args.suggestedRole)) ? str(args.suggestedRole) : null;
  const suggestedSentiment = ['star', 'plus', 'neutral', 'unknown', 'minus', 'x'].includes(str(args.suggestedSentiment)) ? str(args.suggestedSentiment) : null;

  // 容量上限（防滥用）
  const pendingCount = await prisma.personSuggestion.count({ where: { tenantId, status: 'pending' } });
  if (pendingCount >= MAX_PENDING_PERSON_SUGG) throw new Error(`候选干系人已达上限（${MAX_PENDING_PERSON_SUGG}），请先在江湖里处理现有候选`);

  // 应用层去重：同租户+同客户+同名+pending → 更新（取高 confidence、补 evidence），不新增
  const dup = await prisma.personSuggestion.findFirst({ where: { tenantId, accountId, name, status: 'pending' } });
  if (dup) {
    if (dup.opportunityId) {
      const duplicateOpportunity = await prisma.opportunity.findFirst({ where: { id: dup.opportunityId, tenantId, accountId } });
      if (!duplicateOpportunity) throw new Error('现有同名候选的商机关联不属于该客户，已拒绝自动更新');
    }
    await prisma.personSuggestion.update({
      where: { id: dup.id },
      data: { title: title || dup.title, evidence: evidence || dup.evidence, sourceUrl: sourceUrl ?? dup.sourceUrl, confidence: Math.max(dup.confidence, confidence), suggestedRole: suggestedRole ?? dup.suggestedRole, suggestedSentiment: suggestedSentiment ?? dup.suggestedSentiment },
    });
    return { suggestionId: dup.id, deduped: true, note: '已存在同名候选干系人（pending），已更新其依据而非新增。' };
  }

  // 提示：是否已有同名正式干系人（由人审决定合并，AI 不替判）
  const existingPerson = await prisma.person.findFirst({ where: { tenantId, accountId, name, ...activePersonWhere } });

  const id = 'ps_' + randomUUID().replaceAll('-', '');
  await prisma.personSuggestion.create({
    data: { id, tenantId, accountId, opportunityId, name, title, orgLevel, origin: 'mcp', evidence, sourceUrl, confidence, status: 'pending', proposedBy: userId, suggestedRole, suggestedSentiment },
  });
  return {
    suggestionId: id,
    note: existingPerson
      ? `⚠️ 该客户下已存在同名正式干系人（id=${existingPerson.id}）。候选已提交，请人审时判断是合并到现有还是新建，AI 不自动合并。`
      : '候选干系人已提交，等待用户人审采纳后才会出现在关系地图上。',
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
  const account = await prisma.account.findFirst({ where: { id: opp.accountId, tenantId } });
  if (!account) throw new Error('商机所属客户不存在或不属于当前工作区');

  // 校验两端点存在且属于该商机的 Account（person → Person 表；suggestion → PersonSuggestion 表）
  const checkEndpoint = async (e: { kind: string; id: string }, role: string) => {
    if (e.kind === 'person') {
      const p = await prisma.person.findFirst({ where: { id: e.id, tenantId, accountId: opp.accountId, ...activePersonWhere } });
      if (!p) throw new Error(`${role}端点（正式干系人 ${e.id}）不存在或不属于该商机客户`);
    } else {
      const s = await prisma.personSuggestion.findFirst({ where: { id: e.id, tenantId, accountId: opp.accountId } });
      if (!s) throw new Error(`${role}端点（候选干系人 ${e.id}）不存在或不属于该商机客户`);
      if (s.opportunityId) {
        const candidateOpportunity = await prisma.opportunity.findFirst({ where: { id: s.opportunityId, tenantId, accountId: opp.accountId } });
        if (!candidateOpportunity) throw new Error(`${role}端点（候选干系人 ${e.id}）的商机关联不属于该商机客户`);
      }
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

  const id = 'rs_' + randomUUID().replaceAll('-', '');
  await prisma.relSuggestion.create({
    data: { id, tenantId, opportunityId, sourcePersonId: source.id, sourceKind: source.kind, targetPersonId: target.id, targetKind: target.kind, layer, label, confidence, origin: 'mcp', evidence, status: 'pending' },
  });
  return { suggestionId: id, note: '候选关系已提交，等待用户人审采纳后才会画到关系地图上。' };
}

/** list_pending：列本租户待人审候选（只读）。 */
async function listPending(ctx: CommandContext, accountId: string) {
  const { tenantId } = ctx;
  const scope = await resolveEffectiveResourceScope(prisma, {
    tenantId,
    userId: ctx.actorId,
    role: ctx.actorRole,
  });
  if (accountId && !scope.canReadAccountContainer(accountId)) throw new Error('客户不存在或不属于当前工作区');

  const readablePersonAccountIds = accountId
    ? (scope.canReadAccountData(accountId) ? [accountId] : [])
    : [...scope.fullAccountIds];
  const personWhere: any = {
    tenantId,
    status: 'pending',
    accountId: { in: readablePersonAccountIds },
  };
  const persons = await prisma.personSuggestion.findMany({ where: personWhere, orderBy: { createdAt: 'desc' }, take: 100 });

  const visibleMatters = await prisma.opportunity.findMany({
    where: {
      tenantId,
      archivedAt: null,
      id: { in: [...scope.matterIds] },
      ...(accountId ? { accountId } : {}),
    },
    select: { id: true },
  });
  const relWhere: any = {
    tenantId,
    status: 'pending',
    opportunityId: { in: visibleMatters.map((matter) => matter.id) },
  };
  const rels = await prisma.relSuggestion.findMany({ where: relWhere, orderBy: { createdAt: 'desc' }, take: 100 });
  const scopedRels = await resolveScopedRelSuggestions(prisma, tenantId, rels);

  return {
    pendingPersons: persons.map((p) => ({ id: p.id, accountId: p.accountId, name: p.name, title: p.title, orgLevel: p.orgLevel, evidence: p.evidence, sourceUrl: p.sourceUrl ?? undefined, confidence: p.confidence })),
    pendingRelationships: scopedRels.map(({ row: r }) => ({ id: r.id, opportunityId: r.opportunityId, source: { kind: r.sourceKind, id: r.sourcePersonId }, target: { kind: r.targetKind, id: r.targetPersonId }, layer: r.layer, label: r.label, evidence: r.evidence, confidence: r.confidence })),
  };
}

// ───────────────────────── 业务实体直写工具（落正式表 · tenantId 隔离 · 带 origin 溯源） ─────────────────────────
// 与 propose_* 候选工具不同：客户档案属业务实体（非个人身份判定），可直接 upsert 正式表
//（人审边界见 docs/集成-WorkBuddy销售包对接设计.md §0）。复用 applyAction 构造 Action 落库，
// 不另写 prisma 写逻辑；幂等去重在应用层（不靠 DB unique，保持 SQLite↔Postgres 可移植）。

/** upsert_account：按 externalRef(主锚)→unifiedCreditCode(副锚) 幂等 upsert 客户档案。 */
function projectAccountProfile(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const projected: Record<string, string> = {};
  for (const field of ACCOUNT_PROFILE_FIELDS) {
    if (typeof source[field] === 'string') projected[field] = source[field];
  }
  return projected;
}

async function upsertAccount(ctx: CommandContext, args: Record<string, unknown>) {
  const { tenantId } = ctx;
  const externalRef = str(args.externalRef, 80).trim() || null;
  const unifiedCreditCode = str(args.unifiedCreditCode, 40).trim() || null;
  if (!externalRef && !unifiedCreditCode) throw new Error('缺少幂等锚：externalRef 或 unifiedCreditCode 至少提供一个');

  const name = str(args.name, 100).trim();
  const ct = num(args.customerType);
  const customerType = ct && [1, 2, 3].includes(ct) ? ct : undefined;
  const profile = args.profile != null && typeof args.profile === 'object' ? projectAccountProfile(args.profile) : undefined;

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
    if (args.primaryOwnerUserId !== undefined) patch.primaryOwnerUserId = args.primaryOwnerUserId === null ? null : str(args.primaryOwnerUserId, 100);
    // 只把共享契约允许的字段送入 Action；mutator 在数据库侧保留 legacy extras，并生成 server-owned _mcpOrigin。
    let curProfile: unknown = {};
    try { curProfile = JSON.parse(existing.profile || '{}'); } catch { /* 存量坏值，覆盖为空对象 */ }
    patch.profile = { ...projectAccountProfile(curProfile), ...(profile ?? {}) };
    await applyMcpAction(ctx, { type: 'UPDATE_ACCOUNT', accId: existing.id, patch });
    return { id: existing.id, updated: true, origin: 'mcp', note: `已按幂等锚命中现有客户「${existing.name}」并更新（外部来源·待核，见客户卡）。` };
  }

  // 未命中 → CREATE（新建必须有 name）
  if (!name) throw new Error('未命中现有客户，新建需提供 name');
  const id = 'acc_' + randomUUID().replaceAll('-', '');
  await applyMcpAction(ctx, {
    type: 'ADD_ACCOUNT',
    account: {
      id, name,
      customerType: customerType ?? 1,
      unifiedCreditCode: unifiedCreditCode ?? undefined,
      externalRef: externalRef ?? undefined,
      region: str(args.region, 40),
      group: str(args.group, 100),
      primaryOwner: str(args.primaryOwner, 40),
      primaryOwnerUserId: typeof args.primaryOwnerUserId === 'string' ? str(args.primaryOwnerUserId, 100) : undefined,
      profile: profile ?? {},
    },
  });
  // 江湖自算：新建客户后后台入队 enrich 任务（企查查/AI 发现干系人 → 候选进收件箱人审，铁律②）。
  // 仅新建触发、不阻塞 upsert 返回；入队失败不影响客户落库。
  let selfCompute = false;
  try { selfCompute = (await enqueueEnrichJob(tenantId, id, 'auto')).enqueued; } catch { /* 超上限等，忽略 */ }
  // P9：同时入队企业背景研究（企查查/LLM 双轨 → account 级 Note 带溯源 → curated「AI 整理·待核」吸收）
  try { await enqueueProfileJob(tenantId, id); } catch { /* 超上限等，忽略 */ }
  return { id, created: true, origin: 'mcp', note: `已新建客户「${name}」（外部来源·待核，见客户卡）。${selfCompute ? '已启动后台自算补全干系人+企业背景研究，完成后见收件箱/客户档案。' : ''}` };
}

const LEGACY_SYNC_DEPRECATED_AFTER = '2026-10-01';
const canonicalLegacyPayload = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalLegacyPayload);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalLegacyPayload(item)]));
};
const legacySyncKey = (tool: string, args: Record<string, unknown>) => `legacy-${tool}-${createHash('sha256')
  .update(JSON.stringify(canonicalLegacyPayload(args))).digest('hex').slice(0, 32)}`;

async function syncLegacyAccount(ctx: CommandContext, args: Record<string, unknown>) {
  const externalRef = str(args.externalRef, 80).trim();
  const unifiedCreditCode = str(args.unifiedCreditCode, 40).trim();
  let existing = externalRef ? await prisma.account.findFirst({ where: { tenantId: ctx.tenantId, externalRef } }) : null;
  if (!existing && unifiedCreditCode) existing = await prisma.account.findFirst({ where: { tenantId: ctx.tenantId, unifiedCreditCode } });
  if (typeof args.primaryOwnerUserId === 'string') {
    const owner = await prisma.user.findFirst({ where: { id: str(args.primaryOwnerUserId, 100), tenantId: ctx.tenantId } });
    if (!owner) throw new Error('primary owner not found in tenant');
  }
  const name = str(args.name, 100).trim() || existing?.name;
  if (!name) throw new Error('未命中现有客户，新建需提供 name');
  const rawType = num(args.customerType);
  const customerType = rawType && [1, 2, 3, 4].includes(rawType) ? rawType : existing?.customerType ?? 1;
  const syncReceipt = await syncIntelBundle(ctx, {
    idempotencyKey: legacySyncKey('upsert_account', args),
    bundle: { account: {
      ...(externalRef ? { externalRef } : {}),
      ...(unifiedCreditCode ? { unifiedCreditCode } : {}),
      name, customerType,
      ...(args.region !== undefined ? { region: str(args.region, 40) } : {}),
      ...(args.group !== undefined ? { group: str(args.group, 100) } : {}),
      ...(args.primaryOwner !== undefined ? { primaryOwner: str(args.primaryOwner, 40) } : {}),
      ...(args.primaryOwnerUserId !== undefined
        ? { primaryOwnerUserId: typeof args.primaryOwnerUserId === 'string' ? str(args.primaryOwnerUserId, 100) : null }
        : {}),
      ...(args.profile !== undefined ? { profile: projectAccountProfile(args.profile) } : {}),
    } },
  });
  const account = await prisma.account.findFirst({ where: {
    tenantId: ctx.tenantId,
    ...(externalRef ? { externalRef } : { unifiedCreditCode }),
  } });
  if (!account) throw new Error('同步完成后未找到客户');
  const created = syncReceipt.created.includes(`account:${externalRef || unifiedCreditCode}`);
  return {
    id: account.id, ...(created ? { created: true } : { updated: true }), origin: 'mcp',
    note: created ? `已新建客户「${account.name}」（外部来源·待核，见客户卡）。` : `已命中客户「${account.name}」并完成同步。`,
    deprecatedAfter: LEGACY_SYNC_DEPRECATED_AFTER, syncReceipt,
  };
}

async function resolveLegacySyncAccount(ctx: CommandContext, args: Record<string, unknown>) {
  const accountId = str(args.accountId, 40).trim();
  const externalRef = str(args.accountExternalRef, 80).trim();
  const unifiedCreditCode = str(args.unifiedCreditCode, 40).trim();
  const [byId, byExternal, byCredit] = await Promise.all([
    accountId ? prisma.account.findFirst({ where: { id: accountId, tenantId: ctx.tenantId } }) : null,
    externalRef ? prisma.account.findFirst({ where: { tenantId: ctx.tenantId, externalRef } }) : null,
    unifiedCreditCode ? prisma.account.findFirst({ where: { tenantId: ctx.tenantId, unifiedCreditCode } }) : null,
  ]);
  if ((accountId && !byId) || (externalRef && !byExternal) || (unifiedCreditCode && !byCredit)) {
    throw new Error('account anchor does not resolve in the current tenant');
  }
  const ids = new Set([byId?.id, byExternal?.id, byCredit?.id].filter(Boolean));
  if (ids.size > 1) throw new Error('account anchors resolve to different rows');
  const account = byId ?? byExternal ?? byCredit;
  if (!account) throw new Error('未定位到父客户：请提供 accountId / accountExternalRef / unifiedCreditCode 之一（该客户须已存在）');
  return account;
}

async function syncLegacyOpportunity(ctx: CommandContext, args: Record<string, unknown>) {
  const account = await resolveLegacySyncAccount(ctx, args);
  const externalRef = str(args.externalRef, 80).trim();
  if (!externalRef) throw new Error('缺少商机幂等锚 externalRef');
  const existing = await prisma.opportunity.findFirst({ where: { tenantId: ctx.tenantId, accountId: account.id, externalRef } });
  const name = str(args.name, 100).trim() || existing?.name;
  if (!name) throw new Error('未命中现有商机，新建需提供 name');
  const pipelineInput = str(args.pipelineStage, 40) === '合同签约' ? '合同双签' : str(args.pipelineStage, 40);
  const pipelineStage = ['线索', '需求引导', '方案认可', '客户立项', '招投标', '合同谈判', '合同双签'].includes(pipelineInput)
    ? pipelineInput : existing?.pipelineStage;
  const engageInput = str(args.engageStage, 40);
  const engageStage = ['需求调研立项', '方案可研', '预算批复', '招标论证', '招采执行'].includes(engageInput)
    ? engageInput : existing?.engageStage;
  const statusInput = str(args.status, 20);
  const status = ['active', 'paused', 'won', 'lost'].includes(statusInput) ? statusInput : undefined;
  const changeModeInput = str(args.changeMode, 20);
  const changeMode = ['G', 'T', 'EK', 'OC'].includes(changeModeInput) ? changeModeInput : undefined;
  const objectInput = (value: unknown): Record<string, unknown> | undefined => (
    value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  );
  const syncReceipt = await syncIntelBundle(ctx, {
    idempotencyKey: legacySyncKey('upsert_opportunity', args),
    bundle: {
      account: { id: account.id, name: account.name, customerType: account.customerType },
      opportunity: {
        externalRef, name,
        ...(pipelineStage ? { pipelineStage } : {}),
        ...(engageStage ? { engageStage } : {}),
        ...(status ? { status } : {}),
        ...(changeMode ? { changeMode } : {}),
        ...(args.productSolution !== undefined ? { productSolution: str(args.productSolution, 500) } : {}),
        ...(args.competitor !== undefined ? { competitor: str(args.competitor, 200) } : {}),
        ...(args.competitiveSituation !== undefined ? { competitiveSituation: str(args.competitiveSituation, 40) } : {}),
        ...(args.singleSalesGoal !== undefined ? { singleSalesGoal: str(args.singleSalesGoal, 500) } : {}),
        ...(args.customerBusinessGoal !== undefined ? { customerBusinessGoal: str(args.customerBusinessGoal, 500) } : {}),
        ...(args.buyingMotivation !== undefined ? { buyingMotivation: str(args.buyingMotivation, 500) } : {}),
        ...(args.expectedSignDate !== undefined ? { expectedSignDate: str(args.expectedSignDate, 20) } : {}),
        ...(num(args.expectedAmountW) !== undefined ? { expectedAmountW: num(args.expectedAmountW)! } : {}),
        ...(objectInput(args.c3Items) ? { c3Items: objectInput(args.c3Items) as Record<string, boolean> } : {}),
        ...(objectInput(args.c5Items) ? { c5Items: objectInput(args.c5Items) as Record<string, boolean> } : {}),
        ...(objectInput(args.meta) ? { meta: objectInput(args.meta)! } : {}),
      },
    },
  });
  const opportunity = await prisma.opportunity.findFirst({ where: { tenantId: ctx.tenantId, accountId: account.id, externalRef } });
  if (!opportunity) throw new Error('同步完成后未找到商机');
  const created = syncReceipt.created.includes(`opportunity:${externalRef}`);
  const proposed = syncReceipt.proposed.filter((ref) => ref.startsWith(`opportunity:${externalRef}:`)).length;
  return {
    id: opportunity.id, accountId: account.id, ...(created ? { created: true } : { proposed }), origin: 'mcp',
    note: created
      ? `已在客户「${account.name}」下新建商机「${opportunity.name}」（外部来源·待核）。`
      : `已命中商机「${opportunity.name}」；${proposed} 个字段变更转入收件箱待人审（winProbability 未改）。`,
    deprecatedAfter: LEGACY_SYNC_DEPRECATED_AFTER, syncReceipt,
  };
}

async function syncLegacyVisit(ctx: CommandContext, args: Record<string, unknown>) {
  const account = await resolveLegacySyncAccount(ctx, args);
  const externalRef = str(args.externalRef, 120).trim();
  if (!externalRef) throw new Error('缺少拜访记录幂等锚 externalRef');
  const opportunityId = str(args.opportunityId, 40).trim();
  const opportunityExternalRef = str(args.opportunityExternalRef, 80).trim();
  const [byId, byExternal] = await Promise.all([
    opportunityId ? prisma.opportunity.findFirst({ where: { id: opportunityId, tenantId: ctx.tenantId, accountId: account.id } }) : null,
    opportunityExternalRef
      ? prisma.opportunity.findFirst({ where: { tenantId: ctx.tenantId, accountId: account.id, externalRef: opportunityExternalRef } })
      : null,
  ]);
  if ((opportunityId && !byId) || (opportunityExternalRef && !byExternal)) throw new Error('opportunity anchor does not resolve under the account');
  if (byId && byExternal && byId.id !== byExternal.id) throw new Error('opportunity anchors resolve to different rows');
  const opportunity = byId ?? byExternal;
  const participants = Array.isArray(args.participants)
    ? args.participants.slice(0, 50).map((item: unknown) => {
      const participant = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return { name: str(participant.name, 40).trim(), side: participant.side === 'our' ? 'our' as const : 'customer' as const };
    }).filter((participant) => participant.name)
    : undefined;
  const syncReceipt = await syncIntelBundle(ctx, {
    idempotencyKey: legacySyncKey('append_visit_note', args),
    bundle: {
      account: { id: account.id, name: account.name, customerType: account.customerType },
      ...(opportunity?.externalRef ? { opportunity: {
        externalRef: opportunity.externalRef, name: opportunity.name,
        pipelineStage: opportunity.pipelineStage, engageStage: opportunity.engageStage,
      } } : {}),
      visit: {
        externalRef, date: str(args.date, 20), summary: str(args.summary, 5000),
        ...(opportunity ? { opportunityId: opportunity.id } : {}),
        ...(args.topic !== undefined ? { topic: str(args.topic, 200) } : {}),
        ...(participants !== undefined ? { participants } : {}),
      },
    },
  });
  const visit = await prisma.visitNote.findFirst({ where: { tenantId: ctx.tenantId, accountId: account.id, externalRef } });
  if (!visit) throw new Error('同步完成后未找到拜访记录');
  const created = syncReceipt.created.includes(`visit:${externalRef}`);
  return {
    id: visit.id, accountId: account.id, opportunityId: visit.opportunityId ?? undefined,
    ...(created ? { created: true } : { updated: true }), origin: 'mcp',
    note: created ? `已记录拜访（${visit.date}·外部来源·待核）。` : `已按 externalRef 命中拜访记录并更新（${visit.date}·外部来源·待核）。`,
    deprecatedAfter: LEGACY_SYNC_DEPRECATED_AFTER, syncReceipt,
  };
}

/** upsert_opportunity：定位父客户 → 按商机 externalRef 幂等 upsert。守"winProbability 不由 WB 推/覆盖"。 */
async function upsertOpportunity(ctx: CommandContext, args: Record<string, unknown>) {
  const { tenantId } = ctx;
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

  // P12：外部来源·待核标记落 meta._mcpOrigin（与 upsertAccount 同惯例）
  const mcpMark = { source: 'mcp', at: new Date().toISOString(), needsReview: true };

  if (existing) {
    const patch: Record<string, unknown> = { ...fields };
    if (name) patch.name = name;
    if (externalRef && !existing.externalRef) patch.externalRef = externalRef;
    const proposed = await proposeMachineFieldChanges(ctx, {
      accountId: account.id, opportunityId: existing.id, entityKind: 'opportunity', entityId: existing.id,
      current: existing as unknown as Record<string, unknown>, patch,
      evidence: 'WorkBuddy 同步现有商机字段，等待人工确认',
    });
    return { id: existing.id, accountId: account.id, proposed, origin: 'mcp', note: `已命中商机「${existing.name}」；${proposed} 个字段变更转入收件箱待人审（winProbability 未改）。` };
  }

  if (!name) throw new Error('未命中现有商机，新建需提供 name');
  const id = 'opp_' + randomUUID().replaceAll('-', '');
  await applyMcpAction(ctx, {
    type: 'ADD_OPP', accId: account.id,
    opp: {
      id, name, externalRef: externalRef ?? undefined,
      customerType: account.customerType,
      pipelineStage: pipelineStage ?? '线索',
      engageStage: engageStage ?? '需求调研立项',
      status: status ?? 'active',
      ...fields,
      meta: { ...(fields.meta as Record<string, unknown> ?? {}), _mcpOrigin: mcpMark },
    },
  });
  // 江湖自算：新建商机后后台入队关系推断（图算法+LLM 推断商机内关系 → 候选进收件箱人审）。不阻塞、失败不影响落库。
  let selfCompute = false;
  try { selfCompute = (await enqueueSuggestJob(tenantId, account.id, id)).enqueued; } catch { /* 超上限等，忽略 */ }
  return { id, accountId: account.id, created: true, origin: 'mcp', note: `已在客户「${account.name}」下新建商机「${name}」（外部来源·待核）。${selfCompute ? '已启动后台关系推断，候选见收件箱。' : ''}` };
}

/** append_visit_note：定位父客户(+可选商机) → 按 externalRef 幂等 upsert 拜访记录。 */
async function appendVisitNote(ctx: CommandContext, args: Record<string, unknown>) {
  const { tenantId } = ctx;
  // 1) 定位父客户（三选一，全程 where{tenantId}）
  const accId = str(args.accountId, 40).trim();
  const accExtRef = str(args.accountExternalRef, 80).trim();
  const accUscc = str(args.unifiedCreditCode, 40).trim();
  let account = accId ? await prisma.account.findFirst({ where: { id: accId, tenantId } }) : null;
  if (!account && accExtRef) account = await prisma.account.findFirst({ where: { tenantId, externalRef: accExtRef } });
  if (!account && accUscc) account = await prisma.account.findFirst({ where: { tenantId, unifiedCreditCode: accUscc } });
  if (!account) throw new Error('未定位到父客户：请提供 accountId / accountExternalRef / unifiedCreditCode 之一（该客户须已存在）');

  // 2) 可选定位商机（限本客户下，避免跨客户挂错）
  let opportunityId: string | null = null;
  const oppId = str(args.opportunityId, 40).trim();
  const oppExtRef = str(args.opportunityExternalRef, 80).trim();
  if (oppId) {
    const o = await prisma.opportunity.findFirst({ where: { id: oppId, tenantId, accountId: account.id } });
    if (o) opportunityId = o.id;
  }
  if (!opportunityId && oppExtRef) {
    const o = await prisma.opportunity.findFirst({ where: { tenantId, accountId: account.id, externalRef: oppExtRef } });
    if (o) opportunityId = o.id;
  }

  // 3) 必填 + 字段
  const date = str(args.date, 20).trim();
  const summary = str(args.summary, 5000).trim();
  if (!date) throw new Error('缺少必填参数 date（YYYY-MM-DD）');
  if (!summary) throw new Error('缺少必填参数 summary');
  const externalRef = str(args.externalRef, 120).trim() || null;
  const topic = str(args.topic, 200);
  const participants = Array.isArray(args.participants)
    ? args.participants.slice(0, 50).map((p: any) => ({ name: str(p?.name, 40), side: p?.side === 'our' ? 'our' : 'customer' })).filter((p) => p.name)
    : undefined;

  // 4) 幂等：本客户下按 externalRef
  const existing = externalRef ? await prisma.visitNote.findFirst({ where: { tenantId, accountId: account.id, externalRef } }) : null;

  if (existing) {
    const patch: Record<string, unknown> = { date, summary };
    if (topic) patch.topic = topic;
    if (opportunityId) patch.opportunityId = opportunityId;
    if (participants !== undefined) patch.participants = participants;
    await applyMcpAction(ctx, { type: 'UPDATE_VISIT', accId: account.id, visitId: existing.id, patch });
    return { id: existing.id, accountId: account.id, opportunityId: opportunityId ?? existing.opportunityId ?? undefined, updated: true, origin: 'mcp', note: `已按 externalRef 命中拜访记录并更新（${date}·外部来源·待核）。` };
  }

  const id = 'visit_' + randomUUID().replaceAll('-', '');
  // P12：origin 从硬编码 'workbuddy' 改为 'mcp'——精确辨识外部 MCP 直写路径（前端 VisitTimeline/FocusPanel 已扩相应显示）
  await applyMcpAction(ctx, {
    type: 'ADD_VISIT', accId: account.id,
    visit: { id, opportunityId: opportunityId ?? undefined, externalRef: externalRef ?? undefined, date, topic, summary, participants: participants ?? [], origin: 'mcp' },
  });
  return { id, accountId: account.id, opportunityId: opportunityId ?? undefined, created: true, origin: 'mcp', note: `已记录拜访（${date}·外部来源·待核）。` };
}

// ── 阶段1.5 评分状态工具：WorkBuddy 推 ADURC/BI/UCV，G64111 由引擎据此实时算（守硬规则⑥不存死分）──
// 铁律：角色/BI/UCV 只能挂【正式 Person】；候选人物须先 propose_person → 人审采纳。

/** 商机定位：opportunityId 直取，或 opportunityExternalRef + 父客户(accountId/accountExternalRef/unifiedCreditCode)。 */
async function resolveOppFromArgs(tenantId: string, args: Record<string, unknown>) {
  const oppId = str(args.opportunityId, 40).trim();
  if (oppId) {
    const o = await prisma.opportunity.findFirst({ where: { id: oppId, tenantId } });
    if (o) return o;
  }
  const oppExtRef = str(args.opportunityExternalRef, 80).trim();
  if (oppExtRef) {
    const accId = str(args.accountId, 40).trim();
    const accExtRef = str(args.accountExternalRef, 80).trim();
    const accUscc = str(args.unifiedCreditCode, 40).trim();
    let account = accId ? await prisma.account.findFirst({ where: { id: accId, tenantId } }) : null;
    if (!account && accExtRef) account = await prisma.account.findFirst({ where: { tenantId, externalRef: accExtRef } });
    if (!account && accUscc) account = await prisma.account.findFirst({ where: { tenantId, unifiedCreditCode: accUscc } });
    if (account) {
      const o = await prisma.opportunity.findFirst({ where: { tenantId, accountId: account.id, externalRef: oppExtRef } });
      if (o) return o;
    }
  }
  throw new Error('未定位到商机：请提供 opportunityId，或 opportunityExternalRef + 父客户(accountId/accountExternalRef/unifiedCreditCode)');
}

/** 在某客户下按 id 或 name 找正式干系人（非候选）。 */
async function findPersonInAccount(tenantId: string, accountId: string, personId: string, personName: string) {
  if (personId) return prisma.person.findFirst({ where: { id: personId, tenantId, accountId, ...activePersonWhere } });
  if (personName) return prisma.person.findFirst({ where: { tenantId, accountId, name: personName, ...activePersonWhere } });
  return null;
}

const VALID_ROLE = ['A', 'D', 'U', 'R', 'C'];
const VALID_SENT = ['star', 'plus', 'neutral', 'unknown', 'minus', 'x'];
const VALID_CONF = ['共识', '明确', '推理', '不清'];

/** set_opportunity_roles：批量设 ADURC 角色（只对正式 Person，候选跳过并回报）。 */
async function setOpportunityRoles(ctx: CommandContext, args: Record<string, unknown>, policyInput: unknown) {
  const { tenantId } = ctx;
  const opp = await resolveOppFromArgs(tenantId, args);
  const rolesIn = Array.isArray(args.roles) ? (args.roles as any[]) : [];
  if (!rolesIn.length) throw new Error('缺少 roles 数组');
  const persons = await prisma.person.findMany({ where: { tenantId, accountId: opp.accountId, ...activePersonWhere } });
  const byId = new Map(persons.map((p) => [p.id, p]));
  const byName = new Map(persons.map((p) => [p.name, p]));
  const applied: any[] = [];
  const proposed: any[] = []; // 机器对已有正式角色字段的变更 → ChangeProposal（human-wins）
  const skipped: any[] = [];
  for (const r of rolesIn) {
    const pid = str(r?.personId, 40).trim();
    const pname = str(r?.personName, 40).trim();
    const person = pid ? byId.get(pid) : pname ? byName.get(pname) : undefined;
    if (!person) { skipped.push({ personId: pid || undefined, personName: pname || undefined, reason: '未找到正式干系人（候选须先 propose_person 采纳）' }); continue; }
    if (person.isCompetitor) { skipped.push({ personId: person.id, reason: '竞争对手不分配角色' }); continue; }
    const role = VALID_ROLE.includes(str(r?.role)) ? str(r?.role) : undefined;
    if (!role) { skipped.push({ personId: person.id, reason: '缺少有效 role(A/D/U/R/C)' }); continue; }
    if (r?.isKeyInfluencer === true && (role === 'A' || role === 'D')) {
      skipped.push({ personId: person.id, reason: 'P4 关键影响人必须是非 A/D 角色' });
      continue;
    }
    const patch: Record<string, unknown> = { role };
    if (typeof r?.isKeyInfluencer === 'boolean') patch.isKeyInfluencer = r.isKeyInfluencer;
    if (['purchasing', 'agency', 'ownerRep'].includes(str(r?.procurementType))) patch.procurementType = str(r?.procurementType);
    if (['collude', 'verbal', 'none'].includes(str(r?.procurementStatus))) patch.procurementStatus = str(r?.procurementStatus);
    if (VALID_CONF.includes(str(r?.confidence))) patch.confidence = str(r?.confidence);
    const newSent = VALID_SENT.includes(str(r?.sentiment)) ? str(r?.sentiment) : undefined;
    const cur = await prisma.oppRole.findUnique({ where: { tenantId_opportunityId_personId: { tenantId, opportunityId: opp.id, personId: person.id } } });
    if (newSent && newSent !== 'unknown') patch.sentiment = newSent;
    if (cur) {
      const current = cur as unknown as Record<string, unknown>;
      for (const [field, value] of Object.entries(patch)) {
        const oldValue = current[field];
        if (oldValue === value) continue;
        await createFieldProposal(tenantId, {
          accountId: opp.accountId,
          opportunityId: opp.id,
          entityKind: 'oppRole',
          entityId: person.id,
          field,
          oldValue: oldValue == null ? '' : String(oldValue),
          newValue: String(value),
          origin: 'mcp',
          evidence: str(r?.evidence, 500) || `WorkBuddy 同步：${person.name} 的 ${field} 疑似变化`,
          confidence: 0.6,
          proposedBy: ctx.actorId,
        });
        proposed.push({ personId: person.id, name: person.name, field, from: oldValue, to: value });
      }
      continue;
    }
    await applyMcpAction(ctx, { type: 'SET_ROLE', accId: opp.accountId, oppId: opp.id, personId: person.id, patch }, policyInput);
    applied.push({ personId: person.id, name: person.name, role, sentiment: (patch.sentiment as string) ?? 'unknown' });
  }
  const parts = [`已设 ${applied.length} 个角色`];
  if (proposed.length) parts.push(`${proposed.length} 个正式字段变更转入收件箱待人审`);
  if (skipped.length) parts.push(`跳过 ${skipped.length} 个（见 skipped，多为候选未采纳）`);
  return { opportunityId: opp.id, applied, proposed, skipped, origin: 'workbuddy', note: parts.join('；') + '。趋赢力由江湖引擎实时算（同步状态不同步分数）。' };
}

/** set_burning_issue：记某干系人的 BI（按 商机+人+category 幂等）。 */
async function setBurningIssue(ctx: CommandContext, args: Record<string, unknown>, policyInput: unknown) {
  const { tenantId } = ctx;
  const opp = await resolveOppFromArgs(tenantId, args);
  const person = await findPersonInAccount(tenantId, opp.accountId, str(args.personId, 40).trim(), str(args.personName, 40).trim());
  if (!person) throw new Error('未找到正式干系人（候选须先 propose_person 采纳，再设 BI）');
  const description = str(args.description, 500).trim();
  if (!description) throw new Error('缺少 description');
  const category = str(args.category, 40) || '其他';
  const confidence = VALID_CONF.includes(str(args.confidence)) ? str(args.confidence) : '推理';
  const isPrivate = typeof args.isPrivate === 'boolean' ? args.isPrivate : true;
  const existing = await prisma.burningIssue.findFirst({ where: { tenantId, opportunityId: opp.id, personId: person.id, category } });
  if (existing) {
    const proposed = await proposeMachineFieldChanges(ctx, {
      accountId: opp.accountId, opportunityId: opp.id, entityKind: 'bi', entityId: existing.id,
      current: existing as unknown as Record<string, unknown>, patch: { description, confidence, isPrivate },
      evidence: `WorkBuddy 同步「${person.name}」的 BI（${category}）`,
    });
    return { id: existing.id, opportunityId: opp.id, personId: person.id, proposed, origin: 'workbuddy', note: `${proposed} 个 BI 字段变更转入收件箱待人审。` };
  }
  const id = 'bi_' + randomUUID().replaceAll('-', '');
  await applyMcpAction(ctx, { type: 'ADD_BI', accId: opp.accountId, oppId: opp.id, bi: { id, personId: person.id, description, category, isPrivate, confidence } }, policyInput);
  return { id, opportunityId: opp.id, personId: person.id, created: true, origin: 'workbuddy', note: `已记「${person.name}」的 BI（${category}）。` };
}

/** set_ucv：记针对某 BI 的 UCV（按 商机+targetBi 幂等）。 */
async function setUcv(ctx: CommandContext, args: Record<string, unknown>, policyInput: unknown) {
  const { tenantId } = ctx;
  const opp = await resolveOppFromArgs(tenantId, args);
  let targetBiId = str(args.targetBiId, 40).trim();
  if (targetBiId) {
    const bi = await prisma.burningIssue.findFirst({ where: { id: targetBiId, tenantId, opportunityId: opp.id } });
    if (!bi) throw new Error('targetBiId 对应的 BI 不在该商机下');
  } else {
    const person = await findPersonInAccount(tenantId, opp.accountId, str(args.personId, 40).trim(), str(args.personName, 40).trim());
    if (!person) throw new Error('未提供 targetBiId，且未找到干系人来定位 BI');
    const category = str(args.category, 40);
    const bi = await prisma.burningIssue.findFirst({ where: { tenantId, opportunityId: opp.id, personId: person.id, ...(category ? { category } : {}) } });
    if (!bi) throw new Error(`未找到「${person.name}」的 BI，请先 set_burning_issue`);
    targetBiId = bi.id;
  }
  const description = str(args.description, 500).trim();
  if (!description) throw new Error('缺少 description');
  const competitorCannot = str(args.competitorCannot, 500);
  const status = ['建议', '获认可', '已解决'].includes(str(args.status)) ? str(args.status) : '建议';
  const existing = await prisma.uCV.findFirst({ where: { tenantId, opportunityId: opp.id, targetBiId } });
  if (existing) {
    const proposed = await proposeMachineFieldChanges(ctx, {
      accountId: opp.accountId, opportunityId: opp.id, entityKind: 'ucv', entityId: existing.id,
      current: existing as unknown as Record<string, unknown>, patch: { description, competitorCannot, status },
      evidence: 'WorkBuddy 同步现有 UCV 字段',
    });
    return { id: existing.id, opportunityId: opp.id, targetBiId, proposed, origin: 'workbuddy', note: `${proposed} 个 UCV 字段变更转入收件箱待人审。` };
  }
  const id = 'ucv_' + randomUUID().replaceAll('-', '');
  await applyMcpAction(ctx, { type: 'ADD_UCV', accId: opp.accountId, oppId: opp.id, ucv: { id, targetBiId, description, competitorCannot, status } }, policyInput);
  return { id, opportunityId: opp.id, targetBiId, created: true, origin: 'workbuddy', note: '已记 UCV。' };
}

// ───────────────────────── 工具分发 ─────────────────────────

async function callTool(ctx: CommandContext, name: string, args: Record<string, unknown>, policyInput: unknown) {
  const { tenantId, actorId: userId } = ctx;
  switch (name) {
    case 'sync_intel_bundle':
      return syncIntelBundle(ctx, args);
    case 'list_accounts':
      return listAccounts(ctx);
    case 'get_account_detail': {
      const accountId = typeof args.accountId === 'string' ? args.accountId : '';
      if (!accountId) throw new Error('缺少参数 accountId');
      return getAccountDetail(ctx, accountId);
    }
    case 'get_win_tendency': {
      const opportunityId = typeof args.opportunityId === 'string' ? args.opportunityId : '';
      if (!opportunityId) throw new Error('缺少参数 opportunityId');
      return getWinTendency(ctx, opportunityId);
    }
    case 'propose_person':
      return proposePerson(tenantId, userId, args);
    case 'propose_relationship':
      return proposeRelationship(tenantId, userId, args);
    case 'list_pending':
      return listPending(ctx, typeof args.accountId === 'string' ? args.accountId : '');
    case 'upsert_account':
      return syncLegacyAccount(ctx, args);
    case 'upsert_opportunity':
      return syncLegacyOpportunity(ctx, args);
    case 'append_visit_note':
      return syncLegacyVisit(ctx, args);
    case 'set_opportunity_roles':
      return setOpportunityRoles(ctx, args, policyInput);
    case 'set_burning_issue':
      return setBurningIssue(ctx, args, policyInput);
    case 'set_ucv':
      return setUcv(ctx, args, policyInput);
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
export async function handleMcpMessage(ctx: CommandContext, msg: JsonRpcRequest, policyInput: unknown): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;
  const method = msg.method;

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
          instructions: '江湖 MCP：WorkBuddy 业务同步优先使用 sync_intel_bundle，并在重试时复用同一 idempotencyKey；客户/商机/拜访事实原子写入，人物/关系/Evidence 只进候选层。读工具和候选人审继续按工作区隔离。',
        });

      case 'ping':
        return ok(id, {});

      case 'tools/list':
        return ok(id, {
          tools: TOOL_DEFS.filter((tool) => tool.requiredScopes.every((scope) => contextScopes(ctx).includes(scope))),
        });

      case 'tools/call': {
        const params = ToolCallParamsSchema.safeParse(msg.params);
        if (!params.success) return err(id, -32602, '无效的 tool params');
        const { name, arguments: args = {} } = params.data;
        try {
          if (!capabilityPolicyAllows(policyInput, { entitlement: 'sales.workspace' })) {
            return ok(id, toolError('能力未启用'));
          }
          if (canCallTool(ctx, name, args) === false) {
            return ok(id, toolError('权限不足：该令牌无权调用此工具'));
          }
          const result = await callTool(ctx, name, args, policyInput);
          return ok(id, toolText(result));
        } catch (e: unknown) {
          // 工具级错误用 isError content 返回（MCP 约定：工具失败不是协议错误）
          return ok(id, toolError(e instanceof Error ? e.message : '工具执行失败'));
        }
      }

      default:
        return err(id, -32601, `不支持的方法：${method}`);
    }
  } catch (e: unknown) {
    return err(id, -32603, e instanceof Error ? e.message : '内部错误');
  }
}

function requestIdOf(input: unknown): string | number | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const rawId = Object.entries(input).find(([key]) => key === 'id')?.[1];
  const parsed = JsonRpcIdSchema.safeParse(rawId);
  return parsed.success ? parsed.data : null;
}

async function handleUnknownMcpMessage(ctx: CommandContext, input: unknown, policyInput: unknown): Promise<JsonRpcResponse | null> {
  const parsed = JsonRpcRequestSchema.safeParse(input);
  if (!parsed.success) return err(requestIdOf(input), -32600, '无效的 JSON-RPC 请求');
  return handleMcpMessage(ctx, parsed.data, policyInput);
}

/**
 * 处理一个请求体（可能是单条消息，也可能是 JSON-RPC 批量数组）。
 * 返回值：要发回客户端的 JSON（单对象 / 数组 / null）。null 表示纯通知、无响应体（HTTP 204）。
 */
export async function handleMcpBody(ctx: CommandContext, body: unknown, policyInput: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(body)) {
    if (body.length === 0) return err(null, -32600, '无效的 JSON-RPC 请求');
    const responses: JsonRpcResponse[] = [];
    for (const m of body) {
      const r = await handleUnknownMcpMessage(ctx, m, policyInput);
      if (r) responses.push(r);
    }
    return responses.length ? responses : null;
  }
  return handleUnknownMcpMessage(ctx, body, policyInput);
}
