import { useEffect, useState } from 'react';

/** 持久化到 localStorage 的 state（用于侧栏折叠、主题等 UI 偏好）。 */
export function usePersistentState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [val, setVal] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* 隐私模式忽略 */ }
  }, [key, val]);
  return [val, setVal];
}

export type Theme = 'light' | 'dark';

/** 主题：持久化 + 同步到 <html data-theme>，CSS 据此切换变量。默认跟随系统。 */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = usePersistentState<Theme>('jianghu.theme', prefersDark() ? 'dark' : 'light');
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  const toggle = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  return [theme, toggle];
}

function prefersDark(): boolean {
  try { return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false; } catch { return false; }
}

/** 是否窄屏（手机）。响应式切换布局/抽屉行为用。默认断点 768px。 */
export function useIsMobile(maxWidth = 768): boolean {
  const query = `(max-width: ${maxWidth}px)`;
  const [mobile, setMobile] = useState<boolean>(() => {
    try { return window.matchMedia?.(query).matches ?? false; } catch { return false; }
  });
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMobile(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [query]);
  return mobile;
}
