// 个人空间复盘聚合（P8b·B 路）：纯函数层——期间过滤 + 指标聚合 + 复盘正文生成 prompt。
// 快照读写走 db.listRetrospectives / saveRetrospective，本层不碰任何 IO。

import type { Project, WorkRecord } from '../types/models';
import { formatYMD, monthRange } from '../utils/date';

export interface RetroAgg {
  period: string;            // 'YYYY-Www'（ISO 周号）| 'YYYY-MM'
  kind: 'week' | 'month';
  days: number;              // 有记录的天数
  entries: number;           // 条目数
  totalMin: number | null;   // 时长合计（期间无任何计时条目时 null）
  themeDist: { name: string; count: number; min: number }[]; // 项目/主题分布，name=项目名（无项目='未分类'），按条数降序
  learnings: string[];       // 期内全部条目 learnings 展开去重（保序）
  milestones: string[];      // recordType='milestone' 的条目 content 列表
}

/** 'YYYY-Www' → 该 ISO 周的周一~周日（本地时区）。ISO 8601：1 月 4 日恒在第 1 周。 */
function isoWeekRange(period: string): { from: string; to: string } {
  const m = /^(\d{4})-W(\d{2})$/.exec(period);
  if (!m) throw new Error(`周期间格式应为 YYYY-Www，收到「${period}」`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  // 第 1 周周一 = 1 月 4 日所在周的周一（周一=0 … 周日=6）
  const jan4 = new Date(year, 0, 4);
  const monday = new Date(year, 0, 4 - ((jan4.getDay() + 6) % 7) + (week - 1) * 7);
  // 越界校验（W00 / 不存在的 W53）：该周周四必须落在同一 ISO 年
  const thursday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3);
  if (week < 1 || thursday.getFullYear() !== year) {
    throw new Error(`非法周号：${period}（该年无此周）`);
  }
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { from: formatYMD(monday), to: formatYMD(sunday) };
}

function periodRange(period: string, kind: 'week' | 'month'): { from: string; to: string } {
  if (kind === 'week') return isoWeekRange(period);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error(`月期间格式应为 YYYY-MM，收到「${period}」`);
  return monthRange(period);
}

/** 分钟 → 小时字面量（90→'1.5'、60→'1'、45→'0.75'） */
function fmtHours(min: number): string {
  const h = min / 60;
  return Number.isInteger(h) ? String(h) : String(Math.round(h * 100) / 100);
}

/** 期间聚合：week=ISO 周一~周日（本地时区），month=自然月；records 由调用方按空间预过滤 */
export function aggregateRetro(records: WorkRecord[], projects: Project[], period: string, kind: 'week' | 'month'): RetroAgg {
  const { from, to } = periodRange(period, kind);
  const inPeriod = records.filter((r) => r.day >= from && r.day <= to);

  const nameOf = new Map(projects.map((p) => [p.id, p.name]));
  const days = new Set(inPeriod.map((r) => r.day));

  // 主题分布：按项目名聚桶（无项目/项目已删 = '未分类'），同序稳定排（条数降序，首次出现序破平）
  const themes = new Map<string, { name: string; count: number; min: number }>();
  for (const r of inPeriod) {
    const name = (r.projectId ? nameOf.get(r.projectId) : undefined) ?? '未分类';
    const cur = themes.get(name) ?? { name, count: 0, min: 0 };
    cur.count += 1;
    cur.min += r.durationMin ?? 0;
    themes.set(name, cur);
  }
  const themeDist = [...themes.values()].sort((a, b) => b.count - a.count);

  // learnings 展开去重（保序；按去空白键判重，跳过空串）
  const seen = new Set<string>();
  const learnings: string[] = [];
  for (const r of inPeriod) {
    for (const l of r.learnings ?? []) {
      const key = l.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      learnings.push(l);
    }
  }

  // 时长合计：期间内无任何计时条目（durationMin 全 null）→ null
  const timed = inPeriod.filter((r) => typeof r.durationMin === 'number');
  const totalMin = timed.length > 0 ? timed.reduce((s, r) => s + (r.durationMin ?? 0), 0) : null;

  const milestones = inPeriod.filter((r) => r.recordType === 'milestone').map((r) => r.content);

  return {
    period,
    kind,
    days: days.size,
    entries: inPeriod.length,
    totalMin,
    themeDist,
    learnings,
    milestones,
  };
}

/** 复盘正文生成 prompt：system 定角色与口径，user 把 RetroAgg 结构化成文本并要求输出 Markdown 正文 */
export function buildRetroPrompt(agg: RetroAgg): { system: string; user: string } {
  const label = agg.kind === 'week' ? '周复盘' : '月复盘';
  const next = agg.kind === 'week' ? '下周' : '下月';
  const system =
    '你是个人成长复盘撰写助手。基于用户提供的期间记录撰写复盘正文：按主题组织内容；' +
    '从记录中提炼行为模式与进步；结尾给出下期行动建议（周复盘给下周建议，月复盘给下月建议）。' +
    '语气中性书面，不夸大、不抒情，不编造记录之外的内容。';

  const lines: string[] = [];
  lines.push(`请为以下个人空间记录撰写${label}正文（期间 ${agg.period}），直接输出 Markdown 正文。`);
  lines.push('');
  lines.push('期间概览：');
  lines.push(`- 有记录天数：${agg.days} 天`);
  lines.push(`- 条目数：${agg.entries} 条`);
  lines.push(`- 时长合计：${agg.totalMin === null ? '无计时记录' : `${fmtHours(agg.totalMin)} 小时`}`);
  if (agg.themeDist.length > 0) {
    lines.push('');
    lines.push('主题分布（按条数降序）：');
    for (const t of agg.themeDist) lines.push(`- ${t.name}：${t.count} 条，${fmtHours(t.min)} 小时`);
  }
  if (agg.learnings.length > 0) {
    lines.push('');
    lines.push(`学到什么（去重后 ${agg.learnings.length} 条）：`);
    for (const l of agg.learnings) lines.push(`- ${l}`);
  }
  if (agg.milestones.length > 0) {
    lines.push('');
    lines.push('里程碑：');
    for (const ms of agg.milestones) lines.push(`- ${ms}`);
  }
  lines.push('');
  lines.push('要求：');
  lines.push('- 直接输出 Markdown 正文，不要用代码块包裹，不必输出一级标题。');
  lines.push('- 按主题组织（可参考主题分布），提炼期间的行为模式与进步。');
  lines.push(`- 结尾给出${next}行动建议。`);

  return { system, user: lines.join('\n') };
}
