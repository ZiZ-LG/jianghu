import type { VisitNote } from '../types';

/** 拜访记录时间线。WorkBuddy 同步 / 前端手动添加的拜访记录按日期倒序展示。
 *  传入 onExtract → 每条纪要可「🪄 抽取成图」(M1)：把 summary 喂给录入情报抽取管线，
 *  自动落人物/角色/关系，拿不准的进候选；已抽取过的显示「↻ 重新抽取」。 */
export function VisitTimeline({ visits, oppNameById, onExtract, extractingId, extractedIds }: {
  visits: VisitNote[];
  oppNameById?: Map<string, string>;
  onExtract?: (v: VisitNote) => void;
  extractingId?: string | null;
  extractedIds?: Set<string>;
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
        const canExtract = Boolean(onExtract && v.summary?.trim());
        const busy = extractingId === v.id;
        const done = extractedIds?.has(v.id);
        return (
          <div className="tl-item" key={v.id}>
            <div className="dt">
              {v.date || '未注明日期'}
              {v.topic && <span className="visit-topic"> · {v.topic}</span>}
              {oppName && <span className="visit-opp">📌 {oppName}</span>}
              {v.origin === 'workbuddy' && <span className="visit-origin">WorkBuddy</span>}
              {v.origin === 'mcp' && <span className="visit-origin" style={{ background: '#f59e0b', color: '#fff' }} title="外部 MCP 工具写入·待你核实">外部·MCP·待核</span>}
              {canExtract && (
                <button className="btn ghost sm visit-extract" disabled={busy} onClick={() => onExtract!(v)}
                  title="把这条纪要自动整理成图上的人物 / 角色 / 关系，拿不准的进候选待你确认">
                  {busy ? '整理中…' : done ? '↻ 重新抽取' : '🪄 抽取成图'}
                </button>
              )}
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
