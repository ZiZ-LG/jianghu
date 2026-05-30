import type { ReactNode } from 'react';

// 极简、安全的 Markdown 渲染（不使用 dangerouslySetInnerHTML，避免 XSS）
// 支持：#~#### 标题、> 引用、- 列表、**加粗**、空行分段
function inline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    /^\*\*[^*]+\*\*$/.test(p) ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>,
  );
}

export function Markdownish({ text }: { text: string }) {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flush = () => { if (list.length) { out.push(<ul key={`ul${out.length}`} className="md-ul">{list}</ul>); list = []; } };

  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*[-*]\s+/.test(line)) { list.push(<li key={i}>{inline(line.replace(/^\s*[-*]\s+/, ''))}</li>); return; }
    flush();
    if (!line.trim()) return;
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push(<div key={i} className={`md-h md-h${h[1].length}`}>{inline(h[2])}</div>); return; }
    if (/^>\s?/.test(line)) { out.push(<div key={i} className="md-quote">{inline(line.replace(/^>\s?/, ''))}</div>); return; }
    out.push(<p key={i} className="md-p">{inline(line)}</p>);
  });
  flush();
  return <div className="md">{out}</div>;
}
