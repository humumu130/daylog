import { fetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';

/** 把 JSON 里的大数（雪花 ID）转成字符串，避免 JS 精度丢失 */
function parseBigintJSON(text: string): unknown {
  // 匹配 "key":1234567890123456（15位以上数字）→ "key":"1234567890123456"
  const fixed = text.replace(/"(id|issueId|projectId|assigneeId|reporterId|epicId|sprintId|sprintId|userId|organizationId)":(\d{15,})/g, '"$1":"$2"');
  return JSON.parse(fixed);
}

/** 猪齿鱼对接配置（本地存储，不进开源仓库） */
export interface ChoerodonConfig {
  baseUrl: string;
  username: string;
  encryptedPassword: string;
  orgId: string;
}

export interface ChoerodonToken {
  accessToken: string;
  userId: string;
  orgId: string;
}

export interface ChoerodonProject {
  id: string;
  name: string;
  code: string;
}

export interface ChoerodonIssue {
  issueId: string;
  issueNum: string;
  summary: string;
  assigneeId: string | null;
  assigneeName: string | null;
  statusCode: string;
  typeCode: string;
  lastUpdateDate: string;
}

export interface ChoerodonWorkLog {
  logId: string;
  issueId: string;
  projectId: string;
  workTime: number;
  startDate: string;
}

// ==================== 登录（Rust 端 curl，不闪终端）====================

/** 重放加密密码登录 → 拿 access_token + userId + orgId */
export async function choerodonLogin(cfg: ChoerodonConfig): Promise<ChoerodonToken> {
  // Rust 端用 curl 做完整重定向链，提取 access_token
  const accessToken = await invoke<string>('choerodon_login_cmd', {
    baseUrl: cfg.baseUrl,
    username: cfg.username,
    encryptedPassword: cfg.encryptedPassword,
  });

  // 用 token 拿用户信息（userId + orgId）
  const userResp = await fetch(`${cfg.baseUrl}/iam/choerodon/v1/users/self`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!userResp.ok) throw new Error(`获取用户信息失败 (${userResp.status})`);
  const user = await userResp.json() as { id: string; organizationId: string };

  return {
    accessToken,
    userId: user.id,
    orgId: user.organizationId || cfg.orgId,
  };
}

// ==================== 项目列表 ====================

/** 查询用户可访问的项目列表 */
export async function choerodonGetProjects(
  cfg: ChoerodonConfig,
  token: ChoerodonToken,
): Promise<ChoerodonProject[]> {
  const resp = await fetch(
    `${cfg.baseUrl}/cbase/choerodon/v1/organizations/${token.orgId}/users/${token.userId}/projects/paging?page=0&size=50&button_permission=true`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ projectCustomFieldSearchVO: { option: [] } }),
    },
  );
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`获取项目列表失败 (${resp.status}): ${errText.slice(0, 200)}`);
  }
  const data = parseBigintJSON(await resp.text()) as { content?: Record<string, unknown>[] };
  const content = data.content || data;
  if (!Array.isArray(content)) return [];
  return content.map((item: Record<string, unknown>) => {
    const p = (item.projectDTO ?? item) as Record<string, unknown>;
    return {
      id: String(p.id ?? ''),
      name: String(p.name ?? ''),
      code: String(p.code ?? ''),
    };
  });
}

// ==================== 任务列表（按经办人过滤）====================

/** 查询项目下的任务/issue，前端按经办人过滤，按更新时间倒序 */
export async function choerodonGetIssues(
  cfg: ChoerodonConfig,
  token: ChoerodonToken,
  projectId: string,
): Promise<ChoerodonIssue[]> {
  const resp = await fetch(
    `${cfg.baseUrl}/agile/v2/projects/${projectId}/issues/work_list?page=0&size=100`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ treeFlag: true, withSubIssues: false }),
    },
  );
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`获取任务列表失败 (${resp.status}): ${errText.slice(0, 200)}`);
  }
  const data = parseBigintJSON(await resp.text()) as { content?: Record<string, unknown>[] };
  const content = data.content || data;
  if (!Array.isArray(content)) return [];

  // 按经办人过滤（前端筛选，确保正确）
  const issues = content
    .filter((item: Record<string, unknown>) => {
      const aid = item.assigneeId ? String(item.assigneeId) : null;
      return aid === token.userId;
    })
    .map((item: Record<string, unknown>) => ({
      issueId: String(item.issueId),
      issueNum: String(item.issueNum ?? ''),
      summary: String(item.summary ?? ''),
      assigneeId: item.assigneeId ? String(item.assigneeId) : null,
      assigneeName: item.assigneeName ? String(item.assigneeName) : null,
      statusCode: String(item.statusCode ?? ''),
      typeCode: String(item.typeCode ?? ''),
      lastUpdateDate: String(item.lastUpdateDate ?? ''),
    }));

  // 按更新时间倒序
  issues.sort((a: ChoerodonIssue, b: ChoerodonIssue) => b.lastUpdateDate.localeCompare(a.lastUpdateDate));
  return issues;
}

// ==================== 填报工时 ====================

/** 向指定 issue 填报工时 */
export async function choerodonCreateWorkLog(
  cfg: ChoerodonConfig,
  token: ChoerodonToken,
  projectId: string,
  issueId: string,
  date: string,   // YYYY-MM-DD
  hours: number,
): Promise<ChoerodonWorkLog> {
  const startDate = `${date} ${new Date().toTimeString().slice(0, 8)}`;
  const resp = await fetch(`${cfg.baseUrl}/agile/v1/projects/${projectId}/work_log`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      issueId,
      projectId,
      startDate,
      workTime: hours,
      residualPrediction: 'self_adjustment',
      workHoursAttachments: [],
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`工时上报失败 (${resp.status}): ${text.slice(0, 200)}`);
  }
  return await resp.json();
}
