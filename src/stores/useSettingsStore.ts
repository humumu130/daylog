import { create } from 'zustand';
import { loadSettings, setSetting, SettingKeys } from '../services/store';
import { DEFAULT_SETTINGS } from '../services/store';
import { notifyTheme } from '../services/events';
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
    if (partial.dailyCapHours !== undefined) entries.push([SettingKeys.dailyCapHours, partial.dailyCapHours]);
    if (partial.autoBackupEnabled !== undefined) entries.push([SettingKeys.autoBackupEnabled, partial.autoBackupEnabled]);
    if (partial.autoBackupKeep !== undefined) entries.push([SettingKeys.autoBackupKeep, partial.autoBackupKeep]);
    if (partial.autoBackupDir !== undefined) entries.push([SettingKeys.autoBackupDir, partial.autoBackupDir]);
    await Promise.all(entries.map(([k, v]) => setSetting(k, v)));
    // 主题变更：广播给其它窗口（待办插件/快速记录）跟随切换
    if (partial.theme !== undefined) void notifyTheme(partial.theme);
  },
}));
