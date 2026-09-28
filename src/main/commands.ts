import { CalendarRange, Clock, GitBranch, ListTodo, MoonStar, Settings, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toggleQuickCapture, toggleWidget } from '../services/window';
import { useSettingsStore } from '../stores/useSettingsStore';
import { addDays, todayYMD } from '../utils/date';

/** 命令面板上下文：由 CommandPalette 注入（navigate/requestGotoDay） */
export interface CommandCtx {
  navigate: (to: string) => void;
  requestGotoDay: (day: string) => void;
}

export type CommandGroup = '快捷操作' | '页面' | '跳转日期';

export interface Command {
  id: string;
  title: string;
  sub?: string;
  group: CommandGroup;
  icon: LucideIcon;
  hotkey?: string;
  keywords?: string[];
  run: (ctx: CommandCtx) => void;
}

function gotoDay(ctx: CommandCtx, day: string): void {
  ctx.requestGotoDay(day);
  ctx.navigate('/today');
}

/**
 * 中央命令注册表（P2 骨架）：P5/P6/P8 的补扫/重整合/上报等 B/C 动作
 * 后续在此追加注册，命令面板与快捷键自动获得。
 */
export const COMMANDS: Command[] = [
  {
    id: 'quick-capture',
    title: '快速记录',
    sub: '呼出快速记录浮窗',
    group: '快捷操作',
    icon: Zap,
    keywords: ['capture', '记录', '速记'],
    run: () => void toggleQuickCapture(),
  },
  {
    id: 'widget',
    title: '待办浮窗',
    sub: '呼出/收起待办浮窗',
    group: '快捷操作',
    icon: ListTodo,
    keywords: ['todo', '待办'],
    run: () => void toggleWidget(),
  },
  {
    id: 'toggle-theme',
    title: '切换明暗主题',
    sub: '浅色 ⇄ 深色',
    group: '快捷操作',
    icon: MoonStar,
    keywords: ['theme', '主题', '深色', '浅色', 'dark', 'light'],
    run: () => {
      const s = useSettingsStore.getState();
      void s.patch({ theme: s.settings.theme === 'dark' ? 'light' : 'dark' });
    },
  },
  { id: 'page-today', title: '今日', group: '页面', icon: Clock, hotkey: '⌘1', keywords: ['today'], run: (ctx) => ctx.navigate('/today') },
  { id: 'page-calendar', title: '月历', group: '页面', icon: CalendarRange, hotkey: '⌘2', keywords: ['calendar', '月报'], run: (ctx) => ctx.navigate('/calendar') },
  { id: 'page-git', title: 'Git', group: '页面', icon: GitBranch, hotkey: '⌘3', run: (ctx) => ctx.navigate('/git') },
  { id: 'page-settings', title: '设置', group: '页面', icon: Settings, hotkey: '⌘4', keywords: ['settings'], run: (ctx) => ctx.navigate('/settings') },
  { id: 'day-today', title: '回到今天', sub: '今日页跳回当天', group: '跳转日期', icon: Clock, keywords: ['今天', 'today'], run: (ctx) => gotoDay(ctx, todayYMD()) },
  { id: 'day-yesterday', title: '昨天', group: '跳转日期', icon: Clock, keywords: ['昨天', 'yesterday'], run: (ctx) => gotoDay(ctx, addDays(todayYMD(), -1)) },
  { id: 'day-week-ago', title: '上周今天', group: '跳转日期', icon: Clock, keywords: ['上周'], run: (ctx) => gotoDay(ctx, addDays(todayYMD(), -7)) },
];

/** 最近使用记忆（命令面板高亮区） */
const RECENTS_KEY = 'dl-palette-recents';

export function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? (arr as string[]) : [];
  } catch {
    return [];
  }
}

export function pushRecent(id: string): void {
  const next = [id, ...loadRecents().filter((x) => x !== id)].slice(0, 6);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* localStorage 不可用时静默降级为无记忆 */
  }
}
