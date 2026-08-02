import { emit, listen } from '@tauri-apps/api/event';

/** 数据变更事件：任意窗口增删记录/任务后广播，其它窗口监听后刷新 */
export const CHANGE_EVENT = 'worklog:changed';

export function notifyChanged(): Promise<void> {
  return emit(CHANGE_EVENT, null);
}

export function onChanged(cb: () => void): Promise<() => void> {
  return listen(CHANGE_EVENT, () => cb());
}
