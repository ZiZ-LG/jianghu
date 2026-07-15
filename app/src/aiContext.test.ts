import { describe, expect, it } from 'vitest';
// @ts-expect-error Vitest runs in Node; the browser app intentionally does not load global Node typings.
import { readFileSync } from 'node:fs';
import { seedAccount } from './data/seed';
import { scoreFromDomain } from './lib/g64111';
import {
  aiRequestScopeKey,
  buildAdvisorContinuationNote,
  buildAiContext,
  buildContextManifest,
  createAiOperationIdentity,
  createAiRequestScope,
  isAiOperationCurrent,
  isAiRequestScopeCurrent,
} from './aiContext';

describe('buildAiContext G64111 selection semantics', () => {
  it('marks only the explicit second D and the shared legal P4 keeper', () => {
    const account = structuredClone(seedAccount);
    const opp = structuredClone(account.opportunities[0]);
    opp.primaryDPersonId = 'zhao';
    opp.roles = [
      { personId: 'qian', role: 'D', sentiment: 'plus', confidence: '明确' },
      { personId: 'zhao', role: 'D', sentiment: 'neutral', confidence: '明确' },
      { personId: 'sun', role: 'A', sentiment: 'star', confidence: '明确', isKeyInfluencer: true },
      { personId: 'zheng', role: 'U', sentiment: 'plus', confidence: '明确', isKeyInfluencer: true },
      { personId: 'li', role: 'C', sentiment: 'neutral', confidence: '明确', isKeyInfluencer: true },
    ];

    const context = buildAiContext(account, opp, scoreFromDomain(account, opp));
    const byName = new Map(context.people.map((person) => [person.name, person]));

    expect(byName.get('钱大钧')).toMatchObject({ role: 'D', isPrimaryD: false });
    expect(byName.get('赵建国')).toMatchObject({ role: 'D', isPrimaryD: true });
    expect(context.people.filter((person) => person.isPrimaryD)).toHaveLength(1);
    expect(byName.get('孙学文')).toMatchObject({ role: 'A', isKeyInfluencer: false });
    expect(byName.get('李进')).toMatchObject({ role: 'C', isKeyInfluencer: true });
    expect(byName.get('郑工')).toMatchObject({ role: 'U', isKeyInfluencer: false });
    expect(context.people.filter((person) => person.isKeyInfluencer)).toHaveLength(1);
  });

  it('uses the existing first-D fallback when no explicit primary D is valid', () => {
    const account = structuredClone(seedAccount);
    const opp = structuredClone(account.opportunities[0]);
    opp.primaryDPersonId = 'not-a-current-d';
    opp.roles = [
      { personId: 'qian', role: 'D', sentiment: 'plus', confidence: '明确' },
      { personId: 'zhao', role: 'D', sentiment: 'neutral', confidence: '明确' },
    ];

    const context = buildAiContext(account, opp, scoreFromDomain(account, opp));

    expect(context.people.find((person) => person.isPrimaryD)?.name).toBe('钱大钧');
  });

  it.each([
    ['no roles', []],
    ['ordinary U/R/C without P4', [
      { personId: 'li', role: 'U', sentiment: 'neutral', confidence: '明确' },
      { personId: 'zhou', role: 'R', sentiment: 'neutral', confidence: '明确' },
      { personId: 'sun', role: 'C', sentiment: 'plus', confidence: '明确' },
    ]],
  ] as const)('does not invent primary D or P4 markers with %s', (_name, roles) => {
    const account = structuredClone(seedAccount);
    const opp = structuredClone(account.opportunities[0]);
    opp.primaryDPersonId = null;
    opp.roles = [...roles];

    const context = buildAiContext(account, opp, scoreFromDomain(account, opp));

    expect(context.people.filter((person) => person.isPrimaryD)).toHaveLength(0);
    expect(context.people.filter((person) => person.isKeyInfluencer)).toHaveLength(0);
  });
});

describe('INT-403 AI context minimization', () => {
  it('keeps only memberScoped people and current-opportunity relationships', () => {
    const account = structuredClone(seedAccount);
    const opp = structuredClone(account.opportunities[0]);
    const allowed = opp.roles.slice(0, 2).map((role) => role.personId);
    opp.memberScoped = true;
    opp.memberIds = allowed;
    opp.roles = opp.roles.slice(0, 2);
    opp.edges = [
      { id: 'inside', source: allowed[0]!, target: allowed[1]!, layer: 'L2', label: 'inside' },
      { id: 'outside', source: allowed[0]!, target: account.persons.find((p) => !allowed.includes(p.id))!.id, layer: 'L2', label: 'outside' },
    ];

    const context = buildAiContext(account, opp, scoreFromDomain(account, opp));

    expect(context.people.map((person) => person.id).sort()).toEqual([...allowed].sort());
    expect(context.relationships).toContainEqual(expect.objectContaining({ fromId: allowed[0], toId: allowed[1] }));
    expect(context.relationships.every((edge) => allowed.includes(edge.fromId) && allowed.includes(edge.toId))).toBe(true);
    expect(JSON.stringify(context)).not.toContain('outside');
  });

  it('excludes raw logs and FORM by default and only includes them by explicit opt-in', () => {
    const account = structuredClone(seedAccount);
    const opp = structuredClone(account.opportunities[0]);
    const person = account.persons[0]!;
    person.logs = [{ date: '2026-07-15', content: 'RAW-LOG-SECRET', visibility: 'org' }];
    person.form.family = 'FORM-SECRET';

    const minimal = buildAiContext(account, opp, scoreFromDomain(account, opp));
    const expanded = buildAiContext(account, opp, scoreFromDomain(account, opp), { includeRawLogs: true, includeForm: true });

    expect(JSON.stringify(minimal)).not.toContain('RAW-LOG-SECRET');
    expect(JSON.stringify(minimal)).not.toContain('FORM-SECRET');
    expect(JSON.stringify(expanded)).toContain('RAW-LOG-SECRET');
    expect(JSON.stringify(expanded)).toContain('FORM-SECRET');
  });

  it('builds a content-free manifest with counts, field categories and exclusions', () => {
    const account = structuredClone(seedAccount);
    const opp = structuredClone(account.opportunities[0]);
    account.persons[0]!.logs = [{ date: '2026-07-15', content: 'MANIFEST-MUST-NOT-CONTAIN-ME', visibility: 'org' }];
    const context = buildAiContext(account, opp, scoreFromDomain(account, opp));

    const manifest = buildContextManifest(context, { includeRawLogs: false, includeForm: false });

    expect(manifest.entities.people).toBe(context.people.length);
    expect(manifest.fieldCategories).toContain('roles-and-sentiment');
    expect(manifest.excludedSensitiveCategories).toEqual(expect.arrayContaining(['private-bi', 'self-logs', 'raw-logs', 'form']));
    expect(JSON.stringify(manifest)).not.toContain('MANIFEST-MUST-NOT-CONTAIN-ME');
    expect(Object.values(manifest.entities).every(Number.isFinite)).toBe(true);
  });

  const advisorScope = (overrides: Partial<Parameters<typeof createAiRequestScope>[0]> = {}) => createAiRequestScope({
    accountId: 'account-a', opportunityId: 'opp-a', personId: 'person-a', manifestToken: 'token-a',
    options: { includeRawLogs: false, includeForm: false }, generation: 1, ...overrides,
  });

  it('accepts only the current request scope and rejects scope, person, option or generation drift', () => {
    const request = advisorScope();
    expect(isAiRequestScopeCurrent(request, advisorScope())).toBe(true);
    expect(isAiRequestScopeCurrent(request, advisorScope({ opportunityId: 'opp-b' }))).toBe(false);
    expect(isAiRequestScopeCurrent(request, advisorScope({ personId: 'person-b' }))).toBe(false);
    expect(isAiRequestScopeCurrent(request, advisorScope({ options: { includeRawLogs: true, includeForm: false } }))).toBe(false);
    expect(isAiRequestScopeCurrent(request, advisorScope({ generation: 2 }))).toBe(false);
  });

  it('accepts only the same current operation target, person, inputs and nonce', () => {
    const request = createAiOperationIdentity({
      kind: 'drawer-prefill', targetId: 'action-a', personId: 'person-a', inputs: ['标题', '场景'], nonce: 3,
    });
    expect(isAiOperationCurrent(request, createAiOperationIdentity({
      kind: 'drawer-prefill', targetId: 'action-a', personId: 'person-a', inputs: ['标题', '场景'], nonce: 3,
    }))).toBe(true);
    expect(isAiOperationCurrent(request, createAiOperationIdentity({
      kind: 'drawer-prefill', targetId: 'action-b', personId: 'person-a', inputs: ['标题', '场景'], nonce: 3,
    }))).toBe(false);
    expect(isAiOperationCurrent(request, createAiOperationIdentity({
      kind: 'drawer-prefill', targetId: 'action-a', personId: 'person-b', inputs: ['标题', '场景'], nonce: 3,
    }))).toBe(false);
    expect(isAiOperationCurrent(request, createAiOperationIdentity({
      kind: 'drawer-prefill', targetId: 'action-a', personId: 'person-a', inputs: ['改后标题', '场景'], nonce: 3,
    }))).toBe(false);
    expect(isAiOperationCurrent(request, createAiOperationIdentity({
      kind: 'drawer-prefill', targetId: 'action-a', personId: 'person-a', inputs: ['标题', '场景'], nonce: 4,
    }))).toBe(false);
  });

  it('rejects deleted card and milestone operation targets', () => {
    const card = createAiOperationIdentity({ kind: 'card-dispatch', targetId: 'card-a', inputs: ['打法'], nonce: 1 });
    const milestone = createAiOperationIdentity({ kind: 'milestone-plan', targetId: 'milestone-a', inputs: ['签约', '2026-08-01'], nonce: 1 });
    expect(isAiOperationCurrent(card, null)).toBe(false);
    expect(isAiOperationCurrent(milestone, null)).toBe(false);
  });

  it('continues only an assistant analysis created under the same manifest and person scope', () => {
    const scope = advisorScope();
    const result = buildAdvisorContinuationNote([
      { role: 'user', text: '这是我的新问题' },
      { role: 'assistant', text: '同范围分析', contextManifestToken: 'token-a', contextScopeKey: aiRequestScopeKey(scope) },
    ], scope);

    expect(result).toContain('我刚问：这是我的新问题');
    expect(result).toContain('你的分析要点：同范围分析');
  });

  it('keeps the user input but drops analysis when the manifest token changed', () => {
    const result = buildAdvisorContinuationNote([
      { role: 'user', text: '用户本人输入' },
      { role: 'assistant', text: '旧范围敏感分析', contextManifestToken: 'token-old', contextScopeKey: aiRequestScopeKey(advisorScope()) },
    ], advisorScope({ manifestToken: 'token-new' }));

    expect(result).toContain('我刚问：用户本人输入');
    expect(result).not.toContain('旧范围敏感分析');
  });

  it('drops analysis from another focus person even when the manifest token is identical', () => {
    const oldScope = advisorScope({ personId: 'person-old' });
    const result = buildAdvisorContinuationNote([
      { role: 'user', text: '当前问题' },
      { role: 'assistant', text: '另一个人的分析', contextManifestToken: 'token-a', contextScopeKey: aiRequestScopeKey(oldScope) },
    ], advisorScope({ personId: 'person-new' }));

    expect(result).toContain('我刚问：当前问题');
    expect(result).not.toContain('另一个人的分析');
  });

  it('does not continue a restored assistant message without a source token', () => {
    const result = buildAdvisorContinuationNote([
      { role: 'user', text: '恢复后的用户输入' },
      { role: 'assistant', text: '恢复的旧分析无标记' },
    ], advisorScope({ manifestToken: 'token-current' }));

    expect(result).toContain('恢复后的用户输入');
    expect(result).not.toContain('恢复的旧分析无标记');
  });

  it('keeps authoritative preflight disclosure in both AI trigger surfaces', () => {
    const advisor = readFileSync(new URL('./components/AdvisorPanel.tsx', import.meta.url), 'utf8');
    const dock = readFileSync(new URL('./components/DeliberationDock.tsx', import.meta.url), 'utf8');
    const disclosure = readFileSync(new URL('./components/AiContextDisclosure.tsx', import.meta.url), 'utf8');

    for (const source of [advisor, dock]) {
      expect(source).toContain('api.aiContextManifest(opp.id, contextOptions)');
      expect(source).toContain('<AiContextDisclosure');
      expect(source).toContain('!contextReady');
      expect(source.match(/setContextManifest\(result\.manifest\)/g)).toHaveLength(1);
      expect(source).not.toContain('setContextManifest(r.manifest)');
    }
    expect(advisor).toMatch(/api\.aiSimulate\([\s\S]{0,350}if \(!requestIsCurrent\(requestScope\)\) return;/);
    expect(advisor).toMatch(/api\.advisorActions\([\s\S]{0,350}if \(!requestIsCurrent\(requestScope\)\) return;/);
    expect(advisor).toMatch(/if \(!requestIsCurrent\(requestScope\)\) return;[\s\S]{0,180}api\.advisorAppend/);
    expect(dock).toMatch(/api\.strategySuggest\([\s\S]{0,250}if \(!requestIsCurrent\(requestScope\)\) return;/);
    expect(dock).toMatch(/api\.strategyPrefill\([\s\S]{0,300}if \(!requestIsCurrent\(requestScope\)\) return/);
    expect(dock).toMatch(/api\.milestoneActions\([\s\S]{0,500}if \(!requestIsCurrent\(requestScope\) \|\| !operationIsCurrent\(requestOperation\)\) return;/);
    expect(dock.match(/if \(!result\.current \|\| !requestIsCurrent\(requestScope\) \|\| !operationIsCurrent\(requestOperation\)\) return;/g)).toHaveLength(2);
    expect(dock).toContain('fwdCandidateScopeRef.current');
    expect(dock).toContain('bwdCandidateScopeRef.current');
    expect(advisor).toContain('visibleCands.map');
    expect(dock).toContain('visibleFwdCands.map');
    expect(dock).toContain('visibleBwdCands.map');
    expect(dock).toContain("setAiBusy(null); setAiErr(''); setMsBusy(null); setMsArranged({}); setPrefillBusy(null);");
    expect(dock).toContain('currentDrawerOperation');
    expect(dock).toContain('currentCardOperation');
    expect(dock).toContain('currentMilestoneOperation');
    expect((dock.match(/operationIsCurrent\(requestOperation\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(disclosure).toContain('manifest.excludedSensitiveCategories.map');
    expect(disclosure).toContain('manifest.entities.interactionLogs');
  });

  it('keeps embedded and full manuals aligned to real internal workflows', () => {
    const embedded = readFileSync(new URL('./components/HelpManual.tsx', import.meta.url), 'utf8');
    const full = readFileSync(new URL('../../docs/用户手册.md', import.meta.url), 'utf8');
    for (const manual of [embedded, full]) {
      expect(manual).toContain('Workbuddy');
      expect(manual).toContain('MCP Token');
      expect(manual).toContain('收件箱');
      expect(manual).toContain('人审');
      expect(manual).toContain('纠错');
      expect(manual).toContain('合并');
      expect(manual).toContain('恢复');
      expect(manual).toContain('失败');
      expect(manual).not.toMatch(/PDF|Excel|合并快捷键|实时同步承诺/);
    }
  });
});
