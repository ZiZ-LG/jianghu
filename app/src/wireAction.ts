import { ActionSchema, type Action, type ActionType } from '@jianghu/domain-contracts';

interface NestedSpec {
  field: string;
  keys: readonly string[];
  shape?: 'account' | 'person' | 'log' | 'visit';
}

const nestedSpecs: Partial<Record<ActionType, NestedSpec>> = {
  ADD_ACCOUNT: { field: 'account', keys: ['id', 'name', 'customerType', 'unifiedCreditCode', 'externalRef', 'region', 'group', 'primaryOwner', 'primaryOwnerUserId', 'profile'], shape: 'account' },
  UPDATE_ACCOUNT: { field: 'patch', keys: ['name', 'customerType', 'unifiedCreditCode', 'externalRef', 'region', 'group', 'primaryOwner', 'primaryOwnerUserId', 'profile'], shape: 'account' },
  ADD_OPP: { field: 'opp', keys: ['id', 'name', 'customerType', 'pipelineStage', 'engageStage', 'changeMode', 'singleSalesGoal', 'customerBusinessGoal', 'buyingMotivation', 'primaryDPersonId', 'c3Items', 'c5Items', 'externalRef', 'status', 'productSolution', 'competitor', 'competitiveSituation', 'winProbability', 'expectedSignDate', 'expectedAmountW', 'meta', 'memberScoped'] },
  UPDATE_OPP: { field: 'patch', keys: ['name', 'pipelineStage', 'engageStage', 'changeMode', 'singleSalesGoal', 'customerBusinessGoal', 'buyingMotivation', 'primaryDPersonId', 'c3Items', 'c5Items', 'externalRef', 'status', 'productSolution', 'competitor', 'competitiveSituation', 'winProbability', 'expectedSignDate', 'expectedAmountW', 'meta'] },
  ADD_PERSON: { field: 'person', keys: ['id', 'name', 'title', 'orgLevel', 'isCompetitor', 'avatarUrl', 'coachLevel', 'x', 'y', 'form', 'logs'], shape: 'person' },
  UPDATE_PERSON: { field: 'patch', keys: ['name', 'title', 'orgLevel', 'avatarUrl', 'coachLevel', 'color', 'form'], shape: 'person' },
  ADD_LOG: { field: 'log', keys: ['date', 'content', 'sensitive', 'visibility'], shape: 'log' },
  SET_ROLE: { field: 'patch', keys: ['role', 'sentiment', 'sentimentValue', 'confidence', 'isKeyInfluencer', 'procurementType', 'procurementStatus'] },
  ADD_EDGE: { field: 'edge', keys: ['id', 'source', 'target', 'kind', 'layer', 'label', 'color', 'style', 'width', 'directed', 'origin', 'shape', 'bend'] },
  UPDATE_EDGE: { field: 'patch', keys: ['source', 'target', 'kind', 'layer', 'label', 'color', 'style', 'width', 'directed', 'shape', 'bend'] },
  ADD_BI: { field: 'bi', keys: ['id', 'personId', 'description', 'category', 'isPrivate', 'confidence'] },
  UPDATE_BI: { field: 'patch', keys: ['description', 'category', 'isPrivate', 'confidence'] },
  ADD_UCV: { field: 'ucv', keys: ['id', 'targetBiId', 'description', 'competitorCannot', 'status'] },
  UPDATE_UCV: { field: 'patch', keys: ['targetBiId', 'description', 'competitorCannot', 'status'] },
  ADD_VISIT: { field: 'visit', keys: ['id', 'opportunityId', 'externalRef', 'date', 'topic', 'summary', 'participants', 'origin'], shape: 'visit' },
  UPDATE_VISIT: { field: 'patch', keys: ['opportunityId', 'externalRef', 'date', 'topic', 'summary', 'participants', 'origin'], shape: 'visit' },
  ADD_NOTE: { field: 'note', keys: ['id', 'opportunityId', 'personId', 'content', 'source', 'tags'] },
  UPDATE_NOTE: { field: 'patch', keys: ['opportunityId', 'personId', 'content', 'source', 'tags'] },
  ADD_PLAN_ACTION: { field: 'planAction', keys: ['id', 'gapItem', 'personId', 'title', 'scene', 'scripts', 'target', 'ownerId', 'startDate', 'endDate', 'half', 'done', 'doneAt', 'draft', 'review', 'origin', 'resources', 'cautions', 'props'] },
  UPDATE_PLAN_ACTION: { field: 'patch', keys: ['gapItem', 'personId', 'title', 'scene', 'scripts', 'target', 'ownerId', 'startDate', 'endDate', 'half', 'done', 'doneAt', 'draft', 'review', 'resources', 'cautions', 'props'] },
  ADD_MILESTONE: { field: 'milestone', keys: ['id', 'title', 'startDate', 'endDate', 'half'] },
  UPDATE_MILESTONE: { field: 'patch', keys: ['title', 'startDate', 'endDate', 'half'] },
  ADD_OPP_STAGE: { field: 'stage', keys: ['id', 'stageKey', 'startDate', 'endDate'] },
  UPDATE_OPP_STAGE: { field: 'patch', keys: ['stageKey', 'startDate', 'endDate'] },
  ADD_STRATEGY_CARD: { field: 'card', keys: ['id', 'gapItem', 'title', 'basis', 'alternatives', 'personId', 'status', 'origin', 'orderIndex', 'dispatchedActionIds'] },
  UPDATE_STRATEGY_CARD: { field: 'patch', keys: ['gapItem', 'title', 'basis', 'alternatives', 'personId', 'status', 'origin', 'orderIndex', 'dispatchedActionIds'] },
  ADD_STRATEGY_RISK: { field: 'risk', keys: ['id', 'kind', 'text', 'severity', 'mitigation', 'status', 'origin'] },
  UPDATE_STRATEGY_RISK: { field: 'patch', keys: ['kind', 'text', 'severity', 'mitigation', 'status', 'origin'] },
  ADD_STRATEGY_RESOURCE: { field: 'resource', keys: ['id', 'label', 'kind', 'note'] },
  UPDATE_STRATEGY_RESOURCE: { field: 'patch', keys: ['label', 'kind', 'note'] },
  ADD_EVIDENCE: { field: 'evidence', keys: ['id', 'personId', 'signalKey', 'direction', 'tier', 'rawContent', 'occurredAt', 'status', 'origin'] },
};

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allowed = new Set(keys);
  return Object.fromEntries(Object.entries(value).filter(([key, entry]) => allowed.has(key) && entry !== undefined));
}

function sanitizeNested(value: unknown, spec: NestedSpec): Record<string, unknown> {
  const result = pick(value, spec.keys);
  if (spec.shape === 'account' && result.profile) {
    result.profile = pick(result.profile, ['business', 'group', 'bidding', 'risk', 'ourCooperation', 'salesNote', 'aiSuggestion']);
  }
  if (spec.shape === 'person') {
    if (result.form) {
      const form = pick(result.form, ['family', 'occupation', 'recreation', 'moneyMotivation', 'family7']);
      if (form.family7) form.family7 = pick(form.family7, ['籍贯', '年纪', '生日', '毕业院校', '配偶', '子女', '父母']);
      result.form = form;
    }
    if (Array.isArray(result.logs)) result.logs = result.logs.map((log) => pick(log, ['date', 'content', 'sensitive', 'visibility']));
  }
  if (spec.shape === 'visit' && Array.isArray(result.participants)) {
    result.participants = result.participants.map((participant) => pick(participant, ['name', 'side']));
  }
  return result;
}

/** Convert an optimistic UI action into the strict, minimal server mutation payload. */
export function toWireAction(action: Action): Action {
  const candidate = Object.fromEntries(Object.entries(action).filter(([, value]) => value !== undefined));
  const spec = nestedSpecs[action.type];
  if (spec) candidate[spec.field] = sanitizeNested(candidate[spec.field], spec);
  return ActionSchema.parse(candidate);
}
