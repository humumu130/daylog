// P8b 空间参数化机制回归：personal 空间 prompt 口径（成长记录 system + type/learnings
// 白名单校验与回退）与入库字段（workspaceId/recordType/learnings）；work 空间口径与
// 字段恒 'work'/[]。LLM 真实判定质量需装机验收，本套只锁机制。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectSettings, LlmConfig } from '../../src/types/models';
import type { CollectorCtx, EngineInput } from '../../src/services/collector/types';

const DAY = '2026-09-28';

// ---------- 共享内存态 ----------

const h = vi.hoisted(() => ({
  records: [] as Array<Record<string, unknown> & { id: string }>,
  llmItems: [] as Array<Record<string, unknown>>,
  lastSystem: '',
}));

vi.mock('../../src/services/db', () => ({
  createRecord: vi.fn(async (input: Record<string, unknown>) => {
    const id = crypto.randomUUID();
    h.records.push({ id, ...input });
    return id;
  }),
  deleteRecord: vi.fn(async () => undefined),
  listRecordsByDay: vi.fn(async () => []),
}));

vi.mock('../../src/services/llm', () => ({
  generateReport: vi.fn(async (_cfg: unknown, system: string) => {
    h.lastSystem = system;
    return JSON.stringify({ items: h.llmItems, noise: [] });
  }),
}));

vi.mock('../../src/services/collector/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/collector/state')>();
  return {
    ...actual,
    ingestedByDay: vi.fn(async () => []),
    markIngested: vi.fn(async () => undefined),
    noiseDigestIndex: vi.fn(async () => new Map()),
    upsertNoise: vi.fn(async () => undefined),
    saveRun: vi.fn(async () => undefined),
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

function ctx(over: Partial<CollectorCtx> = {}): CollectorCtx {
  return { settings: SETTINGS, llm: {} as LlmConfig, projects: [], existingRecords: [], ...over };
}

function mk(fp: string, text: string): EngineInput {
  return { fingerprint: fp, provider: 'claude-code', day: DAY, projectId: null, kind: 'human_prompt', ts: null, text, human: true };
}

const fp = (i: number) => `${String(i).padStart(2, '0')}` + 'a'.repeat(54); // 前 10 字符互异

beforeEach(() => {
  h.records.length = 0;
  h.llmItems.length = 0;
  h.lastSystem = '';
});

// ---------- 用例 ----------

describe('空间参数化（P8b）', () => {
  it('personal：成长记录 system；type 白名单校验非法回退 thought；learnings 数组化；入库带空间', async () => {
    const { runConsolidate } = await import('../../src/services/collector/engine');
    h.llmItems = [
      { title: '完成 zustand 空间隔离改造', hours: 1, sources: [fp(1)], confidence: 0.9, type: 'milestone', learnings: ['store 查询按 currentId 过滤'] },
      { title: '练习 prompt 分支拆分', hours: 0.5, sources: [fp(2)], confidence: 0.8, type: 'bogus', learnings: 'not-an-array' },
    ];
    const summary = await runConsolidate(DAY, [mk(fp(1), '输入一'), mk(fp(2), '输入二')], ctx({ workspaceId: 'personal', wsKind: 'personal' }));

    expect(summary.created).toBe(2);
    expect(h.lastSystem).toContain('个人成长记录整理助手');
    expect(h.lastSystem).toContain('learnings');
    const [a, b] = h.records;
    expect(a.workspaceId).toBe('personal');
    expect(a.recordType).toBe('milestone');
    expect(a.learnings).toEqual(['store 查询按 currentId 过滤']);
    expect(b.workspaceId).toBe('personal');
    expect(b.recordType).toBe('thought'); // 非法 type 回退
    expect(b.learnings).toEqual([]); // 非数组 learnings 数组化
  });

  it('work（缺省 ctx）：工时口径 system 原样；recordType 恒 work、learnings 恒空', async () => {
    const { runConsolidate } = await import('../../src/services/collector/engine');
    h.llmItems = [{ title: '完成登录组件开发', hours: 1, sources: [fp(1)], confidence: 0.9 }];
    await runConsolidate(DAY, [mk(fp(1), '输入一')], ctx());

    expect(h.lastSystem).toContain('工作日志整理助手');
    expect(h.lastSystem).not.toContain('个人成长记录');
    expect(h.records).toHaveLength(1);
    expect(h.records[0].workspaceId).toBe('work');
    expect(h.records[0].recordType).toBe('work');
    expect(h.records[0].learnings).toEqual([]);
  });

  it('personal 降级：LLM 失败的规则条目 recordType 兜底 thought', async () => {
    const { generateReport } = await import('../../src/services/llm');
    vi.mocked(generateReport).mockRejectedValueOnce(new Error('LLM 不可用'));
    const { runConsolidate } = await import('../../src/services/collector/engine');
    const summary = await runConsolidate(DAY, [mk(fp(1), '降级输入')], ctx({ workspaceId: 'personal', wsKind: 'personal' }));

    expect(summary.degraded).toBe(true);
    expect(h.records).toHaveLength(1);
    expect(h.records[0].recordType).toBe('thought');
    expect(h.records[0].workspaceId).toBe('personal');
  });
});
