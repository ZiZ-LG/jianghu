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

// MCP 握手：initialize + initialized 通知，返回 sessionId。
async function mcpSession(cfg: QccMcpConfig): Promise<string | undefined> {
  const init = await rpc(cfg, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'jianghu', version: '0.1.0' } },
  });
  const sessionId = init.sessionId;
  if (init.json?.error) throw new Error(init.json.error?.message || 'MCP 初始化失败（Token 可能无效）');
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
  return sessionId;
}

// 取 tools/call 结果里第一段 text（多为 JSON 字符串）。
function toolResultText(result: any): string | null {
  if (Array.isArray(result?.content)) {
    const c = result.content.find((x: any) => x?.type === 'text' && typeof x.text === 'string');
    if (c) return c.text;
  }
  if (result?.structuredContent) return JSON.stringify(result.structuredContent);
  return null;
}

export interface CompanyCandidate {
  name: string;            // 企业完整登记名
  creditCode: string;      // 统一社会信用代码
  legalPerson: string;     // 法定代表人
  status: string;          // 经营状态
  establishDate: string;   // 成立日期
}

/**
 * 企业名锚定：输入简称/关键词，调 get_company_by_query 返回候选企业列表。
 * 企查查规则：多候选时必须让用户人审选择，禁止自动锁定。故这里只负责返回候选，由前端点选。
 */
export async function qccMcpResolve(cfg: QccMcpConfig, query: string): Promise<{ exact: boolean; candidates: CompanyCandidate[] }> {
  const sessionId = await mcpSession(cfg);
  const r = await rpc(cfg, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'get_company_by_query', arguments: { searchKey: query } },
  }, sessionId);
  if (r.json?.error) throw new Error(r.json.error?.message || '企业检索失败');
  const text = toolResultText(r.json?.result);
  if (!text) return { exact: false, candidates: [] };
  let data: any;
  try { data = JSON.parse(text); } catch { return { exact: false, candidates: [] }; }

  // 单一精确匹配：返回结构里可能直接给企业信息对象；多候选则给「企业信息」数组。
  const list: any[] = Array.isArray(data?.企业信息) ? data.企业信息
    : Array.isArray(data?.candidates) ? data.candidates
    : (data?.企业名称 ? [data] : []);
  const candidates: CompanyCandidate[] = list.map((x: any) => ({
    name: x?.企业名称 || x?.name || '',
    creditCode: x?.统一社会信用代码 || x?.creditCode || '',
    legalPerson: Array.isArray(x?.法定代表人名称) ? x.法定代表人名称.join('、') : (x?.法定代表人 || x?.法定代表人名称 || ''),
    status: x?.状态 || x?.登记状态 || '',
    establishDate: x?.成立日期 || '',
  })).filter((c) => c.name);

  const exact = String(data?.匹配结果 || '').includes('唯一') || String(data?.匹配结果 || '').includes('精确') || candidates.length === 1;
  return { exact, candidates: candidates.slice(0, 15) };
}

/** 用 MCP 查询某公司的关键人员（应传完整登记名；建议先经 qccMcpResolve 锚定）。 */
export async function qccMcpFetch(cfg: QccMcpConfig, company: string): Promise<DiscoveredPerson[]> {
  const sessionId = await mcpSession(cfg);
  // 企查查 company 服务器的真实工具名 = get_key_personnel，入参仅 searchKey。
  const candidates = ['get_key_personnel', 'get_company_key_personnel', 'get_main_staff'];
  let lastErr = '';
  for (const tool of candidates) {
    try {
      const r = await rpc(cfg, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: tool, arguments: { searchKey: company } },
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

// 企查查 MCP 真实返回为中文字段名（如 {"姓名":"梁华","职务":"董事长"}）；同时兼容英文键以防未来变更。
const NAME_KEYS = ['姓名', 'name', 'Name', 'personName', 'PersonName', 'staffName'];
const TITLE_KEYS = ['职务', '职位', 'job', 'Job', 'position', 'Position', 'title', 'Title', 'jobTitle', 'duty'];

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

// ── 股权 / 对外投资（只读，仅供参考，绝不自动写库）──────────────────────────
// 这两个工具的返回结构已用真实企查查 MCP 实测核实（华为投资控股 / 华为技术），字段名如下；
// 仍保留对常见同义键的兼容，以防企查查后续微调字段命名。
//   get_shareholder_info  → { "企业名称", "摘要", "股东信息": [{ "股东名称","持股比例","认缴出资额","认缴出资日期","实缴出资额","实缴出资日期" }] }
//   get_external_investments → { "企业名称", "摘要", "对外投资信息": [{ "被投资企业名称","状态","成立日期","持股比例","认缴出资额/持股数" }] }

export interface Shareholder {
  name: string;       // 股东名称
  ratio: string;      // 持股比例（原样字符串，如 "99.4753%"）
  amount: string;     // 认缴出资额（原样字符串，可能含单位）
}

export interface Investment {
  name: string;       // 被投资企业名称
  ratio: string;      // 持股比例
  status: string;     // 状态（存续/注销/吊销…）
  establishDate: string; // 成立日期
}

export interface CompanyEquityData {
  shareholders: Shareholder[];
  investments: Investment[];
}

// 取首个非空字符串字段（兼容多组同义键），统一裁剪长度防御异常超长返回。
function firstStr(node: any, keys: string[], max = 80): string {
  for (const k of keys) {
    const v = node?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, max);
    if (typeof v === 'number') return String(v);
  }
  return '';
}

const SHAREHOLDER_NAME_KEYS = ['股东名称', '股东', '投资人', '投资人名称', 'shareholderName', 'name'];
const SHAREHOLDER_LIST_KEYS = ['股东信息', '股东列表', '股东', 'shareholders', 'list'];
const INVEST_NAME_KEYS = ['被投资企业名称', '被投资企业', '企业名称', '投资企业名称', 'investedCompany', 'name'];
const INVEST_LIST_KEYS = ['对外投资信息', '对外投资', '投资信息', 'investments', 'list'];
const RATIO_KEYS = ['持股比例', '出资比例', '占比', 'ratio', 'percent'];
const AMOUNT_KEYS = ['认缴出资额/持股数', '认缴出资额', '出资额', '认缴金额', 'amount'];
const STATUS_KEYS = ['状态', '登记状态', '经营状态', 'status'];
const ESTABLISH_KEYS = ['成立日期', '注册日期', 'establishDate', 'date'];

// 从 tools/call 结果里取数组：先按已知列表键找，找不到则深度搜第一个「对象数组」。
function pickArray(result: any, listKeys: string[]): any[] {
  const text = toolResultText(result);
  if (!text) return [];
  let data: any;
  try { data = JSON.parse(text); } catch { return []; }
  for (const k of listKeys) { if (Array.isArray(data?.[k])) return data[k]; }
  if (Array.isArray(data)) return data;
  // 兜底：深度优先找第一个「元素为对象」的数组
  const found = findObjectArray(data);
  return found ?? [];
}

function findObjectArray(node: any, depth = 0): any[] | null {
  if (!node || depth > 5 || typeof node !== 'object') return null;
  for (const v of Object.values(node)) {
    if (Array.isArray(v) && v.some((x) => x && typeof x === 'object' && !Array.isArray(x))) return v as any[];
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') { const r = findObjectArray(v, depth + 1); if (r) return r; }
  }
  return null;
}

function parseShareholders(result: any): Shareholder[] {
  const arr = pickArray(result, SHAREHOLDER_LIST_KEYS);
  const out: Shareholder[] = [];
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue;
    const name = firstStr(x, SHAREHOLDER_NAME_KEYS, 60);
    if (!name) continue;
    out.push({ name, ratio: firstStr(x, RATIO_KEYS, 20), amount: firstStr(x, AMOUNT_KEYS, 40) });
  }
  return dedupeBy(out, (s) => s.name).slice(0, 30);
}

function parseInvestments(result: any): Investment[] {
  const arr = pickArray(result, INVEST_LIST_KEYS);
  const out: Investment[] = [];
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue;
    const name = firstStr(x, INVEST_NAME_KEYS, 60);
    if (!name) continue;
    out.push({
      name,
      ratio: firstStr(x, RATIO_KEYS, 20),
      status: firstStr(x, STATUS_KEYS, 20),
      establishDate: firstStr(x, ESTABLISH_KEYS, 20),
    });
  }
  return dedupeBy(out, (i) => i.name).slice(0, 50);
}

function dedupeBy<T>(arr: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return arr.filter((x) => { const k = key(x); if (!k || seen.has(k)) return false; seen.add(k); return true; });
}

// ── P9 企业背景档案：工商概况 → 可读文本（get_company_profile 为主、注册信息兜底）。
// 工具名按企查查 MCP 标准工具集（与 get_key_personnel 同族；⚠️ 未实测真实返回——抽不到已知键则存原文截断兜底）──
const PROFILE_KEYS = ['企业名称', '统一社会信用代码', '法定代表人', '注册资本', '成立日期', '企业状态', '登记状态', '所属行业', '企业类型', '企业地址', '注册地址', '经营范围', '员工人数', '参保人数', '官网', '简介', '企业简介'];
function profileTextFrom(result: any): string {
  const t = toolResultText(result);
  if (!t) return '';
  let data: any;
  try { data = JSON.parse(t); } catch { return t.slice(0, 1500); }
  const lines: string[] = [];
  const walk = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    for (const [k, v] of Object.entries(o)) {
      if (PROFILE_KEYS.includes(k) && (typeof v === 'string' || typeof v === 'number') && String(v).trim()) lines.push(`${k}：${String(v).slice(0, 300)}`);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(data);
  return lines.length ? [...new Set(lines)].join('\n') : t.slice(0, 1500);
}
export async function qccMcpCompanyProfile(cfg: QccMcpConfig, company: string): Promise<string> {
  const sessionId = await mcpSession(cfg);
  const tools = ['get_company_profile', 'get_company_registration_info'];
  let lastErr = '';
  for (const tool of tools) {
    try {
      const r = await rpc(cfg, {
        jsonrpc: '2.0', id: 5, method: 'tools/call',
        params: { name: tool, arguments: { searchKey: company } },
      }, sessionId);
      if (r.json?.error) { lastErr = r.json.error?.message || ''; continue; }
      const text = profileTextFrom(r.json?.result);
      if (text) return text;
    } catch (e: any) { lastErr = e?.message || ''; }
  }
  throw new Error(lastErr ? `企查查 MCP 未返回企业档案（${lastErr}）` : '企查查 MCP 未返回企业档案');
}

/**
 * 查询某公司的股权（股东）+ 对外投资数据（应传完整登记名；建议先经 qccMcpResolve 锚定）。
 * 复用同一 MCP 会话连发两个工具调用；任一工具失败不影响另一个（各自降级为空数组）。
 * 仅供参考展示，绝不自动写库/建节点。
 */
export async function qccMcpCompanyData(cfg: QccMcpConfig, company: string): Promise<CompanyEquityData> {
  const sessionId = await mcpSession(cfg);
  let shareholders: Shareholder[] = [];
  let investments: Investment[] = [];

  try {
    const r = await rpc(cfg, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'get_shareholder_info', arguments: { searchKey: company } },
    }, sessionId);
    if (!r.json?.error) shareholders = parseShareholders(r.json?.result);
  } catch { /* 单项失败降级为空 */ }

  try {
    const r = await rpc(cfg, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'get_external_investments', arguments: { searchKey: company } },
    }, sessionId);
    if (!r.json?.error) investments = parseInvestments(r.json?.result);
  } catch { /* 单项失败降级为空 */ }

  return { shareholders, investments };
}
