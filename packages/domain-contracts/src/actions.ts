import { z } from 'zod';

const id = z.string().min(1);
const finiteNumber = z.number().finite();
const customerType = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const role = z.enum(['A', 'D', 'U', 'R', 'C']);
const sentiment = z.enum(['star', 'plus', 'neutral', 'unknown', 'minus', 'x']);
const confidence = z.enum(['共识', '明确', '推理', '不清']);
const layer = z.enum(['L1', 'L2', 'L3', 'L4']);
const pipelineStage = z.enum(['线索', '需求引导', '方案认可', '客户立项', '招投标', '合同谈判', '合同双签']);
const engageStage = z.enum(['需求调研立项', '方案可研', '预算批复', '招标论证', '招采执行']);
const changeMode = z.enum(['G', 'T', 'EK', 'OC']);
const opportunityStatus = z.enum(['active', 'paused', 'won', 'lost']);
const competitiveSituation = z.enum(['', '领先', '胶着', '落后', '未识别']);
const half = z.enum(['am', 'pm', 'eve']);

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), finiteNumber, z.boolean(), z.null(), z.array(jsonValue), z.record(jsonValue),
]));
const jsonRecord = z.record(z.string(), jsonValue);
const booleanRecord = z.record(z.string(), z.boolean());

export const C5_ITEM_KEYS = [
  '竞标方名单/家数', '招标参数', '评标规则', '甲方项目代表', '招标代理机构',
] as const;
export const C5ItemsWriteSchema = z.object({
  '竞标方名单/家数': z.boolean().optional(),
  '招标参数': z.boolean().optional(),
  '评标规则': z.boolean().optional(),
  '甲方项目代表': z.boolean().optional(),
  '招标代理机构': z.boolean().optional(),
}).strict();

export const ACCOUNT_PROFILE_FIELDS = [
  'business', 'group', 'bidding', 'risk', 'ourCooperation', 'salesNote', 'aiSuggestion',
] as const;

const accountProfile = z.object({
  business: z.string().optional(),
  group: z.string().optional(),
  bidding: z.string().optional(),
  risk: z.string().optional(),
  ourCooperation: z.string().optional(),
  salesNote: z.string().optional(),
  aiSuggestion: z.string().optional(),
}).strict();

const accountInput = z.object({
  id,
  name: z.string(),
  customerType,
  unifiedCreditCode: z.string().optional(),
  externalRef: z.string().optional(),
  region: z.string().optional(),
  group: z.string().optional(),
  primaryOwner: z.string().optional(),
  primaryOwnerUserId: id.nullable().optional(),
  profile: accountProfile.optional(),
}).strict();

const accountPatch = z.object({
  name: z.string().optional(),
  customerType: customerType.optional(),
  unifiedCreditCode: z.string().optional(),
  externalRef: z.string().optional(),
  region: z.string().optional(),
  group: z.string().optional(),
  primaryOwner: z.string().optional(),
  primaryOwnerUserId: id.nullable().optional(),
  profile: accountProfile.optional(),
}).strict();

const opportunityInput = z.object({
  id,
  name: z.string(),
  customerType,
  pipelineStage,
  engageStage,
  changeMode: changeMode.optional(),
  singleSalesGoal: z.string().optional(),
  customerBusinessGoal: z.string().optional(),
  buyingMotivation: z.string().optional(),
  primaryDPersonId: id.nullable().optional(),
  c3Items: booleanRecord.optional(),
  c5Items: C5ItemsWriteSchema.optional(),
  externalRef: z.string().optional(),
  status: opportunityStatus.optional(),
  productSolution: z.string().optional(),
  competitor: z.string().optional(),
  competitiveSituation: competitiveSituation.optional(),
  winProbability: finiteNumber.optional(),
  expectedSignDate: z.string().optional(),
  expectedAmountW: finiteNumber.optional(),
  meta: jsonRecord.optional(),
  memberScoped: z.boolean().optional(),
}).strict();

const opportunityPatch = z.object({
  name: z.string().optional(),
  pipelineStage: pipelineStage.optional(),
  engageStage: engageStage.optional(),
  changeMode: changeMode.optional(),
  singleSalesGoal: z.string().optional(),
  customerBusinessGoal: z.string().optional(),
  buyingMotivation: z.string().optional(),
  primaryDPersonId: id.nullable().optional(),
  c3Items: booleanRecord.optional(),
  c5Items: C5ItemsWriteSchema.optional(),
  externalRef: z.string().optional(),
  status: opportunityStatus.optional(),
  productSolution: z.string().optional(),
  competitor: z.string().optional(),
  competitiveSituation: competitiveSituation.optional(),
  winProbability: finiteNumber.optional(),
  expectedSignDate: z.string().optional(),
  expectedAmountW: finiteNumber.optional(),
  meta: jsonRecord.optional(),
}).strict();

const family7 = z.object({
  '籍贯': z.string().optional(),
  '年纪': z.string().optional(),
  '生日': z.string().optional(),
  '毕业院校': z.string().optional(),
  '配偶': z.string().optional(),
  '子女': z.string().optional(),
  '父母': z.string().optional(),
}).strict();

const form = z.object({
  family: z.string(),
  occupation: z.string(),
  recreation: z.string(),
  moneyMotivation: z.string(),
  family7,
}).strict();

const interactionLog = z.object({
  date: z.string(),
  content: z.string(),
  sensitive: z.boolean().optional(),
  visibility: z.enum(['self', 'team', 'org']).optional(),
}).strict();

const personInput = z.object({
  id,
  name: z.string(),
  title: z.string(),
  orgLevel: z.number().int().optional(),
  isCompetitor: z.boolean().optional(),
  avatarUrl: z.string().optional(),
  coachLevel: z.number().int().optional(),
  x: finiteNumber.optional(),
  y: finiteNumber.optional(),
  form: form.optional(),
  logs: z.array(interactionLog).optional(),
}).strict();

const personPatch = z.object({
  name: z.string().optional(),
  title: z.string().optional(),
  orgLevel: z.number().int().optional(),
  avatarUrl: z.string().optional(),
  coachLevel: z.number().int().optional(),
  color: z.string().optional(),
  form: form.optional(),
}).strict();

const rolePatch = z.object({
  role: role.optional(),
  sentiment: sentiment.optional(),
  sentimentValue: z.number().int().min(-5).max(5).optional(),
  confidence: confidence.optional(),
  isKeyInfluencer: z.boolean().optional(),
  procurementType: z.enum(['purchasing', 'agency', 'ownerRep']).optional(),
  procurementStatus: z.enum(['collude', 'verbal', 'none']).optional(),
}).strict();

const edgeInput = z.object({
  id,
  source: id,
  target: id,
  kind: z.string().trim().min(1).optional(),
  layer,
  label: z.string(),
  color: z.string().optional(),
  style: z.enum(['solid', 'dashed']).optional(),
  width: finiteNumber.optional(),
  directed: z.boolean().optional(),
  origin: z.enum(['manual', 'qcc', 'ai', 'voice', 'recording', 'mcp', 'workbuddy']).optional(),
  shape: z.enum(['straight', 'orthogonal', 'curved']).optional(),
  bend: finiteNumber.optional(),
}).strict();

const edgePatch = z.object({
  source: id.optional(),
  target: id.optional(),
  kind: z.string().trim().min(1).optional(),
  layer: layer.optional(),
  label: z.string().optional(),
  color: z.string().optional(),
  style: z.enum(['solid', 'dashed']).optional(),
  width: finiteNumber.optional(),
  directed: z.boolean().optional(),
  shape: z.enum(['straight', 'orthogonal', 'curved']).optional(),
  bend: finiteNumber.optional(),
}).strict();

const burningIssueInput = z.object({
  id,
  personId: id,
  description: z.string(),
  category: z.string(),
  isPrivate: z.boolean(),
  confidence,
}).strict();

const burningIssuePatch = z.object({
  description: z.string().optional(),
  category: z.string().optional(),
  isPrivate: z.boolean().optional(),
  confidence: confidence.optional(),
}).strict();

const ucvInput = z.object({
  id,
  targetBiId: id,
  description: z.string(),
  competitorCannot: z.string(),
  status: z.enum(['建议', '获认可', '已解决']),
}).strict();

const ucvPatch = z.object({
  targetBiId: id.optional(),
  description: z.string().optional(),
  competitorCannot: z.string().optional(),
  status: z.enum(['建议', '获认可', '已解决']).optional(),
}).strict();

const visitParticipant = z.object({
  name: z.string(),
  side: z.enum(['our', 'customer']),
}).strict();

const visitInput = z.object({
  id,
  opportunityId: id.optional(),
  externalRef: z.string().optional(),
  date: z.string(),
  topic: z.string(),
  summary: z.string(),
  participants: z.array(visitParticipant).optional(),
  origin: z.string().optional(),
}).strict();

const visitPatch = z.object({
  opportunityId: id.optional(),
  externalRef: z.string().optional(),
  date: z.string().optional(),
  topic: z.string().optional(),
  summary: z.string().optional(),
  participants: z.array(visitParticipant).optional(),
  origin: z.string().optional(),
}).strict();

const noteInput = z.object({
  id,
  opportunityId: id.optional(),
  personId: id.optional(),
  content: z.string(),
  source: z.string().optional(),
  tags: z.array(z.string()).optional(),
}).strict();

const notePatch = z.object({
  opportunityId: id.optional(),
  personId: id.optional(),
  content: z.string().optional(),
  source: z.string().optional(),
  tags: z.array(z.string()).optional(),
}).strict();

const planActionInput = z.object({
  id,
  gapItem: z.string().optional(),
  personId: id.optional(),
  title: z.string(),
  scene: z.string().optional(),
  scripts: z.string().optional(),
  target: z.string().optional(),
  ownerId: z.string().optional(),
  startDate: z.string(),
  endDate: z.string(),
  half,
  done: z.boolean(),
  doneAt: z.string().optional(),
  draft: z.boolean().optional(),
  review: z.string().optional(),
  origin: z.string().optional(),
  resources: z.string().optional(),
  cautions: z.string().optional(),
  props: z.string().optional(),
}).strict();

const planActionPatch = z.object({
  gapItem: z.string().optional(),
  personId: id.optional(),
  title: z.string().optional(),
  scene: z.string().optional(),
  scripts: z.string().optional(),
  target: z.string().optional(),
  ownerId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  half: half.optional(),
  done: z.boolean().optional(),
  doneAt: z.string().optional(),
  draft: z.boolean().optional(),
  review: z.string().optional(),
  resources: z.string().optional(),
  cautions: z.string().optional(),
  props: z.string().optional(),
}).strict();

const milestoneInput = z.object({
  id,
  title: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  half,
}).strict();
const milestonePatch = milestoneInput.omit({ id: true }).partial().strict();

const oppStageInput = z.object({
  id,
  stageKey: z.string(),
  startDate: z.string(),
  endDate: z.string(),
}).strict();
const oppStagePatch = oppStageInput.omit({ id: true }).partial().strict();

const strategyCardInput = z.object({
  id,
  gapItem: z.string().optional(),
  title: z.string(),
  basis: z.string().optional(),
  alternatives: z.string().optional(),
  personId: id.optional(),
  status: z.enum(['active', 'pending', 'dismissed']).optional(),
  origin: z.enum(['manual', 'ai']).optional(),
  orderIndex: z.number().int().optional(),
  dispatchedActionIds: z.array(id).optional(),
}).strict();
const strategyCardPatch = strategyCardInput.omit({ id: true }).partial().strict();

const strategyRiskInput = z.object({
  id,
  kind: z.enum(['risk', 'assumption']),
  text: z.string(),
  severity: z.enum(['low', 'mid', 'high']).optional(),
  mitigation: z.string().optional(),
  status: z.enum(['open', 'resolved', 'dismissed']).optional(),
  origin: z.enum(['manual', 'ai']).optional(),
}).strict();
const strategyRiskPatch = strategyRiskInput.omit({ id: true }).partial().strict();

const strategyResourceInput = z.object({
  id,
  label: z.string(),
  kind: z.string().optional(),
  note: z.string().optional(),
}).strict();
const strategyResourcePatch = strategyResourceInput.omit({ id: true }).partial().strict();

const evidenceInput = z.object({
  id,
  personId: id,
  signalKey: z.string(),
  direction: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  tier: z.enum(['weak', 'mid', 'strong']),
  rawContent: z.string().optional(),
  occurredAt: z.string().optional(),
  status: z.enum(['pending_review', 'approved', 'rejected']).optional(),
  origin: z.enum(['manual', 'voice', 'recording', 'ai', 'mcp', 'worker', 'system']).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.origin && value.origin !== 'manual' && value.status !== 'pending_review') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: 'machine-origin evidence must remain pending review',
    });
  }
});

const command = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const ACTION_TYPES = [
  'ADD_ACCOUNT', 'UPDATE_ACCOUNT', 'DELETE_ACCOUNT',
  'ADD_OPP', 'UPDATE_OPP', 'DELETE_OPP',
  'ADD_PERSON', 'UPDATE_PERSON', 'MOVE_PERSON', 'DELETE_PERSON', 'ADD_LOG',
  'SET_ROLE', 'REMOVE_ROLE', 'ADD_OPP_MEMBER', 'REMOVE_OPP_MEMBER',
  'ADD_EDGE', 'UPDATE_EDGE', 'DELETE_EDGE',
  'ADD_BI', 'UPDATE_BI', 'DELETE_BI',
  'ADD_UCV', 'UPDATE_UCV', 'DELETE_UCV',
  'ADD_VISIT', 'UPDATE_VISIT', 'DELETE_VISIT',
  'ADD_NOTE', 'UPDATE_NOTE', 'DELETE_NOTE',
  'ADD_PLAN_ACTION', 'UPDATE_PLAN_ACTION', 'DELETE_PLAN_ACTION', 'TOGGLE_PLAN_ACTION',
  'ADD_MILESTONE', 'UPDATE_MILESTONE', 'DELETE_MILESTONE',
  'ADD_OPP_STAGE', 'UPDATE_OPP_STAGE', 'DELETE_OPP_STAGE',
  'ADD_STRATEGY_CARD', 'UPDATE_STRATEGY_CARD', 'DELETE_STRATEGY_CARD',
  'ADD_STRATEGY_RISK', 'UPDATE_STRATEGY_RISK', 'DELETE_STRATEGY_RISK',
  'ADD_STRATEGY_RESOURCE', 'UPDATE_STRATEGY_RESOURCE', 'DELETE_STRATEGY_RESOURCE',
  'ADD_EVIDENCE', 'DELETE_EVIDENCE',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

const actionSchemas = [
  command({ type: z.literal('ADD_ACCOUNT'), account: accountInput }),
  command({ type: z.literal('UPDATE_ACCOUNT'), accId: id, patch: accountPatch }),
  command({ type: z.literal('DELETE_ACCOUNT'), accId: id }),
  command({ type: z.literal('ADD_OPP'), accId: id, opp: opportunityInput }),
  command({ type: z.literal('UPDATE_OPP'), accId: id, oppId: id, patch: opportunityPatch, baseVersion: z.number().int().nonnegative().optional() }),
  command({ type: z.literal('DELETE_OPP'), accId: id, oppId: id }),
  command({ type: z.literal('ADD_PERSON'), accId: id, person: personInput }),
  command({ type: z.literal('UPDATE_PERSON'), accId: id, personId: id, patch: personPatch, baseVersion: z.number().int().nonnegative().optional() }),
  command({ type: z.literal('MOVE_PERSON'), accId: id, personId: id, x: finiteNumber, y: finiteNumber }),
  command({ type: z.literal('DELETE_PERSON'), accId: id, personId: id }),
  command({ type: z.literal('ADD_LOG'), accId: id, personId: id, log: interactionLog }),
  command({ type: z.literal('SET_ROLE'), accId: id, oppId: id, personId: id, patch: rolePatch }),
  command({ type: z.literal('REMOVE_ROLE'), accId: id, oppId: id, personId: id }),
  command({ type: z.literal('ADD_OPP_MEMBER'), accId: id, oppId: id, personId: id }),
  command({ type: z.literal('REMOVE_OPP_MEMBER'), accId: id, oppId: id, personId: id }),
  command({ type: z.literal('ADD_EDGE'), accId: id, oppId: id.optional(), edge: edgeInput }),
  command({ type: z.literal('UPDATE_EDGE'), accId: id, oppId: id, edgeId: id, patch: edgePatch, baseVersion: z.number().int().nonnegative().optional() }),
  command({ type: z.literal('DELETE_EDGE'), accId: id, oppId: id, edgeId: id }),
  command({ type: z.literal('ADD_BI'), accId: id, oppId: id, bi: burningIssueInput }),
  command({ type: z.literal('UPDATE_BI'), accId: id, oppId: id, biId: id, patch: burningIssuePatch }),
  command({ type: z.literal('DELETE_BI'), accId: id, oppId: id, biId: id }),
  command({ type: z.literal('ADD_UCV'), accId: id, oppId: id, ucv: ucvInput }),
  command({ type: z.literal('UPDATE_UCV'), accId: id, oppId: id, ucvId: id, patch: ucvPatch }),
  command({ type: z.literal('DELETE_UCV'), accId: id, oppId: id, ucvId: id }),
  command({ type: z.literal('ADD_VISIT'), accId: id, visit: visitInput }),
  command({ type: z.literal('UPDATE_VISIT'), accId: id, visitId: id, patch: visitPatch }),
  command({ type: z.literal('DELETE_VISIT'), accId: id, visitId: id }),
  command({ type: z.literal('ADD_NOTE'), accId: id, note: noteInput }),
  command({ type: z.literal('UPDATE_NOTE'), accId: id, noteId: id, patch: notePatch }),
  command({ type: z.literal('DELETE_NOTE'), accId: id, noteId: id }),
  command({ type: z.literal('ADD_PLAN_ACTION'), accId: id, oppId: id, planAction: planActionInput }),
  command({ type: z.literal('UPDATE_PLAN_ACTION'), accId: id, actionId: id, patch: planActionPatch }),
  command({ type: z.literal('DELETE_PLAN_ACTION'), accId: id, actionId: id }),
  command({ type: z.literal('TOGGLE_PLAN_ACTION'), accId: id, actionId: id, done: z.boolean(), doneAt: z.string().optional() }),
  command({ type: z.literal('ADD_MILESTONE'), accId: id, oppId: id, milestone: milestoneInput }),
  command({ type: z.literal('UPDATE_MILESTONE'), accId: id, milestoneId: id, patch: milestonePatch }),
  command({ type: z.literal('DELETE_MILESTONE'), accId: id, milestoneId: id }),
  command({ type: z.literal('ADD_OPP_STAGE'), accId: id, oppId: id, stage: oppStageInput }),
  command({ type: z.literal('UPDATE_OPP_STAGE'), accId: id, stageId: id, patch: oppStagePatch }),
  command({ type: z.literal('DELETE_OPP_STAGE'), accId: id, stageId: id }),
  command({ type: z.literal('ADD_STRATEGY_CARD'), accId: id, oppId: id, card: strategyCardInput }),
  command({ type: z.literal('UPDATE_STRATEGY_CARD'), accId: id, cardId: id, patch: strategyCardPatch }),
  command({ type: z.literal('DELETE_STRATEGY_CARD'), accId: id, cardId: id }),
  command({ type: z.literal('ADD_STRATEGY_RISK'), accId: id, oppId: id, risk: strategyRiskInput }),
  command({ type: z.literal('UPDATE_STRATEGY_RISK'), accId: id, riskId: id, patch: strategyRiskPatch }),
  command({ type: z.literal('DELETE_STRATEGY_RISK'), accId: id, riskId: id }),
  command({ type: z.literal('ADD_STRATEGY_RESOURCE'), accId: id, oppId: id, resource: strategyResourceInput }),
  command({ type: z.literal('UPDATE_STRATEGY_RESOURCE'), accId: id, resourceId: id, patch: strategyResourcePatch }),
  command({ type: z.literal('DELETE_STRATEGY_RESOURCE'), accId: id, resourceId: id }),
  command({ type: z.literal('ADD_EVIDENCE'), accId: id, oppId: id, evidence: evidenceInput }),
  command({ type: z.literal('DELETE_EVIDENCE'), accId: id, oppId: id, evidenceId: id }),
] as const;

export const ActionSchema = z.discriminatedUnion('type', actionSchemas);
export type Action = z.infer<typeof ActionSchema>;
