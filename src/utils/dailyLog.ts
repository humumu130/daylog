import type { Half, Project, Task, WorkRecord } from '../types/models';
import { formatYMDChinese } from './date';
import { HALF_LABEL_CN, HALF_ORDER, formatHours } from './halfDay';
import { groupBy } from './groupBy';

interface ExportContext {
  records: WorkRecord[];
  tasks: Task[];
  projects: Project[];
}

function formatRecordLine(r: WorkRecord, ctx: ExportContext): string {
  const parts: string[] = [r.content];
  const taskName = r.taskId ? ctx.tasks.find((t) => t.id === r.taskId)?.title ?? null : null;
  if (taskName) parts.push(`[${taskName}]`);
  const projectName = r.projectId ? ctx.projects.find((p) => p.id === r.projectId)?.name ?? null : null;
  if (projectName) parts.push(`#${projectName}`);
  const line = parts.join(' ');
  const dur = formatHours(r.durationMin);
  return dur ? `${line} ${dur}` : line;
}

/**
 * 日报导出格式：按"天 × 半天"聚合，每个半天汇总一条，便于粘贴到工作日志系统。
 * 示例：
 *   2026-07-31（周四）
 *     上午 3.5h：登录页修复[用户中心重构]；评审 PR 0.5h
 *     下午 4.0h：接口联调；排查告警
 */
export function formatDailyLog(ctx: ExportContext, dayFilter?: string): string {
  const records = dayFilter ? ctx.records.filter((r) => r.day === dayFilter) : ctx.records;
  if (records.length === 0) return '';

  const byDay = groupBy(records, (r) => r.day);
  const days = Object.keys(byDay).sort();

  const blocks: string[] = [];
  for (const day of days) {
    const dayRecords = byDay[day];
    const byHalf = groupBy(dayRecords, (r) => r.half);
    const lineParts: string[] = [formatYMDChinese(day)];
    const halves = (Object.keys(byHalf) as Half[]).sort((a, b) => HALF_ORDER[a] - HALF_ORDER[b]);
    for (const half of halves) {
      const items = byHalf[half];
      const total = items.reduce((sum, r) => sum + (r.durationMin ?? 0), 0);
      const totalLabel = total > 0 ? `${formatHours(total)}：` : '';
      const body = items.map((r) => formatRecordLine(r, ctx)).join('；');
      lineParts.push(`    ${HALF_LABEL_CN[half]} ${totalLabel}${body}`);
    }
    blocks.push(lineParts.join('\n'));
  }
  return blocks.join('\n\n');
}
