import { CalendarRange, ChartLine, Clock, CloudUpload, Inbox, ListTodo, MoonStar, RefreshCw, Settings, Sparkles, Undo2, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toggleQuickCapture, toggleWidget } from '../services/window';
import { manualScanNow, rebuildDayNow, undoDay } from '../services/collector';
import { notifyChanged } from '../services/events';
import { useSettingsStore } from '../stores/useSettingsStore';
import { addDays, todayYMD } from '../utils/date';
import { toast } from './components/UndoToast';

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
  {
    id: 'collect-scan-now',
    title: '立即补扫',
    sub: '扫描 AI 会话与 Git 提交并整合',
    group: '快捷操作',
    icon: RefreshCw,
    keywords: ['scan', '补扫', '采集', 'collect'],
    run: () => {
      void manualScanNow()
        .then((res) => {
          void notifyChanged();
          toast(`补扫完成：${res.events} 事件 · ${res.commits} 提交`);
        })
        .catch(() => toast('补扫失败，请稍后重试'));
    },
  },
  {
    id: 'collect-rebuild-today',
    title: '重新整合今日',
    sub: '用已摄入事件重建今日日志',
    group: '快捷操作',
    icon: Sparkles,
    keywords: ['rebuild', '重整合', '整合', '今日'],
    run: () => {
      void rebuildDayNow(todayYMD())
        .then(() => {
          void notifyChanged();
          toast('今日已重新整合');
        })
        .catch(() => toast('重新整合失败，请稍后重试'));
    },
  },
  {
    id: 'collect-undo-today',
    title: '撤销今日自动条目',
    sub: '删除今日采集生成的条目',
    group: '快捷操作',
    icon: Undo2,
    keywords: ['undo', '撤销', '自动', '今日'],
    run: () => {
      void undoDay(todayYMD())
        .then((n) => {
          void notifyChanged();
          if (n > 0) toast(`已撤销 ${n} 条自动条目`); // 删 0 条无感，不弹
        })
        .catch(() => toast('撤销失败，请稍后重试'));
    },
  },
  {
    id: 'choerodon-batch-sync',
    title: '批量上报',
    sub: '打开猪齿鱼批量上报向导',
    group: '快捷操作',
    icon: CloudUpload,
    keywords: ['choerodon', '猪齿鱼', '上报', '工时', 'sync'],
    // 向导挂在 AppShell 层（MainApp），经事件唤起——不依赖当前页面路由
    run: () => window.dispatchEvent(new CustomEvent('daylog:open-batch-sync')),
  },
  { id: 'page-today', title: '今日', group: '页面', icon: Clock, hotkey: '⌘1', keywords: ['today'], run: (ctx) => ctx.navigate('/today') },
  { id: 'page-history', title: '月历', group: '页面', icon: CalendarRange, hotkey: '⌘2', keywords: ['calendar', '月历', '日历'], run: (ctx) => ctx.navigate('/history') },
  { id: 'page-reports', title: '报告', group: '页面', icon: ChartLine, hotkey: '⌘3', keywords: ['report', '月报', '季报', '年报'], run: (ctx) => ctx.navigate('/reports') },
  { id: 'page-collect', title: '采集中心', group: '页面', icon: Inbox, hotkey: '⌘4', keywords: ['collect', 'git', '导入', '采集'], run: (ctx) => ctx.navigate('/collect') },
  { id: 'page-settings', title: '设置', group: '页面', icon: Settings, hotkey: '⌘5', keywords: ['settings'], run: (ctx) => ctx.navigate('/settings') },
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
