import { WebviewWindow, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

export function currentLabel(): string {
  return getCurrentWebviewWindow().label;
}

export async function showQuickCapture(): Promise<void> {
  const w = await WebviewWindow.getByLabel('quick-capture');
  if (w) {
    await w.show();
    await w.setFocus();
  }
}

export async function hideQuickCapture(): Promise<void> {
  const w = await WebviewWindow.getByLabel('quick-capture');
  if (w) await w.hide();
}

/** 快速记录：已显示则隐藏，否则显示（热键再次按下可关闭） */
export async function toggleQuickCapture(): Promise<void> {
  const w = await WebviewWindow.getByLabel('quick-capture');
  if (!w) return;
  try {
    if (await w.isVisible()) await w.hide();
    else { await w.show(); await w.setFocus(); }
  } catch { /* ignore */ }
}

let lastWidgetToggle = 0;
export async function toggleWidget(): Promise<void> {
  const now = Date.now();
  if (now - lastWidgetToggle < 400) return; // 防抖：避免按下/松开双触发
  lastWidgetToggle = now;
  const w = await WebviewWindow.getByLabel('widget');
  if (!w) return;
  try {
    if (await w.isVisible()) {
      await w.hide();
    } else {
      await w.show();
      await w.setFocus();
    }
  } catch {
    /* ignore */
  }
}

export async function hideWidget(): Promise<void> {
  const w = await WebviewWindow.getByLabel('widget');
  if (w) await w.hide();
}

export async function showMain(): Promise<void> {
  const w = await WebviewWindow.getByLabel('main');
  if (w) {
    await w.show();
    await w.setFocus();
  }
}

export async function hideMain(): Promise<void> {
  const w = await WebviewWindow.getByLabel('main');
  if (w) await w.hide();
}

/** 主窗口：已显示则隐藏到托盘，否则显示并聚焦（热键呼出/收起） */
export async function toggleMain(): Promise<void> {
  const w = await WebviewWindow.getByLabel('main');
  if (!w) return;
  try {
    if (await w.isVisible()) {
      // 已显示：若已聚焦则收进托盘；否则先聚焦
      const focused = await w.isFocused().catch(() => true);
      if (focused) await w.hide();
      else { await w.show(); await w.setFocus(); }
    } else {
      await w.show();
      await w.setFocus();
    }
  } catch { /* ignore */ }
}

/** 捕获面板：失焦自动隐藏（点别处即关） */
export function bindAutoHideOnBlur(onHidden?: () => void): () => void {
  const w = getCurrentWebviewWindow();
  let unlisten: (() => void) | undefined;
  w.onFocusChanged(({ payload: focused }) => {
    if (!focused) {
      void hideQuickCapture();
      onHidden?.();
    }
  }).then((fn) => {
    unlisten = fn;
  });
  return () => unlisten?.();
}
