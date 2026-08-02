// 本地日期处理（避免 UTC 偏移导致"跨天"误判）

export function formatYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayYMD(): string {
  return formatYMD(new Date());
}

export function currentYM(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function parseYMD(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

export function weekdayCN(d: Date): string {
  return WEEK_CN[d.getDay()];
}

/** "7月31日（周四）" */
export function formatYMDChinese(s: string): string {
  const d = parseYMD(s);
  return `${d.getMonth() + 1}月${d.getDate()}日（${weekdayCN(d)}）`;
}

/** 月份网格（周日为首列），返回若干周的 Date[]，覆盖整月 */
export function monthMatrix(year: number, month0: number): Date[][] {
  const first = new Date(year, month0, 1);
  const start = new Date(first);
  start.setDate(start.getDate() - first.getDay());
  const last = new Date(year, month0 + 1, 0);
  const weeks: Date[][] = [];
  const cur = new Date(start);
  do {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(new Date(cur));
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  } while (weeks[weeks.length - 1][6] < last && weeks.length < 6);
  return weeks;
}

export function addDays(s: string, delta: number): string {
  const d = parseYMD(s);
  d.setDate(d.getDate() + delta);
  return formatYMD(d);
}

export function monthRange(ym: string): { from: string; to: string } {
  const [y, m] = ym.split('-').map(Number);
  const from = `${ym}-01`;
  const to = formatYMD(new Date(y, m, 0));
  return { from, to };
}

/** 最近 7 天（含今天）起始日 */
export function startOf7Days(): string {
  return addDays(todayYMD(), -6);
}

/** 相对时间："刚刚" / "x 分钟前" / "x 小时前" / "x 天前" */
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}
