// 活跃区间模型（P5）：会话消息/commit 时间戳 → 活跃区间（间隔>gapMinutes 切断）
// → 区间按项目归属 → 估时硬约束 Σ≤活跃总时长；加班=同一套区间的时间属性
// （区间 ∩ 下班后时段，且区间须含人工交互事件——防挂机后台 agent 虚增）。

import type { CollectSettings } from '../../types/models';
import type { ActiveInterval, EngineInput } from './types';

export const MIN_INTERVAL_MIN = 0.5; // 单区间最短计入 30 分钟

/** 输入须为同一日、已按 ts 升序的定时事件（ts 非 null） */
export function buildIntervals(inputs: EngineInput[], gapMinutes: number): ActiveInterval[] {
  const timed = inputs.filter((x) => x.ts !== null).sort((a, b) => (a.ts as number) - (b.ts as number));
  if (timed.length === 0) return [];
  const gapMs = Math.max(1, gapMinutes) * 60 * 1000;
  const out: ActiveInterval[] = [];
  let start = timed[0].ts as number;
  let last = start;
  let projectId: string | null = timed[0].projectId;
  let human = timed[0].human;

  const flush = (end: number) => {
    const minutes = (end - start) / 60000;
    if (minutes > 0) out.push({ start, end, projectId, human, minutes });
  };

  for (const ev of timed.slice(1)) {
    const t = ev.ts as number;
    if (t - last > gapMs || ev.projectId !== projectId) {
      // 切段：超间隔 或 跨项目（并行多项目日按项目分段归属）
      flush(last);
      start = t;
      projectId = ev.projectId;
      human = ev.human;
    } else {
      human = human || ev.human;
    }
    last = t;
  }
  flush(last);
  return out;
}

// ---------- 加班边界（工时边界模型） ----------

export interface OvertimeBounds {
  /** 下班时刻（分钟数，如 16:30 → 990） */
  workEndMin: number;
  /** 上班时刻（分钟数） */
  workStartMin: number;
  /** 非工作日（周末；节假日日历 P8 接入，先按周末） */
  nonWorkday: boolean;
  weekendOvertime: boolean;
  earlyStartOvertime: boolean;
}

export function parseHHmm(s: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s ?? '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return fallback;
  return h * 60 + min;
}

export function boundsFor(day: string, settings: CollectSettings): OvertimeBounds {
  // day: YYYY-MM-DD；周中 1..5 视为工作日（节假日日历后续接入）
  const d = new Date(`${day}T12:00:00`);
  const dow = d.getDay();
  const nonWorkday = dow === 0 || dow === 6;
  return {
    workStartMin: parseHHmm(settings.workStartTime, 9 * 60),
    workEndMin: parseHHmm(settings.workEndTime, 16 * 60 + 30),
    nonWorkday,
    weekendOvertime: settings.weekendOvertime,
    earlyStartOvertime: settings.earlyStartOvertime,
  };
}

function minuteOfDay(ts: number): number {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * 区间的加班分钟：工作日=区间∩下班后（或上班前，若开早到）；非工作日=区间全长（若开周末计入）。
 * 硬条件：区间含人工交互事件（human=true）。量化（0.5h 粒度）由调用方做。
 */
export function overtimeMinutes(iv: ActiveInterval, b: OvertimeBounds): number {
  if (b.nonWorkday) return b.weekendOvertime && iv.human ? iv.minutes : 0;
  if (!iv.human) return 0;
  const s = minuteOfDay(iv.start);
  const e = Math.max(minuteOfDay(iv.end), s);
  let after = 0;
  if (e > b.workEndMin) after = Math.min(e, 24 * 60) - Math.max(s, b.workEndMin);
  let before = 0;
  if (b.earlyStartOvertime && s < b.workStartMin) before = Math.min(e, b.workStartMin) - s;
  return Math.max(0, after) + Math.max(0, before);
}

/** 一组区间的加班合计（分钟），供今日页「晚间·加班」/上报额度条消费 */
export function totalOvertimeMinutes(intervals: ActiveInterval[], b: OvertimeBounds): number {
  return intervals.reduce((s, iv) => s + overtimeMinutes(iv, b), 0);
}

/** 活跃总时长（分钟）：估时铁律 Σ(当日自动条目)≤活跃总时长−手动已占 */
export function activeTotalMinutes(intervals: ActiveInterval[]): number {
  return intervals.reduce((s, iv) => s + iv.minutes, 0);
}
