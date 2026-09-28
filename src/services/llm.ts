import { fetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import type { LlmConfig, Project, WorkRecord } from '../types/models';
import { formatHours } from '../utils/halfDay';
import { groupBy } from '../utils/groupBy';
import { scrubText } from './collector/scrub';
import { resolveLlmKey } from './llmKey';

// ---------- 脱敏总线（单一出网通道，P5·E6） ----------
// 所有送云端 LLM 的载荷在本函数内统一脱敏（新增任何云端调用走 generateReport 即自动覆盖）。
// 本地 claude CLI 通道不出网，不经过总线。默认开；由 MainApp 依 settings.collect.scrubEnabled 设置。
let scrubBusEnabled = true;
export function setScrubBus(enabled: boolean): void {
  scrubBusEnabled = enabled;
}

/** 把给定记录聚合成文本摘要（供 LLM 写月报）。label 用于标题，通常是日期区间。 */
export function buildMonthSummary(records: WorkRecord[], projects: Project[], label: string): string {
  const totalMin = records.reduce((s, r) => s + (r.durationMin ?? 0), 0);
  const byProject = groupBy(records, (r) => r.projectId ?? '_none');
  const lines: string[] = [
    `【${label} 工作记录汇总】`,
    `共 ${records.length} 条记录，合计 ${formatHours(totalMin)}`,
    '',
  ];
  for (const [pid, list] of Object.entries(byProject)) {
    const name = pid === '_none' ? '未分类' : projects.find((p) => p.id === pid)?.name ?? '未分类';
    const mins = list.reduce((s, r) => s + (r.durationMin ?? 0), 0);
    lines.push(`■ ${name}（${list.length} 条 / ${formatHours(mins)}）`);
    const seen = new Set<string>();
    for (const r of list) {
      if (seen.has(r.content)) continue;
      seen.add(r.content);
      lines.push(`  · ${r.content}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** 调 LLM 生成文本：云端 OpenAI 兼容 / 本地 claude CLI（带重试与超时） */
export async function generateReport(config: LlmConfig, system: string, user: string): Promise<string> {
  const run = async (): Promise<string> => {
    if (config.kind === 'claude-code') {
      try {
        return await invoke<string>('run_claude', { prompt: `${system}\n\n---\n\n${user}` });
      } catch (e) {
        throw new Error(`本地 claude 调用失败：${errMsg(e)}（确认 claude 已装并在 PATH）`);
      }
    }
    const base = (config.baseUrl ?? '').replace(/\/$/, '');
    if (!base) throw new Error('未配置 API 地址，请在设置中填写 LLM 的 API 地址');
    // API Key：settings 内联值（迁移过渡期）优先，空则回落 OS keychain（P8）
    const apiKey = await resolveLlmKey(config.apiKey);
    if (!apiKey) throw new Error('未配置 API Key，请在设置·LLM 保存到钥匙串');
    // 脱敏总线：云端载荷出网前必经（本地 claude 通道在上方分支，不经此处）
    const sysOut = scrubBusEnabled ? scrubText(system).text : system;
    const userOut = scrubBusEnabled ? scrubText(user).text : user;
    // 超时控制：90s（长报告需要时间）
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: config.model || 'glm-4-flash',
          messages: [{ role: 'system', content: sysOut }, { role: 'user', content: userOut }],
          temperature: 0.6,
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw new Error('请求超时（90s），可重试');
      throw new Error(`网络连接失败：${errMsg(e)}（检查网络或 API 地址是否正确）`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw friendlyHttpError(res.status, t);
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new Error('LLM 返回非 JSON（可能网关错误或被限流），可重试');
    }
    const content: string | undefined = (data as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM 返回为空，可能是限流或额度不足，请重试');
    return content;
  };

  return withRetry(run, {
    tries: 3,
    // 仅对"瞬时/可恢复"错误重试：鉴权错误、参数错误等不重试
    retryOn: (e) => /429|服务端错误|网络连接失败|超时|为空|非 JSON|网关|Failed to fetch|ECONN|ETIMEDOUT|reset by peer/i.test(e.message),
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function friendlyHttpError(status: number, body: string): Error {
  if (status === 401 || status === 403) return new Error(`API Key 无效或无权限 (${status})，请检查设置`);
  if (status === 404) return new Error(`接口不存在 (404)：请确认 API 地址正确（通常以 /v1 结尾）`);
  if (status === 429) return new Error('请求过于频繁或额度不足 (429)，请稍后再试');
  if (status >= 500) return new Error(`服务端错误 (${status})，可重试`);
  return new Error(`LLM 请求失败 (${status})：${body.slice(0, 300)}`);
}

/** 指数退避重试。retryOn 返回 false 的错误立即抛出（不重试）。 */
async function withRetry<T>(fn: () => Promise<T>, opts: { tries: number; retryOn: (e: Error) => boolean }): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < opts.tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const err = e instanceof Error ? e : new Error(String(e));
      if (i === opts.tries - 1 || !opts.retryOn(err)) throw err;
      await new Promise((r) => setTimeout(r, 600 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

export interface ConsolidatedItem {
  title: string;
  hashes: string[];
  hours?: number;
  status?: 'new' | 'existing';
}

function extractJsonArray(text: string): string {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) throw new Error('LLM 未返回有效 JSON');
  return text.slice(start, end + 1);
}

/** 用 LLM 把零散提交归类整合，并与已有记录交叉去重 */
export async function consolidateCommits(
  commits: { hash: string; subject: string }[],
  config: LlmConfig,
  existingRecords?: { content: string; project?: string }[],
): Promise<ConsolidatedItem[]> {
  if (commits.length === 0) return [];
  const list = commits.map((c) => `${c.hash} ${c.subject}`).join('\n');
  const hasExisting = existingRecords && existingRecords.length > 0;
  const existingText = hasExisting
    ? existingRecords!.map((r, i) => `${i + 1}. ${r.content}${r.project ? ` (${r.project})` : ''}`).join('\n')
    : '';

  const system =
    '你是 git 提交整理助手。把用户提供的 git 提交归类整合成有意义的工作项：属于同一 bug 修复或功能开发的多条提交' +
    '（代码修改、触发CI、部署测试、补丁、回退、跟进等）应合并为一项。用简洁的中文描述每项工作。' +
    (hasExisting ? '同时与用户已有的工作记录交叉比对，如果某项工作已经被手动记录过，标记为 existing。' : '');

  const user =
    `提交列表（hash 提交说明）：\n${list}\n\n` +
    (hasExisting ? `\n已有工作记录：\n${existingText}\n\n` : '') +
    '请归类整合，输出 JSON 数组，每项形如 {"title":"整合后的工作描述","hashes":["hash1","hash2"],"hours":2,"status":"new"}。' +
    '要求：1) 相关提交合并为一项；2) title 简洁说明做了什么；3) 每个原始 hash 必须出现在某项的 hashes 里；' +
    '4) hours 为该项估算的合理耗时（小时），简单 bugfix 约 1-2h，中等功能约 4-8h，大功能约 1-3 天(8-24h)。' +
    (hasExisting ? '5) status 为 "existing" 表示该工作已在已有记录中覆盖（无需再导入），"new" 表示是新工作（需导入）。' : '') +
    ' 只输出 JSON。';

  const text = await generateReport(config, system, user);
  const arr = JSON.parse(extractJsonArray(text)) as ConsolidatedItem[];
  if (!Array.isArray(arr)) throw new Error('整合结果格式异常');
  return arr.filter((x) => x && typeof x.title === 'string' && Array.isArray(x.hashes));
}

/** 基于已保存的月报生成季度/年度总结 */
/**
 * 生成 季/年中/年度 总结：
 * - 优先用已保存的各月月报（用户打磨过的）；
 * - 月报未覆盖到的日期（漏天）用对应日志补充；
 * - 完全没有月报时，整段用日志生成（gapSummary 即全部日志）。
 */
export async function generatePeriodReport(
  monthReports: { month: string; body: string; from?: string; to?: string }[],
  gapSummary: string,
  period: string,
  reportType: 'quarter' | 'halfyear' | 'year',
  config: LlmConfig,
  templateBody?: string,
): Promise<string> {
  if (monthReports.length === 0 && !gapSummary) {
    throw new Error('该时段既没有月报也没有日志，无法生成。');
  }
  const typeLabel = reportType === 'quarter' ? '季度' : reportType === 'halfyear' ? '年中' : '年度';
  const nextLabel = reportType === 'quarter' ? '下季度' : reportType === 'halfyear' ? '下半年' : '来年';
  const organize = reportType === 'year' ? '按季度或主题' : '按主题';
  const system =
    `你是${typeLabel}工作总结撰写助手。根据用户提供的各月工作月报${gapSummary ? '（及补充日志）' : ''}，撰写一份${typeLabel}工作总结。` +
    `要求：1) ${organize}组织，不要简单按月罗列；2) 提炼核心成果和亮点；` +
    `3) 包含问题反思和${nextLabel}展望；4) 若有范例，严格模仿其格式和语气。只输出总结正文。`;
  const monthPart = monthReports.length > 0
    ? monthReports.map((r) => `--- ${r.month} 月报${r.from && r.to ? `（${r.from}~${r.to}）` : ''} ---\n${r.body}`).join('\n\n')
    : '';
  const user =
    (templateBody ? `【范例（请模仿风格）】\n${templateBody}\n\n` : '') +
    monthPart +
    (gapSummary ? `\n\n【补充日志（月报未覆盖的日期）】\n${gapSummary}\n` : '') +
    `\n\n请据此撰写 ${period} 的${typeLabel}工作总结。标题应包含"${period}"。`;
  return generateReport(config, system, user);
}


