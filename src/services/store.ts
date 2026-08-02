import { load } from '@tauri-apps/plugin-store';
import type { AppSettings, GitRepo, HalfBoundaries, LlmConfig, Theme } from '../types/models';
import { DEFAULT_BOUNDARIES } from '../utils/halfDay';

let _store: Awaited<ReturnType<typeof load>> | null = null;
async function store() {
  if (!_store) _store = await load('settings.json', { autoSave: true });
  return _store;
}

export const SettingKeys = {
  hotkey: 'hotkey',
  todoHotkey: 'todoHotkey',
  theme: 'theme',
  boundaries: 'boundaries',
  llm: 'llm',
  repos: 'repos',
  gitImportMode: 'gitImportMode',
  autostart: 'autostart',
  remindTime: 'remindTime',
  remindMinMinutes: 'remindMinMinutes',
} as const;

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const v = await (await store()).get<T>(key);
  return v ?? fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await (await store()).set(key, value);
}

export const DEFAULT_SETTINGS: AppSettings = {
  hotkey: 'Alt+Shift+L',
  todoHotkey: 'Alt+Shift+J',
  theme: 'light',
  boundaries: DEFAULT_BOUNDARIES,
  llm: {
    kind: 'openai-compat',
    baseUrl: 'https://open.bigmodel.cn/v1',
    model: 'glm-4-flash',
    apiKey: '',
  },
  repos: [],
  gitImportMode: 'raw',
  autostart: true,
  remindTime: '18:00',
  remindMinMinutes: 8 * 60,
};

export async function loadSettings(): Promise<AppSettings> {
  const [hotkey, todoHotkey, theme, boundaries, llm, repos, gitImportMode, autostart, remindTime, remindMinMinutes] = await Promise.all([
    getSetting<string>(SettingKeys.hotkey, DEFAULT_SETTINGS.hotkey),
    getSetting<string>(SettingKeys.todoHotkey, DEFAULT_SETTINGS.todoHotkey),
    getSetting<Theme>(SettingKeys.theme, DEFAULT_SETTINGS.theme),
    getSetting<HalfBoundaries>(SettingKeys.boundaries, DEFAULT_SETTINGS.boundaries),
    getSetting<LlmConfig>(SettingKeys.llm, DEFAULT_SETTINGS.llm),
    getSetting<GitRepo[]>(SettingKeys.repos, DEFAULT_SETTINGS.repos),
    getSetting<'raw' | 'smart'>(SettingKeys.gitImportMode, DEFAULT_SETTINGS.gitImportMode),
    getSetting<boolean>(SettingKeys.autostart, DEFAULT_SETTINGS.autostart),
    getSetting<string>(SettingKeys.remindTime, DEFAULT_SETTINGS.remindTime),
    getSetting<number>(SettingKeys.remindMinMinutes, DEFAULT_SETTINGS.remindMinMinutes),
  ]);
  return { hotkey, todoHotkey, theme, boundaries, llm, repos, gitImportMode, autostart, remindTime, remindMinMinutes };
}
