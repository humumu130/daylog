import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';

export async function setAutostart(on: boolean): Promise<void> {
  if (on) await enable();
  else await disable();
}

export async function getAutostart(): Promise<boolean> {
  try {
    return await isEnabled();
  } catch {
    return false;
  }
}
