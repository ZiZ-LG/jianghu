import { useMemo } from 'react';
import type { Account, Opportunity, Sentiment } from '../types';
import { SENTIMENT_CHAR, SENTIMENT_LABEL, SENTIMENT_COLOR, ENGAGE_STAGES, C3_ITEMS, C5_ITEMS } from '../types';
import type { Action } from '../store';
import { Modal } from './Modal';
import { computeGaps } from '../lib/gaps';

// 态度点选：从"未知"改起，故不列 unknown；点了即视为「明确」确认（进 P1 计分）。
const SENT_OPTS: Sentiment[] = ['star', 'plus', 'neutral', 'minus', 'x'];

/**
 * 补情报清单（M3 → P1③ 问题化 framing）：同一份缺口两种货架——
 * 「下次拜访带着问」（态度/BI/FORM/UCV/招采关键人，标题即问句，见完回来点选）在前，
 * 「案头当场能勾」（C3/C5 材料等）在后。把「补分」从填表动作变回销售动作。
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
  const shelves = [
    { key: 'visit', head: '🚶 下次拜访带着问', items: gaps.filter((g) => g.shelf === 'visit') },
    { key: 'desk', head: '🪑 案头当场能勾', items: gaps.filter((g) => g.shelf === 'desk') },
  ].filter((s) => s.items.length > 0);

  return (
    <Modal title="🎒 下次拜访问什么 · 缺口即问题" width={520} onClose={onClose}
      footer={<>
        <span className="hint-text" style={{ marginRight: 'auto' }}>按情报性价比排序 · 问到/勾上即更新趋赢力</span>
        <button className="btn primary" onClick={onClose}>完成</button>
      </>}>
      {gaps.length === 0 ? (
        <div className="sc-empty" style={{ padding: '28px 0' }}>
          <div style={{ fontSize: 30 }}>✅</div>
          <div>暂无明显缺口——这个商机的 G64111 已经填得不错了。</div>
        </div>
      ) : (
        <div className="gap-list">
          {shelves.map((shelf) => (<div key={shelf.key} className="gap-shelf">
          <div className="gap-shelf-head">{shelf.head}</div>
          {shelf.items.map((g) => (
            <div key={g.id} className="gap-card">
              <div className="gap-head">
                <span className="gap-item">{g.item}</span>
                <b className="gap-title">{g.ask ?? g.title}</b>
              </div>
              <div className="gap-hint">{g.ask ? `${g.title} · ${g.hint}` : g.hint}</div>
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
          </div>))}
        </div>
      )}
    </Modal>
  );
}
