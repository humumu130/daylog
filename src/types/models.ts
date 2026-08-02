// 领域模型（camelCase）。DB 列为 snake_case，映射在 services/db.ts 完成。

export type Half = 'allday' | 'morning' | 'afternoon' | 'evening';
export type TaskStatus = 'active' | 'paused' | 'done';
export type RecordSource = 'manual' | 'git' | 'timer' | 'import';
export type LlmProviderKind = 'openai-compat' | 'anthropic' | 'claude-code';
export type Theme = 'light' | 'dark';

export interface Project {
  id: string;
  name: string;
  color: string;
  keywords: string[];
  isActive: boolean;
  sortOrder: number;
  createdAt: number;
}

/** 工作事项：可跨多天；多条同时 active 即并行 */
export interface Task {
  id: string;
  title: string;
  projectId: string | null;
  status: TaskStatus;
  startDate: string; // YYYY-MM-DD
  endDate: string | null; // YYYY-MM-DD，完成时设置；支撑甘特区间
  note: string;
  createdAt: number;
  updatedAt: number;
}

/** 原子日志条目：绑定具体某天的某个半天，可选关联 Task */
export interface WorkRecord {
  id: string;
  taskId: string | null;
  projectId: string | null;
  content: string;
  durationMin: number | null;
  day: string; // YYYY-MM-DD
  half: Half;
  source: RecordSource;
  createdAt: number;
  updatedAt: number;
  meta: Record<string, unknown>;
}

export interface ReportTemplate {
  id: string;
  name: string;
  body: string;
  isDefault: boolean;
  createdAt: number;
}

export interface Report {
  id: string;
  month: string; // YYYY-MM
  templateId: string | null;
  body: string;
  provider: string;
  model: string;
  createdAt: number;
}

export interface HalfBoundaries {
  morningEnd: number; // 小时，默认 12
  afternoonEnd: number; // 小时，默认 18
}

export interface LlmConfig {
  kind: LlmProviderKind;
  // openai-compat
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  // claude-code
  cliPath?: string;
}

export interface GitRepo {
  id: string;
  path: string;
  projectId: string | null;
  author: string;
}

export interface AppSettings {
  hotkey: string;
  todoHotkey: string;
  theme: Theme;
  boundaries: HalfBoundaries;
  llm: LlmConfig;
  repos: GitRepo[];
  gitImportMode: 'raw' | 'smart';
  autostart: boolean;
  /** 下班提醒：到点若今日记录不足则桌面通知。空字符串=关闭 */
  remindTime: string;
  /** 提醒阈值（分钟）：今日总工时低于此值则提醒 */
  remindMinMinutes: number;
}
