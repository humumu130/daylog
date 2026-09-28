// P8·上报抽象契约：所有工时上报平台适配器实现本接口（当前唯一实现 choerodon）。
// UI 侧（上报向导/设置页）按此文件类型开发，字段名与签名一字不能差。
// PAT 明文只经 ReporterCtx 在内存中传递，持久化一律走 OS keychain（见 ./secrets.ts）。

export interface ReporterCapabilities {
  listProjects: boolean;
  searchIssues: boolean;
  createIssue: boolean;
  createSubtask: boolean;
  logWork: boolean;
  /** 工时日历（对账）；false=向导降级仅靠本地 sync_log */
  queryWorkCalendar: boolean;
}

export interface ReporterCtx {
  baseUrl: string;
  pat: string;
  orgId?: string;
  userId?: string;
}

export interface RemoteProject {
  id: string;
  name: string;
  code: string;
}

export interface RemoteIssue {
  issueId: string;
  issueNum: string;
  summary: string;
  typeCode: string;
  statusCode: string;
  projectId: string;
  lastUpdateDate: string;
}

export interface WorkLogInput {
  issueId: string;
  projectId: string;
  date: string;
  hours: number;
}

export interface ReporterAdapter {
  readonly id: string;
  readonly label: string;
  readonly authKind: 'pat';
  capabilities(): ReporterCapabilities;
  testConnection(ctx: ReporterCtx): Promise<{ userId: string; orgId: string }>;
  listProjects(ctx: ReporterCtx): Promise<RemoteProject[]>;
  searchIssues(ctx: ReporterCtx, projectId: string, keyword?: string): Promise<RemoteIssue[]>;
  createIssue(ctx: ReporterCtx, projectId: string, input: { summary: string; issueTypeId?: string }): Promise<RemoteIssue>;
  createSubtask(ctx: ReporterCtx, projectId: string, parentIssueId: string, input: { summary: string }): Promise<RemoteIssue>;
  listIssueTypes(ctx: ReporterCtx, projectId: string): Promise<{ id: string; name: string; typeCode: string }[]>;
  logWork(ctx: ReporterCtx, input: WorkLogInput): Promise<{ logId: string }>;
  queryWorkCalendar?(ctx: ReporterCtx, from: string, to: string): Promise<{ date: string; minutes: number }[]>;
}
