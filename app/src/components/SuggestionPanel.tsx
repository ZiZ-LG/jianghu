import type { Suggestion, PersonSuggestion } from '../api';
import { Modal } from './Modal';

const LAYER_COLOR: Record<string, string> = { L1: '#2563eb', L2: '#9333ea', L3: '#16a34a', L4: '#ef4444' };
const ORIGIN: Record<string, string> = { graph: '📊 图谱', llm: '🤖 AI', qcc: '🏢 企查查', mcp: '🌐 AI 调研' };

export function SuggestionPanel({
  suggestions, generating, onRegenerate, onAccept, onReject, onClose,
  personSuggs = [], onAcceptPerson, onRejectPerson,
}: {
  suggestions: Suggestion[];
  generating: boolean;
  onRegenerate: () => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onClose: () => void;
  personSuggs?: PersonSuggestion[];
  onAcceptPerson?: (id: string) => void;
  onRejectPerson?: (id: string) => void;
}) {
  return (
    <Modal title="🔮 AI 关系推断 + 候选干系人（待确认）" width={620} onClose={onClose}
      footer={<>
        <span className="hint-text" style={{ margin: 0, marginRight: 'auto' }}>AI/外部调研只给候选，采纳后才上墙 · 绝不自动写入</span>
        <button className="btn ghost" onClick={onClose}>关闭</button>
        <button className="btn primary" onClick={onRegenerate} disabled={generating}>{generating ? '扫描中…' : '🔍 重新扫描'}</button>
      </>}>

      {/* 候选干系人（外部 agent 经 MCP 提议的新人物）*/}
      {personSuggs.length > 0 && (
        <>
          <div className="sug-section-t">🌐 候选干系人（外部调研提议，采纳后建节点上墙）</div>
          <div className="sug-list" style={{ marginBottom: 16 }}>
            {personSuggs.map((p) => (
              <div key={p.id} className="sug-row">
                <div className="sug-main">
                  <div className="sug-pair">
                    <b>{p.name}</b>
                    {p.title && <span className="sug-edge" style={{ color: '#64748b' }}>· {p.title}</span>}
                    <span className="sug-conf">{Math.round(p.confidence * 100)}%</span>
                  </div>
                  <div className="sug-meta">
                    <span className="sug-origin">{ORIGIN[p.origin] || p.origin}</span>
                    {p.existingPersonId && <span className="sug-lyr" style={{ background: '#f59e0b' }}>已有同名</span>}
                    <span className="sug-ev">{p.evidence}{p.sourceUrl ? ` · ${p.sourceUrl}` : ''}</span>
                  </div>
                </div>
                <div className="sug-actions">
                  <button className="btn primary sm" onClick={() => onAcceptPerson?.(p.id)}>采纳</button>
                  <button className="btn ghost sm" onClick={() => onRejectPerson?.(p.id)}>忽略</button>
                </div>
              </div>
            ))}
          </div>
          <div className="sug-section-t">🔗 候选关系</div>
        </>
      )}

      {suggestions.length === 0 && personSuggs.length === 0 ? (
        <div className="sc-empty" style={{ padding: '28px 0' }}>
          <div style={{ fontSize: 30 }}>🔮</div>
          <div>{generating ? '正在用图算法 + AI 挖掘潜在关系…' : '暂无候选关系。点「重新扫描」让 AI 基于共同联系人、籍贯/校友等挖掘。'}</div>
          {!generating && <button className="btn primary sm" onClick={onRegenerate}>🔍 开始扫描</button>}
        </div>
      ) : suggestions.length === 0 ? (
        <div className="empty-hint" style={{ padding: '8px 2px' }}>暂无候选关系（可点「重新扫描」生成，或由外部 agent 经 MCP 提议）。</div>
      ) : (
        <div className="sug-list">
          {suggestions.map((s) => (
            <div key={s.id} className="sug-row">
              <div className="sug-main">
                <div className="sug-pair">
                  <b>{s.sourceName}</b>
                  <span className="sug-edge" style={{ color: LAYER_COLOR[s.layer] }}>— {s.label} —</span>
                  <b>{s.targetName}</b>
                  <span className="sug-conf">{Math.round(s.confidence * 100)}%</span>
                </div>
                <div className="sug-meta">
                  <span className="sug-origin">{ORIGIN[s.origin] || s.origin}</span>
                  <span className="sug-lyr" style={{ background: LAYER_COLOR[s.layer] }}>{s.layer}</span>
                  <span className="sug-ev">{s.evidence}</span>
                </div>
              </div>
              <div className="sug-actions">
                <button className="btn primary sm" onClick={() => onAccept(s.id)}>采纳</button>
                <button className="btn ghost sm" onClick={() => onReject(s.id)}>忽略</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
