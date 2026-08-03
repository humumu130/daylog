import { addDays, formatYMD, parseYMD } from '../utils/date';

/** 区间内日期（YYYY-MM-DD），可选跳过周六日 */
export function daysBetween(start: string, end: string, skipWeekend: boolean): string[] {
  const out: string[] = [];
  const s = parseYMD(start);
  const e = parseYMD(end);
  if (!s || !e || e < s) return out;
  const d = new Date(s);
  while (d <= e) {
    const dow = d.getDay();
    if (!skipWeekend || (dow !== 0 && dow !== 6)) out.push(formatYMD(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

export interface AllocInput {
  /** 选中的条目（key 用于回传；weight 可选，默认 1，留作以后按权重分） */
  items: { key: string; weight?: number }[];
  start: string;
  end: string;
  totalHours: number;
  dailyCap: number;
  skipWeekend: boolean;
  /** 区间内每天已有工时（小时），用于扣减容量 */
  existing: Record<string, number>;
}

export interface AllocAssignment {
  key: string;
  hours: number;
}
export interface AllocDay {
  day: string;
  items: AllocAssignment[];
  hours: number; // 当天分配到的总小时
  existing: number; // 当天已有小时
  cap: number; // 单日上限
  overflow: boolean; // 分配后 + 已有 超过上限
}
export interface AllocResult {
  days: AllocDay[];
  overflow: boolean; // 是否有任一天溢出（或总量超容量）
  totalCapacity: number; // 区间可用总容量（扣已有）
  totalAssigned: number; // 实际分配总小时
  itemCount: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 把 totalHours 智能分配到区间内的各天：
 * - 每天可用容量 = max(0, dailyCap - 已有)；已填满的天容量 0、不再塞。
 * - 按容量比例把条目和工时分摊到各天。
 * - 总量超容量（溢出）时仍按比例分，但单天会 overflow=true（加班），供 UI 标红。
 * - 全部天都满（总容量 0）时退化为均分到每天（全部 overflow）。
 */
export function allocate(input: AllocInput): AllocResult {
  const days = daysBetween(input.start, input.end, input.skipWeekend);
  const items = input.items;
  const N = items.length;
  const assigned: AllocAssignment[][] = days.map(() => []);

  const existingOf = (d: string) => input.existing[d] ?? 0;
  const caps = days.map((d) => Math.max(0, input.dailyCap - existingOf(d)));
  const totalCap = caps.reduce((a, b) => a + b, 0);

  if (N > 0 && days.length > 0) {
    if (totalCap > 0) {
      // 按容量比例算每天分到的条目数（largest-remainder 法保证总数=N）
      const raw = caps.map((c) => (c / totalCap) * N);
      const counts = raw.map((r) => Math.floor(r));
      let leftover = N - counts.reduce((a, b) => a + b, 0);
      const byFrac = raw
        .map((r, i) => ({ i, f: r - Math.floor(r) }))
        .sort((a, b) => b.f - a.f);
      for (let k = 0; k < leftover; k++) counts[byFrac[k % byFrac.length].i]++;
      // 顺序填充条目，工时 = 当天目标 / 当天条目数
      let idx = 0;
      for (let i = 0; i < days.length; i++) {
        const target = (input.totalHours * caps[i]) / totalCap;
        const cnt = counts[i];
        for (let k = 0; k < cnt && idx < N; k++) {
          const hours = cnt > 0 ? target / cnt : 0;
          assigned[i].push({ key: items[idx].key, hours: round2(hours) });
          idx++;
        }
      }
      // 容差：因取整没排完的尾巴，塞到最后一个有容量的天
      while (idx < N) {
        const i = days.length - 1;
        assigned[i].push({ key: items[idx].key, hours: 0 });
        idx++;
      }
    } else {
      // 所有天都满了：均分到每天，全部 overflow
      const per = input.totalHours / N;
      let idx = 0;
      for (let i = 0; i < days.length && idx < N; i++) {
        const cnt = Math.ceil(N / days.length);
        for (let k = 0; k < cnt && idx < N; k++) {
          assigned[i].push({ key: items[idx].key, hours: round2(per) });
          idx++;
        }
      }
    }
  }

  const resultDays: AllocDay[] = days.map((d, i) => {
    const hours = assigned[i].reduce((s, a) => s + a.hours, 0);
    const existing = existingOf(d);
    return {
      day: d,
      items: assigned[i],
      hours: round2(hours),
      existing: round2(existing),
      cap: input.dailyCap,
      overflow: hours + existing > input.dailyCap + 0.01,
    };
  });
  const totalAssigned = resultDays.reduce((s, r) => s + r.hours, 0);

  return {
    days: resultDays,
    overflow: totalAssigned > totalCap + 0.01 || resultDays.some((r) => r.overflow),
    totalCapacity: round2(totalCap),
    totalAssigned: round2(totalAssigned),
    itemCount: N,
  };
}

/**
 * 从 endDay 起向前倒着分配 totalHours：每天先填满（单日上限 - 已有工时），
 * 溢出的转到前一天，适合"今天完成一项 16h 的工作 → 记到昨天+今天"。
 * 所有天都满时，剩余压到最早那天（加班）。
 */
export function splitHoursBackward(
  totalHours: number,
  dailyCap: number,
  existing: Record<string, number>,
  endDay: string,
): { day: string; hours: number }[] {
  const out: { day: string; hours: number }[] = [];
  let remaining = totalHours;
  let day = endDay;
  let guard = 0;
  while (remaining > 0.01 && guard < 40) {
    const cap = Math.max(0, dailyCap - (existing[day] ?? 0));
    const take = Math.min(remaining, cap);
    if (take > 0.01) out.push({ day, hours: round2(take) });
    remaining -= take;
    day = addDays(day, -1);
    guard++;
  }
  if (remaining > 0.01) out.push({ day, hours: round2(remaining) });
  return out;
}
