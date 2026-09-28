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
import { readPersistedWsId, useWorkspaceStore } from '../stores/useWorkspaceStore';
import { autoDuration, commitAutoDuration } from '../services/duration';
import { notifyChanged, onChanged, onTheme } from '../services/events';
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
    // 主窗切换空间/其它窗口改动 → 同步本窗内存 currentId（localStorage 现读）并重拉，
    // 保证弹出时项目/任务清单跟随主窗当前空间（stores 按各窗内存 currentId 过滤）
    const uc = onChanged(() => {
      useWorkspaceStore.setState({ currentId: readPersistedWsId() });
      void fetchProjects();
      void fetchTasks();
    });
    return () => {
      void p.then((fn) => fn());
      void ut.then((fn) => fn());
      void uc.then((fn) => fn());
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
    // P8b：落库进当前空间（现读 localStorage——主窗切换后快速记录跟随）
    const wsId = readPersistedWsId();
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
          workspaceId: wsId,
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
          workspaceId: wsId,
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
