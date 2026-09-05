import { useCallback, useEffect, useRef, useState } from 'react';
import type { PersonalWorkbenchList } from '@jianghu/domain-contracts';
import { api, toApiError } from '../api';
import { createOpaqueEntityId } from './opaqueId';

export const personalLifecycleLabel = (status: string, outcome: string | null) => ({ active: '推进中', paused: '已暂停', completed: outcome === 'won' ? '已赢单' : outcome === 'lost' ? '已丢单' : '已结束', canceled: '已取消' }[status] ?? status);
export function personalTime(value: string | null | undefined) {
  return value ? new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '时间待定';
}
export function selectPersonalMatters(entries: PersonalWorkbenchList['entries'], search: string, state: string, stage: string) {
  const query = search.trim().toLocaleLowerCase();
  return entries.filter(entry => (!query || `${entry.matter.title} ${entry.customerName} ${entry.customerBusinessGoal ?? ''}`.toLocaleLowerCase().includes(query))
    && (state === 'all' || entry.matter.lifecycleStatus === state)
    && (stage === 'all' || (stage === 'unassessed' ? entry.salesProgress === null : `stage:${entry.salesProgress}` === stage)))
    .sort((a, b) => Number(b.matter.priority === 'high') - Number(a.matter.priority === 'high')
      || (a.nextCommitment?.scheduledAtUtc ?? a.nextCommitment?.dueAtUtc ?? '9999').localeCompare(b.nextCommitment?.scheduledAtUtc ?? b.nextCommitment?.dueAtUtc ?? '9999')
      || a.matter.title.localeCompare(b.matter.title, 'zh-CN') || a.matter.id.localeCompare(b.matter.id));
}

/** Key the caller by its route + actor. Old reads cannot repopulate another context. */
export function usePersonalRead<T>(read: (signal: AbortSignal) => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const current = useRef({ request: 0, mounted: true, controller: new AbortController() });
  const readRef = useRef(read);
  readRef.current = read;
  const reload = useCallback(async () => {
    const guard = current.current;
    if (!guard.mounted) return;
    guard.controller.abort();
    guard.controller = new AbortController();
    const request = ++guard.request, token = api.getToken();
    const valid = () => guard.mounted && guard.request === request && api.getToken() === token;
    setLoading(true); setError('');
    try {
      const value = await readRef.current(guard.controller.signal);
      if (valid()) setData(value);
    } catch (cause) {
      if (valid()) { setData(null); setError(toApiError(cause).message); }
    } finally { if (valid()) setLoading(false); }
  }, []);
  useEffect(() => {
    current.current.mounted = true;
    void reload();
    const refresh = () => { if (document.visibilityState === 'visible') void reload(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const interval = window.setInterval(refresh, 60_000);
    return () => {
      current.current.mounted = false; current.current.request++; current.current.controller.abort();
      window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); window.clearInterval(interval);
    };
  }, [reload]);
  return { data, loading, error, reload };
}

/** A failed send retains its payload's key; navigation/session replacement cancels UI follow-ups. */
export function usePersonalSubmission() {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const guard = useRef({ mounted: true, busy: false, signature: '', key: '' });
  useEffect(() => { guard.current.mounted = true; return () => { guard.current.mounted = false; }; }, []);
  const submit = async <T,>(payload: unknown, send: (key: string) => Promise<T>): Promise<T | undefined> => {
    const state = guard.current;
    if (state.busy || !state.mounted) return;
    const signature = JSON.stringify(payload), token = api.getToken();
    if (state.signature !== signature) { state.signature = signature; state.key = createOpaqueEntityId('command'); }
    state.busy = true; setBusy(true); setError('');
    try {
      const result = await send(state.key);
      if (state.mounted && api.getToken() === token) return result;
    } catch (cause) { if (state.mounted && api.getToken() === token) setError(toApiError(cause).message); }
    finally { state.busy = false; if (state.mounted && api.getToken() === token) setBusy(false); }
  };
  return { busy, error, submit };
}
