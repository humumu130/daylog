import { getCurrentWindow } from '@tauri-apps/api/window';

/** 无边框窗口的自定义标题栏按钮 */
export function WindowControls() {
  const win = getCurrentWindow();
  return (
    <div className="win-controls">
      <button className="win-btn" title="最小化" onClick={() => void win.minimize()}>
        –
      </button>
      <button className="win-btn" title="最大化/还原" onClick={() => void win.toggleMaximize()}>
        ▢
      </button>
      <button className="win-btn win-close" title="关闭" onClick={() => void win.close()}>
        ✕
      </button>
    </div>
  );
}
