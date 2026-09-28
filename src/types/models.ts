// 领域模型（camelCase）。DB 列为 snake_case，映射在 services/db.ts 完成。

export type Half = 'allday' | 'morning' | 'afternoon' | 'evening';
export type TaskStatus = 'active' | 'paused' | 'done';
export type RecordSource = 'manual' | 'git' | 'timer' | 'import' | 'ai' | 'mixed';
export type LlmProviderKind = 'openai-compat' | 'anthropic' | 'claude-code';
export type Theme = 'light' | 'dark';

/** 空间类型（枚举锁死两值：模块矩阵依赖类型语义，自定义类型会打穿显隐/守卫体系） */
export type WorkspaceKind = 'work' | 'personal';

/** 空间（P8b）：工作空间（工时/上报/额度）与个人空间（成长记录/复盘/无上报）数据隔离，采集引擎共享 */
export interface Workspace {
  id: string;
  name: string;
  type: WorkspaceKind;
  isDefault: boolean;
  archived: boolean;
  createdAt: number;
}

/** 记录类型（个人空间主用；work 空间恒 'work'） */
export type RecordType = 'work' | 'learning' | 'practice' | 'milestone' | 'thought' | 'retro';

export const RECORD_TYPE_LABELS: Record<RecordType, string> = {
  work: '工作',
  learning: '学到什么',
  practice: '练习实践',
  milestone: '里程碑',
  thought: '想法',
  retro: '复盘',
};

export interface Project {
  id: string;
  name: string;
  color: string;
  keywords: string[];
  isActive: boolean;
  sortOrder: number;
  createdAt: number;
  /** 所属空间（P8b；存量= 'work'） */
  workspaceId: string;
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
  /** 来源：手动 / AI 会话 todo 摄入 */
  source: 'manual' | 'ai';
  /** 外部幂等键 sha1(provider+normalize(subject)+projectId)，AI 摄入防重 */
  externalKey: string | null;
  /** 所属空间（P8b；存量= 'work'） */
  workspaceId: string;
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
  /** 产生本条的整合运行 id（自动条目溯源/按 run 撤销）；手动条目无 */
  runId?: string;
  /** 所属空间（P8b；存量= 'work'） */
  workspaceId: string;
  /** 记录类型（个人空间主用；work 空间恒 'work'） */
  recordType: RecordType;
  /** 学到什么（个人空间 learnings 全链路；work 空间为空数组） */
  learnings: string[];
  /** 标签 */
  tags: string[];
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

/** 采集引擎设置（P5）：无感日志体系的行为开关与阈值 */
export interface CollectSettings {
  /** 总开关：关=调度器不跑（手动补扫仍可用） */
  enabled: boolean;
  /** AI 会话扫描根目录（空=默认 ~/.claude/projects） */
  scanRoots: string[];
  /** 启动补扫回看天数（水位线兜底，默认 7，远小于源数据 30 天保留） */
  lookbackDays: number;
  /** 超过此天数的会话文件跳过（对齐源数据 30 天保留期） */
  retentionDays: number;
  /** 活跃区间切断阈值（分钟）：相邻事件间隔超过此值即切段，默认 15 */
  gapMinutes: number;
  /** 出网脱敏总线开关（默认开；关闭需自担风险，UI 有明确提示） */
  scrubEnabled: boolean;
  /** 噪音过滤开关（默认开） */
  noiseFilter: boolean;
  /** 噪音严格度：true=严格（更多进待确认）/ false=宽松（更多自动排除） */
  noiseStrict: boolean;
  /** 工时边界（加班判定）：上班/下班时间，HH:mm */
  workStartTime: string;
  workEndTime: string;
  /** 周末活动计入加班（默认开） */
  weekendOvertime: boolean;
  /** 上班前早到计入加班（默认关） */
  earlyStartOvertime: boolean;
  /** 月度加班额度（小时）：上限提醒用（证据如实累计，不硬塞不硬砍） */
  overtimeCapHours: number;
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
  /** 侧栏「图标+文字」模式（默认纯图标保持密度，非开发者兜底） */
  sidebarLabels: boolean;
  /** 自动备份：开关 / 保留份数 / 自定义目录（空=默认 com.worklog.app/backups） */
  autoBackupEnabled: boolean;
  autoBackupKeep: number;
  autoBackupDir: string;
  /** 采集引擎（P5 无感日志体系） */
  collect: CollectSettings;
  /** 猪齿鱼对接配置（null = 未启用；公司专属，不进开源） */
  choerodon: ChoerodonSettings | null;
  /** 填报策略（P8）：上报向导与导出的时长口径；本地日志永远如实 */
  reportPolicy: ReportPolicy;
  /** 首启向导已完成（P8b：三选一只弹一次） */
  onboardDone: boolean;
  /** Obsidian 库路径（个人空间每日导出；空=未配置） */
  obsidianDir: string;
}

export interface ChoerodonSettings {
  baseUrl: string;          // API 地址
  orgId: string;            // 组织 ID（PAT self 接口可自动补全，可留空）
  /** PAT 明文只存 OS keychain（Rust secret_put，service='daylog' account='choerodon-pat'）；
   *  此处只留尾 4 位供显示，空串=未配置 */
  patTail: string;
  /** 本地项目 id → 猪齿鱼项目 id（F1 映射；空=未映射→向导/健康检查黄提醒） */
  projectMap: Record<string, string>;
  /** 上次全成功上报日（YYYY-MM-DD；窗口推进：此后→本次。'' = 从未上报） */
  lastSyncDay: string;
}

/** 填报策略（上报/导出口径；本地日志永远如实）：fact=如实 / fill=按目标补齐（缺口按当日项目比例分摊至 dailyCap） */
export type ReportPolicy = 'fact' | 'fill';
