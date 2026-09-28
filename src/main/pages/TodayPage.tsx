import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CloudUpload, MoreHorizontal } from 'lucide-react';
import { CaptureBar } from '../components/CaptureBar';
import { TimelineEntry, recordToInput, truncateEntry, type EntryPatch } from '../components/TimelineEntry';
import { ProgressRing } from '../components/ProgressRing';
import { RecordEditor } from '../components/RecordEditor';
import { ChoerodonSyncModal } from '../components/ChoerodonSyncModal';
import { toast } from '../components/UndoToast';
import { rebuildDayNow, undoDay } from '../../services/collector';
import { notifyChanged } from '../../services/events';
import type { Half, WorkRecord } from '../../types/models';
import type { RecordInput } from '../../services/db';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useRecordsStore } from '../../stores/useRecordsStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useTasksStore } from '../../stores/useTasksStore';
import { useUiStore } from '../../stores/useUiStore';
import { addDays, formatYMDChinese, parseYMD, todayYMD, weekdayCN } from '../../utils/date';
import { formatHM } from '../../utils/halfDay';
import { HALF_LABEL_CN, HALF_ORDER } from '../../utils/halfDay';

/** 今日页：捕获 + 分组时间轴（行内编辑）+ 进度环（目标=dailyCapHours，随设置联动） */
export function TodayPage() {
  const [day, setDay] = useState(todayYMD());
  const [editor, setEditor] = useState<{ open: boolean; half: Half; record?: WorkRecord | null }>({
    open: false,
    half: 'morning',
  });
  const [choerodonOpen, setChoerodonOpen] = useState(false);
  // 日菜单（作用于当前查看日 day，非永远今天）
  const [dayMenuOpen, setDayMenuOpen] = useState(false);
  const [dayBusy, setDayBusy] = useState<'' | 'rebuild' | 'undo'>('');
  const dayMenuRef = useRef<HTMLDivElement>(null);

  const records = useRecordsStore((s) => s.records);
  const dailyCapHours = useSettingsStore((s) => s.settings.dailyCapHours);
  const choerodonCfg = useSettingsStore((s) => s.settings.choerodon);
  const setRange = useRecordsStore((s) => s.setRange);
  const create = useRecordsStore((s) => s.create);
  const update = useRecordsStore((s) => s.update);
  const remove = useRecordsStore((s) => s.remove);
  const projects = useProjectsStore((s) => s.projects);
  const tasks = useTasksStore((s) => s.tasks);
  const createTask = useTasksStore((s) => s.create);
  const gotoDay = useUiStore((s) => s.gotoDay);
  const consumeGotoDay = useUiStore((s) => s.consumeGotoDay);

  const today = todayYMD();
  const isToday = day === today;

  useEffect(() => {
    void setRange(addDays(today, -6), today);
  }, [setRange, today]);

  // 来自命令面板的跳转请求：确保目标日期落在已加载区间内
  useEffect(() => {
    if (gotoDay) {
      setDay(gotoDay);
      void setRange(addDays(gotoDay, -6), gotoDay);
      consumeGotoDay();
    }
  }, [gotoDay, consumeGotoDay, setRange]);

  // 日菜单：点击外部收起（同 Select 交互）
  useEffect(() => {
    if (!dayMenuOpen) return;
    function onDoc(e: MouseEvent) {
      if (dayMenuRef.current && !dayMenuRef.current.contains(e.target as Node)) setDayMenuOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [dayMenuOpen]);

  const dayRecords = useMemo(() => records.filter((r) => r.day === day), [records, day]);
  const totalMin = dayRecords.reduce((s, r) => s + (r.durationMin ?? 0), 0);

  // 分组：全天/上午/下午/晚间（按 HALF_ORDER），组内新→旧
  const groups = useMemo(() => {
    return (Object.keys(HALF_ORDER) as Half[])
      .sort((a, b) => HALF_ORDER[a] - HALF_ORDER[b])
      .map((half) => ({
        half,
        label: HALF_LABEL_CN[half],
        items: dayRecords
          .filter((r) => r.half === half)
          .sort((a, b) => b.createdAt - a.createdAt),
      }))
      .filter((g) => g.items.length > 0);
  }, [dayRecords]);

  async function onSubmit(input: RecordInput, existing?: WorkRecord) {
    if (existing) await update(existing.id, input);
    else await create(input);
  }

  /** 行内更新：字段 patch 合并到全量载荷落库 */
  function onEntryUpdate(id: string, patch: EntryPatch) {
    const rec = records.find((r) => r.id === id);
    if (!rec) return;
    void update(id, { ...recordToInput(rec), ...patch });
  }

  /** 立即删除 + 5 秒撤销（单条删除不再弹确认框；批量操作才走 ConfirmDialog） */
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

  /** 日菜单：重整合当前查看日（已摄入事件重建；运行中禁用防双击） */
  async function onRebuildDay() {
    if (dayBusy) return;
    setDayBusy('rebuild');
    try {
      await rebuildDayNow(day);
      await notifyChanged();
      setDayMenuOpen(false);
    } catch {
      toast('重新整合失败，请稍后重试');
    } finally {
      setDayBusy('');
    }
  }

  /** 日菜单：撤销当前查看日自动条目（删 0 条无感；N>0 轻提示） */
  async function onUndoAutoDay() {
    if (dayBusy) return;
    setDayBusy('undo');
    try {
      const n = await undoDay(day);
      await notifyChanged();
      if (n > 0) toast(`已撤销 ${n} 条自动条目`);
      setDayMenuOpen(false);
    } catch {
      toast('撤销失败，请稍后重试');
    } finally {
      setDayBusy('');
    }
  }

  return (
    <div className="today-page">
      <header className="today-header">
        <div className="th-left">
          <div className="row gap-sm">
            <button className="icon-btn" onClick={() => setDay((d) => addDays(d, -1))} title="前一天">
              <ArrowLeft size={16} />
            </button>
            <h1 className="today-date-big">{isToday ? '今天' : formatYMDChinese(day)}</h1>
            <button className="icon-btn" onClick={() => setDay((d) => addDays(d, 1))} disabled={day >= today} title="后一天">
              <ArrowRight size={16} />
            </button>
            <div ref={dayMenuRef} style={{ position: 'relative' }}>
              <button
                className="icon-btn"
                onClick={() => setDayMenuOpen((o) => !o)}
                title={isToday ? '日菜单' : '当日菜单'}
                aria-haspopup="menu"
                aria-expanded={dayMenuOpen}
              >
                <MoreHorizontal size={16} />
              </button>
              {dayMenuOpen && (
                <div className="select-popover" style={{ minWidth: 176 }} role="menu">
                  <button
                    type="button"
                    className="select-option"
                    disabled={dayBusy !== ''}
                    onClick={() => void onRebuildDay()}
                  >
                    {dayBusy === 'rebuild' ? '整合中…' : isToday ? '重新整合今日' : '重新整合当日'}
                  </button>
                  <button
                    type="button"
                    className="select-option"
                    disabled={dayBusy !== ''}
                    onClick={() => void onUndoAutoDay()}
                  >
                    {dayBusy === 'undo' ? '撤销中…' : isToday ? '撤销今日自动条目' : '撤销当日自动条目'}
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="muted today-sub">
            {weekdayCN(parseYMD(day))} · 专注记录，积少成多{!isToday && ' · 查看历史'}
          </div>
        </div>
        <div className="today-head-right">
          {choerodonCfg && dayRecords.length > 0 && (
            <button className="today-action" title="上报当日记录到猪齿鱼" onClick={() => setChoerodonOpen(true)}>
              <CloudUpload size={14} /> 上报猪齿鱼
            </button>
          )}
          <div className="today-stat-card">
            <ProgressRing progress={totalMin / (Math.max(1, dailyCapHours) * 60)} />
            <div className="stat-info">
              <div className="muted stat-label">{isToday ? '今日' : '当日'}总耗时</div>
              <div className="stat-value">{formatHM(totalMin)}</div>
              <div className="muted stat-sub">{dayRecords.length} 条 · 目标 {dailyCapHours}h</div>
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
          {groups.map((g) => {
            const gMin = g.items.reduce((s, r) => s + (r.durationMin ?? 0), 0);
            return (
              <section key={g.half} className="tl-group">
                <header className="tl-group-h">
                  <span className="tl-group-name">{g.label}</span>
                  <span className="tl-group-meta">
                    {g.items.length} 条{gMin > 0 && ` · ${formatHM(gMin)}`}
                  </span>
                </header>
                {g.items.map((r) => (
                  <TimelineEntry
                    key={r.id}
                    record={r}
                    projects={projects}
                    onUpdate={onEntryUpdate}
                    onEdit={(rec) => setEditor({ open: true, half: rec.half, record: rec })}
                    onDelete={onEntryDelete}
                    onToTodo={onToTodo}
                  />
                ))}
              </section>
            );
          })}
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
