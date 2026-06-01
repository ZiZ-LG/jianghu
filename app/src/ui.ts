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

// 手机判定：窄屏(竖屏) 或 矮屏(横屏手机)。与 styles.css 的移动端媒体查询保持一致。
const MOBILE_Q = '(max-width: 768px), (max-height: 500px)';
const LANDSCAPE_Q = '(orientation: landscape)';

export interface Viewport { isMobile: boolean; isLandscape: boolean; }

function readViewport(): Viewport {
  try {
    return {
      isMobile: window.matchMedia?.(MOBILE_Q).matches ?? false,
      isLandscape: window.matchMedia?.(LANDSCAPE_Q).matches ?? false,
    };
  } catch { return { isMobile: false, isLandscape: false }; }
}

/** 视口信息：是否手机 + 是否横屏。旋转/缩放即时更新（横屏手机也算 mobile）。 */
export function useViewport(): Viewport {
  const [vp, setVp] = useState<Viewport>(readViewport);
  useEffect(() => {
    const onChange = () => setVp(readViewport());
    const mqs = [window.matchMedia(MOBILE_Q), window.matchMedia(LANDSCAPE_Q)];
    mqs.forEach((m) => m.addEventListener?.('change', onChange));
    window.addEventListener('resize', onChange);
    window.addEventListener('orientationchange', onChange);
    onChange();
    return () => {
      mqs.forEach((m) => m.removeEventListener?.('change', onChange));
      window.removeEventListener('resize', onChange);
      window.removeEventListener('orientationchange', onChange);
    };
  }, []);
  return vp;
}

/** 兼容旧用法：是否手机。 */
export function useIsMobile(): boolean {
  return useViewport().isMobile;
}
