import { useMemo } from 'react';
import type { Account, Opportunity, Sentiment } from '../types';
import { SENTIMENT_CHAR, SENTIMENT_LABEL, SENTIMENT_COLOR, ENGAGE_STAGES, C3_ITEMS, C5_ITEMS } from '../types';
import type { Action } from '../store';
import { Modal } from './Modal';
import { computeGaps } from '../lib/gaps';

// 态度点选：从"未知"改起，故不列 unknown；点了即视为「明确」确认（进 P1 计分）。
const SENT_OPTS: Sentiment[] = ['star', 'plus', 'neutral', 'minus', 'x'];

/**
 * 补分清单（M3）：把 G64111 低分项变成一叠「待确认卡片」，按性价比排序，点选即更新趋赢力——
 * 把周复盘/补分从「面对表单填空」变成「刷卡」。复用现有 Action 落库，0 schema。
 */
export function GapCards({ account, opp, dispatch, onClose }: {
  account: Account;
  opp: Opportunity;
  dispatch: (a: Action) => void;
  onClose: () => void;
}) {
  const gaps = useMemo(() => computeGaps(account, opp), [account, opp]);
  const influencerCandidates = opp.roles.filter((r) => r.role !== 'A' && r.role !== 'D');
  const nameOf = (id: string) => account.persons.find((p) => p.id === id)?.name ?? '?';

  return (
    <Modal title="📋 补分清单 · 点一下就记下" width={520} onClose={onClose}
      footer={<>
        <span className="hint-text" style={{ marginRight: 'auto' }}>按性价比排序 · 点选即更新趋赢力，不必填表</span>
        <button className="btn primary" onClick={onClose}>完成</button>
      </>}>
      {gaps.length === 0 ? (
        <div className="sc-empty" style={{ padding: '28px 0' }}>
          <div style={{ fontSize: 30 }}>✅</div>
          <div>暂无明显缺口——这个商机的 G64111 已经填得不错了。</div>
        </div>
      ) : (
        <div className="gap-list">
          {gaps.map((g) => (
            <div key={g.id} className="gap-card">
              <div className="gap-head">
                <span className="gap-item">{g.item}</span>
                <b className="gap-title">{g.title}</b>
              </div>
              <div className="gap-hint">{g.hint}</div>
              <div className="gap-ops">
                {g.action.kind === 'sentiment' && SENT_OPTS.map((s) => (
                  <button key={s} className="gap-sent" style={{ color: SENTIMENT_COLOR[s] }} title={SENTIMENT_LABEL[s]}
                    onClick={() => dispatch({ type: 'SET_ROLE', accId: account.id, oppId: opp.id, personId: (g.action as { personId: string }).personId, patch: { sentiment: s, confidence: '明确' } })}>
                    <span className="gs-char">{SENTIMENT_CHAR[s]}</span>{SENTIMENT_LABEL[s]}
                  </button>
                ))}
                {g.action.kind === 'c3' && C3_ITEMS.filter((k) => !opp.c3Items[k]).map((k) => (
                  <button key={k} className="gap-chip" onClick={() => dispatch({ type: 'UPDATE_OPP', accId: account.id, oppId: opp.id, patch: { c3Items: { ...opp.c3Items, [k]: true } } })}>＋ {k}</button>
                ))}
                {g.action.kind === 'c5' && C5_ITEMS.filter((k) => !opp.c5Items[k]).map((k) => (
                  <button key={k} className="gap-chip" onClick={() => dispatch({ type: 'UPDATE_OPP', accId: account.id, oppId: opp.id, patch: { c5Items: { ...opp.c5Items, [k]: true } } })}>＋ {k}</button>
                ))}
                {g.action.kind === 'c4' && ENGAGE_STAGES.map((s) => (
                  <button key={s} className="gap-chip" onClick={() => dispatch({ type: 'UPDATE_OPP', accId: account.id, oppId: opp.id, patch: { engageStage: s } })}>{s}</button>
                ))}
                {g.action.kind === 'key-influencer' && (influencerCandidates.length
                  ? influencerCandidates.map((r) => (
                    <button key={r.personId} className="gap-chip" onClick={() => dispatch({ type: 'SET_ROLE', accId: account.id, oppId: opp.id, personId: r.personId, patch: { isKeyInfluencer: true } })}>{nameOf(r.personId)}（{r.role}）</button>
                  ))
                  : <span className="gap-guide">→ 先在画布上加一个非 A/D 的影响者角色</span>)}
                {g.action.kind === 'guide' && <span className="gap-guide">→ 去「{g.action.to}」处理</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
