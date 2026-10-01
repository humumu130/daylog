import Database from '@tauri-apps/plugin-sql';
import type {
  Half,
  Project,
  RecordSource,
  RecordType,
  Report,
  ReportTemplate,
  Task,
  TaskStatus,
  Workspace,
  WorkspaceKind,
  WorkRecord,
} from '../types/models';

/**
 * 空间维度约定（P8b）：
 * - 查询函数的可选 wsId 参数：传则按 workspace_id 过滤（空间隔离），不传=跨空间全局
 *   （引擎/上报对账等跨空间场景用）。
 * - 写入函数的可选 workspaceId：不填默认 'work'（与迁移回填一致，存量调用零改动）。
 */
export const DEFAULT_WORKSPACE_ID = 'work';

let _db: Database | null = null;
let _dbPromise: Promise<Database> | null = null;
async function db(): Promise<Database> {
  if (_db) return _db;
  if (!_dbPromise) {
    _dbPromise = (async () => {
      let lastErr: unknown;
      for (let i = 0; i < 5; i++) {
        try {
          _db = await Database.load('sqlite:worklog.db');
          return _db;
        } catch (e) {
          lastErr = e;
          // 首启多窗口并发建库竞态（plugin-sql 的 connect 在池锁外，db 不存在时
          // 两路同时 create_database 可撞 SQLITE_CANTOPEN/BUSY）。Rust 侧 preload
          // 已根治主体；此处单飞 + 可重试错误 backoff 兜住残余窗口。
          const msg = String(e);
          if (!/code: 14|code: 5|unable to open|database is locked|database is busy/i.test(msg)) {
            throw e;
          }
          await new Promise((r) => setTimeout(r, 300 * (i + 1)));
        }
      }
      throw lastErr;
    })();
    _dbPromise.catch(() => {
      _dbPromise = null; // 失败清缓存，下次调用可重进
    });
  }
  return _dbPromise;
}

function safeParseArr(s: string): string[] {
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
function safeParseObj(s: string): Record<string, unknown> {
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------- Workspaces（P8b） ----------
interface WorkspaceRow {
  id: string;
  name: string;
  type: string;
  is_default: number;
  archived: number;
  created_at: number;
}
function mapWorkspace(r: WorkspaceRow): Workspace {
  return {
    id: r.id,
    name: r.name,
    type: r.type as WorkspaceKind,
    isDefault: !!r.is_default,
    archived: !!r.archived,
    createdAt: r.created_at,
  };
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const rows = await (await db()).select<WorkspaceRow[]>(
    'SELECT * FROM workspaces ORDER BY created_at ASC',
  );
  return rows.map(mapWorkspace);
}

export async function createWorkspace(input: { id?: string; name: string; type: WorkspaceKind; isDefault?: boolean }): Promise<string> {
  const id = input.id ?? crypto.randomUUID();
  await (await db()).execute(
    'INSERT INTO workspaces (id, name, type, is_default, archived, created_at) VALUES ($1,$2,$3,$4,0,$5)',
    [id, input.name, input.type, input.isDefault ? 1 : 0, Date.now()],
  );
  return id;
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  await (await db()).execute('UPDATE workspaces SET name=$1 WHERE id=$2', [name, id]);
}

/** 改空间类型（仅 work|personal 两值；首启向导「只记个人」把种子 work 行转 personal 用） */
export async function setWorkspaceKind(id: string, type: WorkspaceKind): Promise<void> {
  await (await db()).execute('UPDATE workspaces SET type=$1 WHERE id=$2', [type, id]);
}

export async function archiveWorkspace(id: string, archived: boolean): Promise<void> {
  await (await db()).execute('UPDATE workspaces SET archived=$1 WHERE id=$2', [archived ? 1 : 0, id]);
}

/** 设默认空间（互斥：先清其它） */
export async function setDefaultWorkspace(id: string): Promise<void> {
  const d = await db();
  await d.execute('UPDATE workspaces SET is_default=0 WHERE is_default=1');
  await d.execute('UPDATE workspaces SET is_default=1 WHERE id=$1', [id]);
}

/** 删除空间：仅允许空空间（无 records/projects/tasks），否则抛错——危险操作前置校验 */
export async function deleteWorkspace(id: string): Promise<void> {
  if (id === DEFAULT_WORKSPACE_ID) throw new Error('默认工作空间不可删除');
  const d = await db();
  const [pr, rec, tk] = await Promise.all([
    d.select<{ n: number }[]>('SELECT COUNT(*) as n FROM projects WHERE workspace_id=$1', [id]),
    d.select<{ n: number }[]>('SELECT COUNT(*) as n FROM records WHERE workspace_id=$1', [id]),
    d.select<{ n: number }[]>('SELECT COUNT(*) as n FROM tasks WHERE workspace_id=$1', [id]),
  ]);
  if ((pr[0]?.n ?? 0) + (rec[0]?.n ?? 0) + (tk[0]?.n ?? 0) > 0) {
    throw new Error('空间内仍有数据（记录/项目/任务），请先清空或归档');
  }
  await d.execute('DELETE FROM workspaces WHERE id=$1', [id]);
}

// ---------- Projects ----------
interface ProjectRow {
  id: string;
  name: string;
  color: string;
  keywords: string;
  is_active: number;
  sort_order: number;
  created_at: number;
  workspace_id: string;
}
function mapProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    keywords: safeParseArr(r.keywords),
    isActive: !!r.is_active,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    workspaceId: r.workspace_id ?? DEFAULT_WORKSPACE_ID,
  };
}

export interface ProjectInput {
  name: string;
  color: string;
  keywords: string[];
  isActive: boolean;
  sortOrder: number;
  /** 所属空间；不填= 'work'（存量调用兼容） */
  workspaceId?: string;
}

export async function listProjects(wsId?: string): Promise<Project[]> {
  const rows = wsId
    ? await (await db()).select<ProjectRow[]>(
        'SELECT * FROM projects WHERE workspace_id=$1 ORDER BY sort_order ASC, created_at ASC',
        [wsId],
      )
    : await (await db()).select<ProjectRow[]>(
        'SELECT * FROM projects ORDER BY sort_order ASC, created_at ASC',
      );
  return rows.map(mapProject);
}

export async function createProject(input: ProjectInput): Promise<string> {
  const id = crypto.randomUUID();
  await (await db()).execute(
    'INSERT INTO projects (id, name, color, keywords, is_active, sort_order, created_at, workspace_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, input.name, input.color, JSON.stringify(input.keywords), input.isActive ? 1 : 0, input.sortOrder, Date.now(), input.workspaceId ?? DEFAULT_WORKSPACE_ID],
  );
  return id;
}

export async function updateProject(id: string, input: ProjectInput): Promise<void> {
  await (await db()).execute(
    'UPDATE projects SET name=$1, color=$2, keywords=$3, is_active=$4, sort_order=$5 WHERE id=$6',
    [input.name, input.color, JSON.stringify(input.keywords), input.isActive ? 1 : 0, input.sortOrder, id],
  );
}

export async function deleteProject(id: string): Promise<void> {
  await (await db()).execute('DELETE FROM projects WHERE id=$1', [id]);
}

// ---------- Tasks ----------
interface TaskRow {
  id: string;
  title: string;
  project_id: string | null;
  status: string;
  start_date: string;
  end_date: string | null;
  note: string;
  created_at: number;
  updated_at: number;
  source?: string;
  external_key?: string | null;
  workspace_id?: string;
}
function mapTask(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    projectId: r.project_id,
    status: r.status as TaskStatus,
    startDate: r.start_date,
    endDate: r.end_date,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    source: (r.source as Task['source']) ?? 'manual',
    externalKey: r.external_key ?? null,
    workspaceId: r.workspace_id ?? DEFAULT_WORKSPACE_ID,
  };
}

export interface TaskInput {
  title: string;
  projectId: string | null;
  status: TaskStatus;
  startDate: string;
  endDate: string | null;
  note: string;
  /** 来源与外部幂等键（AI 会话 todo 摄入用）；updateTask 不改这两列 */
  source?: 'manual' | 'ai';
  externalKey?: string | null;
  /** 所属空间；不填= 'work'（存量调用兼容）。项目归属存在时以项目空间为准（调用方负责） */
  workspaceId?: string;
}

export async function listTasks(status?: TaskStatus, wsId?: string): Promise<Task[]> {
  const d = await db();
  const conds: string[] = [];
  const args: unknown[] = [];
  if (status) {
    conds.push(`status=$${args.length + 1}`);
    args.push(status);
  }
  if (wsId) {
    conds.push(`workspace_id=$${args.length + 1}`);
    args.push(wsId);
  }
  const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
  const rows = await d.select<TaskRow[]>(`SELECT * FROM tasks${where} ORDER BY updated_at DESC`, args);
  return rows.map(mapTask);
}

export async function createTask(input: TaskInput): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await (await db()).execute(
    'INSERT INTO tasks (id, title, project_id, status, start_date, end_date, note, created_at, updated_at, source, external_key, workspace_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [id, input.title, input.projectId, input.status, input.startDate, input.endDate, input.note, now, now, input.source ?? 'manual', input.externalKey ?? null, input.workspaceId ?? DEFAULT_WORKSPACE_ID],
  );
  return id;
}

/** 按外部幂等键找任务（AI todo 摄入防重） */
export async function findTaskByExternalKey(key: string): Promise<Task | null> {
  const rows = await (await db()).select<TaskRow[]>('SELECT * FROM tasks WHERE external_key=$1 LIMIT 1', [key]);
  return rows[0] ? mapTask(rows[0]) : null;
}

export async function updateTask(id: string, input: TaskInput): Promise<void> {
  await (await db()).execute(
    'UPDATE tasks SET title=$1, project_id=$2, status=$3, start_date=$4, end_date=$5, note=$6, updated_at=$7 WHERE id=$8',
    [input.title, input.projectId, input.status, input.startDate, input.endDate, input.note, Date.now(), id],
  );
}

export async function deleteTask(id: string): Promise<void> {
  await (await db()).execute('DELETE FROM tasks WHERE id=$1', [id]);
}

// ---------- Records ----------
interface RecordRow {
  id: string;
  task_id: string | null;
  project_id: string | null;
  content: string;
  duration_min: number | null;
  day: string;
  half: string;
  source: string;
  created_at: number;
  updated_at: number;
  meta: string;
  run_id?: string | null;
  workspace_id?: string;
  record_type?: string;
  learnings?: string;
  tags?: string;
}
function mapRecord(r: RecordRow): WorkRecord {
  return {
    id: r.id,
    taskId: r.task_id,
    projectId: r.project_id,
    content: r.content,
    durationMin: r.duration_min,
    day: r.day,
    half: r.half as Half,
    source: r.source as RecordSource,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    meta: safeParseObj(r.meta),
    runId: r.run_id ?? undefined,
    workspaceId: r.workspace_id ?? DEFAULT_WORKSPACE_ID,
    recordType: (r.record_type as RecordType | undefined) ?? 'work',
    learnings: safeParseArr(r.learnings ?? '[]'),
    tags: safeParseArr(r.tags ?? '[]'),
  };
}

export interface RecordInput {
  taskId: string | null;
  projectId: string | null;
  content: string;
  durationMin: number | null;
  day: string;
  half: Half;
  source: RecordSource;
  meta?: Record<string, unknown>;
  /** 所属空间；不填= 'work'（存量调用兼容） */
  workspaceId?: string;
  /** 记录类型（个人空间主用）；不填= 'work' */
  recordType?: RecordType;
  /** 学到什么（个人空间） */
  learnings?: string[];
  tags?: string[];
}

export async function listRecordsByDay(day: string, wsId?: string): Promise<WorkRecord[]> {
  const rows = wsId
    ? await (await db()).select<RecordRow[]>(
        'SELECT * FROM records WHERE day=$1 AND workspace_id=$2 ORDER BY created_at ASC',
        [day, wsId],
      )
    : await (await db()).select<RecordRow[]>(
        'SELECT * FROM records WHERE day=$1 ORDER BY created_at ASC',
        [day],
      );
  return rows.map(mapRecord);
}

export async function listRecordsByRange(from: string, to: string, wsId?: string): Promise<WorkRecord[]> {
  const rows = wsId
    ? await (await db()).select<RecordRow[]>(
        'SELECT * FROM records WHERE day >= $1 AND day <= $2 AND workspace_id=$3 ORDER BY day ASC, created_at ASC',
        [from, to, wsId],
      )
    : await (await db()).select<RecordRow[]>(
        'SELECT * FROM records WHERE day >= $1 AND day <= $2 ORDER BY day ASC, created_at ASC',
        [from, to],
      );
  return rows.map(mapRecord);
}

export async function createRecord(input: RecordInput, runId?: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await (await db()).execute(
    'INSERT INTO records (id, task_id, project_id, content, duration_min, day, half, source, created_at, updated_at, meta, run_id, workspace_id, record_type, learnings, tags) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
    [
      id,
      input.taskId,
      input.projectId,
      input.content,
      input.durationMin,
      input.day,
      input.half,
      input.source,
      now,
      now,
      JSON.stringify(input.meta ?? {}),
      runId ?? null,
      input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      input.recordType ?? 'work',
      JSON.stringify(input.learnings ?? []),
      JSON.stringify(input.tags ?? []),
    ],
  );
  return id;
}

export async function updateRecord(id: string, input: RecordInput): Promise<void> {
  await (await db()).execute(
    'UPDATE records SET task_id=$1, project_id=$2, content=$3, duration_min=$4, day=$5, half=$6, source=$7, updated_at=$8, meta=$9, record_type=$10, learnings=$11, tags=$12 WHERE id=$13',
    [
      input.taskId,
      input.projectId,
      input.content,
      input.durationMin,
      input.day,
      input.half,
      input.source,
      Date.now(),
      JSON.stringify(input.meta ?? {}),
      input.recordType ?? 'work',
      JSON.stringify(input.learnings ?? []),
      JSON.stringify(input.tags ?? []),
      id,
    ],
  );
}

export async function deleteRecord(id: string): Promise<void> {
  await (await db()).execute('DELETE FROM records WHERE id=$1', [id]);
}

/** 全局搜索记录内容（按内容模糊匹配，最近优先，最多 60 条）。wsId 传则限空间 */
export async function searchRecords(query: string, wsId?: string): Promise<WorkRecord[]> {
  const q = query.trim();
  if (!q) return [];
  // 转义 LIKE 通配符，避免用户输入的 % _ 被当通配
  const escaped = q.replace(/[/%_]/g, (c) => '/' + c);
  const rows = wsId
    ? await (await db()).select<RecordRow[]>(
        "SELECT * FROM records WHERE content LIKE $1 ESCAPE '/' AND workspace_id=$2 ORDER BY created_at DESC LIMIT 60",
        [`%${escaped}%`, wsId],
      )
    : await (await db()).select<RecordRow[]>(
        "SELECT * FROM records WHERE content LIKE $1 ESCAPE '/' ORDER BY created_at DESC LIMIT 60",
        [`%${escaped}%`],
      );
  return rows.map(mapRecord);
}

// ---------- Retrospectives（P8b 复盘快照） ----------
export interface RetrospectiveRow {
  id: string;
  workspaceId: string;
  period: string; // 'YYYY-Www' / 'YYYY-MM'
  kind: 'week' | 'month';
  content: string;
  createdAt: number;
}

export async function listRetrospectives(wsId: string, kind?: 'week' | 'month'): Promise<RetrospectiveRow[]> {
  const rows = kind
    ? await (await db()).select<RetrospectiveRow[]>(
        'SELECT id, workspace_id as "workspaceId", period, kind, content, created_at as "createdAt" FROM retrospectives WHERE workspace_id=$1 AND kind=$2 ORDER BY created_at DESC',
        [wsId, kind],
      )
    : await (await db()).select<RetrospectiveRow[]>(
        'SELECT id, workspace_id as "workspaceId", period, kind, content, created_at as "createdAt" FROM retrospectives WHERE workspace_id=$1 ORDER BY created_at DESC',
        [wsId],
      );
  return rows;
}

export async function saveRetrospective(row: { workspaceId: string; period: string; kind: 'week' | 'month'; content: string }): Promise<string> {
  const id = crypto.randomUUID();
  await (await db()).execute(
    'INSERT INTO retrospectives (id, workspace_id, period, kind, content, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, row.workspaceId, row.period, row.kind, row.content, Date.now()],
  );
  return id;
}

// ---------- Templates / Reports (Phase 2 使用，先备好接口) ----------
interface TemplateRow {
  id: string;
  name: string;
  body: string;
  is_default: number;
  created_at: number;
}
function mapTemplate(r: TemplateRow): ReportTemplate {
  return { id: r.id, name: r.name, body: r.body, isDefault: !!r.is_default, createdAt: r.created_at };
}

export async function listTemplates(): Promise<ReportTemplate[]> {
  const rows = await (await db()).select<TemplateRow[]>('SELECT * FROM templates ORDER BY created_at DESC');
  return rows.map(mapTemplate);
}
export async function saveTemplate(t: { id?: string; name: string; body: string; isDefault: boolean }): Promise<string> {
  const id = t.id ?? crypto.randomUUID();
  await (await db()).execute(
    'INSERT INTO templates (id, name, body, is_default, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET name=$2, body=$3, is_default=$4',
    [id, t.name, t.body, t.isDefault ? 1 : 0, Date.now()],
  );
  return id;
}
export async function deleteTemplate(id: string): Promise<void> {
  await (await db()).execute('DELETE FROM templates WHERE id=$1', [id]);
}

interface ReportRow {
  id: string;
  month: string;
  template_id: string | null;
  body: string;
  provider: string;
  model: string;
  created_at: number;
  date_from: string | null;
  date_to: string | null;
}
function mapReport(r: ReportRow): Report {
  return {
    id: r.id,
    month: r.month,
    templateId: r.template_id,
    body: r.body,
    provider: r.provider,
    model: r.model,
    createdAt: r.created_at,
    dateFrom: r.date_from,
    dateTo: r.date_to,
  };
}
export async function listReports(month: string): Promise<Report[]> {
  const rows = await (await db()).select<ReportRow[]>('SELECT * FROM reports WHERE month=$1 ORDER BY created_at DESC', [month]);
  return rows.map(mapReport);
}
export async function listAllReports(): Promise<Report[]> {
  const rows = await (await db()).select<ReportRow[]>('SELECT * FROM reports ORDER BY created_at DESC');
  return rows.map(mapReport);
}
/** 取 date_to 最大（覆盖到最晚）的那份报告的起止日期，用于月报默认起始 = 其结束日+1 */
export async function getLatestReportRange(): Promise<{ from: string | null; to: string | null } | null> {
  const rows = await (await db()).select<ReportRow[]>(
    'SELECT * FROM reports WHERE date_to IS NOT NULL ORDER BY date_to DESC LIMIT 1',
  );
  if (rows.length === 0) return null;
  return { from: rows[0].date_from, to: rows[0].date_to };
}
export async function saveReport(r: { month: string; templateId: string | null; body: string; provider: string; model: string; dateFrom?: string | null; dateTo?: string | null }): Promise<string> {
  const id = crypto.randomUUID();
  await (await db()).execute(
    'INSERT INTO reports (id, month, template_id, body, provider, model, created_at, date_from, date_to) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, r.month, r.templateId, r.body, r.provider, r.model, Date.now(), r.dateFrom ?? null, r.dateTo ?? null],
  );
  return id;
}

// ==================== 猪齿鱼上报日志（choerodon_sync_log，P8 幂等防重） ====================

export interface SyncLogRow {
  logId: string;
  recordId: string;
  day: string;
  minutes: number;
  strategyRunId: string | null;
  payload: string;
  createdAt: number;
}

/** 单条上报留痕（log_id 主键=平台返回的工时日志 id 或本地生成，防重报） */
export async function insertSyncLog(row: {
  logId: string;
  recordId: string;
  day: string;
  minutes: number;
  strategyRunId?: string | null;
  payload?: unknown;
}): Promise<void> {
  await (await db()).execute(
    'INSERT OR REPLACE INTO choerodon_sync_log (log_id, record_id, day, minutes, strategy_run_id, payload, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [row.logId, row.recordId, row.day, row.minutes, row.strategyRunId ?? null, JSON.stringify(row.payload ?? {}), Date.now()],
  );
}

/** 窗口内已上报的天→分钟汇总（对账防重：已报日跳过/标记） */
export async function listSyncLogDays(from: string, to: string): Promise<Map<string, number>> {
  const rows = await (await db()).select<SyncLogRow[]>(
    'SELECT * FROM choerodon_sync_log WHERE day >= $1 AND day <= $2',
    [from, to],
  );
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.day, (m.get(r.day) ?? 0) + r.minutes);
  return m;
}

/** 某条记录是否已上报过（record_id 维度防重） */
export async function isRecordSynced(recordId: string): Promise<boolean> {
  const rows = await (await db()).select<{ n: number }[]>(
    'SELECT COUNT(*) as n FROM choerodon_sync_log WHERE record_id = $1',
    [recordId],
  );
  return (rows[0]?.n ?? 0) > 0;
}
