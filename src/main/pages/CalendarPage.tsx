import { useEffect, useMemo, useState } from 'react';
import { Button } from '@fluentui/react-components';
import { ArrowLeftRegular, ArrowRightRegular, CopyRegular } from '@fluentui/react-icons';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useRecordsStore } from '../../stores/useRecordsStore';
import { useTasksStore } from '../../stores/useTasksStore';
import { MonthCalendar } from '../components/MonthCalendar';
import { TimelineEntry } from '../components/TimelineEntry';
import { RecordEditor } from '../components/RecordEditor';
import type { Half, Report, WorkRecord } from '../../types/models';
import type { RecordInput } from '../../services/db';
import * as db from '../../services/db';
import { currentYM, formatYMDChinese, monthRange, todayYMD } from '../../utils/date';
import { formatHours } from '../../utils/halfDay';
import { formatZhuchiyu } from '../../utils/zhuchiyu';
import { copyText } from '../../services/clipboard';

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
  const [monthReports, setMonthReports] = useState<Report[]>([]);
  const [ymReports, setYmReports] = useState<Report[]>([]);
  const [expandedReport, setExpandedReport] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<{ open: boolean; half: Half; record?: WorkRecord | null }>({ open: false, half: 'morning' });

  const records = useRecordsStore((s) => s.records);
  const setRange = useRecordsStore((s) => s.setRange);
  const create = useRecordsStore((s) => s.create);
  const update = useRecordsStore((s) => s.update);
  const remove = useRecordsStore((s) => s.remove);
  const projects = useProjectsStore((s) => s.projects);
  const tasks = useTasksStore((s) => s.tasks);

  useEffect(() => {
    if (viewMode === 'year') void setRange(`${year}-01-01`, `${year}-12-31`);
    else { const { from, to } = monthRange(ym); void setRange(from, to); }
  }, [viewMode, ym, year, setRange]);

  useEffect(() => {
    if (selectedMonth) void (async () => setMonthReports(await db.listReports(selectedMonth)))();
  }, [selectedMonth]);

  useEffect(() => {
    void (async () => setYmReports(await db.listReports(ym)))();
  }, [ym]);

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
    await copyText(t || '（本月无记录）'); flash('已复制本月猪齿鱼格式');
  }
  async function onSubmit(input: RecordInput, existing?: WorkRecord) {
    if (existing) await update(existing.id, input); else await create(input);
  }
  function onMonthClick(ymStr: string) { setSelectedMonth(ymStr); }

  return (
    <div>
      <div className="page-head" style={{ marginBottom: 10 }}>
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
              <Button size="small" onClick={() => { setYm(currentYM()); setSelectedDay(todayYMD()); }}>本月</Button>
              <Button icon={<ArrowRightRegular />} onClick={() => setYm((v) => shiftMonth(v, 1))} />
              <Button size="small" icon={<CopyRegular />} onClick={() => void onCopyMonth()}>复制</Button>
            </>
          ) : (
            <>
              <Button icon={<ArrowLeftRegular />} onClick={() => setYear((y) => String(Number(y) - 1))} />
              <Button size="small" onClick={() => setYear(currentYM().slice(0, 4))}>今年</Button>
              <Button icon={<ArrowRightRegular />} onClick={() => setYear((y) => String(Number(y) + 1))} />
            </>
          )}
        </div>
      </div>
      {notice && <div className="notice">{notice}</div>}

      {/* 年历 */}
      {viewMode === 'year' && yearStats && (
        <div className="layout-cal">
          <div className="year-grid-wrap">
            <div className="year-grid">
              {yearStats.map((s) => (
                <div key={s.month} className={`year-cell${selectedMonth === s.ym ? ' selected' : ''}`} onClick={() => onMonthClick(s.ym)}>
                  <div className="year-cell-month">{s.month}月</div>
                  <div className="year-cell-hours">{formatHours(s.totalMin) || '—'}</div>
                  <div className="muted year-cell-meta">{s.count > 0 ? `${s.count} 条 · ${s.days} 天` : '无记录'}</div>
                  <div className="year-cell-bar"><div className="year-cell-bar-fill" style={{ width: `${Math.min(100, (s.days / 22) * 100)}%` }} /></div>
                </div>
              ))}
            </div>
          </div>
          <div className="year-month-panel">
            {selectedMonth ? (
              <>
                <h3 className="set-h">{selectedMonth} 月报</h3>
                {monthReports.length > 0 ? (
                  <div className="year-report-list">
                    {monthReports.map((r) => (
                      <div key={r.id} className="year-report-item">
                        <div className="row spread" style={{ marginBottom: 6 }}>
                          <span className="muted" style={{ fontSize: 11 }}>{new Date(r.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                          <button className="icon-btn" title="复制" onClick={() => void copyText(r.body)}><CopyRegular /></button>
                        </div>
                        <pre className="year-report-body">{r.body}</pre>
                      </div>
                    ))}
                  </div>
                ) : <div className="empty" style={{ padding: 24, textAlign: 'center' }}>该月无已保存月报</div>}
              </>
            ) : <div className="empty" style={{ padding: 48, textAlign: 'center' }}>← 点击左侧月份查看月报</div>}
          </div>
        </div>
      )}

      {/* 月历 */}
      {viewMode === 'month' && (
        <div className="layout-cal">
          <div className="cal-pane card" style={{ padding: 8 }}>
            <MonthCalendar ym={ym} records={records} projects={projects} selectedDay={selectedDay} onSelectDay={setSelectedDay} />
          </div>
          <div className="day-pane">
            <h3 className="day-pane-title">{formatYMDChinese(selectedDay)}</h3>
            {dayRecords.length === 0 ? (
              <div className="empty day-empty">当天无记录</div>
            ) : (
              <div className="tl">
                {[...dayRecords].sort((a, b) => b.createdAt - a.createdAt).map((r) => (
                  <TimelineEntry key={r.id} record={r} project={r.projectId ? projects.find((p) => p.id === r.projectId) : undefined}
                    onEdit={(rec) => setEditor({ open: true, half: rec.half, record: rec })} onDelete={(id) => void remove(id)} />
                ))}
              </div>
            )}

            {/* 本月报告 */}
            {ymReports.length > 0 && (
              <div className="cal-month-reports">
                <div className="cal-mr-head">本月报告（{ymReports.length}）</div>
                {ymReports.map((r) => (
                  <div key={r.id} className="cal-mr-item">
                    <div className="cal-mr-row" onClick={() => setExpandedReport(expandedReport === r.id ? null : r.id)}>
                      <span className="muted" style={{ fontSize: 11 }}>{new Date(r.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                      <span className="muted cal-mr-preview">{r.body.slice(0, 40).replace(/\n/g, ' ')}…</span>
                      <span className="cal-mr-toggle">{expandedReport === r.id ? '收起' : '展开'}</span>
                    </div>
                    {expandedReport === r.id && (
                      <div className="cal-mr-expanded">
                        <pre className="cal-mr-body">{r.body}</pre>
                        <div className="row gap-sm" style={{ marginTop: 6 }}>
                          <Button size="small" icon={<CopyRegular />} onClick={() => void copyText(r.body)}>复制</Button>
                          <a href="#/report" className="cal-mr-edit">→ 去报告页编辑</a>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <RecordEditor open={editor.open} onClose={() => setEditor((e) => ({ ...e, open: false }))}
        day={selectedDay} half={editor.half} record={editor.record} projects={projects} tasks={tasks} onSubmit={onSubmit} />
    </div>
  );
}
