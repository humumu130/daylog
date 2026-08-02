import * as db from './db';
import type { RecordInput } from './db';
import type { WorkRecord } from '../types/models';

const DAY_TOTAL_MIN = 8 * 60;
const OVERTIME_DEFAULT_MIN = 2 * 60; // 当天已满 8h，新条目默认加班 2h
const MIN_PER_ENTRY = 30; // 每条最少 30 分钟

/** 是否为"可重分配"记录：无时长 或 之前由 autoDuration 自动分配的（meta 标记） */
function isRedistributable(r: WorkRecord): boolean {
  return r.durationMin === null || r.meta?.autoDuration === true;
}

function toInput(r: WorkRecord, durationMin: number): RecordInput {
  return {
    content: r.content,
    durationMin,
    day: r.day,
    half: r.half,
    taskId: r.taskId,
    projectId: r.projectId,
    source: r.source,
    meta: { ...r.meta, autoDuration: true },
  };
}

/**
 * 智能工时分配：
 * - 无时长的记录 + 之前自动分配的 → 从 8h 预算按份均分（手动填的不动）
 * - 当天已有 ≥8h 明确工时 → 返回加班默认（2h），不压缩已有
 * - 返回新记录应得的分钟数
 */
export async function autoDuration(day: string): Promise<number> {
  const existing = await db.listRecordsByDay(day);
  const fixed = existing.filter((r) => !isRedistributable(r));
  const redistributable = existing.filter(isRedistributable);

  const fixedSum = fixed.reduce((s, r) => s + (r.durationMin ?? 0), 0);
  const remaining = DAY_TOTAL_MIN - fixedSum;

  if (remaining <= 0) {
    // 加班场景：8h 已被明确工时占满，新条目给默认加班时长
    return OVERTIME_DEFAULT_MIN;
  }

  const slots = redistributable.length + 1; // 可重分配 + 新增这条
  const share = Math.max(MIN_PER_ENTRY, Math.round(remaining / slots));

  // 重算已有的可重分配记录
  for (const r of redistributable) {
    await db.updateRecord(r.id, toInput(r, share));
  }

  return share;
}
