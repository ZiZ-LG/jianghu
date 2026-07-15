import { pickKeyInfluencerKeeper, type Account, type Opportunity } from './types';
import type { ScoreBreakdown } from './lib/g64111';

export interface AiContextOptions {
  includeRawLogs: boolean;
  includeForm: boolean;
}

export const DEFAULT_AI_CONTEXT_OPTIONS: AiContextOptions = {
  includeRawLogs: false,
  includeForm: false,
};

export interface AiRequestScope {
  accountId: string;
  opportunityId: string;
  personId?: string;
  manifestToken: string;
  options: AiContextOptions;
  generation: number;
}

export function createAiRequestScope(scope: AiRequestScope): AiRequestScope {
  return {
    ...scope,
    options: {
      includeRawLogs: !!scope.options.includeRawLogs,
      includeForm: !!scope.options.includeForm,
    },
  };
}

/** Stable identity for model results and advisor continuation; generation is compared separately. */
export function aiRequestScopeKey(scope: AiRequestScope): string {
  return JSON.stringify([
    scope.accountId,
    scope.opportunityId,
    scope.personId ?? '',
    scope.manifestToken,
    scope.options.includeRawLogs,
    scope.options.includeForm,
  ]);
}

export function isAiRequestScopeCurrent(request: AiRequestScope, current: AiRequestScope): boolean {
  return request.generation === current.generation && aiRequestScopeKey(request) === aiRequestScopeKey(current);
}

export type AiOperationKind = 'drawer-prefill' | 'card-dispatch' | 'milestone-plan';

export interface AiOperationIdentity {
  kind: AiOperationKind;
  targetId: string;
  personId?: string;
  inputFingerprint: string;
  nonce: number;
}

export function createAiOperationIdentity(input: {
  kind: AiOperationKind;
  targetId: string;
  personId?: string;
  inputs: readonly unknown[];
  nonce: number;
}): AiOperationIdentity {
  return {
    kind: input.kind,
    targetId: input.targetId,
    personId: input.personId,
    inputFingerprint: JSON.stringify(input.inputs.map((value) => value ?? null)),
    nonce: input.nonce,
  };
}

export function aiOperationIdentityKey(identity: AiOperationIdentity): string {
  return JSON.stringify([
    identity.kind,
    identity.targetId,
    identity.personId ?? '',
    identity.inputFingerprint,
    identity.nonce,
  ]);
}

export function isAiOperationCurrent(
  request: AiOperationIdentity,
  current: AiOperationIdentity | null,
): boolean {
  return !!current && aiOperationIdentityKey(request) === aiOperationIdentityKey(current);
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

export interface AdvisorContinuationMessage {
  role: 'user' | 'assistant';
  text: string;
  /** Present only for an analysis produced under this exact server preflight scope. */
  contextManifestToken?: string;
  contextScopeKey?: string;
}

export function buildAdvisorContinuationNote(
  messages: readonly AdvisorContinuationMessage[],
  currentScope: AiRequestScope,
): string {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') { lastUserIndex = index; break; }
  }
  const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex]!.text : '';
  const currentScopeKey = aiRequestScopeKey(currentScope);
  const sameScopeAnalysis = currentScope.manifestToken
    ? [...messages.slice(lastUserIndex + 1)].reverse().find((message) =>
      message.role === 'assistant'
      && message.contextManifestToken === currentScope.manifestToken
      && message.contextScopeKey === currentScopeKey)?.text ?? ''
    : '';
  return [
    lastUser && `我刚问：${lastUser}`,
    sameScopeAnalysis && `你的分析要点：${sameScopeAnalysis.slice(0, 240)}`,
  ].filter(Boolean).join('\n');
}

type AiContext = ReturnType<typeof buildAiContext>;

/** 把当前商机 + 趋赢力打分组装成给 AI 的紧凑上下文（用户自己的数据，发给用户自己的模型） */
export function buildAiContext(
  account: Account,
  opp: Opportunity,
  breakdown: ScoreBreakdown,
  options: AiContextOptions = DEFAULT_AI_CONTEXT_OPTIONS,
) {
  const allowedPersonIds = opp.memberScoped
    ? new Set(opp.memberIds ?? [])
    : new Set(account.persons.map((person) => person.id));
  const visiblePeople = account.persons.filter((person) => allowedPersonIds.has(person.id));
  const personById = new Map(account.persons.map((p) => [p.id, p]));
  const visibleRoles = opp.roles.filter((role) => allowedPersonIds.has(role.personId));
  const roleByPerson = new Map(visibleRoles.map((r) => [r.personId, r]));
  const nameOf = (id: string) => personById.get(id)?.name ?? id;
  const dRoles = visibleRoles.filter((role) => role.role === 'D');
  const primaryD = dRoles.find((role) => role.personId === opp.primaryDPersonId) ?? dRoles[0];
  const keyInfluencer = pickKeyInfluencerKeeper(visibleRoles);

  const people = visiblePeople.map((p) => {
    const r = roleByPerson.get(p.id);
    return {
      id: p.id,
      name: p.name, title: p.title, isCompetitor: !!p.isCompetitor,
      role: r?.role ?? null, sentiment: r?.sentiment ?? null,
      confidence: r?.confidence ?? null,
      isPrimaryD: !!primaryD && r?.personId === primaryD.personId,
      isKeyInfluencer: !!keyInfluencer && r?.personId === keyInfluencer.personId,
      ...(options.includeForm ? { form: p.form } : {}),
    };
  });
  const relationships = [...account.baseEdges, ...opp.edges].slice(0, 40)
    .filter((edge) => allowedPersonIds.has(edge.source) && allowedPersonIds.has(edge.target))
    .map((e) => ({ fromId: e.source, toId: e.target, from: nameOf(e.source), to: nameOf(e.target), layer: e.layer, label: e.label }));
  const visibleBis = opp.bis.filter((bi) => !bi.isPrivate && allowedPersonIds.has(bi.personId));
  const biById = new Map(visibleBis.map((b) => [b.id, b]));
  const bis = visibleBis.map((b) => ({ personId: b.personId, person: nameOf(b.personId), category: b.category, description: b.description }));
  // UCV 挂靠某个 BI：解 BI 得到「针对谁的什么燃点」，AI 能理解为什么这条价值对得上
  const ucvs = opp.ucvs.filter((ucv) => biById.has(ucv.targetBiId)).map((u) => {
    const bi = biById.get(u.targetBiId);
    return { person: bi ? nameOf(bi.personId) : '?', bi: bi ? `${bi.category}·${bi.description}` : '?', description: u.description, competitorCannot: u.competitorCannot, status: u.status };
  });
  // 近期交往：关键人（A/D/关键影响人）优先各出 2 条最新 log，全局 30 条上限——够上下文用又不撑爆 payload
  const keyIds = new Set(visibleRoles
    .filter((role) => role.role === 'A' || role.role === 'D' || role.personId === keyInfluencer?.personId)
    .map((role) => role.personId));
  const recentInteractions: { person: string; date: string; content: string }[] = [];
  for (const p of visiblePeople) {
    if (!keyIds.has(p.id)) continue;
    if (!options.includeRawLogs) continue;
    for (const l of (p.logs ?? []).filter((log) => log.visibility !== 'self').slice(0, 2)) {
      recentInteractions.push({ person: p.name, date: l.date, content: l.content });
    }
    if (recentInteractions.length >= 30) break;
  }

  return {
    account: { name: account.name, customerType: account.customerType },
    opportunity: { name: opp.name, pipelineStage: opp.pipelineStage, engageStage: opp.engageStage, singleSalesGoal: opp.singleSalesGoal, expectedSignDate: opp.expectedSignDate ?? null },
    winTendency: { percent: breakdown.percent, total: breakdown.total, band: breakdown.band, items: breakdown.items },
    people, relationships, bis, ucvs, recentInteractions,
  };
}

/** Content-free disclosure summary. Never add names, IDs, descriptions or excerpts here. */
export function buildContextManifest(
  context: AiContext,
  options: AiContextOptions = DEFAULT_AI_CONTEXT_OPTIONS,
): ContextManifest {
  return {
    entities: {
      accounts: 1,
      opportunities: 1,
      people: context.people.length,
      relationships: context.relationships.length,
      burningIssues: context.bis.length,
      ucvs: context.ucvs.length,
      interactionLogs: context.recentInteractions.length,
    },
    fieldCategories: [
      'account-summary',
      'opportunity-summary',
      'g64111-score',
      'roles-and-sentiment',
      'relationship-metadata',
      'business-issues-and-value',
      ...(options.includeForm ? ['form'] : []),
      ...(options.includeRawLogs ? ['raw-logs'] : []),
    ],
    excludedSensitiveCategories: [
      'private-bi',
      'self-logs',
      'outside-opportunity',
      ...(!options.includeRawLogs ? ['raw-logs'] : []),
      ...(!options.includeForm ? ['form'] : []),
    ],
  };
}
