// 江湖 · 领域类型（对应 docs/产品设计方案.md §3 与 G64111-评分规格.md）
import type { CommitmentV2, JsonValue, MatterV2 } from '@jianghu/domain-contracts';
export type {
  CapabilityPolicy,
  CommitmentV2,
  CrmCommand,
  CrmCommandInput,
  CustomerV2,
  EntitlementKey,
  MatterV2,
  PermissionKey,
} from '@jianghu/domain-contracts';
import { C3_ITEMS, C5_ITEMS, FAMILY_7Q, canonicalC5Items } from '@jianghu/g64111';
import type {
  Confidence,
  EngageStage,
  ProcurementStatus,
  ProcurementType,
  Role,
  Sentiment,
} from '@jianghu/g64111';

export { C3_ITEMS, C5_ITEMS, FAMILY_7Q, pickKeyInfluencerKeeper, readC5Item } from '@jianghu/g64111';
export type { Confidence, EngageStage, ProcurementStatus, ProcurementType, Role, Sentiment };

export type C5ItemKey = (typeof C5_ITEMS)[number];
export function c5WriteItems(items: Record<string, unknown>): Partial<Record<C5ItemKey, boolean>> {
  return canonicalC5Items(items);
}

/** 角色：A批准人 / D拍板人 / U使用者 / R影响者·技术把关 / C教练（竞争对手不是角色） */

/** 关系分层：L1组织架构 / L2决策权力 / L3情感阵营 / L4战略本质 */
export type Layer = 'L1' | 'L2' | 'L3' | 'L4';

/** 四类客户（数字能源 v1.1） */
export type CustomerType = 1 | 2 | 3 | 4;

/** 商机管线阶段（与 C4 介入阶段是两回事） */
export type PipelineStage =
  | '线索' | '需求引导' | '方案认可' | '客户立项' | '招投标' | '合同谈判' | '合同双签';

/** 客户变化模式（分析标签，不计分） */
export type ChangeMode = 'G' | 'T' | 'EK' | 'OC';

export interface Form {
  family: string;
  occupation: string;
  recreation: string;
  moneyMotivation: string;
  /** 家庭 7 问，键为 FAMILY_7Q 之一 */
  family7: Partial<Record<(typeof FAMILY_7Q)[number], string>>;
}

export interface InteractionLog {
  date: string;
  content: string;
  /** 敏感动作：记录但用中性指代 */
  sensitive?: boolean;
  visibility?: 'self' | 'team' | 'org';
}

/** 干系人（存量节点） */
export interface Person {
  id: string;
  name: string;
  title: string;
  orgLevel: number;
  form: Form;
  coachLevel?: number; // 仅 C：教练五级 1-5
  logs: InteractionLog[];
  isCompetitor?: boolean; // 友商（不是角色，样式预设=深色，不可改色）
  color?: string; // 节点高亮色（手动样式，仅非友商可改；空=默认）
  // 画布种子坐标
  x: number;
  y: number;
  version?: number; // 乐观锁版本（后端 GET /state 带出；UPDATE_PERSON 时回传作 baseVersion）
}

/** 燃眉之急 BI */
export interface BurningIssue {
  id: string;
  personId: string;
  description: string;
  category: string;
  isPrivate: boolean;
  confidence: Confidence;
}

/** 独特价值 UCV（针对某个 BI） */
export interface UCV {
  id: string;
  targetBiId: string;
  description: string;
  competitorCannot: string;
  status: '建议' | '获认可' | '已解决';
}

/** 增量角色覆盖（人 × 项目） */
export interface OppRole {
  personId: string;
  role: Role;
  sentiment: Sentiment;
  sentimentValue?: number; // -5..5 细分
  confidence: Confidence;
  isKeyInfluencer?: boolean; // P4 当前锁定
  procurementType?: ProcurementType; // 若是招采关键人
  procurementStatus?: ProcurementStatus;
}

/** 连线外观形状（与 style 实/虚线正交）：直线 / 折线(正交) / 曲线 */
export type EdgeShape = 'straight' | 'orthogonal' | 'curved';

export interface Edge {
  id: string;
  source: string;
  target: string;
  kind?: string; // 通用开放关系类型；未知值原样保留，销售视图仍由 layer 映射
  layer: Layer;
  label: string;
  color?: string;
  style?: 'solid' | 'dashed';
  width?: number;
  directed?: boolean;
  origin?: 'manual' | 'qcc' | 'ai' | 'voice' | 'recording' | 'mcp' | 'workbuddy';
  shape?: EdgeShape; // 缺省按 layer 推断：L1=orthogonal，其余=straight
  bend?: number;     // 曲线弯曲度：控制点相对中点的垂直偏移(px，带符号)
  version?: number;  // 乐观锁版本（后端带出；UPDATE_EDGE 时回传作 baseVersion）
}

/** 商机生命周期状态 */
export type OpportunityStatus = 'active' | 'paused' | 'won' | 'lost';
/** 竞争态势（'' = 未填） */
export type CompetitiveSituation = '' | '领先' | '胶着' | '落后' | '未识别';

/** 项目/商机（增量根） */
export interface Opportunity {
  id: string;
  accountId: string;
  name: string;
  customerType: CustomerType;
  pipelineStage: PipelineStage;
  engageStage: EngageStage; // C4
  changeMode?: ChangeMode;
  singleSalesGoal: string;
  customerBusinessGoal?: string;
  buyingMotivation?: string;
  primaryDPersonId?: string | null;            // 主拍板人 D；null/缺省为存量兼容待确认
  // ── WorkBuddy 集成扩展（销售包推送的商机业务字段）──
  externalRef?: string;                       // 销售包商机锚（幂等）
  status?: OpportunityStatus;                  // 生命周期状态
  productSolution?: string;                    // 我方产品/方案
  competitor?: string;                         // 主要友商
  competitiveSituation?: CompetitiveSituation; // 竞争态势
  winProbability?: number;                     // 赢单概率(销售在江湖自填，WB 不推/不覆盖)
  expectedSignDate?: string;                   // 预计签约 YYYY-MM-DD
  expectedAmountW?: number;                    // 预计金额(万元)
  meta?: Record<string, JsonValue>;            // JSON 兜底(BANT 辅助等)
  c3Items: Record<string, boolean>; // C3 七项是否已掌握
  c5Items: Partial<Record<C5ItemKey, boolean>>; // C5 权威五项是否已掌握
  roles: OppRole[];
  bis: BurningIssue[];
  ucvs: UCV[];
  edges: Edge[]; // 增量边 L2/L3/L4
  memberScoped?: boolean;  // true=只显示 memberIds 的人(含竞品)；false/缺省=全员可见(存量兼容)
  memberIds?: string[];    // 该商机可见的干系人 id 集(缺省视为空；仅 memberScoped 时生效)
  participantIds?: string[]; // 通用 Matter 参与人；与销售角色、legacy visibility 相互独立
  evidenceEvents?: EvidenceEvent[]; // 策略引擎证据事件(E2，喂局势分布)
  version?: number;        // 乐观锁版本（后端带出；UPDATE_OPP 时回传作 baseVersion）
}

/** GET /api/state 在 CORE-103 expand 阶段返回的同行 Matter 投影。 */
export interface OpportunityMatterState {
  kind: string;
  lifecycleStatus: MatterV2['lifecycleStatus'];
  outcomeKey: string | null;
  priority: string | null;
  targetDate: string | null;
  primaryOwnerUserId: string | null;
  activeMethodologyBindingId: string | null;
}

export type OpportunityState = Opportunity & OpportunityMatterState;

/** 策略引擎 · 证据事件（E2）：每条证据喂局势分布 */
export interface EvidenceEvent {
  id: string;
  accountId: string;
  opportunityId: string;
  personId: string;
  signalKey: string;
  direction: -1 | 0 | 1;   // +1 利好 / -1 不利 / 0 方向不明
  tier: 'weak' | 'mid' | 'strong';
  rawContent?: string;
  occurredAt?: string;
  status?: 'pending_review' | 'approved' | 'rejected'; // M3 审核流：缺省=approved（人工直落）；机器抽取 pending_review 待人审
  origin?: 'manual' | 'ai' | 'voice' | 'recording' | 'mcp' | 'worker' | 'system'; // 溯源
  createdAt?: string;
}

/** 外部 MCP 写入溯源标记（存于 Account.profile / Opportunity.meta 的 `_mcpOrigin` 键）。
 *  at = 最近一次 MCP upsert 落库时间 —— 契约 v1.0 §三-② 时点戳/新鲜度点的数据源。 */
export interface McpOriginMark {
  source: string;        // 'mcp'
  at: string;            // ISO 时间戳（每次 upsert 刷新）
  needsReview?: boolean; // 外部来源·待核（人工编辑档案后清除）
}

/**
 * 客户档案（profile，JSON 落库）：销售包（WorkBuddy）经 MCP 推送的企业背景，分维度。
 * 各字段皆可选，缺省即未采集；属业务实体（非个人身份判定），可直接 upsert（非候选）。
 */
export interface AccountProfile {
  business?: string;       // 工商基础：注册资本/成立日期/法定代表人/经营范围
  group?: string;          // 集团关系：母子公司/控股结构
  bidding?: string;        // 招投标：历史/在招项目摘要
  risk?: string;           // 风险信号：诉讼/失信/经营异常
  ourCooperation?: string; // 我方现有合作：已签/在执行/历史交付
  salesNote?: string;      // 销售自填背景
  aiSuggestion?: string;   // AI 建议（参考，不计分）
  _mcpOrigin?: McpOriginMark; // 外部 MCP 写入溯源（时点戳/新鲜度数据源）
}

/** 拜访记录参与人 */
export interface VisitParticipant {
  name: string;
  side: 'our' | 'customer'; // 我方 / 客户方
}

/** 拜访记录（销售包核心产出；WorkBuddy 经 MCP 同步，挂客户下，可关联商机） */
export interface VisitNote {
  id: string;
  accountId: string;
  opportunityId?: string;     // 可选：关联商机
  externalRef?: string;       // 销售包拜访锚（幂等）
  date: string;               // YYYY-MM-DD
  topic: string;
  summary: string;            // WorkBuddy 提炼正文
  participants: VisitParticipant[];
  origin?: string;            // workbuddy | manual | mcp（外部 MCP 直写·待核，P12）
  createdBy?: string;         // 提交者 userId
  createdAt?: string;         // ISO
}

/** 自由文本层 · 通用笔记（零散/长尾，三挂载对象皆可空；挂 person/opp 时冗余 accountId） */
export interface Note {
  id: string;
  accountId?: string;         // 主挂载(冗余)；未归类则空
  opportunityId?: string;
  personId?: string;
  content: string;            // 自由文本(原始零散信息)
  source?: string;            // manual/voice/ai/import
  tags?: string[];
  createdBy?: string;
  createdAt?: string;
}

/** 时段（周视图定位用） */
export type Half = 'am' | 'pm' | 'eve';

/** 商机策划 · 行动计划（🎯，带完成态） */
export interface PlanAction {
  id: string;
  accountId: string;
  opportunityId: string;
  gapItem?: string;        // 关联 G64111 低分项 C1..C6|P1..P4|1K（空=非补分动作）
  personId?: string;       // 目标干系人
  title: string;
  scene?: string;
  scripts?: string;        // 话术（741 行动宝典可预填）
  target?: string;
  ownerId?: string;
  startDate: string;       // YYYY-MM-DD（日历主锚·起）
  endDate: string;         // YYYY-MM-DD（止；单日 == startDate）
  half: Half;
  done: boolean;
  doneAt?: string;
  draft?: boolean;         // 第4刀：坞内草稿（true=只在坞列④不挂画布；false/缺省=已上桌）。语义反转图纸 staged，存量零迁移
  review?: string;
  resources?: string;      // 所需资源（牌·六要素）
  cautions?: string;       // 注意要点（牌·六要素）
  props?: string;          // 道具：方案/POC/报告/会议大纲…（P3 WorkBuddy 产）
  origin?: string;         // manual | ai | workbuddy
  createdBy?: string;
  createdAt?: string;

  // CORE-106 expand-phase shadow fields. They remain optional in the legacy
  // PlanAction UI until CORE-107 switches state/commands to Commitment V2.
  kind?: CommitmentV2['kind'];
  ownerUserId?: CommitmentV2['ownerUserId'];
  executionStatus?: CommitmentV2['executionStatus'];
  confirmationStatus?: CommitmentV2['confirmationStatus'];
  scheduledAtUtc?: CommitmentV2['scheduledAtUtc'];
  dueAtUtc?: CommitmentV2['dueAtUtc'];
  timeZone?: CommitmentV2['timeZone'];
  isAllDay?: CommitmentV2['isAllDay'];
  localDate?: CommitmentV2['localDate'];
  confirmationDueAtUtc?: CommitmentV2['confirmationDueAtUtc'];
  confirmedAtUtc?: CommitmentV2['confirmedAtUtc'];
  confirmedByUserId?: CommitmentV2['confirmedByUserId'];
  scheduleVersion?: CommitmentV2['scheduleVersion'];
  nextCommitmentId?: CommitmentV2['nextCommitmentId'];
  source?: CommitmentV2['source'];
  sourceRef?: CommitmentV2['sourceRef'];
  archivedAt?: CommitmentV2['archivedAt'];
  version?: CommitmentV2['version'];
}

/** 商机策划 · 里程碑（🚩，可多个/自由增删） */
export interface OppMilestone {
  id: string;
  accountId: string;
  opportunityId: string;
  title: string;
  startDate: string;
  endDate: string;
  half: Half;
  createdAt?: string;
}

/** 商机策划 · 阶段段（年视图模型 B，可同名重复/降级回退） */
export interface OppStage {
  id: string;
  accountId: string;
  opportunityId: string;
  stageKey: string;        // 需求引导|方案认可|客户立项|招投标|合同谈判|合同双签
  startDate: string;
  endDate: string;
  createdAt?: string;
}

// ───────── 策略沙盘（推演段）─────────

/** 策略沙盘 · 策略卡（打法卡）。挂靠 G64111 低分项；origin=ai 时 status=pending 为待采纳候选 */
export interface StrategyCard {
  id: string;
  accountId: string;
  opportunityId: string;
  gapItem?: string;        // 挂靠 G64111 低分项 C1..C6|P1..P4|1K（空=非补分打法）
  title: string;
  basis?: string;          // 依据
  alternatives?: string;   // 备选打法
  personId?: string;       // 目标干系人（仅引用已存在 Person）
  status?: 'active' | 'pending' | 'dismissed';
  origin?: 'manual' | 'ai';
  orderIndex?: number;
  dispatchedActionIds?: string[]; // 已派发的 PlanAction id（防重复派发）
  createdAt?: string;
}

/** 策略沙盘 · 风险/假设（kind 区分二者） */
export interface StrategyRisk {
  id: string;
  accountId: string;
  opportunityId: string;
  kind: 'risk' | 'assumption';
  text: string;
  severity?: 'low' | 'mid' | 'high';
  mitigation?: string;
  status?: 'open' | 'resolved' | 'dismissed';
  origin?: 'manual' | 'ai';
  createdAt?: string;
}

/** 策略沙盘 · 轻量弹药清单（不建全局资源库） */
export interface StrategyResource {
  id: string;
  accountId: string;
  opportunityId: string;
  label: string;
  kind?: string;           // 自由文本 product/relation/case/commercial…
  note?: string;
  createdAt?: string;
}

/** 客户（存量根） */
export interface Account {
  id: string;
  name: string;
  customerType: CustomerType;
  unifiedCreditCode?: string;
  externalRef?: string;     // 销售包 customer_id，跨系统幂等主锚（WorkBuddy 集成）
  region?: string;          // 大区
  group?: string;           // 集团/母公司
  primaryOwner?: string;    // 主负责人
  primaryOwnerUserId?: string | null; // 授权唯一使用的稳定 User.id
  profile?: AccountProfile; // 企业背景档案（销售包推送）
  persons: Person[];
  baseEdges: Edge[]; // 存量边 L1 + 基础 L3
  opportunities: Opportunity[];
  visitNotes?: VisitNote[]; // 拜访记录（WorkBuddy 同步）
  notes?: Note[]; // 自由文本层：挂在该客户(及其商机/人)的笔记
  planActions?: PlanAction[]; // 商机策划 · 行动计划
  milestones?: OppMilestone[]; // 商机策划 · 里程碑
  oppStages?: OppStage[]; // 商机策划 · 阶段段（年视图）
  strategyCards?: StrategyCard[]; // 策略沙盘 · 策略卡
  strategyRisks?: StrategyRisk[]; // 策略沙盘 · 风险/假设
  strategyResources?: StrategyResource[]; // 策略沙盘 · 轻量弹药
}

/** 云端整树的客户投影；保留 legacy Account/Opportunity 字段供兼容 UI 使用。 */
export type AccountState = Omit<Account, 'opportunities'> & { opportunities: OpportunityState[] };

// 角色显示色（设计方案 §4.1，5 色 A/D/U/R/C）
export const ROLE_COLOR: Record<Role, string> = {
  A: '#9333ea', // 紫 批准人
  D: '#dc2626', // 红 拍板人
  U: '#2563eb', // 蓝 使用者
  R: '#0891b2', // 青 影响者·技术把关
  C: '#16a34a', // 绿 教练
};
export const ROLE_LABEL: Record<Role, string> = {
  A: '批准人', D: '拍板人', U: '使用者', R: '影响者·技术把关', C: '教练',
};

// 支持度显示
export const SENTIMENT_CHAR: Record<Sentiment, string> = {
  star: '★', plus: '+', neutral: '=', unknown: '?', minus: '−', x: '✕',
};
export const SENTIMENT_COLOR: Record<Sentiment, string> = {
  star: '#f59e0b', plus: '#16a34a', neutral: '#9ca3af', unknown: '#9ca3af', minus: '#f97316', x: '#b91c1c',
};
export const SENTIMENT_LABEL: Record<Sentiment, string> = {
  star: '排他性支持', plus: '明确支持', neutral: '中立', unknown: '未知', minus: '负面/抗拒', x: '倒向对手',
};

export const LAYER_LABEL: Record<Layer, string> = {
  L1: 'L1 组织架构', L2: 'L2 决策权力', L3: 'L3 情感阵营', L4: 'L4 战略本质',
};

// 表单用常量
export const CUSTOMER_TYPE_LABEL: Record<CustomerType, string> = {
  1: '央企发电集团（五大六小）', 2: '地方能源国企', 3: '分布式头部民企', 4: 'EPC总承包商',
};
export const PIPELINE_STAGES: PipelineStage[] = ['线索', '需求引导', '方案认可', '客户立项', '招投标', '合同谈判', '合同双签'];
export const ENGAGE_STAGES: EngageStage[] = ['需求调研立项', '方案可研', '预算批复', '招标论证', '招采执行'];
export const CHANGE_MODES: { v: ChangeMode; label: string }[] = [
  { v: 'G', label: 'G 增长型 · 如虎添翼' }, { v: 'T', label: 'T 困境型 · 亡羊补牢' },
  { v: 'EK', label: 'EK 平稳型 · 我行我素' }, { v: 'OC', label: 'OC 自负型 · 班门弄斧' },
];
export const CONFIDENCES: Confidence[] = ['共识', '明确', '推理', '不清'];
export const BI_CATEGORIES = ['考核压力', '降本KPI', '按期投产', '审计整改', '个人晋升', '安全责任', '投资风险', '融资上市', '其他'];
export const PROCUREMENT_TYPE_LABEL: Record<string, string> = {
  purchasing: '采购/招标管理负责人', agency: '招标代理/集采平台', ownerRep: '甲方项目代表',
};
export const PROCUREMENT_STATUS_LABEL: Record<string, string> = {
  collude: '已预对齐(密谋)', verbal: '口头承诺', none: '未有效接触',
};
export const LAYER_HINT: Record<Layer, string> = {
  L1: '汇报/组织关系', L2: '本项目权力流(谁卡谁/否决/影响)', L3: '私交好恶(校友/亲戚/宿怨/盟友)', L4: '战略与竞争(利益输送/信任背书)',
};
