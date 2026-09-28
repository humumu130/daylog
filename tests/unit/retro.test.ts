// P8b·B 路复盘聚合纯函数回归：ISO 周/自然月边界过滤（含跨年周）、无计时 totalMin=null、
// 主题分布排序与「未分类」、learnings 去重保序、里程碑收集、非法期间抛错、prompt 组装。
// 纯逻辑层不起 Tauri 桥，无 mock。

import { describe, expect, it } from 'vitest';
import type { Project, WorkRecord } from '../../src/types/models';
import { aggregateRetro, buildRetroPrompt } from '../../src/services/retro';

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
    createdAt: new Date(`${day}T12:00:00`).getTime(),
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

// ---------- 用例 ----------

describe('aggregateRetro 周期过滤', () => {
  it('ISO 周：2026-W40 = 09-28(周一)~10-04(周日)，周界外条目剔除', () => {
    const records = [
      mkRecord({ day: '2026-09-27' }), // 上周日，属 W39
      mkRecord({ day: '2026-09-28' }),
      mkRecord({ day: '2026-09-30' }),
      mkRecord({ day: '2026-10-04' }),
      mkRecord({ day: '2026-10-05' }), // 下周一，属 W41
    ];
    const agg = aggregateRetro(records, [], '2026-W40', 'week');
    expect(agg.entries).toBe(3);
    expect(agg.days).toBe(3);
  });

  it('跨年周：2026-W01 = 2025-12-29 ~ 2026-01-04（ISO 周年 ≠ 公历年）', () => {
    const records = [
      mkRecord({ day: '2025-12-28' }),
      mkRecord({ day: '2025-12-29' }),
      mkRecord({ day: '2026-01-04' }),
      mkRecord({ day: '2026-01-05' }),
    ];
    const agg = aggregateRetro(records, [], '2026-W01', 'week');
    expect(agg.entries).toBe(2);
    expect(agg.days).toBe(2);
  });

  it('自然月：2026-02 = 02-01~02-28，首尾日之外剔除', () => {
    const records = [
      mkRecord({ day: '2026-01-31' }),
      mkRecord({ day: '2026-02-01' }),
      mkRecord({ day: '2026-02-12' }),
      mkRecord({ day: '2026-02-28' }),
      mkRecord({ day: '2026-03-01' }),
    ];
    const agg = aggregateRetro(records, [], '2026-02', 'month');
    expect(agg.entries).toBe(3);
    expect(agg.days).toBe(3);
  });

  it('非法期间抛错：格式错 / 不存在的周号（2025 只有 52 周）/ 非法月份', () => {
    expect(() => aggregateRetro([], [], '2026-40', 'week')).toThrow();
    expect(() => aggregateRetro([], [], '2026-W00', 'week')).toThrow();
    expect(() => aggregateRetro([], [], '2025-W53', 'week')).toThrow();
    expect(() => aggregateRetro([], [], '2026-13', 'month')).toThrow();
  });
});

describe('aggregateRetro 指标口径', () => {
  const proj = mkProject({ id: 'p1', name: '日迹' });
  const records = [
    mkRecord({ day: '2026-09-28', projectId: 'p1', durationMin: 60 }),
    mkRecord({ day: '2026-09-29', durationMin: null }),
    mkRecord({ day: '2026-09-29', projectId: '已删除', durationMin: 30 }),
    mkRecord({ day: '2026-09-30', durationMin: null }),
    mkRecord({ day: '2026-09-30', projectId: 'p1', recordType: 'milestone', content: '跑完首个半马', durationMin: 0 }),
  ];

  it('totalMin：期间无任何计时条目 → null（而非 0）', () => {
    const none = aggregateRetro([mkRecord({ day: '2026-09-28' }), mkRecord({ day: '2026-09-29' })], [], '2026-W40', 'week');
    expect(none.totalMin).toBeNull();
  });

  it('totalMin 混合计时：只累计有值条目（60+30+0=90，null 当无）', () => {
    const agg = aggregateRetro(records, [proj], '2026-W40', 'week');
    expect(agg.totalMin).toBe(90);
  });

  it('themeDist：按条数降序（3>2）、未分类兜底（无项目+项目已删）、min 逐桶累计', () => {
    const agg = aggregateRetro(records, [proj], '2026-W40', 'week');
    expect(agg.themeDist).toEqual([
      { name: '未分类', count: 3, min: 30 }, // 无项目 2 条 + 项目已删 1 条
      { name: '日迹', count: 2, min: 60 },
    ]);
  });

  it('learnings 展开去重保序；milestones 只收 recordType=milestone 的 content', () => {
    const rs = [
      mkRecord({ day: '2026-09-28', recordType: 'learning', learnings: ['永久笔记用自己的话写', '记录带上下文'] }),
      mkRecord({ day: '2026-09-29', recordType: 'retro', learnings: ['永久笔记用自己的话写', ''] }),
      mkRecord({ day: '2026-09-30', recordType: 'milestone', content: '完成 P8b 空间制' }),
    ];
    const agg = aggregateRetro(rs, [], '2026-W40', 'week');
    expect(agg.learnings).toEqual(['永久笔记用自己的话写', '记录带上下文']);
    expect(agg.milestones).toEqual(['完成 P8b 空间制']);
  });
});

describe('buildRetroPrompt', () => {
  const agg = aggregateRetro(
    [
      mkRecord({ day: '2026-09-28', projectId: 'p1', durationMin: 60, learnings: ['学会了 ISO 周'] }),
      mkRecord({ day: '2026-09-29', recordType: 'milestone', content: '完成复盘模块' }),
    ],
    [mkProject({ id: 'p1', name: '日迹' })],
    '2026-W40',
    'week',
  );

  it('system 定口径：按主题组织、提炼模式与进步、给下周建议、中性书面', () => {
    const { system } = buildRetroPrompt(agg);
    expect(system).toContain('个人成长复盘撰写助手');
    expect(system).toContain('主题');
    expect(system).toContain('模式与进步');
    expect(system).toContain('下周');
    expect(system).toContain('中性书面');
  });

  it('user 结构化 RetroAgg：期间/概览/分布/learnings/里程碑，要求输出 Markdown 正文', () => {
    const { user } = buildRetroPrompt(agg);
    expect(user).toContain('2026-W40');
    expect(user).toContain('有记录天数：2 天');
    expect(user).toContain('条目数：2 条');
    expect(user).toContain('1 小时');
    expect(user).toContain('日迹：1 条，1 小时');
    expect(user).toContain('- 学会了 ISO 周');
    expect(user).toContain('- 完成复盘模块');
    expect(user).toContain('Markdown');
  });

  it('月复盘给下月建议；无计时显示「无计时记录」', () => {
    const monthAgg = aggregateRetro([mkRecord({ day: '2026-02-10' })], [], '2026-02', 'month');
    const { system, user } = buildRetroPrompt(monthAgg);
    expect(system).toContain('下月');
    expect(user).toContain('无计时记录');
    expect(user).not.toContain('下周');
  });
});
