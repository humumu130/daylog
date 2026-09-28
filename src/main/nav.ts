import { CalendarRange, Clock, GitBranch, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** 图标轨导航注册表：Sidebar 渲染 + ⌘1..N 快捷键共用（P4 拆报告/采集时在此扩至 5+） */
export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  hotkeyIndex: number; // ⌘N 序号
}

export const NAV: NavItem[] = [
  { to: '/today', label: '今日', icon: Clock, hotkeyIndex: 1 },
  { to: '/calendar', label: '月历', icon: CalendarRange, hotkeyIndex: 2 },
  { to: '/git', label: 'Git', icon: GitBranch, hotkeyIndex: 3 },
  { to: '/settings', label: '设置', icon: Settings, hotkeyIndex: 4 },
];
