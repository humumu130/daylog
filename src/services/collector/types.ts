// 采集引擎类型（P5）：与 Rust ai_scan.rs 的四个命令契约一一对应（camelCase）。
// 任何形状变更必须两侧同步改。

import type { CollectSettings, LlmConfig, Project, WorkRecord } from '../../types/models';

/** ai_session_list 返回：一个会话 jsonl 文件的元信息 */
export interface AiSessionInfo {
  provider: string; // 'claude-code' | 'codex'（Rust detect_provider 按路径判定）
  file: string;
  sizeBytes: number;
  lastModified: number; // ms
  lastEventTs: number | null; // ms
}

/** ai_session_parse 返回：自水位线起新解析出的事件 */
export interface AiParseResult {
  file: string;
  sizeBytes: number; // 新文件长度 = 下一条水位线
  parseErrors: number;
  events: AiEvent[];
}

export type AiEventKind = 'human_prompt' | 'assistant_tail' | 'todo_tool';

export interface AiTodoInfo {
  action: 'create' | 'update' | 'write';
  subject: string;
  status: string | null;
}

export interface AiEvent {
  provider: string;
  kind: AiEventKind;
  ts: number; // ms
  day: string; // 本地 YYYY-MM-DD
  cwd: string;
  gitBranch: string | null;
  text: string;
  todo: AiTodoInfo | null;
}

/** ai_session_cwds 返回：未映射面板/F2 候选/P6 状态头共用 */
export interface CwdSummary {
  provider: string;
  cwd: string;
  gitBranch: string | null;
  sessions: number;
  lastTs: number | null;
}

/** discover_repos 返回 */
export interface DiscoveredRepo {
  path: string;
  remote: string | null;
  readmeTitle: string | null;
  hasPackageJson: boolean;
}

/** 引擎输入：一条待整合事件（AI 事件或 Git 提交的归一形态），带指纹 */
export interface EngineInput {
  fingerprint: string; // sha256 hex，幂等主键
  provider: 'claude-code' | 'codex' | 'git';
  day: string;
  projectId: string | null; // cwd/仓库最长前缀匹配；null=未映射
  kind: AiEventKind | 'commit';
  ts: number | null; // commit 无精确时间戳时为 null（day 级）
  text: string;
  human: boolean; // 是否人工交互事件（human_prompt/commit 为 true）
}

/** 活跃区间（估时与加班共用的同一套区间） */
export interface ActiveInterval {
  start: number; // ms
  end: number; // ms
  projectId: string | null;
  human: boolean; // 区间内是否含人工交互事件（加班判定硬条件）
  minutes: number;
}

/** LLM 整合输出条目（严格 JSON 协议） */
export interface ConsolidatedEntry {
  title: string;
  hours: number;
  sources: string[]; // 指纹列表：本条由哪些输入事件整合而来
  confidence: number; // 0~1
  half?: 'morning' | 'afternoon' | 'evening' | 'allday';
}

/** LLM 噪音判定输出 */
export interface NoiseVerdict {
  digest: string; // 原文摘要（≤60 字）
  reason: string;
  confidence: number; // 0~1 噪音置信度
  sources: string[];
}

export type NoiseStatus = 'auto_dropped' | 'pending' | 'kept' | 'dropped';

export interface NoiseReview {
  fingerprint: string; // sha256(workspaceId + digest)
  workspaceId: string;
  status: NoiseStatus;
  digest: string;
  reason: string;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

/** 一次整合运行的结果摘要（写 consolidate_runs.summary，供 UI 展示） */
export interface RunSummary {
  created: number;
  skippedExisting: number;
  pending: number; // 进待确认的噪音数
  autoDropped: number;
  degraded: boolean; // LLM 失败降级为规则入库？
}

/** 扫描器上下文：引擎与调度器从外部注入（settings/projects/已有记录），保持服务纯函数化 */
export interface CollectorCtx {
  settings: CollectSettings;
  llm: LlmConfig;
  projects: Project[];
  existingRecords: WorkRecord[]; // 引擎只读（防语义重复）
}
