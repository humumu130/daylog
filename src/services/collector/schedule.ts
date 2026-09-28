// 采集调度器（P5）：启动补扫（lookback 天）+ 30 分钟轮询日变 + 单飞锁。
// 只在主窗口启动（MainApp init 调 startCollector）。采集失败静默记日志，
// 不打扰用户；有产出时广播 CHANGE_EVENT 供各窗口刷新。

import type { AppSettings } from '../../types/models';
import * as db from '../db';
import { scanRepos, type GitCommit } from '../git';
import { notifyChanged } from '../events';
import { commitFingerprint, defaultScanRoots, eventFingerprint, makeResolver, scanSessions, sha256Hex, toEngineInputs } from './scan';
import { ingestTodos } from './todoIngest';
import { runConsolidate } from './engine';
import { commitWatermarks, filterIngested } from './state';
import type { AiEvent, EngineInput, RunSummary } from './types';

const POLL_MS = 30 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<CollectPassResult> | null = null;

export interface CollectPassResult {
  files: number;
  events: number;
  commits: number;
  todos: { created: number; updated: number; skipped: number };
  days: Record<string, RunSummary>;
}

/** 主窗口启动时调用：立即补扫一轮 + 周期轮询（幂等，可重复调用） */
export function startCollector(getSettings: () => AppSettings): void {
  if (timer !== null) return;
  void collectOnce(getSettings).catch(() => undefined);
  timer = setInterval(() => {
    void collectOnce(getSettings).catch(() => undefined);
  }, POLL_MS);
}

export function stopCollector(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** 单飞锁：同一时刻最多一轮采集在跑（补扫/轮询/手动补扫共用） */
export function collectOnce(getSettings: () => AppSettings): Promise<CollectPassResult> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      return await runPass(getSettings());
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** LLM 是否真正可用（claude-code 本地 CLI 恒可用；云端需 baseUrl+key） */
function llmReady(settings: AppSettings): boolean {
  if (settings.llm.kind === 'claude-code') return true;
  return Boolean(settings.llm.baseUrl && settings.llm.apiKey);
}

async function runPass(settings: AppSettings): Promise<CollectPassResult> {
  const out: CollectPassResult = { files: 0, events: 0, commits: 0, todos: { created: 0, updated: 0, skipped: 0 }, days: {} };
  if (!settings.collect.enabled) return out;

  const projects = await db.listProjects();
  const resolver = makeResolver(projects, settings.repos);

  // ① AI 会话增量扫描（水位线不在此推进——消费成功后统一提交）
  const scan = await scanSessions(settings.collect);
  out.files = scan.files;
  out.events = scan.freshEvents.length;

  // ② todo 摄入（独立于整合：LLM 挂了 todo 照常进；内部标记指纹已摄入）
  if (scan.freshEvents.length > 0) {
    out.todos = await ingestTodos(scan.freshEvents, resolver, projects);
  }

  // ③ 事件 → 引擎输入（todo_tool 不进整合文本；已摄入指纹过滤）
  const contentEvents: AiEvent[] = scan.freshEvents.filter((e) => e.kind !== 'todo_tool');
  const aiInputs = await toEngineInputs(contentEvents, resolver);

  // ④ Git 提交（同窗口期，带时间戳模式：区间/加班证据）
  const since = `${new Date(Date.now() - settings.collect.lookbackDays * 24 * 3600 * 1000).toISOString().slice(0, 10)} 00:00`;
  let commits: GitCommit[] = [];
  if (settings.repos.length > 0) {
    try {
      const r = await scanRepos(settings.repos, since, undefined, settings.gitAuthor, true);
      commits = r.commits;
    } catch {
      // git 扫描失败不阻塞 AI 侧
    }
  }
  const commitInputs = await commitsToInputs(commits);
  out.commits = commitInputs.length;

  // ⑤ 按日分组整合（同日同项目必进同一次 LLM 调用——引擎内分组保证）。
  //    LLM 未就绪→本轮跳过整合（事件不消费、水位线不提交，配好后自动补上）
  if (llmReady(settings)) {
    const byDay = new Map<string, EngineInput[]>();
    for (const x of [...aiInputs, ...commitInputs]) {
      const arr = byDay.get(x.day);
      if (arr) arr.push(x);
      else byDay.set(x.day, [x]);
    }
    for (const [day, inputs] of byDay) {
      if (inputs.length === 0) continue;
      const existing = await db.listRecordsByDay(day);
      try {
        out.days[day] = await runConsolidate(day, inputs, {
          settings: settings.collect,
          llm: settings.llm,
          projects,
          existingRecords: existing,
        });
      } catch {
        // 单日失败不影响其它日；指纹未摄入→水位线不提交→下轮重解析重试
      }
    }
  }

  // ⑥ 水位线提交：本轮全部指纹（事件+提交）均已摄入才提交——at-least-once 投递
  //    + 指纹幂等消费 = 恰好一次语义。LLM 未就绪时引擎输入未消费→不提交→配好后自动补。
  try {
    const eventFps = await Promise.all(scan.freshEvents.map((e) => eventFingerprint(e)));
    const allFps = [...eventFps, ...commitInputs.map((c) => c.fingerprint)];
    if (allFps.length === 0) {
      // 无新事件（文件解析过但全为重复/空）：解析即完成，直接提交
      await commitWatermarks(scan.pendingWatermarks);
    } else {
      const ingested = await filterIngested(allFps);
      if (allFps.every((fp) => ingested.has(fp))) {
        await commitWatermarks(scan.pendingWatermarks);
      }
    }
  } catch {
    // 提交失败：下轮重解析，指纹去重兜底
  }

  // ⑦ 有实际产出才广播刷新
  const produced =
    out.todos.created + out.todos.updated > 0 ||
    Object.values(out.days).some((s) => s.created > 0 || s.pending > 0 || s.autoDropped > 0);
  if (produced) void notifyChanged();
  return out;
}

/** Git 提交 → 引擎输入（指纹幂等过滤；ts 从 ISO 时间戳来，无则 null） */
async function commitsToInputs(commits: GitCommit[]): Promise<EngineInput[]> {
  const stamped = await Promise.all(
    commits.map(async (c) => ({ c, fp: await commitFingerprint(c.hash) })),
  );
  const ingested = await filterIngested(stamped.map((x) => x.fp));
  return stamped
    .filter((x) => !ingested.has(x.fp))
    .map(({ c, fp }) => ({
      fingerprint: fp,
      provider: 'git' as const,
      day: c.date.slice(0, 10),
      projectId: c.projectId,
      kind: 'commit' as const,
      ts: c.ts ?? null,
      text: `commit ${c.hash} ${c.subject}`,
      human: true,
    }));
}

/** 手动触发入口（命令面板「立即补扫」）：与调度共用单飞锁 */
export async function manualScanNow(): Promise<CollectPassResult> {
  const { useSettingsStore } = await import('../../stores/useSettingsStore');
  return collectOnce(() => useSettingsStore.getState().settings);
}

/** 供引擎 inputSig 等场景复用 */
export { sha256Hex, defaultScanRoots };
