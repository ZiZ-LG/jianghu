// 对象级时点戳 + 新鲜度点（契约 v1.0 §三-②）——数据源 = MCP upsert 落库时间（_mcpOrigin.at）。
// 语义红线：这是「我多久没被数字员工推过」的新鲜度指示器，不是 7×24 心跳监控——
// 文案绝不出现「在线/离线」；同步失败的告知责任在销售包侧（收口对话内直说），江湖不展示失败状态。
// 阈值：🟢 ≤36h（昨晚收口推过）；🟡 >72h（连续没收口或同步断了）；36-72h 之间只显时点戳、不标点。
import type { McpOriginMark } from '../types';

const H = 3600_000;

export function freshnessInfo(mark?: McpOriginMark): { label: string; dot: 'green' | 'yellow' | null; title: string } | null {
  if (!mark?.at) return null;
  const t = Date.parse(mark.at);
  if (Number.isNaN(t)) return null;
  const ms = Date.now() - t;
  const hours = ms / H;
  const ago = ms < 60_000 ? '刚刚'
    : ms < H ? `${Math.floor(ms / 60_000)} 分钟前`
    : hours < 48 ? `${Math.floor(hours)} 小时前`
    : `${Math.floor(hours / 24)} 天前`;
  return {
    label: `${ago}由数字员工更新`,
    dot: hours <= 36 ? 'green' : hours > 72 ? 'yellow' : null,
    title: `最近一次由数字员工（销售包 MCP 同步）更新：${mark.at.slice(0, 16).replace('T', ' ')}${hours > 72 ? '——超过 72 小时未收口同步，注意时效' : ''}`,
  };
}

/** 时点戳 chip：无 _mcpOrigin（纯江湖手工数据）不渲染。 */
export function Freshness({ mark }: { mark?: McpOriginMark }) {
  const f = freshnessInfo(mark);
  if (!f) return null;
  return (
    <span className="fresh-chip" title={f.title}>
      {f.dot && <i className={`fresh-dot ${f.dot}`} />}
      {f.label}
    </span>
  );
}
