import { useEffect, useMemo, useState } from 'react';
import { Button, IconButton } from '../../ui';
import { ArrowLeft, ArrowRight, Copy } from 'lucide-react';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useRecordsStore } from '../../stores/useRecordsStore';
import { useTasksStore } from '../../stores/useTasksStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { MonthCalendar } from '../components/MonthCalendar';
import { TimelineEntry, recordToInput, truncateEntry, type EntryPatch } from '../components/TimelineEntry';
import { RecordEditor } from '../components/RecordEditor';
import { toast } from '../components/UndoToast';
import type { Half, Project, RecordType, WorkRecord } from '../../types/models';
import { RECORD_TYPE_LABELS } from '../../types/models';
import type { RecordInput } from '../../services/db';
import { currentYM, formatYMD, formatYMDChinese, monthMatrix, monthRange, todayYMD } from '../../utils/date';
import { formatHours } from '../../utils/halfDay';
import { groupBy } from '../../utils/groupBy';
import { formatDailyLog } from '../../utils/dailyLog';
import { copyText } from '../../services/clipboard';

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const WEEK_HEAD = ['一', '二', '三', '四', '五', '六', '日'];

/** 热度按条数分档（P8b 个人空间）：无 / 1 条 / 2-3 条 / 4+ 条——沿用 data-heat css 档位 */
function heatOfCount(n: number): 'none' | 'low' | 'mid' | 'high' {
  if (n <= 0) return 'none';
  if (n === 1) return 'low';
  if (n <= 3) return 'mid';
  return 'high';
}

/**
 * 个人空间月历（P8b）：复用 cal-* 样式与 MonthCalendar 布局（周一首列 + 周合计列），
 * 但格内/周合计显条数、热度按条数分档、无上报角标。MonthCalendar 组件属 work 路径不动，故此处内联实现。
 */
function PersonalMonthCalendar({
  ym,
  records,
  projects,
  selectedDay,
  onSelectDay,
}: {
  ym: string;
  records: WorkRecord[];
  projects: Project[];
  selectedDay: string;
  onSelectDay: (day: string) => void;
}) {
  const [year, month0] = ym.split('-').map(Number);
  const weeks = monthMatrix(year, month0 - 1).map((w) => [...w.slice(1), w[0]]);
  const today = todayYMD();
  const byDay = groupBy(records, (r) => r.day);
  const projColor = (id: string) => projects.find((p) => p.id === id)?.color ?? '#94a3b8';

  const statOf = (day: string) => {
    const list = byDay[day] ?? [];
    const pidSet = new Set<string>();
    for (const r of list) if (r.projectId) pidSet.add(r.projectId);
    return { count: list.length, projectIds: [...pidSet] };
  };

  return (
    <div className="cal">
      <div className="cal-weekhead">
        {WEEK_HEAD.map((w) => (
          <div key={w} className="cal-weekcell">{w}</div>
        ))}
        <div className="cal-weekcell cal-weeksum-head" title="本周合计条数">周</div>
      </div>
      {weeks.map((week, wi) => {
        const weekCount = week.reduce((s, d) => s + statOf(formatYMD(d)).count, 0);
        return (
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
                  data-heat={inMonth ? heatOfCount(stat.count) : undefined}
                  onClick={() => onSelectDay(day)}
                >
                  <div className="cal-day-top">
                    <div className={`cal-daynum${isToday ? ' today' : ''}`}>{d.getDate()}</div>
                  </div>
                  {stat.count > 0 && (
                    <div className="cal-dayinfo">
                      <span className="cal-hours">{stat.count} 条</span>
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
            <div className="cal-weeksum" title="本周合计条数">
              {weekCount > 0 ? `${weekCount} 条` : '·'}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 月历页（/history）：月历 + 日详情；年历 = 纯导航 12 宫格（报告区已拆去 /reports）。
 *  P8b：personal 空间中性版——热度/周合计按条数、无上报角标、日详情显条数与类型分布；work 路径原样。 */
export function HistoryPage() {
  const [viewMode, setViewMode] = useState<'month' | 'year'>('month');
  const [ym, setYm] = useState(currentYM());
  const [year, setYear] = useState(currentYM().slice(0, 4));
  const [selectedDay, setSelectedDay] = useState(todayYMD());
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<{ open: boolean; half: Half; record?: WorkRecord | null }>({ open: false, half: 'morning' });

  const records = useRecordsStore((s) => s.records);
  const setRange = useRecordsStore((s) => s.setRange);
  const create = useRecordsStore((s) => s.create);
  const update = useRecordsStore((s) => s.update);
  const remove = useRecordsStore((s) => s.remove);
  const projects = useProjectsStore((s) => s.projects);
  const tasks = useTasksStore((s) => s.tasks);
  const createTask = useTasksStore((s) => s.create);
  const dailyCapHours = useSettingsStore((s) => s.settings.dailyCapHours);
  // P8b 空间分流
  const wsKind = useWorkspaceStore((s) => s.currentKind());
  const wsId = useWorkspaceStore((s) => s.currentId);
  const isPersonal = wsKind === 'personal';

  useEffect(() => {
    if (viewMode === 'year') void setRange(`${year}-01-01`, `${year}-12-31`);
    else {
      const { from, to } = monthRange(ym);
      void setRange(from, to);
    }
  }, [viewMode, ym, year, setRange]);

  // 空间隔离：只看当前空间记录
  const wsRecords = useMemo(() => records.filter((r) => r.workspaceId === wsId), [records, wsId]);
  const dayRecords = useMemo(() => wsRecords.filter((r) => r.day === selectedDay), [wsRecords, selectedDay]);

  // personal 日详情：类型分布（每类型一行「学到什么 3 条」）
  const typeDist = useMemo(() => {
    const dist = new Map<RecordType, number>();
    for (const r of dayRecords) dist.set(r.recordType, (dist.get(r.recordType) ?? 0) + 1);
    return [...dist.entries()].sort((a, b) => b[1] - a[1]);
  }, [dayRecords]);

  const yearStats = useMemo(() => {
    if (viewMode !== 'year') return null;
    return Array.from({ length: 12 }, (_, i) => {
      const prefix = `${year}-${String(i + 1).padStart(2, '0')}`;
      const recs = wsRecords.filter((r) => r.day.startsWith(prefix));
      const totalMin = recs.reduce((s, r) => s + (r.durationMin ?? 0), 0);
      const days = new Set(recs.map((r) => r.day)).size;
      return { month: i + 1, ym: prefix, totalMin, count: recs.length, days };
    });
  }, [wsRecords, year, viewMode]);

  function flash(m: string) {
    setNotice(m);
    setTimeout(() => setNotice(''), 1800);
  }
  async function onCopyMonth() {
    const t = formatDailyLog({ records: wsRecords, tasks, projects });
    await copyText(t || '（无记录）');
    flash('已复制');
  }
  async function onSubmit(input: RecordInput, existing?: WorkRecord) {
    if (existing) {
      // P8b：编辑器不感知空间字段，合并保留（work 记录字段值为默认，无行为差异）
      await update(existing.id, {
        ...input,
        workspaceId: existing.workspaceId,
        recordType: existing.recordType,
        learnings: existing.learnings,
        tags: existing.tags,
      });
    } else {
      await create(isPersonal ? { ...input, workspaceId: wsId, recordType: input.recordType ?? 'thought' } : input);
    }
  }
  function onEntryUpdate(id: string, patch: EntryPatch) {
    const rec = records.find((r) => r.id === id);
    if (!rec) return;
    void update(id, { ...recordToInput(rec), ...patch });
  }
  function onEntryDelete(r: WorkRecord) {
    void remove(r.id).then(() => {
      toast(`已删除「${truncateEntry(r.content, 18)}」`, {
        actionLabel: '撤销',
        onAction: () => void create(recordToInput(r)),
      });
    });
  }
  /** 转为待办：条目内容生成 active 待办进待办浮窗（todo⇄record 双向之一）；两空间共用 */
  async function onToTodo(r: WorkRecord) {
    await createTask({
      title: truncateEntry(r.content, 60),
      projectId: r.projectId,
      status: 'active',
      startDate: r.day,
      endDate: null,
      note: '',
      workspaceId: wsId,
    });
    toast(`已转为待办「${truncateEntry(r.content, 18)}」`);
  }
  /** 年历 12 宫格点击 → 跳该月月历 */
  function gotoMonth(m: string) {
    setYm(m);
    setYear(m.slice(0, 4));
    setSelectedDay(`${m}-01`);
    setViewMode('month');
  }

  return (
    <div>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <div className="left">
          <h2 className="section-title">{viewMode === 'year' ? `${year} 年历` : `${ym} 月历`}</h2>
        </div>
        <div className="row gap-sm">
          <div className="seg">
            <button className={`seg-btn${viewMode === 'month' ? ' active' : ''}`} onClick={() => setViewMode('month')}>月历</button>
            <button className={`seg-btn${viewMode === 'year' ? ' active' : ''}`} onClick={() => setViewMode('year')}>年历</button>
          </div>
          {viewMode === 'month' ? (
            <>
              <IconButton title="上一月" onClick={() => setYm((v) => shiftMonth(v, -1))}><ArrowLeft size={16} /></IconButton>
              <Button onClick={() => { setYm(currentYM()); setSelectedDay(todayYMD()); }}>本月</Button>
              <IconButton title="下一月" onClick={() => setYm((v) => shiftMonth(v, 1))}><ArrowRight size={16} /></IconButton>
              <Button icon={<Copy size={14} />} onClick={() => void onCopyMonth()}>复制日报</Button>
            </>
          ) : (
            <>
              <IconButton title="上一年" onClick={() => setYear((y) => String(Number(y) - 1))}><ArrowLeft size={16} /></IconButton>
              <Button onClick={() => setYear(currentYM().slice(0, 4))}>今年</Button>
              <IconButton title="下一年" onClick={() => setYear((y) => String(Number(y) + 1))}><ArrowRight size={16} /></IconButton>
            </>
          )}
        </div>
      </div>
      {notice && <div className="notice">{notice}</div>}

      {viewMode === 'month' ? (
        <div className="cal-top-row">
          <div className="cal-grid-pane" style={{ padding: 4 }}>
            {isPersonal ? (
              <PersonalMonthCalendar ym={ym} records={wsRecords} projects={projects} selectedDay={selectedDay}
                onSelectDay={setSelectedDay} />
            ) : (
              <MonthCalendar ym={ym} records={wsRecords} projects={projects} selectedDay={selectedDay}
                onSelectDay={setSelectedDay} dailyCapHours={dailyCapHours} />
            )}
          </div>
          <div className="cal-detail-pane">
            <h3 className="cal-detail-title">{formatYMDChinese(selectedDay)}</h3>
            {isPersonal && dayRecords.length > 0 && (
              <div className="rt-day-summary">
                <span className="rt-day-summary-count">{dayRecords.length} 条记录</span>
                {typeDist.map(([t, n]) => (
                  <span key={t} className="rt-day-summary-type">{RECORD_TYPE_LABELS[t]} {n} 条</span>
                ))}
              </div>
            )}
            {dayRecords.length === 0 ? (
              <div className="empty" style={{ padding: 16, fontSize: 13 }}>当天无记录</div>
            ) : (
              <div className="tl" style={{ maxHeight: 360, overflow: 'auto' }}>
                {[...dayRecords].sort((a, b) => b.createdAt - a.createdAt).map((r) => (
                  <TimelineEntry key={r.id} record={r} projects={projects}
                    onUpdate={onEntryUpdate}
                    onEdit={(rec) => setEditor({ open: true, half: rec.half, record: rec })}
                    onDelete={onEntryDelete}
                    onToTodo={onToTodo} />
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="cal-grid-pane">
          <div className="year-grid year-grid-compact">
            {yearStats?.map((s) => (
              <div key={s.month} className="year-cell year-cell-sm" onClick={() => gotoMonth(s.ym)} title="点击查看该月">
                <div className="year-cell-month">{s.month}月</div>
                {isPersonal ? (
                  <>
                    <div className="year-cell-hours">{s.count > 0 ? `${s.count} 条` : '—'}</div>
                    <div className="muted" style={{ fontSize: 10 }}>{s.days > 0 ? `${s.days} 天` : ''}</div>
                  </>
                ) : (
                  <>
                    <div className="year-cell-hours">{formatHours(s.totalMin) || '—'}</div>
                    <div className="muted" style={{ fontSize: 10 }}>{s.count > 0 ? `${s.count}条` : ''}</div>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <RecordEditor open={editor.open} onClose={() => setEditor((e) => ({ ...e, open: false }))}
        day={selectedDay} half={editor.half} record={editor.record} projects={projects} tasks={tasks} onSubmit={onSubmit} />
    </div>
  );
}
