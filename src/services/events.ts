import { emit, listen } from '@tauri-apps/api/event';

/** 数据变更事件：任意窗口增删记录/任务后广播，其它窗口监听后刷新 */
export const CHANGE_EVENT = 'worklog:changed';

export function notifyChanged(): Promise<void> {
  return emit(CHANGE_EVENT, null);
}

export function onChanged(cb: () => void): Promise<() => void> {
  return listen(CHANGE_EVENT, () => cb());
}

/** 主题变更事件：主面板切深浅色后广播，待办插件/快速记录弹窗跟随 */
export const THEME_EVENT = 'worklog:theme';

export function notifyTheme(theme: string): Promise<void> {
  return emit(THEME_EVENT, theme);
}

export function onTheme(cb: (theme: string) => void): Promise<() => void> {
  return listen(THEME_EVENT, (e) => cb(e.payload as string));
}
