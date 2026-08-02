import type { Half, HalfBoundaries } from '../types/models';

export const DEFAULT_BOUNDARIES: HalfBoundaries = { morningEnd: 12, afternoonEnd: 18 };

export const HALF_LABEL_CN: Record<Half, string> = {
  allday: '全天',
  morning: '上午',
  afternoon: '下午',
  evening: '晚间',
};
export const HALF_ORDER: Record<Half, number> = { allday: 0, morning: 1, afternoon: 2, evening: 3 };
export const HALF_VALUES: Half[] = ['allday', 'morning', 'afternoon', 'evening'];

export function halfOfHour(hour: number, b: HalfBoundaries = DEFAULT_BOUNDARIES): Half {
  if (hour < b.morningEnd) return 'morning';
  if (hour < b.afternoonEnd) return 'afternoon';
  return 'evening';
}

export function halfOf(d: Date, b: HalfBoundaries = DEFAULT_BOUNDARIES): Half {
  return halfOfHour(d.getHours(), b);
}

export function formatHours(min: number | null | undefined): string {
  if (min == null) return '';
  const h = min / 60;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

/** "6h 45m" 形式 */
export function formatHM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
