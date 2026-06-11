// 竖屏引导遮罩：工作台三视图（关系地图/策略沙盘/行动计划）为横屏作战设计。
// Web 无法强制锁定方向（iOS Safari 不支持 orientation.lock），故竖屏时全屏引导旋转；
// 「全屏并横屏」在 Android 生效（fullscreen 后 lock），iOS 静默失败靠用户手动旋转；
// 「仍用竖屏」降级入口 sessionStorage 记住（本次会话不再打扰）。
import { useState } from 'react';

const SKIP_KEY = 'jianghu.portraitOk';

export function OrientationGate() {
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(SKIP_KEY) === '1'; } catch { return false; }
  });
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
    <div className="orient-gate">
      <div className="orient-phone" aria-hidden>📱</div>
      <h3>请横屏使用</h3>
      <p>关系地图 · 策略沙盘 · 行动计划为横屏作战视野设计，旋转手机后自动进入横屏布局。</p>
      <button className="btn primary sm" onClick={goLandscape}>🔄 全屏并横屏</button>
      <button className="orient-skip" onClick={skip}>仍用竖屏继续 →</button>
    </div>
  );
}
