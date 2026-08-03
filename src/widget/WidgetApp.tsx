import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, FluentProvider, Input } from '@fluentui/react-components';
import { darkTheme, lightTheme } from '../styles/theme';
import { AddRegular, DeleteRegular, DismissRegular, PinRegular, TaskListLtrRegular } from '@fluentui/react-icons';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useProjectsStore } from '../stores/useProjectsStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useTasksStore } from '../stores/useTasksStore';
import { useRecordsStore } from '../stores/useRecordsStore';
import { createRecord } from '../services/db';
import { notifyChanged, onTheme } from '../services/events';
import { hideWidget } from '../services/window';
import { autoDuration, commitAutoDuration } from '../services/duration';
import { todayYMD } from '../utils/date';
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

  const [theme, setTheme] = useState(lightTheme);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState('');
  const [pinned, setPinned] = useState(true); // 置顶（始终在最前）
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadSettings().then((s) => setTheme(s.theme === 'dark' ? darkTheme : lightTheme));
    void fetchTasks();
    void fetchProjects();
    void setRange(todayYMD(), todayYMD());
    const w = getCurrentWebviewWindow();
    const p = w.onFocusChanged(({ payload: f }) => {
      if (f) inputRef.current?.focus();
    });
    const ut = onTheme((t) => setTheme(t === 'dark' ? darkTheme : lightTheme));
    return () => {
      void p.then((fn) => fn());
      void ut.then((fn) => fn());
    };
  }, [loadSettings, fetchTasks, fetchProjects, setRange]);

  const active = useMemo(() => tasks.filter((t) => t.status === 'active'), [tasks]);

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

  async function complete(id: string, title: string, projectId: string | null, note: string) {
    setBusy(id);
    try {
      const explicit = readDuration(note);
      let durationMin: number;
      let plan;
      if (explicit !== null) {
        durationMin = explicit;
      } else {
        plan = await autoDuration(todayYMD());
        durationMin = plan.share;
      }
      // 先建新记录 → 建成功后再压缩已有（保证原子性）
      await createRecord({
        content: title,
        durationMin,
        day: todayYMD(),
        half: halfOf(new Date(), settings.boundaries),
        taskId: id,
        projectId,
        source: 'manual',
        meta: plan ? { autoDuration: true } : undefined,
      });
      if (plan) await commitAutoDuration(plan);
      await setStatus(id, 'done');
      await notifyChanged();
      await setRange(todayYMD(), todayYMD());
      flashMsg(plan ? `已记一笔 · 自动 ${formatHM(durationMin)}` : '已完成并记录');
    } catch (e) {
      flashMsg('记录失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  }

  function projOf(id: string | null) {
    return id ? projects.find((p) => p.id === id) : undefined;
  }

  return (
    <FluentProvider theme={theme} className="app-shell widget-root">
      <div className="widget-header" data-tauri-drag-region>
        <span className="widget-title">
          <TaskListLtrRegular className="widget-title-icon" /> 待办
        </span>
        <span className="widget-count">{active.length}</span>
        <Button
          appearance="subtle"
          size="small"
          icon={<PinRegular />}
          className={`widget-pin${pinned ? ' active' : ''}`}
          title={pinned ? '取消置顶' : '置顶（始终在最前）'}
          onClick={() => void togglePin()}
        />
        <Button appearance="subtle" size="small" icon={<DismissRegular />} onClick={() => void hideWidget()} />
      </div>

      <div className="widget-add">
        <Input
          ref={inputRef}
          value={text}
          onChange={(_, d) => setText(d.value)}
          placeholder="加个待办，可带 #项目 / 耗时"
          contentBefore={<AddRegular />}
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
        {active.map((t) => {
          const proj = projOf(t.projectId);
          const dur = readDuration(t.note);
          return (
            <div key={t.id} className={`widget-item${busy === t.id ? ' busy' : ''}`}>
              <Checkbox disabled={busy === t.id} onChange={() => void complete(t.id, t.title, t.projectId, t.note)} />
              <div className="widget-item-body">
                <span className="widget-item-title">{t.title}</span>
                <div className="widget-item-meta">
                  {proj && (
                    <span className="widget-item-proj">
                      <i className="wdot" style={{ background: proj.color }} /> {proj.name}
                    </span>
                  )}
                  {dur != null && <span className="widget-item-dur">{formatHM(dur)}</span>}
                </div>
              </div>
              <button
                className="widget-del"
                title="删除"
                disabled={busy === t.id}
                onClick={() => void removeTask(t.id)}
              >
                <DeleteRegular />
              </button>
            </div>
          );
        })}
      </div>

      <div className="widget-foot">
        {flash ? (
          <span className="widget-flash">✓ {flash}</span>
        ) : (
          <span>今日 {formatHM(todayMin)} · {todayCount} 条 · 勾选即记一笔</span>
        )}
      </div>
    </FluentProvider>
  );
}
