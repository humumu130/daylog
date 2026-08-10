import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRegular, ArrowRightRegular, CloudAddRegular } from '@fluentui/react-icons';
import { CaptureBar } from '../components/CaptureBar';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { TimelineEntry } from '../components/TimelineEntry';
import { ProgressRing } from '../components/ProgressRing';
import { RecordEditor } from '../components/RecordEditor';
import { ChoerodonSyncModal } from '../components/ChoerodonSyncModal';
import type { Half, WorkRecord } from '../../types/models';
import type { RecordInput } from '../../services/db';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useRecordsStore } from '../../stores/useRecordsStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useTasksStore } from '../../stores/useTasksStore';
import { useUiStore } from '../../stores/useUiStore';
import { addDays, formatYMDChinese, parseYMD, todayYMD, weekdayCN } from '../../utils/date';
import { formatHM } from '../../utils/halfDay';

const GOAL_MIN = 8 * 60;

export function TodayPage() {
  const [day, setDay] = useState(todayYMD());
  const [editor, setEditor] = useState<{ open: boolean; half: Half; record?: WorkRecord | null }>({
    open: false,
    half: 'morning',
  });
  const [delId, setDelId] = useState<string | null>(null);
  const [choerodonOpen, setChoerodonOpen] = useState(false);

  const records = useRecordsStore((s) => s.records);
  const choerodonCfg = useSettingsStore((s) => s.settings.choerodon);
  const setRange = useRecordsStore((s) => s.setRange);
  const create = useRecordsStore((s) => s.create);
  const update = useRecordsStore((s) => s.update);
  const remove = useRecordsStore((s) => s.remove);
  const projects = useProjectsStore((s) => s.projects);
  const tasks = useTasksStore((s) => s.tasks);
  const gotoDay = useUiStore((s) => s.gotoDay);
  const consumeGotoDay = useUiStore((s) => s.consumeGotoDay);

  const today = todayYMD();
  const isToday = day === today;

  useEffect(() => {
    void setRange(addDays(today, -6), today);
  }, [setRange, today]);

  // 来自全局搜索的跳转请求：确保目标日期落在已加载区间内
  useEffect(() => {
    if (gotoDay) {
      setDay(gotoDay);
      void setRange(addDays(gotoDay, -6), gotoDay);
      consumeGotoDay();
    }
  }, [gotoDay, consumeGotoDay, setRange]);

  const dayRecords = useMemo(() => records.filter((r) => r.day === day), [records, day]);
  const totalMin = dayRecords.reduce((s, r) => s + (r.durationMin ?? 0), 0);

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
          {choerodonCfg && dayRecords.length > 0 && (
            <button className="today-action" title="上报当日记录到猪齿鱼" onClick={() => setChoerodonOpen(true)}>
              <CloudAddRegular /> 上报猪齿鱼
            </button>
          )}
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
                onDelete={(id) => setDelId(id)}
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

      <ConfirmDialog
        open={delId !== null}
        title="删除这条记录？"
        message="删除后无法恢复。确定要删除该条工作记录吗？"
        confirmText="删除"
        destructive
        onCancel={() => setDelId(null)}
        onConfirm={() => { if (delId) void remove(delId); setDelId(null); }}
      />

      <ChoerodonSyncModal
        open={choerodonOpen}
        records={dayRecords}
        projects={projects}
        choerodonCfg={choerodonCfg}
        onClose={() => setChoerodonOpen(false)}
      />
    </div>
  );
}
