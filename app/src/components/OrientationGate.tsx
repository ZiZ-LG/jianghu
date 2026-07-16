// 竖屏引导遮罩：工作台三视图（关系地图/策略沙盘/行动计划）为横屏作战设计。
// Web 无法强制锁定方向（iOS Safari 不支持 orientation.lock），故竖屏时全屏引导旋转；
// 「全屏并横屏」在 Android 生效（fullscreen 后 lock），iOS 静默失败靠用户手动旋转；
// 「仍用竖屏」降级入口 sessionStorage 记住（本次会话不再打扰）。
import { useEffect, useRef, useState } from 'react';
import { focusableElements, trapTabKey } from '../lib/focusTrap';

const SKIP_KEY = 'jianghu.portraitOk';

export function OrientationGate() {
  const gateRef = useRef<HTMLDivElement>(null);
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(SKIP_KEY) === '1'; } catch { return false; }
  });

  useEffect(() => {
    const gate = gateRef.current;
    const parent = gate?.parentElement;
    if (!gate || !parent || dismissed) return;
    const prior = new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>();
    const isolate = () => {
      Array.from(parent.children).forEach((element) => {
        if (element === gate || !(element instanceof HTMLElement) || prior.has(element)) return;
        prior.set(element, { inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') });
        element.inert = true;
        element.setAttribute('aria-hidden', 'true');
      });
    };
    isolate();
    const observer = new MutationObserver(isolate);
    observer.observe(parent, { childList: true });
    focusableElements(gate)[0]?.focus();
    return () => {
      observer.disconnect();
      prior.forEach((value, element) => {
        element.inert = value.inert;
        if (value.ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', value.ariaHidden);
      });
    };
  }, [dismissed]);
  if (dismissed) return null;

  const goLandscape = async () => {
    try {
      await document.documentElement.requestFullscreen?.();
      await (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.('landscape');
    } catch { /* iOS Safari 等不支持：保留遮罩，用户手动旋转 */ }
  };
  const skip = () => {
    try { sessionStorage.setItem(SKIP_KEY, '1'); } catch { /* 隐私模式等存储不可用：仅本次关闭 */ }
    setDismissed(true);
  };

  return (
    <div ref={gateRef} className="orient-gate" role="dialog" aria-modal="true" aria-labelledby="orientation-title" aria-describedby="orientation-description"
      onKeyDown={(event) => gateRef.current && trapTabKey(event, gateRef.current)}>
      <div className="orient-phone" aria-hidden>📱</div>
      <h3 id="orientation-title">请横屏使用</h3>
      <p id="orientation-description">关系地图 · 策略沙盘 · 行动计划为横屏作战视野设计，旋转手机后自动进入横屏布局。</p>
      <button type="button" className="btn primary sm" onClick={goLandscape}>🔄 全屏并横屏</button>
      <button type="button" className="orient-skip" onClick={skip}>仍用竖屏继续 →</button>
    </div>
  );
}
