import { CalendarRange, ChartLine, Clock, Inbox, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** ⌘/Ctrl+N 快捷键序号 */
  hotkeyIndex: number;
}

/** 侧栏与 ⌘1..5 共用的页面注册表（P4 五路由） */
export const NAV: NavItem[] = [
  { to: '/today', label: '今日', icon: Clock, hotkeyIndex: 1 },
  { to: '/history', label: '月历', icon: CalendarRange, hotkeyIndex: 2 },
  { to: '/reports', label: '报告', icon: ChartLine, hotkeyIndex: 3 },
  { to: '/collect', label: '采集', icon: Inbox, hotkeyIndex: 4 },
  { to: '/settings', label: '设置', icon: Settings, hotkeyIndex: 5 },
];
