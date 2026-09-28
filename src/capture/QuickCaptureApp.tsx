import { useEffect, useMemo, useRef, useState } from 'react';
import { Pencil, X } from 'lucide-react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { CaptureInput } from '../main/components/CaptureInput';
import { applyTheme } from '../styles/applyTheme';
import { useProjectsStore } from '../stores/useProjectsStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useTasksStore } from '../stores/useTasksStore';
import { todayYMD } from '../utils/date';
import { formatHours, halfOf } from '../utils/halfDay';
import { createRecord } from '../services/db';
import { autoDuration, commitAutoDuration } from '../services/duration';
import { notifyChanged, onTheme } from '../services/events';
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

  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadSettings().then((s) => applyTheme(s.theme));
    void fetchProjects();
    void fetchTasks();
    const w = getCurrentWebviewWindow();
    const p = w.onFocusChanged(({ payload: f }) => {
      if (f) inputRef.current?.focus();
      else void hideQuickCapture();
    });
    const ut = onTheme((t) => applyTheme(t));
    return () => {
      void p.then((fn) => fn());
      void ut.then((fn) => fn());
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
        const plan = await autoDuration(recordDay, settings.dailyCapHours);
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

  const projName = (id: string | null) => (id ? projects.find((p) => p.id === id)?.name : undefined);

  return (
    <div className="app-shell capture-root">
      <div className="capture-header" data-tauri-drag-region>
        <span className="capture-title">快速记录 · {settings.hotkey}</span>
        <button className="qc-close" title="关闭" onClick={() => void hideQuickCapture()}>
          <X size={16} />
        </button>
      </div>
      <div className="capture-body">
        <CaptureInput
          value={text}
          onChange={setText}
          onSubmit={() => void save()}
          onEsc={() => void hideQuickCapture()}
          placeholder="处理 xxbug 8h  （; 多条）"
          icon={<Pencil size={16} />}
          inputRef={inputRef}
          wrapClassName="capture-input"
        />
        <div className="capture-chips">
          {first?.durationMin != null && <span className="chip">{formatHours(first.durationMin)}</span>}
          {first?.projectId && <span className="chip">{projName(first.projectId)}</span>}
          {count > 1 && <span className="chip count-chip">{count} 条</span>}
        </div>
      </div>
    </div>
  );
}
