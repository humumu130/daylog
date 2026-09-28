import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, ListTodo, Pin, Trash2, X, ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Button, Checkbox, Input } from '../ui';
import { applyTheme } from '../styles/applyTheme';
import { useProjectsStore } from '../stores/useProjectsStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useTasksStore } from '../stores/useTasksStore';
import { useRecordsStore } from '../stores/useRecordsStore';
import { createRecord, listRecordsByRange } from '../services/db';
import { notifyChanged, onChanged, onTheme } from '../services/events';
import { hideWidget } from '../services/window';
import { autoDuration, commitAutoDuration } from '../services/duration';
import { splitHoursBackward } from '../services/allocate';
import { addDays, todayYMD } from '../utils/date';
import { formatHM, halfOf } from '../utils/halfDay';
import { parseEntry } from '../utils/parseEntry';
import './widget.css';

/** 把待办附带的可选耗时存进 note（JSON），完成时取出；无则按当天剩余自动分配 */
function noteWithDuration(durationMin: number | null): string {
  return durationMin != null ? JSON.stringify({ durationMin }) : '';
}
function readDuration(note: string): number | null {
  if (!note) return null;
  try {
    const j = JSON.parse(note);
    if (j && typeof j.durationMin === 'number') return j.durationMin;
  } catch { /* ignore */ }
  return null;
}

export function WidgetApp() {
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.load);
  const tasks = useTasksStore((s) => s.tasks);
  const fetchTasks = useTasksStore((s) => s.fetch);
  const createTask = useTasksStore((s) => s.create);
  const setStatus = useTasksStore((s) => s.setStatus);
  const removeTask = useTasksStore((s) => s.remove);
  const projects = useProjectsStore((s) => s.projects);
  const fetchProjects = useProjectsStore((s) => s.fetch);
  const records = useRecordsStore((s) => s.records);
  const setRange = useRecordsStore((s) => s.setRange);

  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState('');
  const [pinned, setPinned] = useState(true); // 置顶（始终在最前）
  const [hoursById, setHoursById] = useState<Record<string, string>>({}); // 每条待办的工时输入
  const [aiFoldOpen, setAiFoldOpen] = useState(false); // AI 采集分组折叠态（默认折叠，计数常显）
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadSettings().then((s) => applyTheme(s.theme));
    void fetchTasks();
    void fetchProjects();
    void setRange(todayYMD(), todayYMD());
    const w = getCurrentWebviewWindow();
    const p = w.onFocusChanged(({ payload: f }) => {
      if (f) inputRef.current?.focus();
    });
    const ut = onTheme((t) => applyTheme(t));
    // 采集引擎产出（AI 待办摄入/自动条目）广播 → 浮窗实时刷新
    const uc = onChanged(() => {
      void fetchTasks();
      void setRange(todayYMD(), todayYMD());
    });
    return () => {
      void p.then((fn) => fn());
      void ut.then((fn) => fn());
      void uc.then((fn) => fn());
    };
  }, [loadSettings, fetchTasks, fetchProjects, setRange]);

  const active = useMemo(() => tasks.filter((t) => t.status === 'active'), [tasks]);
  // AI 采集待办单独分组（todoIngest 摄入，去重由 external_key 保证；完成同手动勾选记账）
  const manualActive = active.filter((t) => t.source !== 'ai');
  const aiActive = active.filter((t) => t.source === 'ai');

  // NL 解析输入（#项目 / 耗时），用于回显芯片 + 创建时带上
  const parsed = useMemo(
    () => parseEntry(text, { projects, tasks: active }),
    [text, projects, active],
  );
  const projName = (id: string | null) => (id ? projects.find((p) => p.id === id)?.name : undefined);

  // 今日小结
  const todayMin = records
    .filter((r) => r.day === todayYMD())
    .reduce((s, r) => s + (r.durationMin ?? 0), 0);
  const todayCount = records.filter((r) => r.day === todayYMD()).length;

  function flashMsg(m: string) {
    setFlash(m);
    setTimeout(() => setFlash(''), 1400);
  }

  async function togglePin() {
    const next = !pinned;
    setPinned(next);
    try { await getCurrentWebviewWindow().setAlwaysOnTop(next); } catch { /* ignore */ }
  }

  async function addTodo() {
    const title = parsed.content.trim();
    if (!title) return;
    try {
      await createTask({
        title,
        projectId: parsed.projectId,
        status: 'active',
        startDate: todayYMD(),
        endDate: null,
        note: noteWithDuration(parsed.durationMin),
      });
      await notifyChanged();
      setText('');
      inputRef.current?.focus();
    } catch (e) {
      flashMsg('添加失败：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  /** 完成待办并记一笔。hours 为输入框/携带的显式工时；> 单日上限则倒着拆到多天；无则自动分配 */
  async function complete(task: { id: string; title: string; projectId: string | null; note: string }, hours: number | null) {
    setBusy(task.id);
    try {
      const fromNote = readDuration(task.note);
      const h = hours != null ? hours : fromNote;
      const half = halfOf(new Date(), settings.boundaries);
      if (h != null && h > 0) {
        if (h > settings.dailyCapHours) {
          // 超过单日上限：倒着拆到多天（今天优先，满了转前一天）
          const span = Math.ceil(h / settings.dailyCapHours) + 1;
          const recs = await listRecordsByRange(addDays(todayYMD(), -span), todayYMD());
          const existing: Record<string, number> = {};
          for (const r of recs) existing[r.day] = (existing[r.day] ?? 0) + (r.durationMin ?? 0) / 60;
          const split = splitHoursBackward(h, settings.dailyCapHours, existing, todayYMD());
          for (const s of split) {
            await createRecord({ content: task.title, durationMin: Math.round(s.hours * 60), day: s.day, half, taskId: task.id, projectId: task.projectId, source: 'manual' });
          }
          await setStatus(task.id, 'done'); await notifyChanged(); await setRange(todayYMD(), todayYMD());
          flashMsg(`已记 ${split.length} 天 · 共 ${h}h`);
        } else {
          await createRecord({ content: task.title, durationMin: Math.round(h * 60), day: todayYMD(), half, taskId: task.id, projectId: task.projectId, source: 'manual' });
          await setStatus(task.id, 'done'); await notifyChanged(); await setRange(todayYMD(), todayYMD());
          flashMsg(`已完成 · ${h}h`);
        }
      } else {
        // 无显式工时：autoDuration 智能分配
        const plan = await autoDuration(todayYMD(), settings.dailyCapHours);
        await createRecord({ content: task.title, durationMin: plan.share, day: todayYMD(), half, taskId: task.id, projectId: task.projectId, source: 'manual', meta: { autoDuration: true } });
        await commitAutoDuration(plan);
        await setStatus(task.id, 'done'); await notifyChanged(); await setRange(todayYMD(), todayYMD());
        flashMsg(`已记一笔 · 自动 ${formatHM(plan.share)}`);
      }
    } catch (e) {
      flashMsg('记录失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
      setHoursById((m) => { const n = { ...m }; delete n[task.id]; return n; });
    }
  }

  function projOf(id: string | null) {
    return id ? projects.find((p) => p.id === id) : undefined;
  }

  /** 待办行（手动/AI 共用；AI 行 meta 里加来源徽标） */
  function renderTodo(t: (typeof tasks)[number]) {
    const proj = projOf(t.projectId);
    const dur = readDuration(t.note);
    return (
      <div key={t.id} className={`widget-item${busy === t.id ? ' busy' : ''}`}>
        <Checkbox
          checked={false}
          disabled={busy === t.id}
          ariaLabel={`完成 ${t.title}`}
          onChange={() => void complete(t, null)}
        />
        <div className="widget-item-body">
          <span className="widget-item-title">{t.title}</span>
          <div className="widget-item-meta">
            {t.source === 'ai' && <span className="widget-item-ai">AI 采集</span>}
            {proj && (
              <span className="widget-item-proj">
                <i className="wdot" style={{ background: proj.color }} /> {proj.name}
              </span>
            )}
            {dur != null && <span className="widget-item-dur">{formatHM(dur)}</span>}
          </div>
        </div>
        <input
          className="sel widget-hours-input"
          type="number"
          step={0.5}
          min={0}
          placeholder="工时"
          value={hoursById[t.id] ?? ''}
          onChange={(e) => setHoursById((m) => ({ ...m, [t.id]: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const hv = parseFloat(hoursById[t.id] ?? '');
              void complete(t, isNaN(hv) ? null : hv);
            }
          }}
          disabled={busy === t.id}
          title="工时（小时），回车完成；不填自动分配；超单日上限自动拆到前几天"
        />
        <button
          className="widget-del"
          title="删除"
          aria-label={`删除 ${t.title}`}
          tabIndex={-1}
          disabled={busy === t.id}
          onClick={() => void removeTask(t.id)}
        >
          <Trash2 size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="app-shell widget-root">
      <div className="widget-header" data-tauri-drag-region>
        <span className="widget-title">
          <ListTodo size={14} className="widget-title-icon" /> 待办
        </span>
        <span className="widget-count">{active.length}</span>
        <Button
          variant="ghost"
          size="sm"
          icon={<Pin size={14} />}
          className={`widget-pin${pinned ? ' active' : ''}`}
          title={pinned ? '取消置顶' : '置顶（始终在最前）'}
          aria-label={pinned ? '取消置顶' : '置顶'}
          onClick={() => void togglePin()}
        />
        <Button variant="ghost" size="sm" icon={<X size={14} />} title="关闭" aria-label="关闭" onClick={() => void hideWidget()} />
      </div>

      <div className="widget-add">
        <Input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="加个待办，可带 #项目 / 耗时"
          prefix={<Plus size={14} />}
          className="grow"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void addTodo();
            }
          }}
        />
        {(parsed.projectId || parsed.durationMin != null) && (
          <div className="widget-chips">
            {parsed.projectId && <span className="wchip">{projName(parsed.projectId)}</span>}
            {parsed.durationMin != null && <span className="wchip">{formatHM(parsed.durationMin)}</span>}
          </div>
        )}
      </div>

      <div className="widget-list">
        {active.length === 0 && <div className="empty widget-empty">没有待办，加一个吧 ✍️</div>}
        {manualActive.map(renderTodo)}
        {aiActive.length > 0 && (
          <div className="widget-ai-group">
            <button
              type="button"
              className="widget-ai-fold"
              aria-expanded={aiFoldOpen}
              title="从 AI 会话采集的待办（自动去重，会话完成自动划掉）"
              onClick={() => setAiFoldOpen((v) => !v)}
            >
              {aiFoldOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
              <Sparkles size={13} className="widget-ai-icon" aria-hidden="true" />
              <span>AI 采集</span>
              <span className="widget-ai-count">{aiActive.length}</span>
            </button>
            {aiFoldOpen && aiActive.map(renderTodo)}
          </div>
        )}
      </div>

      <div className="widget-foot">
        {flash ? (
          <span className="widget-flash">✓ {flash}</span>
        ) : (
          <span>今日 {formatHM(todayMin)} · {todayCount} 条 · 勾选即记一笔</span>
        )}
      </div>
    </div>
  );
}
