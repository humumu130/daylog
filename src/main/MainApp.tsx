import { useEffect, useState } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { FluentProvider, Spinner } from '@fluentui/react-components';
import { darkTheme, lightTheme } from '../styles/theme';
import { Sidebar } from './Sidebar';
import { WindowControls } from './components/WindowControls';
import { TodayPage } from './pages/TodayPage';
import { ReviewPage } from './pages/ReviewPage';
import { GitPage } from './pages/GitPage';
import { SettingsPage } from './pages/SettingsPage';
import { useProjectsStore } from '../stores/useProjectsStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useTasksStore } from '../stores/useTasksStore';
import { setAutostart } from '../services/autostart';
import { onChanged } from '../services/events';
import { registerHotkey, unregisterHotkey } from '../services/hotkey';
import { showQuickCapture, toggleWidget } from '../services/window';
import { useRecordsStore } from '../stores/useRecordsStore';
import './app.css';
import './pages.css';
import './components/components.css';

export function MainApp() {
  const settings = useSettingsStore((s) => s.settings);
  const load = useSettingsStore((s) => s.load);
  const fetchProjects = useProjectsStore((s) => s.fetch);
  const fetchTasks = useTasksStore((s) => s.fetch);
  const fetchRecords = useRecordsStore((s) => s.fetch);
  const [ready, setReady] = useState(false);

  const theme = settings.theme === 'dark' ? darkTheme : lightTheme;

  // 初始化：加载设置、拉取基础数据、应用自启
  useEffect(() => {
    void (async () => {
      const s = await load();
      await setAutostart(s.autostart).catch(() => undefined);
      await Promise.all([fetchProjects(), fetchTasks()]);
      setReady(true);
    })();
  }, [load, fetchProjects, fetchTasks]);

  // 快速记录热键
  useEffect(() => {
    if (!ready) return;
    void registerHotkey('capture', settings.hotkey, () => void showQuickCapture());
    return () => {
      void unregisterHotkey('capture');
    };
  }, [settings.hotkey, ready]);

  // 待办插件热键
  useEffect(() => {
    if (!ready) return;
    void registerHotkey('todo', settings.todoHotkey, () => void toggleWidget());
    return () => {
      void unregisterHotkey('todo');
    };
  }, [settings.todoHotkey, ready]);

  // 跨窗口数据同步：捕获面板/待办插件改动后自动刷新
  useEffect(() => {
    if (!ready) return;
    const p = onChanged(() => {
      void fetchTasks();
      void fetchRecords();
    });
    return () => {
      void p.then((fn) => fn());
    };
  }, [ready, fetchTasks, fetchRecords]);

  return (
    <FluentProvider theme={theme} className="app-shell app-layout">
      <HashRouter>
        <Sidebar />
        <div className="main-col">
          <div className="titlebar" data-tauri-drag-region>
            <WindowControls />
          </div>
          <main className="app-content">
          {ready ? (
            <Routes>
              <Route path="/" element={<Navigate to="/today" replace />} />
              <Route path="/today" element={<TodayPage />} />
              <Route path="/calendar" element={<ReviewPage />} />
              <Route path="/git" element={<GitPage />} />
              <Route path="/report" element={<ReviewPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          ) : (
            <div className="loading">
              <Spinner /> <span className="muted">加载中…</span>
            </div>
          )}
          </main>
        </div>
      </HashRouter>
    </FluentProvider>
  );
}
