import type { VisitNote } from '../types';

/** 拜访记录时间线（只读展示）。WorkBuddy 经 MCP 同步、或前端手动添加的拜访记录在此按日期倒序展示。 */
export function VisitTimeline({ visits, oppNameById }: {
  visits: VisitNote[];
  oppNameById?: Map<string, string>;
}) {
  if (!visits.length) {
    return <div className="empty-hint">暂无拜访记录（销售包同步后在此展示）</div>;
  }
  // 按 date 倒序（后端已 desc，这里再保险一次）
  const sorted = [...visits].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return (
    <div className="timeline">
      {sorted.map((v) => {
        const oppName = v.opportunityId ? oppNameById?.get(v.opportunityId) : undefined;
        return (
          <div className="tl-item" key={v.id}>
            <div className="dt">
              {v.date || '未注明日期'}
              {v.topic && <span className="visit-topic"> · {v.topic}</span>}
              {oppName && <span className="visit-opp">📌 {oppName}</span>}
              {v.origin === 'workbuddy' && <span className="visit-origin">WorkBuddy</span>}
            </div>
            <div className="ct">
              {v.summary || <span style={{ color: 'var(--faint)' }}>（无纪要）</span>}
              {v.participants && v.participants.length > 0 && (
                <div className="visit-parts">
                  {v.participants.map((p, i) => (
                    <span key={i} className={`vp-chip ${p.side}`}>{p.name}<i>{p.side === 'our' ? '我方' : '客户'}</i></span>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
