import { useEffect, useMemo, useState } from 'react';
import { Button, IconButton } from '../../ui';
import { ArrowLeft, ArrowRight, Copy } from 'lucide-react';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useRecordsStore } from '../../stores/useRecordsStore';
import { useTasksStore } from '../../stores/useTasksStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { MonthCalendar } from '../components/MonthCalendar';
import { TimelineEntry, recordToInput, truncateEntry, type EntryPatch } from '../components/TimelineEntry';
import { RecordEditor } from '../components/RecordEditor';
import { toast } from '../components/UndoToast';
import type { Half, WorkRecord } from '../../types/models';
import type { RecordInput } from '../../services/db';
import { currentYM, formatYMDChinese, monthRange, todayYMD } from '../../utils/date';
import { formatHours } from '../../utils/halfDay';
import { formatDailyLog } from '../../utils/dailyLog';
import { copyText } from '../../services/clipboard';

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 月历页（/history）：月历 + 日详情；年历 = 纯导航 12 宫格（报告区已拆去 /reports） */
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

  useEffect(() => {
    if (viewMode === 'year') void setRange(`${year}-01-01`, `${year}-12-31`);
    else {
      const { from, to } = monthRange(ym);
      void setRange(from, to);
    }
  }, [viewMode, ym, year, setRange]);

  const dayRecords = useMemo(() => records.filter((r) => r.day === selectedDay), [records, selectedDay]);

  const yearStats = useMemo(() => {
    if (viewMode !== 'year') return null;
    return Array.from({ length: 12 }, (_, i) => {
      const prefix = `${year}-${String(i + 1).padStart(2, '0')}`;
      const recs = records.filter((r) => r.day.startsWith(prefix));
      const totalMin = recs.reduce((s, r) => s + (r.durationMin ?? 0), 0);
      const days = new Set(recs.map((r) => r.day)).size;
      return { month: i + 1, ym: prefix, totalMin, count: recs.length, days };
    });
  }, [records, year, viewMode]);

  function flash(m: string) {
    setNotice(m);
    setTimeout(() => setNotice(''), 1800);
  }
  async function onCopyMonth() {
    const t = formatDailyLog({ records, tasks, projects });
    await copyText(t || '（无记录）');
    flash('已复制');
  }
  async function onSubmit(input: RecordInput, existing?: WorkRecord) {
    if (existing) await update(existing.id, input);
    else await create(input);
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
  /** 转为待办：条目内容生成 active 待办进待办浮窗（todo⇄record 双向之一） */
  async function onToTodo(r: WorkRecord) {
    await createTask({
      title: truncateEntry(r.content, 60),
      projectId: r.projectId,
      status: 'active',
      startDate: r.day,
      endDate: null,
      note: '',
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
            <MonthCalendar ym={ym} records={records} projects={projects} selectedDay={selectedDay}
              onSelectDay={setSelectedDay} dailyCapHours={dailyCapHours} />
          </div>
          <div className="cal-detail-pane">
            <h3 className="cal-detail-title">{formatYMDChinese(selectedDay)}</h3>
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
                <div className="year-cell-hours">{formatHours(s.totalMin) || '—'}</div>
                <div className="muted" style={{ fontSize: 10 }}>{s.count > 0 ? `${s.count}条` : ''}</div>
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
