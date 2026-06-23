import { useEffect, useRef, useState } from 'react';

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

/** 是否开启系统「减少动态效果」偏好。动画代码据此降级（JS 动画如 count-up 直接落定值）。 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    try { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false; } catch { return false; }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try { mq = window.matchMedia('(prefers-reduced-motion: reduce)'); } catch { return; }
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

/**
 * 数字滚动到目标值：rAF + ease-out cubic。target 变化即重新缓动（从当前显示值平滑续接），
 * 首次挂载不滚；尊重 prefers-reduced-motion（直接落定）。用于趋赢力分数等。
 */
export function useCountUp(target: number, ms = 600): number {
  const reduced = useReducedMotion();
  const [val, setVal] = useState(target);
  const valRef = useRef(target);
  const rafRef = useRef(0);
  useEffect(() => {
    if (reduced || ms <= 0) { valRef.current = target; setVal(target); return; }
    const from = valRef.current;
    if (from === target) return;
    let startTs = 0;
    const tick = (ts: number) => {
      if (!startTs) startTs = ts;
      const p = Math.min(1, (ts - startTs) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      const cur = Math.round(from + (target - from) * eased);
      valRef.current = cur;
      setVal(cur);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, ms, reduced]);
  return reduced ? target : val;
}
