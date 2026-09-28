// P8·F1 项目映射规则回归：三路命中（keywords 全等 / git 仓库尾段 / 名称归一化）、
// 未命中待配行、健康检查（warnings/broken）、LLM 精配兜底与幻觉过滤、落库合并。
// 纯函数为主；stores 与 LLM 走 vi.mock（node 环境，不起 Tauri 桥）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmConfig, Project } from '../../src/types/models';
import type { RemoteProject } from '../../src/services/reporters/types';
import type { MapSuggestion } from '../../src/services/choerodonMap';

// ---------- 共享内存态（vi.hoisted 保证 mock 工厂可引用） ----------

const h = vi.hoisted(() => ({
  patch: vi.fn(async () => undefined),
  update: vi.fn(async () => undefined),
  projects: [] as Project[],
  choerodon: null as null | { baseUrl: string; orgId: string; patTail: string; projectMap: Record<string, string>; lastSyncDay: string },
  generateReport: vi.fn(async () => '[]'),
}));

vi.mock('../../src/stores/useSettingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ settings: { choerodon: h.choerodon }, patch: h.patch }),
  },
}));
vi.mock('../../src/stores/useProjectsStore', () => ({
  useProjectsStore: {
    // update 模拟真实 store 的「写库后 refetch」：把 input 落回内存列表，
    // 这样 rememberRule 的去重逻辑是对刷新后的 keywords 判断的（与装机行为一致）
    getState: () => ({
      projects: h.projects,
      update: (id: string, input: Record<string, unknown>) => {
        h.update(id, input);
        const i = h.projects.findIndex((p) => p.id === id);
        if (i >= 0) h.projects[i] = { ...h.projects[i], ...input } as (typeof h.projects)[number];
      },
    }),
  },
}));
vi.mock('../../src/services/llm', () => ({
  generateReport: h.generateReport,
}));

// ---------- 工具 ----------

let seq = 0;
function mkProject(over: Partial<Project> = {}): Project {
  seq += 1;
  return {
    id: over.id ?? `p${seq}`,
    name: `项目${seq}`,
    color: '#3b82f6',
    keywords: [],
    isActive: true,
    sortOrder: seq,
    createdAt: 0,
    ...over,
  };
}

function mkRemote(over: Partial<RemoteProject> = {}): RemoteProject {
  seq += 1;
  return {
    id: over.id ?? `r${seq}`,
    name: `远程项目${seq}`,
    code: `code-${seq}`,
    ...over,
  };
}

function pendingRow(id: string, name: string): MapSuggestion {
  return { localProjectId: id, localName: name, remoteProjectId: null, remoteName: null, confidence: 0, ruleBased: false, reason: '' };
}

const CH = { baseUrl: 'https://x.example.com', orgId: '15', patTail: 'abcd', projectMap: {} as Record<string, string>, lastSyncDay: '' };

beforeEach(() => {
  h.patch.mockClear();
  h.update.mockClear();
  h.projects.length = 0;
  h.choerodon = null;
  h.generateReport.mockClear();
});

// ---------- 用例 ----------

describe('ruleMatchProjects 三路规则命中', () => {
  it('规则一：远程 code 与本地 keywords 全等（大小写不敏感）→ 高置信 0.95', async () => {
    const { ruleMatchProjects } = await import('../../src/services/choerodonMap');
    const local = [mkProject({ id: 'p1', name: '日迹', keywords: ['DAYLOG', '日记'] })];
    const remote = [mkRemote({ id: 'r1', code: 'daylog' }), mkRemote({ id: 'r2', code: 'daylog-x' })];
    const rows = ruleMatchProjects(local, remote);
    expect(rows).toHaveLength(1);
    expect(rows[0].remoteProjectId).toBe('r1');
    expect(rows[0].confidence).toBe(0.95);
    expect(rows[0].ruleBased).toBe(true);
    expect(rows[0].reason).toContain('daylog');
  });

  it('规则二：git 仓库路径尾段 === 远程 code（.git 后缀与大小写不敏感）', async () => {
    const { ruleMatchProjects } = await import('../../src/services/choerodonMap');
    const local = [mkProject({ id: 'p2', name: '财务门户', keywords: [] })];
    const remote = [mkRemote({ id: 'r9', code: 'Finance-Portal' }), mkRemote({ id: 'r8', code: 'other' })];
    const rows = ruleMatchProjects(local, remote, { p2: ['/Users/x/dev/finance-portal.git', '/tmp/无关'] });
    expect(rows[0].remoteProjectId).toBe('r9');
    expect(rows[0].confidence).toBe(0.95);
    expect(rows[0].reason).toContain('git');
  });

  it('规则三：名称归一化相等（去空格/全小写/去「项目」后缀）', async () => {
    const { ruleMatchProjects } = await import('../../src/services/choerodonMap');
    const local = [
      mkProject({ id: 'p3', name: '数据平台 项目' }),
      mkProject({ id: 'p4', name: 'AI 中台' }),
    ];
    const remote = [
      mkRemote({ id: 'r3', name: '数据平台' }),
      mkRemote({ id: 'r4', name: 'ai中台' }),
    ];
    const rows = ruleMatchProjects(local, remote);
    expect(rows.find((r) => r.localProjectId === 'p3')!.remoteProjectId).toBe('r3');
    expect(rows.find((r) => r.localProjectId === 'p4')!.remoteProjectId).toBe('r4');
  });

  it('未命中 → 待配行（confidence 0、remoteProjectId null、ruleBased false）', async () => {
    const { ruleMatchProjects } = await import('../../src/services/choerodonMap');
    const local = [mkProject({ id: 'p5', name: '秘密项目', keywords: [] })];
    const remote = [mkRemote({ id: 'r5', name: '完全无关', code: 'zzz' })];
    const rows = ruleMatchProjects(local, remote);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.remoteProjectId).toBeNull();
    expect(row.remoteName).toBeNull();
    expect(row.confidence).toBe(0);
    expect(row.ruleBased).toBe(false);
  });

  it('多路同时命中时 keywords 优先；每个本地项目恰产出一条建议', async () => {
    const { ruleMatchProjects } = await import('../../src/services/choerodonMap');
    const local = [mkProject({ id: 'p6', name: '同名项目', keywords: ['kw'] })];
    const remote = [
      mkRemote({ id: 'by-kw', name: '无关甲', code: 'kw' }),
      mkRemote({ id: 'by-name', name: '同名', code: 'x' }),
    ];
    const rows = ruleMatchProjects(local, remote);
    expect(rows).toHaveLength(1);
    expect(rows[0].remoteProjectId).toBe('by-kw');
    expect(rows[0].reason).toContain('关键词');
  });
});

describe('mapHealth 健康检查', () => {
  it('本地活跃无映射 → warnings；不活跃无映射 → 不告警', async () => {
    const { mapHealth } = await import('../../src/services/choerodonMap');
    const local = [
      mkProject({ id: 'a1', name: '活跃未映射', isActive: true }),
      mkProject({ id: 'a2', name: '停用未映射', isActive: false }),
      mkProject({ id: 'a3', name: '活跃已映射', isActive: true }),
    ];
    const remote = [mkRemote({ id: 'rr' })];
    const { warnings, broken } = mapHealth(local, remote, { a3: 'rr' });
    expect(warnings).toEqual([{ localProjectId: 'a1', name: '活跃未映射' }]);
    expect(broken).toEqual([]);
  });

  it('映射指向的远程 id 不存在 → broken（带原 remoteId 与本地名）', async () => {
    const { mapHealth } = await import('../../src/services/choerodonMap');
    const local = [mkProject({ id: 'b1', name: '断链项目', isActive: true })];
    const remote = [mkRemote({ id: 'live' })];
    const { warnings, broken } = mapHealth(local, remote, { b1: 'gone-id' });
    expect(warnings).toEqual([]);
    expect(broken).toEqual([{ localProjectId: 'b1', remoteId: 'gone-id', name: '断链项目' }]);
  });
});

describe('llmMatchProjects LLM 兜底', () => {
  it('无 LLM key（非 claude-code 且缺 baseUrl/apiKey）→ 空数组且不发起调用', async () => {
    const { llmMatchProjects } = await import('../../src/services/choerodonMap');
    const rows = [pendingRow('p9', '旧门户系统')];
    const out = await llmMatchProjects(rows, [mkRemote({ id: 'r1', code: 'daylog' })], { kind: 'openai-compat' } as LlmConfig);
    expect(out).toEqual([]);
    expect(h.generateReport).not.toHaveBeenCalled();
  });

  it('幻觉 remoteProjectId 被丢弃；合法行 ruleBased=false 且置信度透传', async () => {
    const { llmMatchProjects } = await import('../../src/services/choerodonMap');
    h.generateReport.mockResolvedValueOnce(
      JSON.stringify([
        { localProjectId: 'p9', remoteProjectId: 'r-good', confidence: 0.8, reason: '语义相近' },
        { localProjectId: 'p9', remoteProjectId: 'r-ghost', confidence: 0.9, reason: '幻觉' },
      ]),
    );
    const remote = [mkRemote({ id: 'r-good', name: '门户系统', code: 'portal' })];
    const out = await llmMatchProjects([pendingRow('p9', '旧门户系统')], remote, { kind: 'claude-code' } as LlmConfig);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ localProjectId: 'p9', remoteProjectId: 'r-good', confidence: 0.8, ruleBased: false });
    // 送 LLM 的载荷含待配行与远程清单
    const user = h.generateReport.mock.calls[0][2];
    expect(user).toContain('旧门户系统');
    expect(user).toContain('门户系统');
  });
});

describe('映射落库', () => {
  it('applyProjectMap 合并写入 projectMap（保留已有映射）；choerodon 未配置时抛错', async () => {
    const { applyProjectMap } = await import('../../src/services/choerodonMap');
    h.choerodon = { ...CH, projectMap: { keep: 'r-old' } };
    await applyProjectMap([{ localProjectId: 'a1', remoteProjectId: 'r-new' }]);
    expect(h.patch).toHaveBeenCalledTimes(1);
    const arg = h.patch.mock.calls[0][0] as { choerodon: { projectMap: Record<string, string> } };
    expect(arg.choerodon.projectMap).toEqual({ keep: 'r-old', a1: 'r-new' });

    h.choerodon = null;
    await expect(applyProjectMap([{ localProjectId: 'a1', remoteProjectId: 'r' }])).rejects.toThrow('未配置');
  });

  it('rememberRule 把远程 code 去重追加进 keywords，且带回原有字段', async () => {
    const { rememberRule } = await import('../../src/services/choerodonMap');
    h.projects = [mkProject({ id: 'p7', name: '日迹', color: '#ff0000', keywords: ['已有'], isActive: false, sortOrder: 3 })];
    await rememberRule('p7', 'daylog');
    await rememberRule('p7', '已有'); // 重复不再追加
    expect(h.update).toHaveBeenCalledTimes(2);
    expect(h.update.mock.calls[0]).toEqual(['p7', { name: '日迹', color: '#ff0000', keywords: ['已有', 'daylog'], isActive: false, sortOrder: 3 }]);
    expect(h.update.mock.calls[1][1].keywords).toEqual(['已有', 'daylog']);
  });
});
