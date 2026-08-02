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
