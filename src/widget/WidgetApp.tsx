import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, FluentProvider, Input } from '@fluentui/react-components';
import { darkTheme, lightTheme } from '../styles/theme';
import { AddRegular, DismissRegular, TaskListLtrRegular } from '@fluentui/react-icons';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useProjectsStore } from '../stores/useProjectsStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useTasksStore } from '../stores/useTasksStore';
import { createRecord } from '../services/db';
import { notifyChanged } from '../services/events';
import { hideWidget } from '../services/window';
import { todayYMD } from '../utils/date';
import { HALF_LABEL_CN, halfOf } from '../utils/halfDay';
import './widget.css';

export function WidgetApp() {
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.load);
  const tasks = useTasksStore((s) => s.tasks);
  const fetchTasks = useTasksStore((s) => s.fetch);
  const createTask = useTasksStore((s) => s.create);
  const setStatus = useTasksStore((s) => s.setStatus);
  const projects = useProjectsStore((s) => s.projects);
  const fetchProjects = useProjectsStore((s) => s.fetch);

  const [theme, setTheme] = useState(lightTheme);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadSettings().then((s) => setTheme(s.theme === 'dark' ? darkTheme : lightTheme));
    void fetchTasks();
    void fetchProjects();
    const w = getCurrentWebviewWindow();
    const p = w.onFocusChanged(({ payload: f }) => {
      if (f) inputRef.current?.focus();
    });
    return () => {
      void p.then((fn) => fn());
    };
  }, [loadSettings, fetchTasks, fetchProjects]);

  const active = tasks.filter((t) => t.status === 'active');

  async function addTodo() {
    const title = text.trim();
    if (!title) return;
    await createTask({ title, projectId: null, status: 'active', startDate: todayYMD(), endDate: null, note: '' });
    await notifyChanged();
    setText('');
    inputRef.current?.focus();
  }

  async function complete(id: string, title: string, projectId: string | null) {
    setBusy(id);
    try {
      await createRecord({
        content: title,
        durationMin: null,
        day: todayYMD(),
        half: halfOf(new Date(), settings.boundaries),
        taskId: id,
        projectId,
        source: 'manual',
      });
      await setStatus(id, 'done');
      await notifyChanged();
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
        <Button appearance="subtle" size="small" icon={<DismissRegular />} onClick={() => void hideWidget()} />
      </div>

      <div className="widget-add">
        <Input
          ref={inputRef}
          value={text}
          onChange={(_, d) => setText(d.value)}
          placeholder="加个待办，回车添加"
          contentBefore={<AddRegular />}
          className="grow"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void addTodo();
            }
          }}
        />
      </div>

      <div className="widget-list">
        {active.length === 0 && <div className="empty widget-empty">没有待办，加一个吧 ✍️</div>}
        {active.map((t) => {
          const proj = projOf(t.projectId);
          return (
            <div key={t.id} className={`widget-item${busy === t.id ? ' busy' : ''}`}>
              <Checkbox disabled={busy === t.id} onChange={() => void complete(t.id, t.title, t.projectId)} />
              <div className="widget-item-body">
                <span className="widget-item-title">{t.title}</span>
                {proj && (
                  <span className="widget-item-proj">
                    <i className="wdot" style={{ background: proj.color }} /> {proj.name}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="widget-foot">
        {HALF_LABEL_CN[halfOf(new Date(), settings.boundaries)]} · 勾选即自动记一笔
      </div>
    </FluentProvider>
  );
}
