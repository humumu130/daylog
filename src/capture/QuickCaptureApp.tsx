import { useEffect, useMemo, useRef, useState } from 'react';
import { FluentProvider, Input } from '@fluentui/react-components';
import { DismissRegular } from '@fluentui/react-icons';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { darkTheme, lightTheme } from '../styles/theme';
import { useProjectsStore } from '../stores/useProjectsStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useTasksStore } from '../stores/useTasksStore';
import { todayYMD } from '../utils/date';
import { formatHours, halfOf } from '../utils/halfDay';
import { createRecord } from '../services/db';
import { autoDuration, commitAutoDuration } from '../services/duration';
import { notifyChanged } from '../services/events';
import { hideQuickCapture } from '../services/window';
import { parseEntries } from '../utils/parseEntry';
import './quick-capture.css';

export function QuickCaptureApp() {
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.load);
  const projects = useProjectsStore((s) => s.projects);
  const fetchProjects = useProjectsStore((s) => s.fetch);
  const tasks = useTasksStore((s) => s.tasks);
  const fetchTasks = useTasksStore((s) => s.fetch);

  const [theme, setTheme] = useState(lightTheme);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadSettings().then((s) => setTheme(s.theme === 'dark' ? darkTheme : lightTheme));
    void fetchProjects();
    void fetchTasks();
    const w = getCurrentWebviewWindow();
    const p = w.onFocusChanged(({ payload: f }) => {
      if (f) inputRef.current?.focus();
      else void hideQuickCapture();
    });
    return () => {
      void p.then((fn) => fn());
    };
  }, [loadSettings, fetchProjects, fetchTasks]);

  const activeTasks = tasks.filter((t) => t.status === 'active');
  const parsed = useMemo(
    () => parseEntries(text, { projects, tasks: activeTasks }),
    [text, projects, activeTasks],
  );
  const first = parsed.find((p) => p.content);
  const count = parsed.filter((p) => p.content).length;

  async function save() {
    const entries = parseEntries(text, { projects, tasks: activeTasks }).filter((p) => p.content);
    if (entries.length === 0) {
      void hideQuickCapture();
      return;
    }
    const half = halfOf(new Date(), settings.boundaries);
    for (const e of entries) {
      const recordDay = e.day || todayYMD();
      if (e.durationMin !== null) {
        await createRecord({
          content: e.content,
          durationMin: e.durationMin,
          day: recordDay,
          half,
          taskId: e.taskId,
          projectId: e.projectId,
          source: 'manual',
        });
      } else {
        const plan = await autoDuration(recordDay);
        await createRecord({
          content: e.content,
          durationMin: plan.share,
          day: recordDay,
          half,
          taskId: e.taskId,
          projectId: e.projectId,
          source: 'manual',
          meta: { autoDuration: true },
        });
        await commitAutoDuration(plan);
      }
    }
    await notifyChanged();
    setText('');
    void hideQuickCapture();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      void hideQuickCapture();
    }
  }

  const projName = (id: string | null) => (id ? projects.find((p) => p.id === id)?.name : undefined);

  return (
    <FluentProvider theme={theme} className="app-shell capture-root">
      <div className="capture-header" data-tauri-drag-region>
        <span className="capture-title">快速记录 · {settings.hotkey}</span>
        <button className="qc-close" onClick={() => void hideQuickCapture()}>
          <DismissRegular />
        </button>
      </div>
      <div className="capture-body">
        <Input
          ref={inputRef}
          value={text}
          onChange={(_, d) => setText(d.value)}
          onKeyDown={onKeyDown}
          placeholder="处理 xxbug 8h  （; 多条）"
          size="large"
          className="capture-input"
        />
        <div className="capture-chips">
          {first?.durationMin != null && <span className="chip">{formatHours(first.durationMin)}</span>}
          {first?.projectId && <span className="chip">{projName(first.projectId)}</span>}
          {count > 1 && <span className="chip count-chip">{count} 条</span>}
        </div>
      </div>
    </FluentProvider>
  );
}
