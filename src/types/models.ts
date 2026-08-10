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
  /** 报告覆盖的起止日期（YYYY-MM-DD），用于季/年报检测漏天、月报默认起始 */
  dateFrom: string | null;
  dateTo: string | null;
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
  /** 显示/隐藏主窗口的热键 */
  mainHotkey: string;
  theme: Theme;
  boundaries: HalfBoundaries;
  llm: LlmConfig;
  repos: GitRepo[];
  gitImportMode: 'raw' | 'smart';
  /** Git 提交作者（全局，扫描时按此过滤；各仓库 author 可单独覆盖） */
  gitAuthor: string;
  autostart: boolean;
  /** 下班提醒：到点若今日记录不足则桌面通知。空字符串=关闭 */
  remindTime: string;
  /** 提醒阈值（分钟）：今日总工时低于此值则提醒 */
  remindMinMinutes: number;
  /** 单日工时上限（小时）：Git 区间分配时遵守，默认 8 */
  dailyCapHours: number;
  /** 自动备份：开关 / 保留份数 / 自定义目录（空=默认 com.worklog.app/backups） */
  autoBackupEnabled: boolean;
  autoBackupKeep: number;
  autoBackupDir: string;
  /** 猪齿鱼对接配置（null = 未启用；公司专属，不进开源） */
  choerodon: ChoerodonSettings | null;
}

export interface ChoerodonSettings {
  baseUrl: string;          // API 地址
  username: string;         // 邮箱
  encryptedPassword: string; // RSA 加密的 base64 密码
  orgId: string;            // 组织 ID
}
