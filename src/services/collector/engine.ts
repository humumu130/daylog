// 整合引擎（P5）：按（日,projectId）预分组——同日同项目的 Git+AI 必进同一次 LLM
// 调用（机制性跨源合并）；输出严格 JSON；噪音三通道；后校验（输入覆盖 +
// Σ≤活跃总时长−手动已占 + title 非空去重）；失败降级不断档。
// 采 SKILL 口径：成果式表述 / 同主题合并 / 忽略琐碎 / 技术细节提取 / 相邻去重。

import type { Half, WorkRecord } from '../../types/models';
import { quantizeMinutes } from '../duration';
import { generateReport } from '../llm';
import * as db from '../db';
import { boundsFor, buildIntervals, totalOvertimeMinutes } from './intervals';
import { digestFingerprint, ingestedByDay, markIngested, markRunUndone, noiseDigestIndex, saveRun, upsertNoise } from './state';
import { sha256Hex } from './scan';
import type { CollectorCtx, ConsolidatedEntry, EngineInput, NoiseVerdict, RunSummary } from './types';

const WORKSPACE_ID = 'work'; // P8b 空间制激活前的默认空间
const HALVES: Half[] = ['allday', 'morning', 'afternoon', 'evening'];

// ---------- 对外入口 ----------

export interface ConsolidateOptions {
  /** new=常规增量；rebuild=重整合（用 ingested_events 快照重建输入，先清非 user_edited 自动条目） */
  mode?: 'new' | 'rebuild';
}

/** 对一个日子的全部输入跑整合（inputs 必须同日）。多项目自动分组各自调用 LLM。 */
export async function runConsolidate(day: string, rawInputs: EngineInput[], ctx: CollectorCtx, opts: ConsolidateOptions = {}): Promise<RunSummary> {
  const mode = opts.mode ?? 'new';
  const summary: RunSummary = { created: 0, skippedExisting: 0, pending: 0, autoDropped: 0, degraded: false };

  if (mode === 'rebuild') {
    await deleteAutoRecordsOfRun(day);
    rawInputs = await inputsFromIngested(day);
  }
  if (rawInputs.length === 0) return summary;

  // 同类已判噪音内容：不再进 LLM（用户判定沉淀为规则，同类不再问）
  const noiseIndex = ctx.settings.noiseFilter ? await noiseDigestIndex(WORKSPACE_ID) : new Map<string, string>();
  const inputs = rawInputs.filter((x) => {
    if (!ctx.settings.noiseFilter) return true;
    return noiseIndex.get(digestFingerprint(WORKSPACE_ID, digestOf(x.text))) !== 'dropped';
  });
  if (inputs.length === 0) return summary;

  const inputByFp = new Map(inputs.map((x) => [x.fingerprint, x]));
  const consume = (fp: string, bucket: string): ConsumedRow | null => {
    const x = inputByFp.get(fp);
    if (!x) return null;
    return { fingerprint: fp, provider: x.provider, day, kind: x.kind, payload: snapshot(x, bucket) };
  };

  // 日级约束量：活跃总时长 − 手动/已编辑条目占用。
  // 无时间戳证据（纯文本导入等）→ 回落内容量估时：不限预算，只做 0.5h 量化。
  const dayActiveMin = buildIntervals(inputs, ctx.settings.gapMinutes).reduce((s, iv) => s + iv.minutes, 0);
  const manualMin = ctx.existingRecords
    .filter((r) => r.day === day && (r.source === 'manual' || userEdited(r)))
    .reduce((s, r) => s + (r.durationMin ?? 0), 0);
  let dayBudgetMin = dayActiveMin > 0 ? Math.max(0, dayActiveMin - manualMin) : Number.POSITIVE_INFINITY;

  const runId = crypto.randomUUID();
  const consumed = new Map<string, ConsumedRow>();
  const noiseRows: { fingerprint: string; digest: string; reason: string; confidence: number; status: 'auto_dropped' | 'pending' }[] = [];

  // 按（项目）分组：null 一组（未映射，仍整合，P6 认领流兜底）
  const groups = new Map<string, EngineInput[]>();
  for (const x of inputs) {
    const key = x.projectId ?? '';
    const arr = groups.get(key);
    if (arr) arr.push(x);
    else groups.set(key, [x]);
  }

  for (const [projectId, groupInputs] of groups) {
    const project = ctx.projects.find((p) => p.id === projectId) ?? null;
    const groupIntervals = buildIntervals(groupInputs, ctx.settings.gapMinutes);
    const groupActiveMin = groupIntervals.reduce((s, iv) => s + iv.minutes, 0);
    const ot = totalOvertimeMinutes(groupIntervals, boundsFor(day, ctx.settings));

    let entries: ConsolidatedEntry[] = [];
    let noise: NoiseVerdict[] = [];
    try {
      const res = await callLlm(day, project?.name ?? '未映射项目', groupInputs, ctx, groupActiveMin, Math.min(dayBudgetMin, groupActiveMin));
      entries = res.items;
      noise = res.noise;
    } catch {
      // E3 故障降级：原始条目按规则入库（低置信，不断档，时长留给用户/后续重整合）
      summary.degraded = true;
      entries = groupInputs
        .filter((x) => x.kind !== 'todo_tool')
        .map((x) => ({ title: clipTitle(x.text), hours: 0, sources: [x.fingerprint], confidence: 0.3 }));
      noise = [];
    }

    // ---- 噪音三通道（高置信自动排除留痕 / 中置信待确认 / 低置信当正常内容）----
    const autoDropAt = ctx.settings.noiseStrict ? 0.95 : 0.9;
    for (const n of noise) {
      if (!ctx.settings.noiseFilter || !n) continue;
      const fpKey = digestFingerprint(WORKSPACE_ID, digestOf(n.digest ?? ''));
      const prior = noiseIndex.get(fpKey);
      const status: 'auto_dropped' | 'pending' =
        prior === 'kept' ? 'pending' : (n.confidence ?? 0) >= autoDropAt ? 'auto_dropped' : (n.confidence ?? 0) >= 0.5 ? 'pending' : 'pending';
      if (status === 'auto_dropped') summary.autoDropped++;
      else summary.pending++;
      noiseRows.push({ fingerprint: fpKey, digest: (n.digest ?? '').slice(0, 60), reason: n.reason ?? '', confidence: n.confidence ?? 0, status });
      for (const fp of n.sources ?? []) {
        const row = consume(fp, 'noise');
        if (row) consumed.set(row.fingerprint, row);
      }
    }

    // ---- 后校验 1：输入覆盖——未覆盖指纹回退独立条目（宁多一条不丢事件）----
    const covered = new Set<string>([...entries.flatMap((e) => e.sources ?? []), ...noise.flatMap((n) => n.sources ?? [])]);
    for (const x of groupInputs) {
      if (!covered.has(x.fingerprint)) {
        entries.push({ title: clipTitle(x.text), hours: 0, sources: [x.fingerprint], confidence: 0.4 });
      }
    }

    // ---- 后校验 2：title 非空 + 与已有/本轮条目字面去重 ----
    const seenTitle = new Set(ctx.existingRecords.filter((r) => r.day === day).map((r) => r.content.trim()));
    entries = entries.filter((e) => {
      const t = (e.title ?? '').trim();
      if (!t) {
        // 空标题：不入库但指纹照常消费（否则每轮重放 LLM 空转）
        for (const fp of e.sources ?? []) {
          const row = consume(fp, 'skipped');
          if (row) consumed.set(row.fingerprint, row);
        }
        return false;
      }
      if (seenTitle.has(t)) {
        summary.skippedExisting++;
        // 字面重复：指纹仍要消费（防重扫复活）
        for (const fp of e.sources ?? []) {
          const row = consume(fp, 'skipped');
          if (row) consumed.set(row.fingerprint, row);
        }
        return false;
      }
      seenTitle.add(t);
      return true;
    });

    // ---- 后校验 3：Σ(自动条目) ≤ min(日预算, 组活跃)——唯一铁律（活跃区间口径）----
    const budgetMin = Math.min(dayBudgetMin, groupActiveMin > 0 ? groupActiveMin : Number.POSITIVE_INFINITY);
    const quantized = entries.map((e) => ({ e, min: quantizeMinutes((Number(e.hours) || 0) * 60) }));
    let totalMin = quantized.reduce((s, q) => s + q.min, 0);
    if (Number.isFinite(budgetMin) && totalMin > budgetMin && quantized.length > 0) {
      const maxIdx = quantized.reduce((mi, q, i) => (q.min > quantized[mi].min ? i : mi), 0);
      // 0.5h 碎片并入最大条：少一条记录，总量不变（保条目完整度）
      for (const q of quantized) {
        if (q !== quantized[maxIdx] && q.min === 30) {
          q.min = 0;
          quantized[maxIdx].min += 30;
        }
      }
      // 仍超：从小条往大条截（真正减总量）
      for (const q of [...quantized].sort((a, b) => a.min - b.min)) {
        if (totalMin <= budgetMin) break;
        const cut = Math.min(q.min, totalMin - budgetMin);
        q.min -= cut;
        totalMin -= cut;
      }
    }
    dayBudgetMin = Math.max(0, dayBudgetMin - totalMin);

    // ---- 入库（min=0 的条=被并入/截断，不建记录但指纹照常消费防复活）----
    for (const { e, min } of quantized) {
      for (const fp of e.sources ?? []) {
        const row = consume(fp, min > 0 ? 'item' : 'merged');
        if (row) consumed.set(row.fingerprint, row);
      }
      if (min <= 0) continue;
      const srcFps = e.sources ?? [];
      const hasGit = groupInputs.some((x) => x.provider === 'git' && srcFps.includes(x.fingerprint));
      const hasAi = groupInputs.some((x) => x.provider === 'claude-code' && srcFps.includes(x.fingerprint));
      const half = deriveHalf(groupInputs, srcFps) ?? (HALVES.includes(e.half as Half) ? (e.half as Half) : 'allday');
      await db.createRecord({
        taskId: null,
        projectId: projectId || null,
        content: e.title,
        durationMin: min,
        day,
        half,
        source: hasGit && hasAi ? 'mixed' : hasGit ? 'git' : 'ai',
        meta: {
          runId,
          sources: srcFps,
          confidence: e.confidence ?? 0.5,
          degraded: summary.degraded || undefined,
          evidence: groupIntervals.length > 0 ? groupIntervals.map((iv) => ({ start: iv.start, end: iv.end })) : undefined,
          overtimeMin: ot > 0 ? ot : undefined,
        },
      }, runId);
      summary.created++;
    }
  }

  // ---- 收尾：摄入指纹（哨兵：撤销后不复活）+ 噪音留痕 + 运行记录 ----
  await markIngested([...consumed.values()]);
  for (const n of noiseRows) {
    await upsertNoise({ fingerprint: n.fingerprint, workspaceId: WORKSPACE_ID, status: n.status, digest: n.digest, reason: n.reason, confidence: n.confidence });
  }
  const inputSig = await sha256Hex(rawInputs.map((x) => x.fingerprint).sort().join(','));
  await saveRun({ id: runId, day, inputSig, status: summary.degraded ? 'failed' : 'success', summary: JSON.stringify(summary) });
  return summary;
}

/** 按日撤销：删自动条目（user_edited 保护）+ 运行标 undone（指纹哨兵防复活） */
export async function undoDay(day: string): Promise<number> {
  await markRunUndone(day);
  return deleteAutoRecordsOfRun(day);
}

/** 重整合入口（今日页日菜单/采集中心）：用已摄入事件重建该日 */
export async function rebuildDay(day: string, ctx: CollectorCtx): Promise<RunSummary> {
  return runConsolidate(day, [], ctx, { mode: 'rebuild' });
}

/**
 * E1 粘贴即整理（聊天记录导入·文本）：走引擎同一 LLM 管线，但**只预览不落库**
 * （L2 一次确认语义）。确认入库由 UI 调 db.createRecord（source 'ai'，meta 标 confirmed）。
 * 截图走视觉模型在 UI 层先转文本，再进本函数。
 */
export async function previewConsolidate(
  day: string,
  text: string,
  ctx: CollectorCtx,
  projectId: string | null = null,
): Promise<{ entries: ConsolidatedEntry[]; noise: NoiseVerdict[] }> {
  const synthetic: EngineInput[] = splitPastedText(text).map((t, i) => ({
    fingerprint: `paste-${i}-${t.length}`,
    provider: 'claude-code',
    day,
    projectId,
    kind: 'human_prompt',
    ts: null,
    text: t,
    human: true,
  }));
  if (synthetic.length === 0) return { entries: [], noise: [] };
  const project = ctx.projects.find((p) => p.id === projectId) ?? null;
  // 粘贴文本无时间戳证据：内容量估时（预算 ∞，仅 0.5h 量化约束）
  const res = await callLlm(day, project?.name ?? '未指定项目', synthetic, ctx, 0, Number.POSITIVE_INFINITY);
  return { entries: res.items, noise: res.noise };
}

/** 粘贴文本切段：按空行/行分割，过滤太短的行，每段 ≤400 字 */
function splitPastedText(text: string): string[] {
  return (text ?? '')
    .split(/\n{2,}|\n(?=\d{1,2}:\d{2})/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 6)
    .map((s) => (s.length > 400 ? `${s.slice(0, 400)}…` : s))
    .slice(0, 80);
}

// ---------- 内部 ----------

interface ConsumedRow {
  fingerprint: string;
  provider: string;
  day: string;
  kind: string;
  payload: unknown;
}

function snapshot(x: EngineInput, bucket: string): unknown {
  return { text: x.text, ts: x.ts, projectId: x.projectId, human: x.human, kind: x.kind, provider: x.provider, bucket };
}

function userEdited(r: WorkRecord): boolean {
  return r.meta?.user_edited === true;
}

async function deleteAutoRecordsOfRun(day: string): Promise<number> {
  const recs = await db.listRecordsByDay(day);
  let n = 0;
  for (const r of recs) {
    if (r.source === 'manual' || r.source === 'timer' || r.source === 'import') continue;
    if (userEdited(r)) continue; // 收养保护
    await db.deleteRecord(r.id);
    n++;
  }
  return n;
}

async function inputsFromIngested(day: string): Promise<EngineInput[]> {
  const rows = await ingestedByDay(day);
  return rows
    .filter((r) => r.kind !== 'noise' && r.kind !== 'skipped' && r.kind !== 'merged')
    .map((r) => {
      try {
        const p = JSON.parse(r.payload) as Partial<EngineInput>;
        if (!p || typeof p.text !== 'string') return null;
        return {
          fingerprint: r.fingerprint,
          provider: (r.provider === 'git' ? 'git' : 'claude-code') as EngineInput['provider'],
          day: r.day,
          projectId: p.projectId ?? null,
          kind: p.kind ?? (r.kind as EngineInput['kind']),
          ts: p.ts ?? null,
          text: p.text,
          human: p.human ?? true,
        };
      } catch {
        return null;
      }
    })
    .filter((x): x is EngineInput => x !== null);
}

function digestOf(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function clipTitle(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || '（自动采集）';
}

function deriveHalf(inputs: EngineInput[], sources: string[]): Half | null {
  const tsList = inputs.filter((x) => x.ts !== null && sources.includes(x.fingerprint)).map((x) => x.ts as number);
  if (tsList.length === 0) return null;
  const mean = tsList.reduce((a, b) => a + b, 0) / tsList.length;
  const h = new Date(mean).getHours();
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

// ---------- LLM 调用（脱敏总线必经；本地 claude CLI 通道在 llm.ts 内部豁免） ----------

interface LlmConsolidateResult {
  items: ConsolidatedEntry[];
  noise: NoiseVerdict[];
}

async function callLlm(day: string, projectName: string, inputs: EngineInput[], ctx: CollectorCtx, groupActiveMin: number, budgetMin: number): Promise<LlmConsolidateResult> {
  const budgetHours = Number.isFinite(budgetMin) ? Math.floor((budgetMin / 60) * 10) / 10 : null;
  const activeHours = Math.floor((groupActiveMin / 60) * 10) / 10;

  const lines = inputs.map((x) => {
    const t = x.ts ? ` ${new Date(x.ts).toTimeString().slice(0, 5)}` : '';
    return `[${x.fingerprint.slice(0, 10)}] (${x.provider === 'git' ? 'commit' : x.kind}${t}) ${x.text}`;
  });
  const existing = ctx.existingRecords
    .filter((r) => r.day === day)
    .map((r) => `- ${r.content}（${r.durationMin ? `${r.durationMin / 60}h` : '未计时长'}）`)
    .join('\n');

  const system =
    '你是工作日志整理助手。把 AI 会话记录与 git 提交整理成工作日志条目。要求：' +
    '1) 用成果式表述（"完成登录组件开发，含表单校验"而非"用户让我做登录页"）；' +
    '2) 同项目相邻同主题内容合并为一条（一天一项目约 1~6 条）；' +
    '3) 从内容提取技术细节（改了什么/修了什么/做了什么决策）充实条目，但绝不虚构；' +
    '4) 与已有记录语义重复的工作放入 noise（reason 写明已被哪条覆盖）；' +
    '5) 与工作无关的内容（闲聊/测试性提问/生活话题）放入 noise 并给噪音置信度。' +
    '只输出 JSON，不要任何其它文字。';

  const user =
    `日期：${day}\n项目：${projectName}\n本组活跃时长（小时）：${activeHours}\n` +
    (budgetHours !== null ? `本组工时上限（小时，Σ(items.hours) 不得超过）：${budgetHours}\n` : '') +
    `\n原始材料（[指纹] (类型 时间) 内容）：\n${lines.join('\n')}\n` +
    (existing ? `\n当日已有记录（语义去重用）：\n${existing}\n` : '') +
    `\n输出 JSON：{"items":[{"title":"成果式描述","hours":1.5,"sources":["指纹"],"confidence":0.9,"half":"morning"}],` +
    `"noise":[{"digest":"内容摘要≤30字","reason":"原因","confidence":0.95,"sources":["指纹"]}]}\n` +
    '约束：每个输入指纹必须出现在 items[].sources 或 noise[].sources 里恰好一次；hours 最小 0.5、Σ≤上限；title 非空互不重复。';

  // 脱敏由 llm.ts 出网总线统一处理（单一通道，勿在此重复）
  const text = await generateReport(ctx.llm, system, user);
  const parsed = JSON.parse(extractJsonObject(text)) as LlmConsolidateResult;
  // LLM 可能截断指纹：前缀 → 全量映射
  const byPrefix = new Map<string, string>();
  for (const x of inputs) byPrefix.set(x.fingerprint.slice(0, 10), x.fingerprint);
  const expand = (srcs: string[] | undefined): string[] =>
    (srcs ?? []).map((s) => byPrefix.get(s) ?? byPrefix.get(s.slice(0, 10)) ?? s);
  return {
    items: (parsed.items ?? [])
      .filter((e) => e && typeof e.title === 'string')
      .map((e) => ({ ...e, sources: expand(e.sources), hours: Number(e.hours) || 0, confidence: Number(e.confidence) || 0.5 })),
    noise: (parsed.noise ?? [])
      .filter((n) => n && typeof n.digest === 'string')
      .map((n) => ({ ...n, sources: expand(n.sources), confidence: Number(n.confidence) || 0 })),
  };
}

function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('LLM 未返回有效 JSON');
  return text.slice(start, end + 1);
}
