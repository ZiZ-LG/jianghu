// 右栏「焦点面板」：跟选中的人走，身份头 + 三 tab（档案 / 动态 / 参谋）。
// tab 受控（App 管：单击节点→参谋、双击→档案；选中即现面板）。
// 档案＝复用 DetailDrawer(embedded) + 头部引擎立场条（M5 StanceRangeBar 嵌入式：三色分布+n_eff 角标，点击跳动态看证据）；
// 动态＝person.logs + 该人参与的 VisitNote，按日期倒序、带溯源；参谋＝ChatPanel(P2 升级为带全图上下文的深度参谋)。
import { useEffect, useState, type Dispatch } from 'react';
import type { Account, Opportunity, Person, OppRole, BurningIssue, UCV, VisitNote } from '../types';
import { ROLE_LABEL, SENTIMENT_LABEL } from '../types';
import type { Action } from '../store';
import { DetailDrawer } from './DetailDrawer';
import { ReadonlyProfile } from './ReadonlyProfile';
import { AdvisorPanel } from './AdvisorPanel';
import type { ScoreBreakdown } from '../lib/g64111';
import { api } from '../api';
import type { SessionLease } from '../lib/sessionLifecycle';
import type { MutationCoordinator } from '../lib/sync/mutationCoordinator';

type Tab = 'profile' | 'dynamic' | 'advisor';
type DynItem = { date: string; title?: string; body: string; source: string; sensitive?: boolean; pending?: boolean };
// M5 立场条数据（PDE ev.stakeholders 逐人分布；支持/中立/反对语义色同 types.ts 惯例）
type StanceDetail = { id: string; pS: number; pN: number; pO: number; n_eff: number };

export function FocusPanel({
  accId, oppId, account, opp, breakdown, person, oppRole, bis, ucvs, visitNotes, tab, onTabChange, dispatch, sessionLease, draftDispatch, flushDraft, coordinator, onRefresh, onViewCloud, onClose, onRepairRecord, readonly = false,
}: {
  accId: string; oppId: string;
  account: Account; opp: Opportunity; breakdown: ScoreBreakdown;
  person: Person; oppRole?: OppRole; bis: BurningIssue[]; ucvs: UCV[];
  visitNotes: VisitNote[];
  tab: Tab; onTabChange: (t: Tab) => void;
  dispatch: Dispatch<Action>;
  sessionLease: SessionLease;
  draftDispatch?: Dispatch<Action>;
  flushDraft?: (action: Action) => void | Promise<void>;
  coordinator?: MutationCoordinator;
  onRefresh: () => void; // 参谋改图后刷新整树
  onViewCloud?: () => void | Promise<void>;
  onClose: () => void;
  onRepairRecord?: (kind: 'visitNote' | 'note', id: string) => void;
  readonly?: boolean; // viewer 只读投影：档案纯呈现、参谋 tab 不渲染（契约 v1.0 §二-1）
}) {
  const f = person.form;
  const formFilled = [f.family, f.occupation, f.recreation, f.moneyMotivation].filter(Boolean).length;

  // M5 · 引擎立场分布（商机级 fetch，切人不重拉；引擎不可用/该人不在牌局→静默隐藏，同坞头徽章惯例）
  const [stances, setStances] = useState<StanceDetail[] | null>(null);
  useEffect(() => {
    let alive = true;
    api.pdeEv(opp.id)
      .then((r) => { if (alive) setStances(r.stakeholders ?? null); })
      .catch(() => { if (alive) setStances(null); });
    return () => { alive = false; };
  }, [opp.id, breakdown]);
  const myStance = !person.isCompetitor ? stances?.find((s) => s.id === person.id) : undefined;

  // 动态时间线：交往日志(人级) + 该人参与的拜访记录(name 匹配) + PDE 行为信号证据(M3/M5 EvidenceTimeline 并入，待审高亮)，按日期倒序、带溯源
  const evDyn: DynItem[] = (opp.evidenceEvents ?? [])
    .filter((e) => e.personId === person.id && e.status !== 'rejected')
    .map((e) => ({
      date: e.occurredAt || (e.createdAt ?? '').slice(0, 10),
      title: `⚡ ${e.direction > 0 ? '＋利好' : e.direction < 0 ? '－不利' : '○中性'}信号 · ${e.signalKey}`,
      body: e.rawContent || '（无原文）',
      source: `证据 · ${e.origin === 'manual' ? '手动/回填' : e.origin === 'voice' ? '🎙️ 口述' : '🎧 录音'}${e.status === 'pending_review' ? ' · ⏳待审核（未参与计算）' : ''}`,
      pending: e.status === 'pending_review',
    }));
  const dyn: DynItem[] = [
    ...person.logs.map((l) => ({ date: l.date, body: l.content, source: '交往日志', sensitive: l.sensitive })),
    ...visitNotes
      .filter((vn) => vn.participants.some((p) => p.name === person.name))
      .map((vn) => ({ date: vn.date, title: vn.topic, body: vn.summary, source: `拜访 · ${vn.origin === 'mcp' ? '外部·MCP·待核' : vn.origin === 'workbuddy' ? 'WorkBuddy' : '手动'}` })),
    ...evDyn,
  ].sort((a, b) => (a.date < b.date ? 1 : -1));
  const repairRecords = [
    ...visitNotes
      .filter((visit) => visit.participants.some((participant) => participant.name === person.name))
      .map((visit) => ({ kind: 'visitNote' as const, id: visit.id, label: visit.topic || visit.date || '拜访记录', source: visit.origin || 'manual' })),
    ...(account.notes ?? [])
      .filter((note) => note.personId === person.id)
      .map((note) => ({ kind: 'note' as const, id: note.id, label: note.content.slice(0, 24) || '笔记', source: note.source || 'manual' })),
  ];

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
        {!readonly && <button className={`focus-tab ${tab === 'advisor' ? 'on' : ''}`} onClick={() => onTabChange('advisor')}>🧭 参谋</button>}
      </div>

      <div className="focus-body">
        {(tab === 'profile' || (readonly && tab === 'advisor')) && (
          <>
            {myStance && (
              <div className="stance-bar" title={`引擎立场分布：支持 ${Math.round(myStance.pS * 100)}% / 中立 ${Math.round(myStance.pN * 100)}% / 反对 ${Math.round(myStance.pO * 100)}%（等效样本 n≈${myStance.n_eff.toFixed(1)}）。点击看证据时间线`}
                onClick={() => onTabChange('dynamic')}>
                <span className="stance-bar-cap">引擎立场</span>
                <div className="stance-bar-track">
                  <i className="s" style={{ width: `${myStance.pS * 100}%` }} />
                  <i className="n" style={{ width: `${myStance.pN * 100}%` }} />
                  <i className="o" style={{ width: `${myStance.pO * 100}%` }} />
                </div>
                <span className={`stance-bar-neff${myStance.n_eff < 3 ? ' thin' : ''}`}>n≈{myStance.n_eff.toFixed(1)}{myStance.n_eff < 3 ? ' · 样本薄' : ''}</span>
              </div>
            )}
            {readonly
              ? <ReadonlyProfile person={person} oppRole={oppRole} bis={bis} ucvs={ucvs} />
              : <DetailDrawer key={person.id} embedded accId={accId} oppId={oppId} person={person}
                  primaryDPersonId={opp.primaryDPersonId}
                  oppRole={oppRole} bis={bis} ucvs={ucvs} dispatch={dispatch} draftDispatch={draftDispatch}
                  flushDraft={flushDraft} coordinator={coordinator} onViewCloud={onViewCloud ?? onRefresh} onClose={onClose}
                  repairRecords={repairRecords} onRepairRecord={onRepairRecord} />}
          </>
        )}

        {tab === 'dynamic' && (
          dyn.length > 0 ? (
            <div className="focus-tl">
              {dyn.map((it, i) => (
                <div className={`focus-tl-item${it.pending ? ' focus-tl-pending' : ''}`} key={i}>
                  <div className="focus-tl-date">{it.date}{it.sensitive && <span className="sensitive-tag">敏感·仅团队</span>}</div>
                  {it.title && <div className="focus-tl-title">{it.title}</div>}
                  <div className="focus-tl-body">{it.body}</div>
                  <span className="focus-tl-src">溯源：{it.source}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="focus-empty">暂无动态。{!readonly && <><br />在「档案」记一次交往日志，或用录音 / 口述录入，都会汇到这条时间线。</>}</div>
          )
        )}

        {tab === 'advisor' && !readonly && (
          <AdvisorPanel account={account} opp={opp} breakdown={breakdown} person={person} dispatch={dispatch} sessionLease={sessionLease} />
        )}
      </div>
    </div>
  );
}
