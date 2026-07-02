// P2 引擎心跳（三环评价：无心跳→后台价值零感知）：一行「引擎 · 昨夜巡检 N 商机 · M 条新提醒」。
// 数据=inbox 响应的 patrol（本租户最近一轮巡检统计）；呼吸绿点=生命迹象。null（刚重启/无活跃商机）→ 不渲染。
import type { PatrolInfo } from '../api';

function fmtWhen(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.getHours() < 9 ? '今晨' : '今天';
  if (new Date(now.getTime() - 86400000).toDateString() === d.toDateString()) return d.getHours() >= 21 ? '昨夜' : '昨天';
  return `${d.getMonth() + 1}/${d.getDate()} `;
}

export function EnginePulse({ patrol }: { patrol?: PatrolInfo | null }) {
  if (!patrol) return null;
  const tip = `引擎最近一轮巡检 ${new Date(patrol.at).toLocaleString()}：扫 ${patrol.scanned} 个活跃商机，新增 ${patrol.created} 条提醒，自动消除 ${patrol.resolved} 条（每日一轮·确定性规则·零 LLM）`;
  return (
    <span className="engine-pulse" title={tip}>
      引擎 · {fmtWhen(patrol.at)}巡检 {patrol.scanned} 商机 · {patrol.created > 0 ? `${patrol.created} 条新提醒` : '一切平稳'}
    </span>
  );
}
