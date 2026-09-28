// P8b·B 路 Obsidian 导出回归：md 四区格式（frontmatter/Summary/Learnings/raw callout）、
// RECORD_TYPE_LABELS 中文标签、空记录渲染、未配置目录抛错、幂等合并（「## 补充 HH:mm」段，
// 不覆盖已有内容、全重复跳过）、区间导出按天分组。
// 纯渲染无 mock；IO 层（tauri invoke / db / settings store）走 vi.mock（node 环境，不起 Tauri 桥）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, WorkRecord } from '../../src/types/models';

// ---------- 共享内存态（vi.hoisted 保证 mock 工厂可引用） ----------

const h = vi.hoisted(() => ({
  files: new Map<string, string>(), // path → contents（模拟文件系统）
  dirs: [] as string[],
  records: [] as WorkRecord[],
  projects: [] as Project[],
  obsidianDir: '',
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    const path = String(args?.path ?? '');
    switch (cmd) {
      case 'plugin:fs|mkdir':
        h.dirs.push(path);
        return;
      case 'plugin:fs|exists':
        return h.files.has(path);
      case 'plugin:fs|read_text_file': {
        if (!h.files.has(path)) throw new Error(`文件不存在: ${path}`);
        return h.files.get(path);
      }
      case 'plugin:fs|write_text_file':
        h.files.set(path, String(args?.contents ?? ''));
        return;
      default:
        throw new Error(`未预期的 invoke: ${cmd}`);
    }
  }),
}));

vi.mock('../../src/services/db', () => ({
  listRecordsByDay: vi.fn(async (day: string, wsId?: string) =>
    h.records.filter((r) => r.day === day && (!wsId || r.workspaceId === wsId))),
  listRecordsByRange: vi.fn(async (from: string, to: string, wsId?: string) =>
    h.records
      .filter((r) => r.day >= from && r.day <= to && (!wsId || r.workspaceId === wsId))
      .sort((a, b) => (a.day === b.day ? a.createdAt - b.createdAt : a.day < b.day ? -1 : 1))),
  listProjects: vi.fn(async (wsId?: string) => h.projects.filter((p) => !wsId || p.workspaceId === wsId)),
}));

vi.mock('../../src/stores/useSettingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ settings: { obsidianDir: h.obsidianDir } }),
  },
}));

// ---------- 工具 ----------

let seq = 0;
function mkRecord(over: Partial<WorkRecord> = {}): WorkRecord {
  seq += 1;
  const day = over.day ?? '2026-09-28';
  return {
    id: over.id ?? `r${seq}`,
    taskId: null,
    projectId: null,
    content: over.content ?? `记录${seq}`,
    durationMin: null,
    day,
    half: 'allday',
    source: 'manual',
    createdAt: over.createdAt ?? new Date(`${day}T12:00:00`).getTime(),
    updatedAt: 0,
    meta: {},
    workspaceId: 'personal',
    recordType: 'work',
    learnings: [],
    tags: [],
    ...over,
  };
}

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
    workspaceId: 'personal',
    ...over,
  };
}

const at = (day: string, hh: number, mm: number) => new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`).getTime();

const DAY = '2026-09-28';

beforeEach(() => {
  h.files.clear();
  h.dirs.length = 0;
  h.records.length = 0;
  h.projects.length = 0;
  h.obsidianDir = '/vault';
});

// ---------- 用例 ----------

describe('renderDayMarkdown 纯渲染', () => {
  it('完整四区：frontmatter(source/date) + Summary + Learnings + raw callout（旧 hook 协议）', async () => {
    const { renderDayMarkdown } = await import('../../src/services/obsidianExport');
    const projects = [mkProject({ id: 'p1', name: '日迹' })];
    const records = [
      mkRecord({ id: 'r1', day: DAY, projectId: 'p1', content: '完成导出模块联调', durationMin: 90, createdAt: at(DAY, 10, 30) }),
      mkRecord({
        id: 'r2',
        day: DAY,
        recordType: 'learning',
        content: '读了《卡片笔记写作法》第 3 章',
        createdAt: at(DAY, 21, 15),
        learnings: ['永久笔记要用自己的话写', '记录时要带上上下文'],
      }),
    ];
    const md = renderDayMarkdown(records, projects);
    expect(md).toBe(
      [
        '---',
        'source: daylog',
        `date: ${DAY}`,
        'projects: ["日迹"]',
        '---',
        '',
        '## Summary',
        '',
        '- [10:30] （工作）完成导出模块联调（1.5h）',
        '- [21:15] （学到什么）读了《卡片笔记写作法》第 3 章',
        '',
        '## Learnings',
        '',
        '- 永久笔记要用自己的话写',
        '- 记录时要带上上下文',
        '',
        '> [!record] 原始记录',
        '> - 完成导出模块联调',
        '> - 读了《卡片笔记写作法》第 3 章',
        '',
      ].join('\n'),
    );
  });

  it('类型标签走 RECORD_TYPE_LABELS 中文；时长 45min→0.75h；无时长省略尾括号', async () => {
    const { renderDayMarkdown } = await import('../../src/services/obsidianExport');
    const md = renderDayMarkdown(
      [
        mkRecord({ day: DAY, recordType: 'practice', content: '刷了两道算法题', durationMin: 45, createdAt: at(DAY, 9, 0) }),
        mkRecord({ day: DAY, recordType: 'milestone', content: '跑完首个半马', durationMin: 60, createdAt: at(DAY, 14, 5) }),
        mkRecord({ day: DAY, recordType: 'thought', content: '想把复盘改成周更', createdAt: at(DAY, 22, 0) }),
      ],
      [],
    );
    expect(md).toContain('- [09:00] （练习实践）刷了两道算法题（0.75h）');
    expect(md).toContain('- [14:05] （里程碑）跑完首个半马（1h）');
    expect(md).toContain('- [22:00] （想法）想把复盘改成周更');
    expect(md).not.toContain('（想法）想把复盘改成周更（');
  });

  it('无 learnings 时省略 Learnings 区', async () => {
    const { renderDayMarkdown } = await import('../../src/services/obsidianExport');
    const md = renderDayMarkdown([mkRecord({ day: DAY, content: '普通一条' })], []);
    expect(md).toContain('## Summary');
    expect(md).not.toContain('## Learnings');
    expect(md).toContain('> [!record] 原始记录');
  });

  it('空记录日渲染不抛错：无 date 行，Summary 区与 callout 标记保留', async () => {
    const { renderDayMarkdown } = await import('../../src/services/obsidianExport');
    const md = renderDayMarkdown([], []);
    expect(md.startsWith('---\nsource: daylog\n---')).toBe(true);
    expect(md).not.toContain('date:');
    expect(md).toContain('## Summary');
    expect(md).toContain('> [!record] 原始记录');
  });
});

describe('exportDay / exportRange', () => {
  it('未配置目录抛「未配置 Obsidian 库路径」', async () => {
    const { exportDay } = await import('../../src/services/obsidianExport');
    h.obsidianDir = '';
    h.records = [mkRecord({ day: DAY })];
    await expect(exportDay(DAY, 'personal')).rejects.toThrow('未配置 Obsidian 库路径');
  });

  it('该日无记录抛错，不落文件', async () => {
    const { exportDay } = await import('../../src/services/obsidianExport');
    await expect(exportDay(DAY, 'personal')).rejects.toThrow('无记录');
    expect(h.files.size).toBe(0);
  });

  it('首导：建 record 目录、写入 ${dir}/record/${day}.md、内容即 renderDayMarkdown', async () => {
    const { exportDay, renderDayMarkdown } = await import('../../src/services/obsidianExport');
    const projects = [mkProject({ id: 'p1', name: '日迹' })];
    h.projects = projects;
    h.records = [
      mkRecord({ id: 'r1', day: DAY, projectId: 'p1', content: '完成导出模块联调', durationMin: 90, createdAt: at(DAY, 10, 30) }),
      mkRecord({ id: 'r2', day: DAY, recordType: 'learning', content: '读书', createdAt: at(DAY, 21, 15), learnings: ['永久笔记要用自己的话写'] }),
    ];
    const path = await exportDay(DAY, 'personal');
    expect(path).toBe('/vault/record/2026-09-28.md');
    expect(h.dirs).toContain('/vault/record');
    expect(h.files.get(path)).toBe(renderDayMarkdown(h.records, projects));
  });

  it('幂等合并：已有文件文末追加「## 补充 HH:mm」段（仅新条目），不覆盖原内容；全重复不再追加', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-28T15:00:00') });
    try {
      const { exportDay } = await import('../../src/services/obsidianExport');
      h.records = [mkRecord({ id: 'r1', day: DAY, content: '上午写复盘聚合', createdAt: at(DAY, 10, 0) })];
      await exportDay(DAY, 'personal');
      const first = h.files.get('/vault/record/2026-09-28.md')!;

      // 新增一条（时间推进到 15:00，补充段时间戳由此取）
      h.records.push(mkRecord({ id: 'r2', day: DAY, content: '下午接 Obsidian 导出', durationMin: 30, createdAt: at(DAY, 15, 0) }));
      await exportDay(DAY, 'personal');
      const merged = h.files.get('/vault/record/2026-09-28.md')!;
      expect(merged.startsWith(first)).toBe(true); // 原内容一字不动
      expect(merged).toContain('## 补充 15:00');
      expect(merged).toContain('- [15:00] （工作）下午接 Obsidian 导出（0.5h）');
      expect(merged.match(/## 补充/g)).toHaveLength(1);

      // 全部条目已在文件中：幂等跳过，内容不变
      await exportDay(DAY, 'personal');
      expect(h.files.get('/vault/record/2026-09-28.md')).toBe(merged);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exportRange：按天分组落盘、无记录的天跳过；重复导出 files=0（幂等）', async () => {
    const { exportRange } = await import('../../src/services/obsidianExport');
    h.records = [
      mkRecord({ day: '2026-09-28', content: 'day1-a', createdAt: at('2026-09-28', 10, 0) }),
      mkRecord({ day: '2026-09-28', content: 'day1-b', createdAt: at('2026-09-28', 11, 0) }),
      mkRecord({ day: '2026-09-30', content: 'day3-a', createdAt: at('2026-09-30', 9, 0) }),
      mkRecord({ day: '2026-10-01', workspaceId: 'work', content: '别空间的', createdAt: at('2026-10-01', 9, 0) }), // 空间隔离
    ];
    const r1 = await exportRange('2026-09-28', '2026-10-02', 'personal');
    expect(r1).toEqual({ files: 2, dir: '/vault' });
    expect(h.files.has('/vault/record/2026-09-28.md')).toBe(true);
    expect(h.files.has('/vault/record/2026-09-29.md')).toBe(false); // 空日不落文件
    expect(h.files.has('/vault/record/2026-09-30.md')).toBe(true);
    expect(h.files.has('/vault/record/2026-10-01.md')).toBe(false); // work 空间记录不进个人导出

    // 内容含当日全部条目（分组正确）
    expect(h.files.get('/vault/record/2026-09-28.md')).toContain('day1-a');
    expect(h.files.get('/vault/record/2026-09-28.md')).toContain('day1-b');

    const r2 = await exportRange('2026-09-28', '2026-10-02', 'personal');
    expect(r2.files).toBe(0); // 全部已存在，幂等
  });
});

afterEach(() => {
  vi.useRealTimers();
});
