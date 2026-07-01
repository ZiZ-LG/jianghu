// 右栏「焦点面板」：跟选中的人走，身份头 + 三 tab（档案 / 动态 / 参谋）。
// tab 受控（App 管：单击节点→参谋、双击→档案；选中即现面板）。
// 档案＝复用 DetailDrawer(embedded)；动态＝person.logs + 该人参与的 VisitNote，按日期倒序、带溯源；参谋＝ChatPanel(P2 升级为带全图上下文的深度参谋)。
import type { Dispatch } from 'react';
import type { Account, Opportunity, Person, OppRole, BurningIssue, UCV, VisitNote } from '../types';
import { ROLE_LABEL, SENTIMENT_LABEL } from '../types';
import type { Action } from '../store';
import { DetailDrawer } from './DetailDrawer';
import { AdvisorPanel } from './AdvisorPanel';
import type { ScoreBreakdown } from '../lib/g64111';

type Tab = 'profile' | 'dynamic' | 'advisor';
type DynItem = { date: string; title?: string; body: string; source: string; sensitive?: boolean };

export function FocusPanel({
  accId, oppId, account, opp, breakdown, person, oppRole, bis, ucvs, visitNotes, tab, onTabChange, dispatch, onRefresh, onClose,
}: {
  accId: string; oppId: string;
  account: Account; opp: Opportunity; breakdown: ScoreBreakdown;
  person: Person; oppRole?: OppRole; bis: BurningIssue[]; ucvs: UCV[];
  visitNotes: VisitNote[];
  tab: Tab; onTabChange: (t: Tab) => void;
  dispatch: Dispatch<Action>;
  onRefresh: () => void; // 参谋改图后刷新整树
  onClose: () => void;
}) {
  const f = person.form;
  const formFilled = [f.family, f.occupation, f.recreation, f.moneyMotivation].filter(Boolean).length;

  // 动态时间线：交往日志(人级) + 该人参与的拜访记录(name 匹配)，按日期倒序、带溯源
  const dyn: DynItem[] = [
    ...person.logs.map((l) => ({ date: l.date, body: l.content, source: '交往日志', sensitive: l.sensitive })),
    ...visitNotes
      .filter((vn) => vn.participants.some((p) => p.name === person.name))
      .map((vn) => ({ date: vn.date, title: vn.topic, body: vn.summary, source: `拜访 · ${vn.origin === 'workbuddy' ? 'WorkBuddy' : '手动'}` })),
  ].sort((a, b) => (a.date < b.date ? 1 : -1));

  return (
    <div className="drawer focus-panel">
      <div className="focus-head">
        <div className="focus-id">
          <div className="focus-avatar">{person.name[0] || '?'}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="focus-name">{person.name}</div>
            <div className="focus-title">{person.title || '—'}</div>
          </div>
          <button className="x-btn" onClick={onClose} aria-label="关闭">×</button>
        </div>
        {!person.isCompetitor && (
          <div className="focus-tags">
            <span className="focus-tag role">{oppRole?.role ? `${oppRole.role} · ${ROLE_LABEL[oppRole.role]}` : '未分配角色'}</span>
            {oppRole?.sentiment && <span className="focus-tag">{SENTIMENT_LABEL[oppRole.sentiment]}</span>}
            <span className="focus-tag">FORM {formFilled}/4</span>
          </div>
        )}
      </div>

      <div className="focus-tabs">
        <button className={`focus-tab ${tab === 'profile' ? 'on' : ''}`} onClick={() => onTabChange('profile')}>📇 档案</button>
        <button className={`focus-tab ${tab === 'dynamic' ? 'on' : ''}`} onClick={() => onTabChange('dynamic')}>📝 动态</button>
        <button className={`focus-tab ${tab === 'advisor' ? 'on' : ''}`} onClick={() => onTabChange('advisor')}>🧭 参谋</button>
      </div>

      <div className="focus-body">
        {tab === 'profile' && (
          <DetailDrawer embedded accId={accId} oppId={oppId} person={person}
            oppRole={oppRole} bis={bis} ucvs={ucvs} dispatch={dispatch} onClose={onClose} />
        )}

        {tab === 'dynamic' && (
          dyn.length > 0 ? (
            <div className="focus-tl">
              {dyn.map((it, i) => (
                <div className="focus-tl-item" key={i}>
                  <div className="focus-tl-date">{it.date}{it.sensitive && <span className="sensitive-tag">敏感·仅团队</span>}</div>
                  {it.title && <div className="focus-tl-title">{it.title}</div>}
                  <div className="focus-tl-body">{it.body}</div>
                  <span className="focus-tl-src">溯源：{it.source}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="focus-empty">暂无动态。<br />在「档案」记一次交往日志，或用录音 / 口述录入，都会汇到这条时间线。</div>
          )
        )}

        {tab === 'advisor' && (
          <AdvisorPanel account={account} opp={opp} breakdown={breakdown} person={person} dispatch={dispatch} />
        )}
      </div>
    </div>
  );
}
