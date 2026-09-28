import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CloudUpload, MoreHorizontal, Pencil } from 'lucide-react';
import { CaptureBar } from '../components/CaptureBar';
import { CaptureInput } from '../components/CaptureInput';
import { TimelineEntry, recordToInput, truncateEntry, type EntryPatch } from '../components/TimelineEntry';
import { ProgressRing } from '../components/ProgressRing';
import { RecordEditor } from '../components/RecordEditor';
import { toast } from '../components/UndoToast';
import { Button, Segmented } from '../../ui';
import { rebuildDayNow, undoDay } from '../../services/collector';
import { notifyChanged } from '../../services/events';
import type { Half, RecordType, WorkRecord } from '../../types/models';
import { RECORD_TYPE_LABELS } from '../../types/models';
import type { RecordInput } from '../../services/db';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useRecordsStore } from '../../stores/useRecordsStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useTasksStore } from '../../stores/useTasksStore';
import { useUiStore } from '../../stores/useUiStore';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { addDays, formatYMDChinese, parseYMD, todayYMD, weekdayCN } from '../../utils/date';
import { formatHM, formatHours, halfOf } from '../../utils/halfDay';
import { HALF_LABEL_CN, HALF_ORDER } from '../../utils/halfDay';
import { parseEntries } from '../../utils/parseEntry';

/** 个人空间捕获区的记录类型五选（默认「想法」；work 空间不渲染选择器） */
const PERSONAL_RECORD_TYPES: { value: RecordType; label: string }[] = (
  ['learning', 'practice', 'milestone', 'thought', 'retro'] as RecordType[]
).map((value) => ({ value, label: RECORD_TYPE_LABELS[value] }));

/**
 * 个人空间捕获区（P8b）：复用 CaptureInput/解析语法，但带记录类型选择；
 * 与 CaptureBar 的差异——不走 autoDuration 工时分摊（个人记录无工时目标，时长仅在显式输入时保留）。
 * CaptureBar 属 work 路径不动，故个人形态在本文件内实现。
 */
function PersonalCaptureBar({ day, onDayChange, wsId }: { day: string; onDayChange: (d: string) => void; wsId: string }) {
  const projects = useProjectsStore((s) => s.projects);
  const tasks = useTasksStore((s) => s.tasks);
  const create = useRecordsStore((s) => s.create);
  const boundaries = useSettingsStore((s) => s.settings.boundaries);

  const [text, setText] = useState('');
  const [recordType, setRecordType] = useState<RecordType>('thought');
  const [flashed, setFlashed] = useState(false);

  const activeTasks = tasks.filter((t) => t.status === 'active');
  const parsed = useMemo(
    () => parseEntries(text, { projects, tasks: activeTasks }),
    [text, projects, activeTasks],
  );
  const validCount = parsed.filter((p) => p.content).length;
  const first = parsed.find((p) => p.content);

  async function save() {
    const entries = parseEntries(text, { projects, tasks: activeTasks }).filter((p) => p.content);
    if (entries.length === 0) return;
    const half: Half = halfOf(new Date(), boundaries);
    for (const e of entries) {
      await create({
        content: e.content,
        durationMin: e.durationMin,
        day: e.day || day,
        half,
        taskId: e.taskId,
        projectId: e.projectId,
        source: 'manual',
        workspaceId: wsId,
        recordType,
      });
    }
    await notifyChanged();
    setText('');
    setFlashed(true);
    setTimeout(() => setFlashed(false), 900);
  }

  return (
    <div className={`capture-bar${flashed ? ' flashed' : ''}`}>
      <div className="rt-capture-types">
        <Segmented
          size="sm"
          aria-label="记录类型"
          value={recordType}
          onChange={setRecordType}
          options={PERSONAL_RECORD_TYPES}
        />
      </div>
      <div className="capture-row">
        <CaptureInput
          value={text}
          onChange={setText}
          onSubmit={() => void save()}
          placeholder="读了《卡片笔记》；跑步 30m #健康   （支持：昨天 / 5号 / X月X日 / ; 多条）"
          icon={<span className="capture-icon">{flashed ? <Check size={18} /> : <Pencil size={18} />}</span>}
          wrapClassName="capture-input"
        />
        <Button variant="primary" className="capture-btn" onClick={() => void save()}>
          记录
        </Button>
      </div>
      <div className="capture-chips">
        <input type="date" className="sel capture-date" value={day} onChange={(e) => onDayChange(e.target.value)} style={{ width: 'auto' }} title="记录日期" />
        {first?.day && first.day !== day && (
          <span className="chip day-chip" title="输入中检测到的日期" onClick={() => onDayChange(first.day!)}>
            → {formatYMDChinese(first.day)}
          </span>
        )}
        {first?.durationMin != null && <span className="chip">{formatHours(first.durationMin)}</span>}
        {first?.projectId && <span className="chip">{projects.find((p) => p.id === first.projectId)?.name}</span>}
        {first?.taskId && <span className="chip task-chip">[{tasks.find((t) => t.id === first.taskId)?.title}]</span>}
        {validCount > 1 && <span className="chip count-chip">{validCount} 条</span>}
      </div>
    </div>
  );
}

/** 今日页：捕获 + 分组时间轴（行内编辑）+ 进度环（目标=dailyCapHours，随设置联动）。
 *  P8b：personal 空间形态——捕获区带类型选择、无进度环/上报入口，头部显条数；work 路径原样。 */
export function TodayPage() {
  const [day, setDay] = useState(todayYMD());
  const [editor, setEditor] = useState<{ open: boolean; half: Half; record?: WorkRecord | null }>({
    open: false,
    half: 'morning',
  });
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
  // P8b 空间分流：work=原路径零回归；personal=成长记录形态
  const wsKind = useWorkspaceStore((s) => s.currentKind());
  const wsId = useWorkspaceStore((s) => s.currentId);
  const isPersonal = wsKind === 'personal';

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

  // 空间隔离：只看当前空间记录（records store 为跨空间全局缓存，页面侧过滤）
  const wsRecords = useMemo(() => records.filter((r) => r.workspaceId === wsId), [records, wsId]);
  const dayRecords = useMemo(() => wsRecords.filter((r) => r.day === day), [wsRecords, day]);
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

  // personal 头部：类型分布（「想法 2 · 学到什么 1」，按量降序）
  const typeDistText = useMemo(() => {
    const dist = new Map<RecordType, number>();
    for (const r of dayRecords) dist.set(r.recordType, (dist.get(r.recordType) ?? 0) + 1);
    return [...dist.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${RECORD_TYPE_LABELS[t]} ${n}`)
      .join(' · ');
  }, [dayRecords]);

  async function onSubmit(input: RecordInput, existing?: WorkRecord) {
    if (existing) {
      // P8b：编辑器不感知空间字段，personal 载荷合并保留类型/学到/标签（work 记录这些字段本就是默认值，合并无行为差异）
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

  /** 打开猪齿鱼批量上报向导（Modal 挂在 MainApp，经事件唤起，任意页面可用）——work 空间专属 */
  function openBatchSync() {
    setDayMenuOpen(false);
    window.dispatchEvent(new CustomEvent('daylog:open-batch-sync'));
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
                  {!isPersonal && (
                    <button
                      type="button"
                      className="select-option"
                      onClick={openBatchSync}
                    >
                      批量上报…
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="muted today-sub">
            {weekdayCN(parseYMD(day))} · 专注记录，积少成多{!isToday && ' · 查看历史'}
          </div>
        </div>
        <div className="today-head-right">
          {!isPersonal && choerodonCfg && (
            <button className="today-action" title="批量上报工时到猪齿鱼（三步向导）" onClick={openBatchSync}>
              <CloudUpload size={14} /> 批量上报
            </button>
          )}
          {isPersonal ? (
            <div className="today-stat-card">
              <div className="stat-info">
                <div className="muted stat-label">{isToday ? '今日' : '当日'}记录</div>
                <div className="stat-value">{dayRecords.length} 条</div>
                <div className="muted stat-sub">{typeDistText || '还没有类型'}</div>
              </div>
            </div>
          ) : (
            <div className="today-stat-card">
              <ProgressRing progress={totalMin / (Math.max(1, dailyCapHours) * 60)} />
              <div className="stat-info">
                <div className="muted stat-label">{isToday ? '今日' : '当日'}总耗时</div>
                <div className="stat-value">{formatHM(totalMin)}</div>
                <div className="muted stat-sub">{dayRecords.length} 条 · 目标 {dailyCapHours}h</div>
              </div>
            </div>
          )}
        </div>
      </header>

      {isPersonal ? (
        <PersonalCaptureBar day={day} onDayChange={setDay} wsId={wsId} />
      ) : (
        <CaptureBar day={day} onDayChange={setDay} />
      )}

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
    </div>
  );
}
