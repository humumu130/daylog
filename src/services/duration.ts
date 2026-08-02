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

export interface AutoDurationPlan {
  /** 新记录应得的分钟数 */
  share: number;
  /** 需同步更新的已有记录（仅在 share 落库成功后提交） */
  updates: { id: string; input: RecordInput }[];
}

/**
 * 规划智能工时分配（**纯读，不写库**）：
 * - 无时长的记录 + 之前自动分配的 → 从 8h 预算按份均分（手动填的不动）
 * - 当天已有 ≥8h 明确工时 → 返回加班默认（2h），不压缩已有
 *
 * 用法（保证原子性，避免"压缩了已有却没建成新记录"）：
 *   const plan = await autoDuration(day);
 *   await createRecord({ ...base, durationMin: plan.share, meta:{autoDuration:true} }); // 先建
 *   await commitAutoDuration(plan); // 建成功后再压缩已有
 */
export async function autoDuration(day: string): Promise<AutoDurationPlan> {
  const existing = await db.listRecordsByDay(day);
  const fixed = existing.filter((r) => !isRedistributable(r));
  const redistributable = existing.filter(isRedistributable);

  const fixedSum = fixed.reduce((s, r) => s + (r.durationMin ?? 0), 0);
  const remaining = DAY_TOTAL_MIN - fixedSum;

  if (remaining <= 0) {
    // 加班场景：8h 已被明确工时占满，新条目给默认加班时长，不动已有
    return { share: OVERTIME_DEFAULT_MIN, updates: [] };
  }

  const slots = redistributable.length + 1; // 可重分配 + 新增这条
  const share = Math.max(MIN_PER_ENTRY, Math.round(remaining / slots));

  return {
    share,
    updates: redistributable.map((r) => ({ id: r.id, input: toInput(r, share) })),
  };
}

/** 把规划中的"压缩已有记录"写入库。应在新建记录成功后调用。 */
export async function commitAutoDuration(plan: AutoDurationPlan): Promise<void> {
  for (const u of plan.updates) {
    await db.updateRecord(u.id, u.input);
  }
}
