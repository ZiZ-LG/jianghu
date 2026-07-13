import type {
  Band741,
  Confidence,
  EngageStage,
  ItemKey,
  PersonContribution,
  ProcurementStatus,
  ProcurementType,
  Role,
  ScoreBreakdown,
  ScoringAccount,
  ScoringInput,
  ScoringOpportunity,
  ScoringProfile,
  Sentiment,
} from './types.js';

export const C3_ITEMS = ['立项原因', '项目名称', '项目预算', '实施计划', '资金来源', '项目排序', '采购方式'] as const;
export const C5_ITEMS = ['竞标方家数', '招标参数', '评标规则', '甲方代表', '招标代理'] as const;
export const FAMILY_7Q = ['籍贯', '年纪', '生日', '毕业院校', '配偶', '子女', '父母'] as const;

export const P3_1K_MAP: Record<Sentiment, number> = {
  star: 20,
  plus: 10,
  neutral: 0,
  unknown: 0,
  minus: -10,
  x: -20,
};

export const P4_MAP: Record<Sentiment, number> = {
  star: 10,
  plus: 5,
  neutral: 0,
  unknown: 0,
  minus: 0,
  x: 0,
};

export const C4_MAP: Record<EngageStage, number> = {
  '需求调研立项': 5,
  '方案可研': 4,
  '预算批复': 3,
  '招标论证': 2,
  '招采执行': 1,
};

export const BAND_LABEL: Record<Band741, string> = {
  ABSOLUTE_ADVANTAGE: '绝对优势 · 可承诺',
  RELATIVE_ADVANTAGE: '相对优势 · 可争取',
  RELATIVE_DISADVANTAGE: '相对劣势 · 可参与',
  ABSOLUTE_DISADVANTAGE: '绝对劣势 · 重新复盘',
};

export const BAND_STRATEGY: Record<Band741, string> = {
  ABSOLUTE_ADVANTAGE: '直接赢单：控节奏、加速签约、绑框架/多项目复制、防节外生枝',
  RELATIVE_ADVANTAGE: '制定规则/加速进度/总包：主导技术参数与评分、推动尽快挂网、联合体绑定设计院',
  RELATIVE_DISADVANTAGE: '改变规则/减速拖延/拆包：把客户从比价格引到比一体化降本、拖到有利时点、拆出对手强项模块',
  ABSOLUTE_DISADVANTAGE: '重新回炉：评估放弃或养单、优先补 C1/C2 与 D/A 关系、争下一期',
};

export const DEFAULT_PROFILE: ScoringProfile = {
  id: 'energy-g64111-v1',
  name: '数字能源 G64111 v1.1',
  formC1Curve: 'strict',
  bands: { absAdv: 0.75, relAdv: 0.5, relDis: 0.25 },
};

export const ITEM_MAX: Record<ItemKey, number> = {
  C1: 10,
  C2: 5,
  C3: 5,
  C4: 5,
  C5: 5,
  C6: 5,
  P1: 5,
  P2: 10,
  P3: 20,
  P4: 10,
  '1K': 20,
};

export const ITEM_LABEL: Record<ItemKey, string> = {
  C1: 'C1 组织图+D的FORM',
  C2: 'C2 拍板人BI',
  C3: 'C3 立项材料+排序',
  C4: 'C4 介入阶段',
  C5: 'C5 招采事项',
  C6: 'C6 UCV解决度',
  P1: 'P1 多数人支持',
  P2: 'P2 招采关键人',
  P3: 'P3 与D密谋/支持',
  P4: 'P4 关键影响人',
  '1K': '1K 与A密谋/支持',
};

export const ITEM_GROUP: Record<ItemKey, '6必清' | '4优势' | '1决胜'> = {
  C1: '6必清',
  C2: '6必清',
  C3: '6必清',
  C4: '6必清',
  C5: '6必清',
  C6: '6必清',
  P1: '4优势',
  P2: '4优势',
  P3: '4优势',
  P4: '4优势',
  '1K': '1决胜',
};

const P2_WEIGHT: Record<ProcurementType, number> = { purchasing: 4, agency: 2, ownerRep: 4 };
const CONF_RANK: Record<Confidence, number> = { '共识': 3, '明确': 2, '推理': 1, '不清': 0 };
const ROLES: readonly Role[] = ['A', 'D', 'U', 'R', 'C'];
const PROCUREMENT_TYPES: readonly ProcurementType[] = ['purchasing', 'agency', 'ownerRep'];
const PROCUREMENT_STATUSES: readonly ProcurementStatus[] = ['collude', 'verbal', 'none'];

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function isNonBlank(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function knownStage(value: string | null | undefined): EngageStage | null {
  return value && Object.prototype.hasOwnProperty.call(C4_MAP, value) ? (value as EngageStage) : null;
}

export function aggregateLow(scores: number[]): number {
  if (scores.length === 0) return 0;
  const sorted = [...scores].sort((a, b) => a - b);
  return sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : sorted[sorted.length / 2 - 1];
}

export function band741(percent: number, bands = DEFAULT_PROFILE.bands): Band741 {
  if (percent >= bands.absAdv) return 'ABSOLUTE_ADVANTAGE';
  if (percent >= bands.relAdv) return 'RELATIVE_ADVANTAGE';
  if (percent >= bands.relDis) return 'RELATIVE_DISADVANTAGE';
  return 'ABSOLUTE_DISADVANTAGE';
}

export const isConfirmed = (confidence: Confidence): boolean =>
  (CONF_RANK[confidence] ?? -1) >= CONF_RANK['明确'];

export function scoreC1(input: ScoringInput, profile = DEFAULT_PROFILE): number {
  const anyRoleMissing = ROLES.some((role) => !input.rolesPresent[role]);
  const roleScore = Math.max(0, 6 - (anyRoleMissing ? 3 : 0) - input.nonAUnknownCount);
  const procurementScore = input.procurementTypesIdentified / 3;
  const adur = Math.min(7, roleScore + procurementScore);
  const formScore = profile.formC1Curve === 'linear'
    ? Math.round((3 * input.dFamily7Filled) / 7)
    : Math.max(0, 3 - (7 - input.dFamily7Filled));
  return adur + formScore;
}

export const scoreC2 = (input: ScoringInput): number => (input.dHasBI ? 5 : 0);
export const scoreC3 = (input: ScoringInput): number => clamp(5 - (7 - input.c3KnownCount), 0, 5);
export const scoreC4 = (input: ScoringInput): number => (input.engageStage ? C4_MAP[input.engageStage] : 0);
export const scoreC5 = (input: ScoringInput): number => clamp(5 - (5 - input.c5KnownCount), 0, 5);
export const scoreC6 = (input: ScoringInput): number =>
  input.ucvStatus === '已解决' ? 5 : input.ucvStatus === '获认可' ? 3 : 0;
export const scoreP1 = (input: ScoringInput): number =>
  clamp(input.p1PlusCount - input.p1MinusCount, -5, 5);

export function scoreP2(input: ScoringInput): number {
  const types = Object.keys(P2_WEIGHT) as ProcurementType[];
  if (types.every((type) => input.p2[type] === 'none')) return -5;
  return types.reduce((sum, type) => {
    const status = input.p2[type];
    if (status === 'collude') return sum + P2_WEIGHT[type];
    if (status === 'verbal') return sum + 1;
    return sum;
  }, 0);
}

export const scoreP3 = (input: ScoringInput): number =>
  aggregateLow(input.dSentiments.map((sentiment) => P3_1K_MAP[sentiment] ?? 0));
export const scoreP4 = (input: ScoringInput): number =>
  input.keyInfluencerSentiment ? P4_MAP[input.keyInfluencerSentiment] ?? 0 : 0;
export const score1K = (input: ScoringInput): number =>
  aggregateLow(input.aSentiments.map((sentiment) => P3_1K_MAP[sentiment] ?? 0));

export function scoreOpportunity(input: ScoringInput, profile = DEFAULT_PROFILE): ScoreBreakdown {
  const items: Record<ItemKey, number> = {
    C1: scoreC1(input, profile),
    C2: scoreC2(input),
    C3: scoreC3(input),
    C4: scoreC4(input),
    C5: scoreC5(input),
    C6: scoreC6(input),
    P1: scoreP1(input),
    P2: scoreP2(input),
    P3: scoreP3(input),
    P4: scoreP4(input),
    '1K': score1K(input),
  };
  const clears = items.C1 + items.C2 + items.C3 + items.C4 + items.C5 + items.C6;
  const priorities = items.P1 + items.P2 + items.P3 + items.P4;
  const key = items['1K'];
  const total = clears + priorities + key;
  const percent = total / 100;
  const band = band741(percent, profile.bands);
  return {
    items,
    clears,
    priorities,
    key,
    total,
    percent,
    band,
    bandLabel: BAND_LABEL[band],
    strategy: BAND_STRATEGY[band],
  };
}

export function buildScoringInput(account: ScoringAccount, opportunity: ScoringOpportunity): ScoringInput {
  const roles = [...(opportunity.roles ?? [])];
  const bis = [...(opportunity.bis ?? [])];
  const ucvs = [...(opportunity.ucvs ?? [])];
  const personById = new Map((account.persons ?? []).map((person) => [person.id, person]));

  const rolesPresent: Record<Role, boolean> = { A: false, D: false, U: false, R: false, C: false };
  for (const role of roles) {
    if (ROLES.includes(role.role)) rolesPresent[role.role] = true;
  }

  const nonAUnknownCount = roles.filter((role) => role.role !== 'A' && role.sentiment === 'unknown').length;
  const procurementTypesIdentified = new Set(
    roles
      .map((role) => role.procurementType)
      .filter((type): type is ProcurementType => type !== undefined && PROCUREMENT_TYPES.includes(type)),
  ).size;

  const dRoles = roles.filter((role) => role.role === 'D');
  const primaryD = dRoles[0];
  const dFamily = primaryD ? personById.get(primaryD.personId)?.form?.family7 ?? {} : {};
  const dFamily7Filled = FAMILY_7Q.filter((question) => isNonBlank(dFamily[question])).length;

  const dPersonIds = new Set(dRoles.map((role) => role.personId));
  const dHasBI = bis.some((bi) => dPersonIds.has(bi.personId) && isConfirmed(bi.confidence));
  const dBiIds = new Set(bis.filter((bi) => dPersonIds.has(bi.personId)).map((bi) => bi.id));

  let ucvStatus: ScoringInput['ucvStatus'] = 'none';
  for (const ucv of ucvs) {
    if (!dBiIds.has(ucv.targetBiId)) continue;
    if (ucv.status === '已解决') {
      ucvStatus = '已解决';
      break;
    }
    if (ucv.status === '获认可') ucvStatus = '获认可';
    else if (ucv.status === '建议' && ucvStatus === 'none') ucvStatus = '建议';
  }

  const confirmed = roles.filter((role) => isConfirmed(role.confidence));
  const p1PlusCount = confirmed.filter((role) => role.sentiment === 'plus' || role.sentiment === 'star').length;
  const p1MinusCount = confirmed.filter((role) => role.sentiment === 'minus' || role.sentiment === 'x').length;

  const p2: Record<ProcurementType, ProcurementStatus> = {
    purchasing: 'none',
    agency: 'none',
    ownerRep: 'none',
  };
  for (const role of roles) {
    if (
      role.procurementType
      && PROCUREMENT_TYPES.includes(role.procurementType)
      && role.procurementStatus
      && PROCUREMENT_STATUSES.includes(role.procurementStatus)
    ) {
      p2[role.procurementType] = role.procurementStatus;
    }
  }

  return {
    rolesPresent,
    nonAUnknownCount,
    procurementTypesIdentified,
    dFamily7Filled,
    dHasBI,
    c3KnownCount: C3_ITEMS.filter((item) => opportunity.c3Items?.[item] === true).length,
    engageStage: knownStage(opportunity.engageStage),
    c5KnownCount: C5_ITEMS.filter((item) => opportunity.c5Items?.[item] === true).length,
    ucvStatus,
    p1PlusCount,
    p1MinusCount,
    p2,
    dSentiments: dRoles.map((role) => role.sentiment),
    aSentiments: roles.filter((role) => role.role === 'A').map((role) => role.sentiment),
    keyInfluencerSentiment: roles.find((role) => role.isKeyInfluencer)?.sentiment ?? null,
  };
}

export function scoreFromState(
  account: ScoringAccount,
  opportunity: ScoringOpportunity,
  profile: ScoringProfile = DEFAULT_PROFILE,
): ScoreBreakdown {
  return scoreOpportunity(buildScoringInput(account, opportunity), profile);
}

export function personContributions(
  account: ScoringAccount,
  opportunity: ScoringOpportunity,
  profile: ScoringProfile = DEFAULT_PROFILE,
): Map<string, PersonContribution> {
  const result = new Map<string, PersonContribution>();
  const ensure = (personId: string) => {
    let entry = result.get(personId);
    if (!entry) {
      entry = { nominal: 0, potential: 0, upside: 0, parts: [] };
      result.set(personId, entry);
    }
    return entry;
  };
  const addPart = (personId: string, item: ItemKey, value: number, note?: string) => {
    const entry = ensure(personId);
    entry.parts.push(note ? { item, value, note } : { item, value });
    entry.nominal += value;
  };
  const addPotential = (personId: string, value: number) => {
    ensure(personId).potential += value;
  };

  const roles = [...(opportunity.roles ?? [])];
  const bis = [...(opportunity.bis ?? [])];
  const ucvs = [...(opportunity.ucvs ?? [])];
  const personById = new Map((account.persons ?? []).map((person) => [person.id, person]));
  const dRoles = roles.filter((role) => role.role === 'D');
  const aRoles = roles.filter((role) => role.role === 'A');
  const primaryD = dRoles[0];

  const p3Actual = aggregateLow(dRoles.map((role) => P3_1K_MAP[role.sentiment] ?? 0));
  for (const role of dRoles) {
    const value = P3_1K_MAP[role.sentiment] ?? 0;
    addPart(role.personId, 'P3', value, dRoles.length > 1 && value !== p3Actual ? `多D取低，商机实计 ${p3Actual}` : undefined);
    addPotential(role.personId, 20);
  }

  const kActual = aggregateLow(aRoles.map((role) => P3_1K_MAP[role.sentiment] ?? 0));
  for (const role of aRoles) {
    const value = P3_1K_MAP[role.sentiment] ?? 0;
    addPart(role.personId, '1K', value, aRoles.length > 1 && value !== kActual ? `多A取低，商机实计 ${kActual}` : undefined);
    addPotential(role.personId, 20);
  }

  const keyInfluencer = roles.find((role) => role.isKeyInfluencer);
  for (const role of roles) {
    if (!role.isKeyInfluencer) continue;
    if (role === keyInfluencer) {
      addPart(role.personId, 'P4', P4_MAP[role.sentiment] ?? 0);
      addPotential(role.personId, 10);
    } else {
      addPart(role.personId, 'P4', 0, 'P4 已由他人占用');
    }
  }

  for (const role of roles) {
    addPotential(role.personId, 1);
    if (!isConfirmed(role.confidence)) continue;
    if (role.sentiment === 'star' || role.sentiment === 'plus') addPart(role.personId, 'P1', 1);
    else if (role.sentiment === 'minus' || role.sentiment === 'x') addPart(role.personId, 'P1', -1);
  }

  for (const role of roles) {
    if (!role.procurementType || !PROCUREMENT_TYPES.includes(role.procurementType)) continue;
    const weight = P2_WEIGHT[role.procurementType];
    const status = role.procurementStatus && PROCUREMENT_STATUSES.includes(role.procurementStatus)
      ? role.procurementStatus
      : 'none';
    const value = status === 'collude' ? weight : status === 'verbal' ? 1 : 0;
    addPart(role.personId, 'P2', value);
    addPotential(role.personId, weight);
  }

  if (primaryD) {
    const family7 = personById.get(primaryD.personId)?.form?.family7 ?? {};
    const filled = FAMILY_7Q.filter((question) => isNonBlank(family7[question])).length;
    const value = profile.formC1Curve === 'linear'
      ? Math.round((3 * filled) / 7)
      : Math.max(0, 3 - (7 - filled));
    addPart(primaryD.personId, 'C1', value, 'D 的 FORM');
    addPotential(primaryD.personId, 3);
  }

  const dIds = new Set(dRoles.map((role) => role.personId));
  const c2Holder = bis.find((bi) => dIds.has(bi.personId) && isConfirmed(bi.confidence))?.personId;
  if (c2Holder) addPart(c2Holder, 'C2', 5);
  for (const personId of dIds) addPotential(personId, 5);

  const dBiOwner = new Map(bis.filter((bi) => dIds.has(bi.personId)).map((bi) => [bi.id, bi.personId]));
  let c6Best: { value: number; personId: string } | null = null;
  for (const ucv of ucvs) {
    const personId = dBiOwner.get(ucv.targetBiId);
    if (!personId) continue;
    const value = ucv.status === '已解决' ? 5 : ucv.status === '获认可' ? 3 : 0;
    if (value > 0 && (!c6Best || value > c6Best.value)) c6Best = { value, personId };
    if (c6Best?.value === 5) break;
  }
  if (c6Best) addPart(c6Best.personId, 'C6', c6Best.value);
  for (const personId of dIds) addPotential(personId, 5);

  for (const entry of result.values()) entry.upside = entry.potential - entry.nominal;
  return result;
}
