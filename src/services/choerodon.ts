import { fetch } from '@tauri-apps/plugin-http';

/** 猪齿鱼对接配置（本地存储，不进开源仓库） */
export interface ChoerodonConfig {
  baseUrl: string;       // API 地址，如 https://api.choerodon.com.cn
  frontendUrl: string;   // 前端地址，如 https://choerodon.com.cn（redirect_uri 用）
  username: string;      // 邮箱
  encryptedPassword: string; // RSA 加密后的 base64 密码（从浏览器抓的）
  orgId: string;         // 组织 ID
}

export interface ChoerodonToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // 毫秒时间戳
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

// ==================== 登录 ====================

/** 重放加密密码登录，拿 access_token */
export async function choerodonLogin(cfg: ChoerodonConfig): Promise<{ token: ChoerodonToken; userId: string; orgId: string }> {
  const formBody = `username=${encodeURIComponent(cfg.username)}&password=${encodeURIComponent(cfg.encryptedPassword)}`;

  // 1. GET 登录页（拿 JSESSIONID）
  await fetch(`${cfg.baseUrl}/oauth/login`, { method: 'GET' });

  // 2. POST 登录 → 302 → authorize URL
  const loginResp = await fetch(`${cfg.baseUrl}/oauth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${cfg.baseUrl}/oauth/login` },
    body: formBody,
    redirect: 'manual',
  });
  const authorizeUrl = loginResp.headers.get('location');
  if (!authorizeUrl) throw new Error('登录失败：未返回授权地址');

  // 3. GET authorize → 302 → 带 access_token 的 redirect
  const authResp = await fetch(authorizeUrl, { method: 'GET', redirect: 'manual' });
  const finalRedirect = authResp.headers.get('location');
  if (!finalRedirect) throw new Error('登录失败：未返回 token');

  // 从 URL fragment 提取 token
  const tokenMatch = finalRedirect.match(/access_token=([a-f0-9-]+)/);
  const refreshMatch = finalRedirect.match(/refresh_token=([a-f0-9-]+)/);
  const expiresMatch = finalRedirect.match(/expires_in=(\d+)/);
  if (!tokenMatch) throw new Error('登录失败：token 解析失败');

  const accessToken = tokenMatch[1];
  const refreshToken = refreshMatch ? refreshMatch[1] : '';
  const expiresIn = expiresMatch ? parseInt(expiresMatch[1], 10) : 86399;

  // 4. 拿用户信息（userId + orgId）
  const userResp = await fetch(`${cfg.baseUrl}/iam/choerodon/v1/users/self`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const user = await userResp.json();
  const userId = user.id;
  const orgId = user.organizationId || cfg.orgId;

  return {
    token: { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 },
    userId,
    orgId,
  };
}

// ==================== 项目列表 ====================

/** 查询用户可访问的项目列表 */
export async function choerodonGetProjects(
  cfg: ChoerodonConfig,
  token: ChoerodonToken,
  userId: string,
): Promise<ChoerodonProject[]> {
  const resp = await fetch(
    `${cfg.baseUrl}/cbase/choerodon/v1/organizations/${cfg.orgId}/users/${userId}/projects/paging?page=0&size=50&button_permission=true`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ projectCustomFieldSearchVO: { option: [] } }),
    },
  );
  const data = await resp.json();
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

/** 查询项目下的任务/issue，按经办人过滤，按更新时间倒序 */
export async function choerodonGetIssues(
  cfg: ChoerodonConfig,
  token: ChoerodonToken,
  projectId: string,
  assigneeId?: string,
): Promise<ChoerodonIssue[]> {
  const body: Record<string, unknown> = { treeFlag: true, withSubIssues: false };
  if (assigneeId) {
    body.advancedSearchArgs = { assigneeId };
  }

  const resp = await fetch(
    `${cfg.baseUrl}/agile/v2/projects/${projectId}/issues/work_list?page=0&size=100`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  const data = await resp.json();
  const content = data.content || data;
  if (!Array.isArray(content)) return [];

  const issues = content.map((item: Record<string, unknown>) => ({
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
