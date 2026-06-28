// 得到大脑(Get笔记 / biji.com)HTTP REST client。纯 API key（无 OAuth）：Authorization + X-Client-ID 两个 header。
// 只拉录音/会议笔记的转写正文(audio.original)，不碰音频、不自建 ASR。出站调用，无需公网回调。
// 文档：https://www.biji.com/openapi ；base https://openapi.biji.com 。

const GETNOTE_BASE = 'https://openapi.biji.com';

export interface GetnoteCred { apiKey: string; clientId: string; baseUrl?: string }
export interface GetnoteNote { id: string; title: string; type: string }

async function gnFetch(cred: GetnoteCred, path: string): Promise<any> {
  const base = (cred.baseUrl || GETNOTE_BASE).replace(/\/+$/, '');
  const res = await fetch(base + path, {
    headers: { Authorization: cred.apiKey, 'X-Client-ID': cred.clientId },
  });
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok || (typeof d.code === 'number' && d.code !== 0)) {
    throw new Error(`得到大脑 API 失败：${d.message || d.msg || d.error || `HTTP ${res.status}`}`);
  }
  return d;
}

/** 列笔记（游标分页，拉至多 maxPages 页，每页 20）。返回 id/title/type。 */
export async function listGetnoteNotes(cred: GetnoteCred, maxPages = 2): Promise<GetnoteNote[]> {
  const out: GetnoteNote[] = [];
  let cursor = '';
  for (let i = 0; i < maxPages; i++) {
    const d = await gnFetch(cred, '/open/api/v1/resource/note/list' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''));
    const notes: any[] = d.data?.notes || d.notes || [];
    for (const n of notes) {
      const id = n.note_id || n.id || '';
      if (id) out.push({ id, title: n.title || '(无标题笔记)', type: n.note_type || n.type || '' });
    }
    cursor = d.data?.cursor || d.cursor || '';
    if (!(d.data?.has_more ?? d.has_more) || !cursor) break;
  }
  return out;
}

/** 取单条笔记详情，返回转写正文(audio.original，回退 content)+ 时长。 */
export async function getGetnoteTranscript(cred: GetnoteCred, noteId: string): Promise<{ title: string; transcript: string; durationSec: number }> {
  const d = await gnFetch(cred, `/open/api/v1/resource/note/detail?id=${encodeURIComponent(noteId)}`);
  const n: any = d.data?.note || d.note || {};
  const transcript = n.audio?.original || n.content || '';
  return { title: n.title || '', transcript: String(transcript).trim(), durationSec: Number(n.audio?.duration || 0) };
}
