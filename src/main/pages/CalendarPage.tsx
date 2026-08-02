import { useEffect, useMemo, useState } from 'react';
import { Button } from '@fluentui/react-components';
import { ArrowLeftRegular, ArrowRightRegular, CopyRegular } from '@fluentui/react-icons';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useRecordsStore } from '../../stores/useRecordsStore';
import { useTasksStore } from '../../stores/useTasksStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { MonthCalendar } from '../components/MonthCalendar';
import { TimelineEntry } from '../components/TimelineEntry';
import { RecordEditor } from '../components/RecordEditor';
import { ReportSection } from '../components/ReportSection';
import type { Half, ReportTemplate, WorkRecord } from '../../types/models';
import type { RecordInput } from '../../services/db';
import * as db from '../../services/db';
import { currentYM, formatYMDChinese, monthRange, todayYMD } from '../../utils/date';
import { formatHours } from '../../utils/halfDay';
import { formatZhuchiyu } from '../../utils/zhuchiyu';
import { copyText } from '../../services/clipboard';

const quarterMonths: Record<number, [number, number]> = { 1: [1, 3], 2: [4, 6], 3: [7, 9], 4: [10, 12] };

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function CalendarPage() {
  const [viewMode, setViewMode] = useState<'month' | 'year'>('month');
  const [ym, setYm] = useState(currentYM());
  const [year, setYear] = useState(currentYM().slice(0, 4));
  const [selectedDay, setSelectedDay] = useState(todayYMD());
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<{ open: boolean; half: Half; record?: WorkRecord | null }>({ open: false, half: 'morning' });

  const records = useRecordsStore((s) => s.records);
  const setRange = useRecordsStore((s) => s.setRange);
  const create = useRecordsStore((s) => s.create);
  const update = useRecordsStore((s) => s.update);
  const remove = useRecordsStore((s) => s.remove);
  const projects = useProjectsStore((s) => s.projects);
  const tasks = useTasksStore((s) => s.tasks);
  const settings = useSettingsStore((s) => s.settings);

  const [templates, setTemplates] = useState<ReportTemplate[]>([]);

  useEffect(() => {
    if (viewMode === 'year') void setRange(`${year}-01-01`, `${year}-12-31`);
    else { const { from, to } = monthRange(ym); void setRange(from, to); }
  }, [viewMode, ym, year, setRange]);

  useEffect(() => { void (async () => setTemplates(await db.listTemplates()))(); }, []);

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

  function flash(m: string) { setNotice(m); setTimeout(() => setNotice(''), 1800); }
  async function onCopyMonth() {
    const t = formatZhuchiyu({ records, tasks, projects });
    await copyText(t || '（无记录）'); flash('已复制');
  }
  async function onSubmit(input: RecordInput, existing?: WorkRecord) {
    if (existing) await update(existing.id, input); else await create(input);
  }

  const selectedQuarter = selectedMonth ? Math.ceil(Number(selectedMonth.slice(5, 7)) / 3) : Math.ceil(Number(ym.slice(5, 7)) / 3);

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
              <Button icon={<ArrowLeftRegular />} onClick={() => setYm((v) => shiftMonth(v, -1))} />
              <Button onClick={() => { setYm(currentYM()); setSelectedDay(todayYMD()); }}>本月</Button>
              <Button icon={<ArrowRightRegular />} onClick={() => setYm((v) => shiftMonth(v, 1))} />
              <Button icon={<CopyRegular />} onClick={() => void onCopyMonth()}>复制</Button>
            </>
          ) : (
            <>
              <Button icon={<ArrowLeftRegular />} onClick={() => setYear((y) => String(Number(y) - 1))} />
              <Button onClick={() => setYear(currentYM().slice(0, 4))}>今年</Button>
              <Button icon={<ArrowRightRegular />} onClick={() => setYear((y) => String(Number(y) + 1))} />
            </>
          )}
        </div>
      </div>
      {notice && <div className="notice">{notice}</div>}

      {/* ===== 上层：网格 + 详情 ===== */}
      <div className="cal-top-row">
        {viewMode === 'month' ? (
          <>
            <div className="cal-grid-pane" style={{ padding: 4 }}>
              <MonthCalendar ym={ym} records={records} projects={projects} selectedDay={selectedDay} onSelectDay={setSelectedDay} />
            </div>
            <div className="cal-detail-pane">
              <h3 className="cal-detail-title">{formatYMDChinese(selectedDay)}</h3>
              {dayRecords.length === 0 ? (
                <div className="empty" style={{ padding: 16, fontSize: 13 }}>当天无记录</div>
              ) : (
                <div className="tl" style={{ maxHeight: 300, overflow: 'auto' }}>
                  {[...dayRecords].sort((a, b) => b.createdAt - a.createdAt).map((r) => (
                    <TimelineEntry key={r.id} record={r} project={r.projectId ? projects.find((p) => p.id === r.projectId) : undefined}
                      onEdit={(rec) => setEditor({ open: true, half: rec.half, record: rec })} onDelete={(id) => void remove(id)} />
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="cal-grid-pane">
              <div className="year-grid year-grid-compact">
                {yearStats?.map((s) => (
                  <div key={s.month} className={`year-cell year-cell-sm${selectedMonth === s.ym ? ' selected' : ''}`}
                    onClick={() => setSelectedMonth(s.ym)}>
                    <div className="year-cell-month">{s.month}月</div>
                    <div className="year-cell-hours">{formatHours(s.totalMin) || '—'}</div>
                    <div className="muted" style={{ fontSize: 10 }}>{s.count > 0 ? `${s.count}条` : ''}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="cal-detail-pane">
              {selectedMonth ? (
                <>
                  <h3 className="cal-detail-title">{selectedMonth} 月报</h3>
                  <ReportSection period={selectedMonth} title="月报" reportType="month" llmConfig={settings.llm} templates={templates}
                    year={year} ym={selectedMonth} quarterMonths={quarterMonths}
                    records={records.filter((r) => r.day.startsWith(selectedMonth))} projects={projects} />
                </>
              ) : (
                <div className="empty" style={{ padding: 32, textAlign: 'center' }}>← 点击左侧月份</div>
              )}
            </div>
          </>
        )}
      </div>

      {/* ===== 下层：报告区（全宽） ===== */}
      <div className="cal-bottom-row">
        {viewMode === 'month' ? (
          <div style={{ padding: '4px 0' }}>
            <ReportSection period={ym} title="月报" reportType="month" llmConfig={settings.llm} templates={templates}
              year={year} ym={ym} quarterMonths={quarterMonths} records={records} projects={projects} />
          </div>
        ) : (
          <>
            <div style={{ padding: '4px 0 12px' }}>
              <ReportSection period={`${year}Q${selectedQuarter}`} title={`Q${selectedQuarter} 季报`} reportType="quarter"
                llmConfig={settings.llm} templates={templates} year={year} ym={ym} quarterMonths={quarterMonths}
                records={[]} projects={projects} />
            </div>
            <div style={{ padding: '4px 0' }}>
              <ReportSection period={`${year}年报`} title="年报" reportType="year" llmConfig={settings.llm} templates={templates}
                year={year} ym={ym} quarterMonths={quarterMonths} records={[]} projects={projects} />
            </div>
          </>
        )}
      </div>

      <RecordEditor open={editor.open} onClose={() => setEditor((e) => ({ ...e, open: false }))}
        day={selectedDay} half={editor.half} record={editor.record} projects={projects} tasks={tasks} onSubmit={onSubmit} />
    </div>
  );
}
