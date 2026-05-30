import type { Suggestion } from '../api';
import { Modal } from './Modal';

const LAYER_COLOR: Record<string, string> = { L1: '#2563eb', L2: '#9333ea', L3: '#16a34a', L4: '#ef4444' };
const ORIGIN: Record<string, string> = { graph: '📊 图谱', llm: '🤖 AI', qcc: '🏢 企查查' };

export function SuggestionPanel({
  suggestions, generating, onRegenerate, onAccept, onReject, onClose,
}: {
  suggestions: Suggestion[];
  generating: boolean;
  onRegenerate: () => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal title="🔮 AI 关系推断（待确认）" width={620} onClose={onClose}
      footer={<>
        <span className="hint-text" style={{ margin: 0, marginRight: 'auto' }}>AI 只给候选，采纳后才画到墙上 · 绝不自动写入</span>
        <button className="btn ghost" onClick={onClose}>关闭</button>
        <button className="btn primary" onClick={onRegenerate} disabled={generating}>{generating ? '扫描中…' : '🔍 重新扫描'}</button>
      </>}>

      {suggestions.length === 0 ? (
        <div className="sc-empty" style={{ padding: '28px 0' }}>
          <div style={{ fontSize: 30 }}>🔮</div>
          <div>{generating ? '正在用图算法 + AI 挖掘潜在关系…' : '暂无候选关系。点「重新扫描」让 AI 基于共同联系人、籍贯/校友等挖掘。'}</div>
          {!generating && <button className="btn primary sm" onClick={onRegenerate}>🔍 开始扫描</button>}
        </div>
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
