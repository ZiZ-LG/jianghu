// 企查查 MCP（streamable-HTTP）最小客户端。
// 用户在 https://agent.qcc.com/guide 复制的 JSON 形如：
// { "mcpServers": { "qcc-company": { "url": "https://agent.qcc.com/mcp/company/stream",
//                                     "headers": { "Authorization": "Bearer <KEY>" } }, ... } }
// 我们从中取「企业基座 company」服务器的 url + Bearer token，调用其关键人员工具做自动建图。

interface DiscoveredPerson { name: string; title: string; }

export interface QccMcpConfig {
  url: string;        // company-stream endpoint
  token: string;      // Bearer token（不含 "Bearer " 前缀）
}

/** 解析用户粘贴的 MCP 配置 JSON，提取 company 服务器的 url + token。 */
export function parseQccMcpConfig(raw: string): QccMcpConfig {
  let obj: any;
  try { obj = JSON.parse(raw); } catch { throw new Error('不是合法 JSON，请原样粘贴企查查 MCP 配置'); }
  // 兼容：直接给 { url, headers } 或带 mcpServers 包裹
  const servers = obj?.mcpServers ?? obj?.servers ?? obj;
  let node: any = null;
  if (servers && typeof servers === 'object') {
    // 优先 company；否则取第一个带 url 的
    node = servers['qcc-company'] || servers['company']
      || Object.values(servers).find((v: any) => v && typeof v === 'object' && (v.url || v.headers));
  }
  if (!node && (obj?.url || obj?.headers)) node = obj;
  if (!node?.url) throw new Error('配置里找不到 url（应包含 qcc-company 的 stream 地址）');

  const authRaw: string = node.headers?.Authorization || node.headers?.authorization || node.token || '';
  const token = authRaw.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new Error('配置里找不到 Authorization Bearer Token');

  // 统一用 company 端点（即便用户粘的是别的子服务，也切到 company 做关键人）
  const url = String(node.url).replace(/\/mcp\/[a-z-]+\/stream/i, '/mcp/company/stream');
  return { url, token };
}

// ── MCP streamable-HTTP 调用：发一个 JSON-RPC 请求，解析 SSE / JSON 响应 ──
async function rpc(cfg: QccMcpConfig, body: any, sessionId?: string): Promise<{ json: any; sessionId?: string }> {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${cfg.token}`,
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const sid = res.headers.get('mcp-session-id') || sessionId;
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}：${text.slice(0, 120)}`);
  // 响应可能是纯 JSON，或 SSE（多行 data:）。取最后一个含 result/error 的 JSON。
  const json = extractJsonRpc(text);
  return { json, sessionId: sid ?? undefined };
}

function extractJsonRpc(text: string): any {
  const t = text.trim();
  // 纯 JSON
  if (t.startsWith('{')) { try { return JSON.parse(t); } catch { /* fallthrough */ } }
  // SSE：逐行找 data:
  let last: any = null;
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(/^data:\s*(.+)$/);
    if (m) { try { const j = JSON.parse(m[1]); if (j && (j.result || j.error || j.id)) last = j; } catch { /* skip */ } }
  }
  if (last) return last;
  throw new Error('无法解析 MCP 响应');
}

/** 用 MCP 查询某公司的关键人员（initialize → 调用关键人工具 → 解析）。 */
export async function qccMcpFetch(cfg: QccMcpConfig, company: string): Promise<DiscoveredPerson[]> {
  // 1) initialize
  const init = await rpc(cfg, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'jianghu', version: '0.1.0' },
    },
  });
  const sessionId = init.sessionId;
  if (init.json?.error) throw new Error(init.json.error?.message || 'MCP 初始化失败（Token 可能无效）');

  // 2) initialized 通知（streamable-HTTP 下尽力而为，失败忽略）
  try {
    await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${cfg.token}`, ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
  } catch { /* 通知失败不影响后续调用 */ }

  // 3) 调用关键人员工具。不同账号工具名可能略有差异，按优先级尝试。
  const candidates = ['get_key_personnel', 'get_company_key_personnel', 'get_main_staff', 'get_company_profile'];
  let lastErr = '';
  for (const tool of candidates) {
    try {
      const r = await rpc(cfg, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: tool, arguments: { searchKey: company, keyword: company, companyName: company } },
      }, sessionId);
      if (r.json?.error) { lastErr = r.json.error?.message || ''; continue; }
      const persons = parsePersonsFromToolResult(r.json?.result);
      if (persons.length) return persons.slice(0, 15);
    } catch (e: any) { lastErr = e?.message || ''; }
  }
  throw new Error(lastErr ? `企查查 MCP 未返回关键人（${lastErr}）` : '企查查 MCP 未返回关键人');
}

// MCP tools/call 的结果在 result.content[].text（多为 JSON 字符串）。深度找姓名/职务数组。
function parsePersonsFromToolResult(result: any): DiscoveredPerson[] {
  if (!result) return [];
  const texts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const c of result.content) { if (c?.type === 'text' && typeof c.text === 'string') texts.push(c.text); }
  }
  if (result.structuredContent) texts.push(JSON.stringify(result.structuredContent));

  const out: DiscoveredPerson[] = [];
  for (const t of texts) {
    let data: any;
    try { data = JSON.parse(t); } catch { continue; }
    collectPersons(data, out);
  }
  // 去重
  const seen = new Set<string>();
  return out.filter((p) => { const k = p.name + '|' + p.title; if (seen.has(k)) return false; seen.add(k); return true; });
}

const NAME_KEYS = ['name', 'Name', 'personName', 'PersonName', 'staffName'];
const TITLE_KEYS = ['job', 'Job', 'position', 'Position', 'title', 'Title', 'jobTitle', 'duty'];

function collectPersons(node: any, out: DiscoveredPerson[], depth = 0): void {
  if (!node || depth > 6 || out.length >= 40) return;
  if (Array.isArray(node)) { for (const x of node) collectPersons(x, out, depth + 1); return; }
  if (typeof node === 'object') {
    const nameKey = NAME_KEYS.find((k) => typeof node[k] === 'string' && node[k].trim());
    if (nameKey) {
      const titleKey = TITLE_KEYS.find((k) => typeof node[k] === 'string' && node[k].trim());
      out.push({ name: String(node[nameKey]).slice(0, 20), title: titleKey ? String(node[titleKey]).slice(0, 40) : '关键人员' });
    }
    for (const v of Object.values(node)) { if (v && typeof v === 'object') collectPersons(v, out, depth + 1); }
  }
}
