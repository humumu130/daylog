// P8·猪齿鱼（Choerodon）PAT 适配器：Bearer token 直连 API。
// 取代旧的「RSA 加密密码模拟登录」实现（src/services/choerodon.ts，待退役删除）——
// 端点与请求体沿用旧实现已装机验证的部分，登录链路整体换为 PAT。

import { fetch } from '@tauri-apps/plugin-http';
import type {
  RemoteIssue,
  RemoteProject,
  ReporterAdapter,
  ReporterCapabilities,
  ReporterCtx,
  WorkLogInput,
} from './types';

// ==================== 端点常量（装机验证状态逐条注明） ====================

// 已装机验证（旧实现同端点，Bearer PAT 可用）→ { id, organizationId, loginName? }
const EP_USERS_SELF = (baseUrl: string) => `${baseUrl}/iam/choerodon/v1/users/self`;

// 已装机验证（旧实现同款）。需 ctx.orgId/userId，向导在 testConnection 后带上。
const EP_PROJECTS_PAGING = (baseUrl: string, orgId: string, userId: string) =>
  `${baseUrl}/cbase/choerodon/v1/organizations/${orgId}/users/${userId}/projects/paging?page=0&size=50`;

// 已装机验证。keyword 由前端 filter（issueNum/summary includes，大小写不敏感）。
const EP_ISSUES_WORK_LIST = (baseUrl: string, projectId: string) =>
  `${baseUrl}/agile/v2/projects/${projectId}/issues/work_list?page=0&size=100`;

// 已装机验证。logId 取响应 id（大数转串）。
const EP_WORK_LOG = (baseUrl: string, projectId: string) =>
  `${baseUrl}/agile/v1/projects/${projectId}/work_log`;

// —— 以下三个端点未装机验证，PAT 首连时探测 ——

// 未装机验证，PAT 首连时探测
const EP_CREATE_ISSUE = (baseUrl: string, projectId: string) =>
  `${baseUrl}/agile/v1/projects/${projectId}/issue`;

// 未装机验证，PAT 首连时探测
const EP_CREATE_SUBTASK = (baseUrl: string, projectId: string) =>
  `${baseUrl}/agile/v1/projects/${projectId}/sub_issue`;

// 未装机验证，PAT 首连时探测（响应数组字段名可能是 id/name/typeCode 或 issueTypeId/name/code，做多字段兜底）
const EP_ISSUE_TYPES = (baseUrl: string, projectId: string) =>
  `${baseUrl}/agile/v1/projects/${projectId}/issue_types`;

// 工时日历候选端点：两个依次探测（任一 200 且可解析即用），都失败则 capabilities().queryWorkCalendar=false
const EP_WORK_CALENDAR_CANDIDATES: ((baseUrl: string, orgId: string, from: string, to: string) => string)[] = [
  (baseUrl, orgId, from, to) =>
    `${baseUrl}/base/v1/organizations/${orgId}/work_calendar/personal?startDate=${from}&endDate=${to}`,
  (baseUrl, orgId, from, to) =>
    `${baseUrl}/agile/v1/organizations/${orgId}/work_calendars?startDate=${from}&endDate=${to}`,
];

// ==================== 基础设施 ====================

const REQUEST_TIMEOUT_MS = 15_000;

/** 把 JSON 里的大数（雪花 ID）转成字符串，避免 JS 精度丢失（沿用旧实现，扩展 parentId/issueTypeId） */
function parseBigintJSON(text: string): unknown {
  // 匹配 "key":1234567890123456（15位以上数字）→ "key":"1234567890123456"
  const fixed = text.replace(
    /"(id|issueId|projectId|assigneeId|reporterId|epicId|sprintId|userId|organizationId|parentId|issueTypeId)":(\d{15,})/g,
    '"$1":"$2"',
  );
  return JSON.parse(fixed);
}

/** 统一请求出口：拼 Bearer 头、15s 超时、非 2xx 抛带状态码与前 200 字响应体的中文错误 */
async function choerodonFetch(ctx: ReporterCtx, path: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${ctx.pat}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error(`猪齿鱼请求超时（${REQUEST_TIMEOUT_MS / 1000}s）：${path}`);
    }
    throw new Error(`猪齿鱼网络请求失败：${e instanceof Error ? e.message : String(e)}（检查网络或 API 地址）`);
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`猪齿鱼请求失败 (${resp.status})：PAT 无效或过期，请重新生成并保存 PAT。${body.slice(0, 200)}`);
    }
    throw new Error(`猪齿鱼请求失败 (${resp.status}): ${body.slice(0, 200)}`);
  }
  return resp;
}

/** 请求并解析 JSON（大数转串） */
async function choerodonJson(ctx: ReporterCtx, path: string, init?: RequestInit): Promise<unknown> {
  const resp = await choerodonFetch(ctx, path, init);
  return parseBigintJSON(await resp.text());
}

/** 兼容分页包 { content: [...] } 与裸数组两种响应形态 */
function unwrapContent(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const content = (data as { content?: unknown })?.content;
  if (Array.isArray(content)) return content as Record<string, unknown>[];
  return [];
}

/** POST JSON 请求体 */
const jsonBody = (obj: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(obj) });

// ==================== 工时日历探测（实例内缓存） ====================

/** null=未探测（按支持算）；true=探测成功（记录可用端点）；false=两个候选都失败 */
let calendarProbe: { available: boolean; endpoint?: number } = { available: true };

/** 从未知形态的日历响应里提取 { date, minutes }[]；提取不到任何有效行返回 null（=不可解析） */
function extractCalendarRows(data: unknown): { date: string; minutes: number }[] | null {
  const rows = unwrapContent(data);
  const out: { date: string; minutes: number }[] = [];
  for (const item of rows) {
    const rawDate = String(item.date ?? item.workDay ?? item.day ?? item.calendarDay ?? '');
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(rawDate.trim());
    if (!m) continue;
    let minutes: number | null = null;
    const mins = item.minutes ?? item.workMinutes ?? item.min;
    if (typeof mins === 'number' && Number.isFinite(mins)) {
      minutes = mins;
    } else {
      // workTime/workHours 按小时计，转分钟
      const hours = item.workTime ?? item.workHours;
      if (typeof hours === 'number' && Number.isFinite(hours)) minutes = hours * 60;
    }
    out.push({ date: m[1], minutes: minutes ?? 0 });
  }
  return out.length > 0 ? out : null;
}

// ==================== 适配器 ====================

interface RawIssueLike {
  issueId?: unknown;
  issueNum?: unknown;
  summary?: unknown;
  typeCode?: unknown;
  statusCode?: unknown;
  projectId?: unknown;
  lastUpdateDate?: unknown;
  assigneeId?: unknown;
}

function mapIssue(item: Record<string, unknown>, fallbackProjectId: string): RemoteIssue {
  const it = item as RawIssueLike;
  return {
    issueId: String(it.issueId ?? item.id ?? ''),
    issueNum: String(it.issueNum ?? ''),
    summary: String(it.summary ?? ''),
    typeCode: String(it.typeCode ?? ''),
    statusCode: String(it.statusCode ?? ''),
    projectId: String(it.projectId ?? fallbackProjectId),
    lastUpdateDate: String(it.lastUpdateDate ?? ''),
  };
}

export const choerodonReporter: ReporterAdapter = {
  id: 'choerodon',
  label: '猪齿鱼',
  authKind: 'pat',

  capabilities(): ReporterCapabilities {
    return {
      listProjects: true,
      searchIssues: true,
      createIssue: true,
      createSubtask: true,
      logWork: true,
      // 按探测结果动态返回：未探测/探测成功=true，两个候选端点都失败=false
      queryWorkCalendar: calendarProbe.available,
    };
  },

  async testConnection(ctx: ReporterCtx): Promise<{ userId: string; orgId: string }> {
    const data = (await choerodonJson(ctx, EP_USERS_SELF(ctx.baseUrl))) as {
      id?: unknown;
      organizationId?: unknown;
    };
    if (data?.id === undefined || data?.id === null) {
      throw new Error('猪齿鱼返回的用户信息缺少 id，无法完成连接测试');
    }
    return {
      userId: String(data.id),
      orgId: String(data.organizationId ?? ctx.orgId ?? ''),
    };
  },

  async listProjects(ctx: ReporterCtx): Promise<RemoteProject[]> {
    if (!ctx.orgId || !ctx.userId) {
      throw new Error('缺少 orgId/userId：请先 testConnection 获取后再调用 listProjects');
    }
    const data = await choerodonJson(
      ctx,
      EP_PROJECTS_PAGING(ctx.baseUrl, ctx.orgId, ctx.userId),
      jsonBody({ projectCustomFieldSearchVO: { option: [] } }),
    );
    return unwrapContent(data)
      .map((item: Record<string, unknown>) => {
        const p = (item.projectDTO ?? item) as Record<string, unknown>;
        return {
          id: String(p.id ?? ''),
          name: String(p.name ?? ''),
          code: String(p.code ?? ''),
        };
      })
      .filter((p) => p.id !== '');
  },

  async searchIssues(ctx: ReporterCtx, projectId: string, keyword?: string): Promise<RemoteIssue[]> {
    const data = await choerodonJson(
      ctx,
      EP_ISSUES_WORK_LIST(ctx.baseUrl, projectId),
      jsonBody({ treeFlag: true, withSubIssues: false }),
    );
    let items = unwrapContent(data);
    // 按经办人过滤（沿用旧实现装机验证的前端过滤；无 userId 时不过滤）
    if (ctx.userId) {
      items = items.filter((item: Record<string, unknown>) => String(item.assigneeId ?? '') === ctx.userId);
    }
    // keyword 前端 filter：issueNum/summary includes，大小写不敏感
    if (keyword && keyword.trim() !== '') {
      const kw = keyword.trim().toLowerCase();
      items = items.filter((item: Record<string, unknown>) => {
        const num = String(item.issueNum ?? '').toLowerCase();
        const sum = String(item.summary ?? '').toLowerCase();
        return num.includes(kw) || sum.includes(kw);
      });
    }
    const issues = items.map((item: Record<string, unknown>) => mapIssue(item, projectId));
    // 按更新时间倒序（最近在前，便于向导默认选最新）
    issues.sort((a, b) => b.lastUpdateDate.localeCompare(a.lastUpdateDate));
    return issues;
  },

  // —— 以下三个能力未装机验证，端点在 PAT 首连时探测 ——

  async createIssue(ctx: ReporterCtx, projectId: string, input: { summary: string; issueTypeId?: string }): Promise<RemoteIssue> {
    const data = (await choerodonJson(
      ctx,
      EP_CREATE_ISSUE(ctx.baseUrl, projectId),
      jsonBody({ summary: input.summary, issueTypeId: input.issueTypeId, projectId }),
    )) as Record<string, unknown>;
    return mapIssue((data?.issueDTO ?? data) as Record<string, unknown>, projectId);
  },

  async createSubtask(ctx: ReporterCtx, projectId: string, parentIssueId: string, input: { summary: string }): Promise<RemoteIssue> {
    const data = (await choerodonJson(
      ctx,
      EP_CREATE_SUBTASK(ctx.baseUrl, projectId),
      jsonBody({ summary: input.summary, parentId: parentIssueId, projectId }),
    )) as Record<string, unknown>;
    return mapIssue((data?.issueDTO ?? data) as Record<string, unknown>, projectId);
  },

  async listIssueTypes(ctx: ReporterCtx, projectId: string): Promise<{ id: string; name: string; typeCode: string }[]> {
    const data = await choerodonJson(ctx, EP_ISSUE_TYPES(ctx.baseUrl, projectId));
    // 字段名容错：id/issueTypeId、name/name、typeCode/code 多字段兜底
    return unwrapContent(data)
      .map((t: Record<string, unknown>) => ({
        id: String(t.id ?? t.issueTypeId ?? ''),
        name: String(t.name ?? t.issueTypeName ?? ''),
        typeCode: String(t.typeCode ?? t.code ?? ''),
      }))
      .filter((t) => t.id !== '');
  },

  async logWork(ctx: ReporterCtx, input: WorkLogInput): Promise<{ logId: string }> {
    // startDate = 上报日期 + 当前时刻 HH:mm:ss（沿用旧实现）
    const startDate = `${input.date} ${new Date().toTimeString().slice(0, 8)}`;
    const data = (await choerodonJson(
      ctx,
      EP_WORK_LOG(ctx.baseUrl, input.projectId),
      jsonBody({
        issueId: input.issueId,
        projectId: input.projectId,
        startDate,
        workTime: input.hours,
        residualPrediction: 'self_adjustment',
        workHoursAttachments: [],
      }),
    )) as { id?: unknown; logId?: unknown };
    const logId = String(data?.id ?? data?.logId ?? '');
    if (!logId) throw new Error('工时上报成功但响应缺少 logId，无法登记防重日志');
    return { logId };
  },

  async queryWorkCalendar(ctx: ReporterCtx, from: string, to: string): Promise<{ date: string; minutes: number }[]> {
    if (!ctx.orgId) {
      calendarProbe = { available: false };
      throw new Error('缺少 orgId：工时日历查询需要组织 ID');
    }
    // 探测成功的端点直接复用；否则依次探测两个候选
    const order =
      calendarProbe.endpoint !== undefined
        ? [calendarProbe.endpoint]
        : EP_WORK_CALENDAR_CANDIDATES.map((_, i) => i);
    let lastErr: unknown = null;
    for (const idx of order) {
      try {
        const data = await choerodonJson(ctx, EP_WORK_CALENDAR_CANDIDATES[idx](ctx.baseUrl, ctx.orgId, from, to));
        const rows = extractCalendarRows(data);
        if (rows) {
          calendarProbe = { available: true, endpoint: idx };
          return rows;
        }
        lastErr = new Error(`端点 ${idx} 返回 200 但无法解析为日历`);
      } catch (e) {
        lastErr = e;
      }
    }
    // 两个候选都失败：本实例降级（capabilities().queryWorkCalendar=false），向导仅靠本地 sync_log
    calendarProbe = { available: false };
    throw new Error(
      `工时日历不可用（两个候选端点均失败），已降级为仅本地记录：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  },
};
