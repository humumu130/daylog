import type { Project, WorkRecord } from '../../types/models';
import { formatYMD, monthMatrix, todayYMD } from '../../utils/date';
import { formatHours } from '../../utils/halfDay';
import { groupBy } from '../../utils/groupBy';

interface Props {
  ym: string;
  records: WorkRecord[];
  projects: Project[];
  selectedDay: string;
  onSelectDay: (day: string) => void;
  /** 单日工时上限（热度分档基准），默认 8 */
  dailyCapHours?: number;
  /** 已上报日期（P8 接猪齿鱼工时日历后传真数据；空 Set = 不显示 ✓ 角标，绝不冒充） */
  reportedDays?: Set<string>;
  /** 平台手报日期（P8；空 = 不显示「手」角标） */
  manualDays?: Set<string>;
}

interface DayStat {
  count: number;
  totalMin: number;
  projectIds: string[];
}

const WEEK_HEAD = ['一', '二', '三', '四', '五', '六', '日'];

/** 热度分档：无 / 轻(<50%) / 中(50~100%) / 高(≥100%)——一眼看出负荷分布与空白天 */
function heatOf(totalMin: number, capMin: number): 'none' | 'low' | 'mid' | 'high' {
  if (totalMin <= 0) return 'none';
  if (totalMin < capMin * 0.5) return 'low';
  if (totalMin < capMin) return 'mid';
  return 'high';
}

export function MonthCalendar({
  ym,
  records,
  projects,
  selectedDay,
  onSelectDay,
  dailyCapHours = 8,
  reportedDays,
  manualDays,
}: Props) {
  const [year, month0] = ym.split('-').map(Number);
  // 周一为首列（工作日志语境下周末靠边更顺读）
  const weeks = monthMatrix(year, month0 - 1).map((w) => [...w.slice(1), w[0]]);
  const today = todayYMD();
  const byDay = groupBy(records, (r) => r.day);
  const projColor = (id: string) => projects.find((p) => p.id === id)?.color ?? '#94a3b8';
  const capMin = Math.max(1, dailyCapHours) * 60;

  const statOf = (day: string): DayStat => {
    const list = byDay[day] ?? [];
    const totalMin = list.reduce((s, r) => s + (r.durationMin ?? 0), 0);
    const pidSet = new Set<string>();
    for (const r of list) if (r.projectId) pidSet.add(r.projectId);
    return { count: list.length, totalMin, projectIds: [...pidSet] };
  };

  return (
    <div className="cal">
      <div className="cal-weekhead">
        {WEEK_HEAD.map((w) => (
          <div key={w} className="cal-weekcell">{w}</div>
        ))}
        <div className="cal-weekcell cal-weeksum-head" title="本周合计工时">周</div>
      </div>
      {weeks.map((week, wi) => {
        const weekMin = week.reduce((s, d) => s + statOf(formatYMD(d)).totalMin, 0);
        return (
          <div key={wi} className="cal-week">
            {week.map((d) => {
              const day = formatYMD(d);
              const inMonth = d.getMonth() === month0 - 1;
              const stat = statOf(day);
              const isToday = day === today;
              const selected = day === selectedDay;
              const reported = reportedDays?.has(day) ?? false;
              const manual = manualDays?.has(day) ?? false;
              return (
                <div
                  key={day}
                  className={`cal-day${inMonth ? '' : ' out'}${selected ? ' selected' : ''}`}
                  data-heat={inMonth ? heatOf(stat.totalMin, capMin) : undefined}
                  onClick={() => onSelectDay(day)}
                >
                  <div className="cal-day-top">
                    <div className={`cal-daynum${isToday ? ' today' : ''}`}>{d.getDate()}</div>
                    {reported && <span className="cal-flag" title="已上报">✓</span>}
                    {!reported && manual && <span className="cal-flag manual" title="平台手报">手</span>}
                  </div>
                  {stat.count > 0 && (
                    <div className="cal-dayinfo">
                      <span className="cal-hours">{formatHours(stat.totalMin)}</span>
                      <div className="cal-pdots">
                        {stat.projectIds.slice(0, 3).map((pid) => (
                          <span key={pid} className="cal-pdot" style={{ background: projColor(pid) }} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            <div className="cal-weeksum" title="本周合计工时">
              {weekMin > 0 ? formatHours(weekMin) : '·'}
            </div>
          </div>
        );
      })}
    </div>
  );
}
