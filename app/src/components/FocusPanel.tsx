// 右栏「焦点面板」：跟选中的人走，身份头 + 三 tab（档案 / 动态 / 参谋）。
// 档案＝复用 DetailDrawer(embedded)；动态＝person.logs 时间线(后续汇入录音/态度变更)；参谋＝ChatPanel(P2 升级为带全图上下文的深度参谋)。
// P1-a：触发仍走双击(drawerPersonId)，默认停「档案」tab；单击→参谋、关系焦点等为后续增量。
import { useState } from 'react';
import type { Dispatch } from 'react';
import type { Account, Opportunity, Person, OppRole, BurningIssue, UCV } from '../types';
import { ROLE_LABEL, SENTIMENT_LABEL } from '../types';
import type { Action } from '../store';
import { DetailDrawer } from './DetailDrawer';
import { ChatPanel } from './ChatPanel';

type Tab = 'profile' | 'dynamic' | 'advisor';

export function FocusPanel({
  accId, oppId, account, opp, person, oppRole, bis, ucvs, dispatch, onRefresh, onClose,
}: {
  accId: string; oppId: string;
  account: Account; opp: Opportunity;
  person: Person; oppRole?: OppRole; bis: BurningIssue[]; ucvs: UCV[];
  dispatch: Dispatch<Action>;
  onRefresh: () => void; // 参谋改图后刷新整树
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('profile');

  const f = person.form;
  const formFilled = [f.family, f.occupation, f.recreation, f.moneyMotivation].filter(Boolean).length;
  const logs = [...person.logs].reverse(); // 最新在上

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
        <button className={`focus-tab ${tab === 'profile' ? 'on' : ''}`} onClick={() => setTab('profile')}>📇 档案</button>
        <button className={`focus-tab ${tab === 'dynamic' ? 'on' : ''}`} onClick={() => setTab('dynamic')}>📝 动态</button>
        <button className={`focus-tab ${tab === 'advisor' ? 'on' : ''}`} onClick={() => setTab('advisor')}>🧭 参谋</button>
      </div>

      <div className="focus-body">
        {tab === 'profile' && (
          <DetailDrawer embedded accId={accId} oppId={oppId} person={person}
            oppRole={oppRole} bis={bis} ucvs={ucvs} dispatch={dispatch} onClose={onClose} />
        )}

        {tab === 'dynamic' && (
          logs.length > 0 ? (
            <div className="focus-tl">
              {logs.map((log, i) => (
                <div className="focus-tl-item" key={i}>
                  <div className="focus-tl-date">{log.date}{log.sensitive && <span className="sensitive-tag">敏感·仅团队</span>}</div>
                  <div className="focus-tl-body">{log.content}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="focus-empty">暂无动态。<br />在「档案」记一次交往日志，或用录音 / 口述录入，都会汇到这条时间线。</div>
          )
        )}

        {tab === 'advisor' && (
          <ChatPanel account={account} opp={opp} onDone={onRefresh} />
        )}
      </div>
    </div>
  );
}
