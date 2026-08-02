import { register, unregister } from '@tauri-apps/plugin-global-shortcut';

// 支持多个热键，按 id 管理（capture / todo 各一个）
const accels = new Map<string, string>();

/** 注册指定 id 的全局热键（自动注销该 id 旧的）。仅在按下时触发，松开不重复。 */
export async function registerHotkey(id: string, accelerator: string, handler: () => void): Promise<void> {
  const prev = accels.get(id);
  if (prev) {
    try {
      await unregister(prev);
    } catch {
      /* ignore */
    }
  }
  await register(accelerator, (event) => {
    if (event.state === 'Pressed') handler();
  });
  accels.set(id, accelerator);
}

export async function unregisterHotkey(id: string): Promise<void> {
  const prev = accels.get(id);
  if (prev) {
    try {
      await unregister(prev);
    } catch {
      /* ignore */
    }
  }
  accels.delete(id);
}
