// 噪音三通道 + 后校验机制回归（P6）：30 条人工标注样本（工作/噪音高·中·低/边界）。
// LLM 判定本身需装机验收；本套锁定引擎机制——工作内容零误杀（覆盖回退）、
// 高置信自动排除留痕、中置信待确认、低置信不采纳、翻案(kept)后重整合恢复、预算钳位。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectSettings, LlmConfig } from '../../src/types/models';
import type { CollectorCtx, EngineInput } from '../../src/services/collector/types';

import samplesJson from '../fixtures/noise-samples.json';

interface Sample {
  id: string;
  label: 'work' | 'noise-high' | 'noise-mid' | 'noise-low' | 'boundary';
  text: string;
}
const samples = samplesJson as unknown as Sample[];

const DAY = '2026-09-28';

// ---------- 共享内存态（vi.hoisted 保证 mock 工厂可引用） ----------

const h = vi.hoisted(() => {
  return {
    records: [] as Array<Record<string, unknown> & { id: string; day: string; source: string; durationMin: number; meta?: { sources?: string[] } }>,
    ingested: new Map<string, { fingerprint: string; provider: string; day: string; kind: string; payload: string; created_at: number }>(),
    noise: new Map<string, { fingerprint: string; workspaceId: string; status: string; digest: string; reason: string; confidence: number; day?: string | null }>(),
    runs: [] as Array<Record<string, unknown>>,
    behavior: new Map<string, 'item' | 'noise'>(), // 样本 id → mock LLM 归类（覆盖默认）
    noiseConf: new Map<string, number>(), // 样本 id → 噪音置信度（覆盖默认）
    hours: new Map<string, number>(), // 样本 id → item 时长（覆盖默认）
  };
});

vi.mock('../../src/services/db', () => ({
  createRecord: vi.fn(async (input: Record<string, unknown>) => {
    const row = { id: crypto.randomUUID(), ...input } as typeof h.records[number];
    h.records.push(row);
    return row.id;
  }),
  deleteRecord: vi.fn(async (id: string) => {
    const i = h.records.findIndex((r) => r.id === id);
    if (i >= 0) h.records.splice(i, 1);
  }),
  listRecordsByDay: vi.fn(async (day: string) => h.records.filter((r) => r.day === day)),
}));

vi.mock('../../src/services/llm', () => ({
  // 按 fixture 标注构造整合结果：解析引擎送来的 [指纹前缀] (类型 时间) 文本 行
  generateReport: vi.fn(async (_cfg: unknown, _sys: string, user: string) => {
    const items: Array<{ title: string; hours: number; sources: string[]; confidence: number }> = [];
    const noise: Array<{ digest: string; reason: string; confidence: number; sources: string[] }> = [];
    const re = /^\[([^\]]+)\] \([^)]*\) (.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(user)) !== null) {
      const prefix = m[1];
      const s = samples.find((x) => x.text === m![2].trim());
      if (!s) continue;
      const mode = h.behavior.get(s.id) ?? (s.label === 'work' ? 'item' : 'noise');
      if (mode === 'item') {
        items.push({ title: s.text, hours: h.hours.get(s.id) ?? 0.5, sources: [prefix], confidence: 0.9 });
      } else {
        noise.push({
          digest: s.text.slice(0, 20),
          reason: 'mock 判定',
          confidence: h.noiseConf.get(s.id) ?? ({ 'noise-high': 0.93, 'noise-mid': 0.7, 'noise-low': 0.3, boundary: 0.65 } as const)[s.label],
          sources: [prefix],
        });
      }
    }
    return JSON.stringify({ items, noise });
  }),
}));

vi.mock('../../src/services/collector/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/collector/state')>();
  return {
    ...actual,
    ingestedByDay: vi.fn(async (day: string) => [...h.ingested.values()].filter((r) => r.day === day)),
    markIngested: vi.fn(async (rows: Array<{ fingerprint: string; provider: string; day: string; kind: string; payload: unknown }>) => {
      for (const r of rows) {
        h.ingested.set(r.fingerprint, { ...r, payload: JSON.stringify(r.payload ?? {}), created_at: Date.now() });
      }
    }),
    noiseDigestIndex: vi.fn(async (ws: string) => {
      const map = new Map<string, string>();
      for (const r of h.noise.values()) map.set(actual.digestFingerprint(ws, r.digest), r.status);
      return map;
    }),
    upsertNoise: vi.fn(async (n: { fingerprint: string; workspaceId: string; status: string; digest: string; reason: string; confidence: number; day?: string | null }) => {
      h.noise.set(n.fingerprint, { ...n });
    }),
    saveRun: vi.fn(async (run: Record<string, unknown>) => {
      h.runs.push(run);
    }),
    markRunUndone: vi.fn(async () => undefined),
  };
});

// ---------- 工具 ----------

const SETTINGS: CollectSettings = {
  enabled: true,
  scanRoots: [],
  lookbackDays: 7,
  retentionDays: 30,
  gapMinutes: 15,
  scrubEnabled: true,
  noiseFilter: true,
  noiseStrict: false,
  workStartTime: '09:00',
  workEndTime: '16:30',
  weekendOvertime: true,
  earlyStartOvertime: false,
  overtimeCapHours: 20,
};

function ctx(existing: Array<{ day: string; content: string; durationMin: number | null; source: string; meta?: Record<string, unknown> }> = []): CollectorCtx {
  return { settings: SETTINGS, llm: {} as LlmConfig, projects: [], existingRecords: existing as CollectorCtx['existingRecords'] };
}

function fpOf(id: string): string {
  return id.toUpperCase().padEnd(3, '0') + '0'.repeat(21); // 前 10 字符唯一（引擎指纹前缀展开依赖）
}

function mk(s: Sample, over: Partial<EngineInput> = {}): EngineInput {
  return {
    fingerprint: fpOf(s.id),
    provider: 'claude-code',
    day: DAY,
    projectId: null,
    kind: 'human_prompt',
    ts: null,
    text: s.text,
    human: true,
    ...over,
  };
}

const at = (hh: number, mm: number) => new Date(`${DAY}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`).getTime();

const by = (id: string) => samples.find((s) => s.id === id) as Sample;

beforeEach(() => {
  h.records.length = 0;
  h.ingested.clear();
  h.noise.clear();
  h.runs.length = 0;
  h.behavior.clear();
  h.noiseConf.clear();
  h.hours.clear();
});

// ---------- 用例 ----------

describe('噪音三通道（30 条标注样本）', () => {
  it('工作内容零误杀；高置信自动排除留痕；中置信待确认；低置信回退独立条目', async () => {
    const { runConsolidate } = await import('../../src/services/collector/engine');
    const summary = await runConsolidate(DAY, samples.map((s) => mk(s)), ctx());

    const count = (l: Sample['label']) => samples.filter((s) => s.label === l).length;
    expect(summary.created).toBe(count('work') + count('noise-low')); // 低置信噪音走覆盖回退成条目
    expect(summary.autoDropped).toBe(count('noise-high'));
    expect(summary.pending).toBe(count('noise-mid') + count('boundary'));

    // 每条 work / noise-low 输入指纹都落在某条记录的 meta.sources（零误杀铁律）
    for (const s of samples.filter((x) => x.label === 'work' || x.label === 'noise-low')) {
      const hit = h.records.some((r) => (r.meta?.sources ?? []).includes(fpOf(s.id)));
      expect(hit, `样本 ${s.id} 未入库`).toBe(true);
    }
    // 高置信噪音既不进记录，也不出现在任何 sources 里
    for (const s of samples.filter((x) => x.label === 'noise-high' || x.label === 'noise-mid' || x.label === 'boundary')) {
      const hit = h.records.some((r) => (r.meta?.sources ?? []).includes(fpOf(s.id)));
      expect(hit, `样本 ${s.id} 不应入库`).toBe(false);
    }
    // 留痕：noise_reviews 有 day、状态正确
    const statuses = [...h.noise.values()];
    expect(statuses.filter((r) => r.status === 'auto_dropped')).toHaveLength(count('noise-high'));
    expect(statuses.filter((r) => r.status === 'pending')).toHaveLength(count('noise-mid') + count('boundary'));
    expect(statuses.every((r) => r.day === DAY)).toBe(true);
    // 全部输入已摄入（含噪音桶快照，水位线才可提交）
    expect(h.ingested.size).toBe(samples.length);
  });

  it('重整合：噪音桶默认排除；用户翻案(kept)后恢复参与重建', async () => {
    const { runConsolidate, rebuildDay } = await import('../../src/services/collector/engine');
    const { generateReport } = await import('../../src/services/llm');
    const inputs = [by('w01'), by('w02'), by('m01'), by('n01')].map((s) => mk(s));
    await runConsolidate(DAY, inputs, ctx());
    expect(h.records).toHaveLength(2); // w01/w02

    // 用户在采集中心把 m01 判为「计入工作」
    const m01Row = [...h.noise.values()].find((r) => r.digest === by('m01').text.slice(0, 20));
    expect(m01Row).toBeTruthy();
    m01Row!.status = 'kept';
    h.behavior.set('m01', 'item'); // 翻案后重整合，LLM 按内容归入条目

    await rebuildDay(DAY, ctx(h.records as CollectorCtx['existingRecords']));

    // n01 仍排除；m01 恢复入库
    expect(h.records).toHaveLength(3);
    expect(h.records.some((r) => r.content === by('m01').text)).toBe(true);
    expect(h.records.some((r) => r.content === by('n01').text)).toBe(false);
    // 送 LLM 的载荷不含被排除的噪音文本，含翻案文本
    const lastUser = vi.mocked(generateReport).mock.calls.at(-1)![2];
    expect(lastUser).toContain(by('m01').text);
    expect(lastUser).not.toContain(by('n01').text);
  });

  it('预算钳位：Σ(自动条目) ≤ 组活跃时长；0.5h 碎片并入最大条', async () => {
    const { runConsolidate } = await import('../../src/services/collector/engine');
    // 3 个带时间戳输入 10:00/10:10/10:20 → 单区间 20 分钟 → 预算 20
    const inputs = [
      mk(by('w01'), { ts: at(10, 0) }),
      mk(by('w02'), { ts: at(10, 10) }),
      mk(by('w03'), { ts: at(10, 20) }),
    ];
    h.hours.set('w01', 1.5);
    h.hours.set('w02', 0.5);
    h.hours.set('w03', 0.5); // LLM 高估：合计 2.5h，远超 20min
    const summary = await runConsolidate(DAY, inputs, ctx());

    const total = h.records.reduce((s, r) => s + (r.durationMin ?? 0), 0);
    expect(total).toBe(20); // 恰好钳到预算
    expect(summary.created).toBeGreaterThanOrEqual(1);
    expect(h.records.length).toBe(summary.created);
    // 全部指纹照常消费（含被并入的碎片），防重扫复活
    for (const s of ['w01', 'w02', 'w03']) expect(h.ingested.has(fpOf(s))).toBe(true);
  });

  it('E3 降级：LLM 失败→低置信规则条目不断档', async () => {
    const { generateReport } = await import('../../src/services/llm');
    vi.mocked(generateReport).mockRejectedValueOnce(new Error('LLM 不可用'));
    const { runConsolidate } = await import('../../src/services/collector/engine');
    const summary = await runConsolidate(DAY, [mk(by('w01')), mk(by('w02'))], ctx());

    expect(summary.degraded).toBe(true);
    expect(summary.created).toBe(2);
    // 降级条目量化到最低 0.5h（时长口径统一），置信度低值标记
    expect(h.records.every((r) => r.durationMin === 30)).toBe(true);
  });
});
