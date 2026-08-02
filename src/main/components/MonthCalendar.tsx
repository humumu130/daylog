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
}

interface DayStat {
  count: number;
  totalMin: number;
  projectIds: string[];
}

const WEEK_HEAD = ['日', '一', '二', '三', '四', '五', '六'];

export function MonthCalendar({ ym, records, projects, selectedDay, onSelectDay }: Props) {
  const [year, month0] = ym.split('-').map(Number);
  const weeks = monthMatrix(year, month0 - 1);
  const today = todayYMD();
  const byDay = groupBy(records, (r) => r.day);
  const projColor = (id: string) => projects.find((p) => p.id === id)?.color ?? '#94a3b8';

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
      </div>
      {weeks.map((week, wi) => (
        <div key={wi} className="cal-week">
          {week.map((d) => {
            const day = formatYMD(d);
            const inMonth = d.getMonth() === month0 - 1;
            const stat = statOf(day);
            const isToday = day === today;
            const selected = day === selectedDay;
            return (
              <div
                key={day}
                className={`cal-day${inMonth ? '' : ' out'}${selected ? ' selected' : ''}`}
                onClick={() => onSelectDay(day)}
              >
                <div className={`cal-daynum${isToday ? ' today' : ''}`}>{d.getDate()}</div>
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
        </div>
      ))}
    </div>
  );
}
