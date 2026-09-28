import Database from '@tauri-apps/plugin-sql';
import type {
  Half,
  Project,
  RecordSource,
  Report,
  ReportTemplate,
  Task,
  TaskStatus,
  WorkRecord,
} from '../types/models';

let _db: Database | null = null;
async function db(): Promise<Database> {
  if (!_db) _db = await Database.load('sqlite:worklog.db');
  return _db;
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

// ---------- Projects ----------
interface ProjectRow {
  id: string;
  name: string;
  color: string;
  keywords: string;
  is_active: number;
  sort_order: number;
  created_at: number;
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
  };
}

export interface ProjectInput {
  name: string;
  color: string;
  keywords: string[];
  isActive: boolean;
  sortOrder: number;
}

export async function listProjects(): Promise<Project[]> {
  const rows = await (await db()).select<ProjectRow[]>(
    'SELECT * FROM projects ORDER BY sort_order ASC, created_at ASC',
  );
  return rows.map(mapProject);
}

export async function createProject(input: ProjectInput): Promise<string> {
  const id = crypto.randomUUID();
  await (await db()).execute(
    'INSERT INTO projects (id, name, color, keywords, is_active, sort_order, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, input.name, input.color, JSON.stringify(input.keywords), input.isActive ? 1 : 0, input.sortOrder, Date.now()],
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
}

export async function listTasks(status?: TaskStatus): Promise<Task[]> {
  const d = await db();
  const rows = status
    ? await d.select<TaskRow[]>('SELECT * FROM tasks WHERE status=$1 ORDER BY updated_at DESC', [status])
    : await d.select<TaskRow[]>('SELECT * FROM tasks ORDER BY updated_at DESC');
  return rows.map(mapTask);
}

export async function createTask(input: TaskInput): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await (await db()).execute(
    'INSERT INTO tasks (id, title, project_id, status, start_date, end_date, note, created_at, updated_at, source, external_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [id, input.title, input.projectId, input.status, input.startDate, input.endDate, input.note, now, now, input.source ?? 'manual', input.externalKey ?? null],
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
}

export async function listRecordsByDay(day: string): Promise<WorkRecord[]> {
  const rows = await (await db()).select<RecordRow[]>(
    'SELECT * FROM records WHERE day=$1 ORDER BY created_at ASC',
    [day],
  );
  return rows.map(mapRecord);
}

export async function listRecordsByRange(from: string, to: string): Promise<WorkRecord[]> {
  const rows = await (await db()).select<RecordRow[]>(
    'SELECT * FROM records WHERE day >= $1 AND day <= $2 ORDER BY day ASC, created_at ASC',
    [from, to],
  );
  return rows.map(mapRecord);
}

export async function createRecord(input: RecordInput, runId?: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await (await db()).execute(
    'INSERT INTO records (id, task_id, project_id, content, duration_min, day, half, source, created_at, updated_at, meta, run_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
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
    ],
  );
  return id;
}

export async function updateRecord(id: string, input: RecordInput): Promise<void> {
  await (await db()).execute(
    'UPDATE records SET task_id=$1, project_id=$2, content=$3, duration_min=$4, day=$5, half=$6, source=$7, updated_at=$8, meta=$9 WHERE id=$10',
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
      id,
    ],
  );
}

export async function deleteRecord(id: string): Promise<void> {
  await (await db()).execute('DELETE FROM records WHERE id=$1', [id]);
}

/** 全局搜索记录内容（按内容模糊匹配，最近优先，最多 60 条） */
export async function searchRecords(query: string): Promise<WorkRecord[]> {
  const q = query.trim();
  if (!q) return [];
  // 转义 LIKE 通配符，避免用户输入的 % _ 被当通配
  const escaped = q.replace(/[/%_]/g, (c) => '/' + c);
  const rows = await (await db()).select<RecordRow[]>(
    "SELECT * FROM records WHERE content LIKE $1 ESCAPE '/' ORDER BY created_at DESC LIMIT 60",
    [`%${escaped}%`],
  );
  return rows.map(mapRecord);
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
