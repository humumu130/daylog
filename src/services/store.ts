import { load } from '@tauri-apps/plugin-store';
import type { AppSettings, ChoerodonSettings, CollectSettings, GitRepo, HalfBoundaries, LlmConfig, Theme } from '../types/models';
import { DEFAULT_BOUNDARIES } from '../utils/halfDay';

let _store: Awaited<ReturnType<typeof load>> | null = null;
async function store() {
  if (!_store) _store = await load('settings.json', { autoSave: true });
  return _store;
}

export const SettingKeys = {
  hotkey: 'hotkey',
  todoHotkey: 'todoHotkey',
  mainHotkey: 'mainHotkey',
  theme: 'theme',
  boundaries: 'boundaries',
  llm: 'llm',
  repos: 'repos',
  gitImportMode: 'gitImportMode',
  gitAuthor: 'gitAuthor',
  autostart: 'autostart',
  remindTime: 'remindTime',
  remindMinMinutes: 'remindMinMinutes',
  dailyCapHours: 'dailyCapHours',
  sidebarLabels: 'sidebarLabels',
  autoBackupEnabled: 'autoBackupEnabled',
  autoBackupKeep: 'autoBackupKeep',
  autoBackupDir: 'autoBackupDir',
  collect: 'collect',
  choerodon: 'choerodon',
  reportPolicy: 'reportPolicy',
  onboardDone: 'onboardDone',
  obsidianDir: 'obsidianDir',
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
  mainHotkey: 'Alt+Shift+M',
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
  gitAuthor: '',
  autostart: true,
  remindTime: '18:00',
  remindMinMinutes: 8 * 60,
  dailyCapHours: 8,
  sidebarLabels: false,
  autoBackupEnabled: true,
  autoBackupKeep: 5,
  autoBackupDir: '',
  collect: {
    enabled: true,
    scanRoots: [],
    lookbackDays: 7,
    retentionDays: 30,
    gapMinutes: 15,
    scrubEnabled: true,
    noiseFilter: true,
    noiseStrict: false,
    workStartTime: '09:00',
    workEndTime: '16:30',
    weekendOvertime: true,
    earlyStartOvertime: false,
    overtimeCapHours: 20,
  },
  choerodon: null,
  reportPolicy: 'fact' as const,
  onboardDone: false,
  obsidianDir: '',
};

export async function loadSettings(): Promise<AppSettings> {
  const [hotkey, todoHotkey, mainHotkey, theme, boundaries, llm, repos, gitImportMode, gitAuthor, autostart, remindTime, remindMinMinutes, dailyCapHours, sidebarLabels, autoBackupEnabled, autoBackupKeep, autoBackupDir, collect, choerodon, reportPolicy, onboardDone, obsidianDir] = await Promise.all([
    getSetting<string>(SettingKeys.hotkey, DEFAULT_SETTINGS.hotkey),
    getSetting<string>(SettingKeys.todoHotkey, DEFAULT_SETTINGS.todoHotkey),
    getSetting<string>(SettingKeys.mainHotkey, DEFAULT_SETTINGS.mainHotkey),
    getSetting<Theme>(SettingKeys.theme, DEFAULT_SETTINGS.theme),
    getSetting<HalfBoundaries>(SettingKeys.boundaries, DEFAULT_SETTINGS.boundaries),
    getSetting<LlmConfig>(SettingKeys.llm, DEFAULT_SETTINGS.llm),
    getSetting<GitRepo[]>(SettingKeys.repos, DEFAULT_SETTINGS.repos),
    getSetting<'raw' | 'smart'>(SettingKeys.gitImportMode, DEFAULT_SETTINGS.gitImportMode),
    getSetting<string>(SettingKeys.gitAuthor, DEFAULT_SETTINGS.gitAuthor),
    getSetting<boolean>(SettingKeys.autostart, DEFAULT_SETTINGS.autostart),
    getSetting<string>(SettingKeys.remindTime, DEFAULT_SETTINGS.remindTime),
    getSetting<number>(SettingKeys.remindMinMinutes, DEFAULT_SETTINGS.remindMinMinutes),
    getSetting<number>(SettingKeys.dailyCapHours, DEFAULT_SETTINGS.dailyCapHours),
    getSetting<boolean>(SettingKeys.sidebarLabels, DEFAULT_SETTINGS.sidebarLabels),
    getSetting<boolean>(SettingKeys.autoBackupEnabled, DEFAULT_SETTINGS.autoBackupEnabled),
    getSetting<number>(SettingKeys.autoBackupKeep, DEFAULT_SETTINGS.autoBackupKeep),
    getSetting<string>(SettingKeys.autoBackupDir, DEFAULT_SETTINGS.autoBackupDir),
    getSetting<CollectSettings>(SettingKeys.collect, DEFAULT_SETTINGS.collect),
    getSetting<ChoerodonSettings | null>(SettingKeys.choerodon, DEFAULT_SETTINGS.choerodon),
    getSetting<'fact' | 'fill'>(SettingKeys.reportPolicy, DEFAULT_SETTINGS.reportPolicy),
    getSetting<boolean>(SettingKeys.onboardDone, DEFAULT_SETTINGS.onboardDone),
    getSetting<string>(SettingKeys.obsidianDir, DEFAULT_SETTINGS.obsidianDir),
  ]);
  return { hotkey, todoHotkey, mainHotkey, theme, boundaries, llm, repos, gitImportMode, gitAuthor, autostart, remindTime, remindMinMinutes, dailyCapHours, sidebarLabels, autoBackupEnabled, autoBackupKeep, autoBackupDir, collect, choerodon, reportPolicy, onboardDone, obsidianDir };
}
