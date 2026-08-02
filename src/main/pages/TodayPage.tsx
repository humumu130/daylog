import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRegular, ArrowRightRegular, CopyRegular } from '@fluentui/react-icons';
import { CaptureBar } from '../components/CaptureBar';
import { TimelineEntry } from '../components/TimelineEntry';
import { ProgressRing } from '../components/ProgressRing';
import { RecordEditor } from '../components/RecordEditor';
import type { Half, WorkRecord } from '../../types/models';
import type { RecordInput } from '../../services/db';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useRecordsStore } from '../../stores/useRecordsStore';
import { useTasksStore } from '../../stores/useTasksStore';
import { addDays, formatYMDChinese, parseYMD, todayYMD, weekdayCN } from '../../utils/date';
import { formatHM } from '../../utils/halfDay';
import { formatZhuchiyu } from '../../utils/zhuchiyu';
import { copyText } from '../../services/clipboard';

const GOAL_MIN = 8 * 60;

export function TodayPage() {
  const [day, setDay] = useState(todayYMD());
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<{ open: boolean; half: Half; record?: WorkRecord | null }>({
    open: false,
    half: 'morning',
  });

  const records = useRecordsStore((s) => s.records);
  const setRange = useRecordsStore((s) => s.setRange);
  const create = useRecordsStore((s) => s.create);
  const update = useRecordsStore((s) => s.update);
  const remove = useRecordsStore((s) => s.remove);
  const projects = useProjectsStore((s) => s.projects);
  const tasks = useTasksStore((s) => s.tasks);

  const today = todayYMD();
  const isToday = day === today;

  useEffect(() => {
    void setRange(addDays(today, -6), today);
  }, [setRange, today]);

  const dayRecords = useMemo(() => records.filter((r) => r.day === day), [records, day]);
  const totalMin = dayRecords.reduce((s, r) => s + (r.durationMin ?? 0), 0);

  function flash(m: string) {
    setNotice(m);
    setTimeout(() => setNotice(''), 1800);
  }
  async function onCopyDay() {
    const t = formatZhuchiyu({ records: dayRecords, tasks, projects });
    await copyText(t || '（无记录）');
    flash('已复制当日猪齿鱼格式');
  }
  async function onSubmit(input: RecordInput, existing?: WorkRecord) {
    if (existing) await update(existing.id, input);
    else await create(input);
  }

  return (
    <div className="today-page">
      <header className="today-header">
        <div className="th-left">
          <div className="row gap-sm">
            <button className="icon-btn" onClick={() => setDay((d) => addDays(d, -1))} title="前一天">
              <ArrowLeftRegular />
            </button>
            <h1 className="today-date-big">{isToday ? '今天' : formatYMDChinese(day)}</h1>
            <button className="icon-btn" onClick={() => setDay((d) => addDays(d, 1))} disabled={day >= today} title="后一天">
              <ArrowRightRegular />
            </button>
          </div>
          <div className="muted today-sub">
            {weekdayCN(parseYMD(day))} · 专注记录，积少成多{!isToday && ' · 查看历史'}
          </div>
        </div>
        <div className="today-head-right">
          <button className="today-action" title="复制当日猪齿鱼格式" onClick={() => void onCopyDay()}>
            <CopyRegular /> 复制
          </button>
          <div className="today-stat-card">
            <ProgressRing progress={totalMin / GOAL_MIN} />
            <div className="stat-info">
              <div className="muted stat-label">{isToday ? '今日' : '当日'}总耗时</div>
              <div className="stat-value">{formatHM(totalMin)}</div>
              <div className="muted stat-sub">{dayRecords.length} 条 · 目标 8h</div>
            </div>
          </div>
        </div>
      </header>
      {notice && <div className="notice">{notice}</div>}

      <CaptureBar day={day} onDayChange={setDay} />

      {dayRecords.length === 0 ? (
        <div className="today-empty">
          {isToday ? '还没有记录。在上方输入框写一笔，回车或点「记录」' : '当天没有记录'}
        </div>
      ) : (
        <div className="tl">
          {[...dayRecords]
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((r) => (
              <TimelineEntry
                key={r.id}
                record={r}
                project={r.projectId ? projects.find((p) => p.id === r.projectId) : undefined}
                onEdit={(rec) => setEditor({ open: true, half: rec.half, record: rec })}
                onDelete={(id) => void remove(id)}
              />
            ))}
        </div>
      )}

      <RecordEditor
        open={editor.open}
        onClose={() => setEditor((e) => ({ ...e, open: false }))}
        day={day}
        half={editor.half}
        record={editor.record}
        projects={projects}
        tasks={tasks}
        onSubmit={onSubmit}
      />
    </div>
  );
}
