import * as db from './db';
import type { RecordInput } from './db';
import type { WorkRecord } from '../types/models';

/** 0.5h 最小粒度（分钟）——全链路唯一定义点（stepper 步进/量化/快捷档都引用这里） */
export const HALF_HOUR_MIN = 30;
/** 每条记录最低时长（= 0.5h） */
export const MIN_ENTRY_MIN = HALF_HOUR_MIN;
/** 当天已满 cap 时，新条目的默认加班时长 */
export const OVERTIME_DEFAULT_MIN = 2 * 60;

/**
 * 量化到 0.5h 粒度：四舍五入到 30 分钟倍数，最低 0.5h。
 * 全链路（行内 stepper / 编辑器保存 / 引擎输出 / 导入解析）统一走这里，禁止各处 Math.round。
 */
export function quantizeMinutes(min: number): number {
  if (!Number.isFinite(min) || min <= 0) return HALF_HOUR_MIN;
  return Math.max(HALF_HOUR_MIN, Math.round(min / HALF_HOUR_MIN) * HALF_HOUR_MIN);
}

/** 小时数 → 量化后的分钟（编辑器/输入框键入小时用）；null/NaN 返回 null（无时长合法） */
export function hoursToQuantizedMinutes(hours: number | null | undefined): number | null {
  if (hours == null || Number.isNaN(hours)) return null;
  return quantizeMinutes(hours * 60);
}

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
 * - 无时长的记录 + 之前自动分配的 → 从当日预算（dailyCapHours，调用方从设置传入）按份均分（手动填的不动）
 * - 当天已有 ≥ 预算的明确工时 → 返回加班默认（2h），不压缩已有
 * - 均分结果量化到 0.5h 粒度（Σ 可能略超预算，量化优先——半点完整性 > 总量微差）
 *
 * 用法（保证原子性，避免"压缩了已有却没建成新记录"）：
 *   const plan = await autoDuration(day, settings.dailyCapHours);
 *   await createRecord({ ...base, durationMin: plan.share, meta:{autoDuration:true} }); // 先建
 *   await commitAutoDuration(plan); // 建成功后再压缩已有
 */
export async function autoDuration(day: string, dailyCapHours: number): Promise<AutoDurationPlan> {
  const dayTotalMin = dailyCapHours * 60;
  const existing = await db.listRecordsByDay(day);
  const fixed = existing.filter((r) => !isRedistributable(r));
  const redistributable = existing.filter(isRedistributable);

  const fixedSum = fixed.reduce((s, r) => s + (r.durationMin ?? 0), 0);
  const remaining = dayTotalMin - fixedSum;

  if (remaining <= 0) {
    // 加班场景：预算已被明确工时占满，新条目给默认加班时长，不动已有
    return { share: OVERTIME_DEFAULT_MIN, updates: [] };
  }

  const slots = redistributable.length + 1; // 可重分配 + 新增这条
  const share = quantizeMinutes(remaining / slots);

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
