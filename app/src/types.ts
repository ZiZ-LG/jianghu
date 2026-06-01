// 江湖 · 领域类型（对应 docs/产品设计方案.md §3 与 G64111-评分规格.md）

/** 角色：A批准人 / D拍板人 / U使用者 / TB技术选型 / R影响者·教练（竞争对手不是角色） */
export type Role = 'A' | 'D' | 'U' | 'TB' | 'R';

/** 支持度符号：☆排他支持 / +明确支持 / =中立 / ?未知(不计分) / −负面 / x倒向对手 */
export type Sentiment = 'star' | 'plus' | 'neutral' | 'unknown' | 'minus' | 'x';

/** 信息可信度·四程度（P1 只计「明确」及以上） */
export type Confidence = '共识' | '明确' | '推理' | '不清';

/** 关系分层：L1组织架构 / L2决策权力 / L3情感阵营 / L4战略本质 */
export type Layer = 'L1' | 'L2' | 'L3' | 'L4';

/** 三类客户 */
export type CustomerType = 1 | 2 | 3;

/** 商机管线阶段（与 C4 介入阶段是两回事） */
export type PipelineStage =
  | '线索' | '需求引导' | '方案认可' | '客户立项' | '招投标' | '合同谈判' | '合同双签';

/** C4 介入阶段（越早越主动，对应分值见评分规格） */
export type EngageStage = '需求调研立项' | '方案可研' | '预算批复' | '招标论证' | '招采执行';

/** 客户变化模式（分析标签，不计分） */
export type ChangeMode = 'G' | 'T' | 'EK' | 'OC';

/** 招采关键人三类（用于 P2） */
export type ProcurementType = 'purchasing' | 'agency' | 'ownerRep';
/** 招采公关状态（用于 P2） */
export type ProcurementStatus = 'collude' | 'verbal' | 'none';

/** C3 立项材料 7 项 */
export const C3_ITEMS = ['立项原因', '项目名称', '项目预算', '实施计划', '资金来源', '项目排序', '采购方式'] as const;
/** C5 招采事项 5 项 */
export const C5_ITEMS = ['竞标方家数', '招标参数', '评标规则', '甲方代表', '招标代理'] as const;
/** FORM 家庭 7 问 */
export const FAMILY_7Q = ['籍贯', '年纪', '生日', '毕业院校', '配偶', '子女', '父母'] as const;

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
  coachLevel?: number; // 仅 R：教练五级 1-5
  logs: InteractionLog[];
  isCompetitor?: boolean; // 友商（不是角色，样式预设=深色，不可改色）
  color?: string; // 节点高亮色（手动样式，仅非友商可改；空=默认）
  // 画布种子坐标
  x: number;
  y: number;
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
  layer: Layer;
  label: string;
  color?: string;
  style?: 'solid' | 'dashed';
  width?: number;
  directed?: boolean;
  origin?: 'manual' | 'qcc' | 'ai';
  shape?: EdgeShape; // 缺省按 layer 推断：L1=orthogonal，其余=straight
  bend?: number;     // 曲线弯曲度：控制点相对中点的垂直偏移(px，带符号)
}

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
  c3Items: Record<string, boolean>; // C3 七项是否已掌握
  c5Items: Record<string, boolean>; // C5 五项是否已掌握
  roles: OppRole[];
  bis: BurningIssue[];
  ucvs: UCV[];
  edges: Edge[]; // 增量边 L2/L3/L4
}

/** 客户（存量根） */
export interface Account {
  id: string;
  name: string;
  customerType: CustomerType;
  unifiedCreditCode?: string;
  persons: Person[];
  baseEdges: Edge[]; // 存量边 L1 + 基础 L3
  opportunities: Opportunity[];
}

// 角色显示色（设计方案 §4.1，5 色含 TB）
export const ROLE_COLOR: Record<Role, string> = {
  A: '#9333ea', // 紫 批准人
  D: '#dc2626', // 红 拍板人
  U: '#2563eb', // 蓝 使用者
  TB: '#0891b2', // 青 技术选型
  R: '#16a34a', // 绿 影响者/教练
};
export const ROLE_LABEL: Record<Role, string> = {
  A: '批准人', D: '拍板人', U: '使用者', TB: '技术选型', R: '影响者/教练',
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
  1: '五大六小央企能源集团', 2: '央国企电力建设集团', 3: '地方/民营能源投资建设企业',
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
