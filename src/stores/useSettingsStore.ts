import { create } from 'zustand';
import { loadSettings, setSetting, SettingKeys } from '../services/store';
import { DEFAULT_SETTINGS } from '../services/store';
import type { AppSettings } from '../types/models';

interface SettingsState {
  settings: AppSettings;
  loaded: boolean;
  load: () => Promise<AppSettings>;
  patch: (partial: Partial<AppSettings>) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    const settings = await loadSettings();
    set({ settings, loaded: true });
    return settings;
  },
  patch: async (partial) => {
    const next = { ...get().settings, ...partial };
    set({ settings: next });
    const entries: [string, unknown][] = [];
    if (partial.hotkey !== undefined) entries.push([SettingKeys.hotkey, partial.hotkey]);
    if (partial.todoHotkey !== undefined) entries.push([SettingKeys.todoHotkey, partial.todoHotkey]);
    if (partial.mainHotkey !== undefined) entries.push([SettingKeys.mainHotkey, partial.mainHotkey]);
    if (partial.theme !== undefined) entries.push([SettingKeys.theme, partial.theme]);
    if (partial.boundaries !== undefined) entries.push([SettingKeys.boundaries, partial.boundaries]);
    if (partial.llm !== undefined) entries.push([SettingKeys.llm, partial.llm]);
    if (partial.repos !== undefined) entries.push([SettingKeys.repos, partial.repos]);
    if (partial.gitImportMode !== undefined) entries.push([SettingKeys.gitImportMode, partial.gitImportMode]);
    if (partial.autostart !== undefined) entries.push([SettingKeys.autostart, partial.autostart]);
    if (partial.remindTime !== undefined) entries.push([SettingKeys.remindTime, partial.remindTime]);
    if (partial.remindMinMinutes !== undefined) entries.push([SettingKeys.remindMinMinutes, partial.remindMinMinutes]);
    await Promise.all(entries.map(([k, v]) => setSetting(k, v)));
  },
}));
