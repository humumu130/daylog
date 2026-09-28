import { useEffect, useState } from 'react';
import { HashRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Spinner } from '../ui';
import { applyTheme } from '../styles/applyTheme';
import { NAV } from './nav';
import { Sidebar } from './Sidebar';
import { WindowControls } from './components/WindowControls';
import { TodayPage } from './pages/TodayPage';
import { CalendarPage } from './pages/CalendarPage';
import { GitPage } from './pages/GitPage';
import { SettingsPage } from './pages/SettingsPage';
import { useProjectsStore } from '../stores/useProjectsStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useTasksStore } from '../stores/useTasksStore';
import { setAutostart } from '../services/autostart';
import { onChanged } from '../services/events';
import { registerHotkey, unregisterHotkey } from '../services/hotkey';
import { toggleMain, toggleQuickCapture, toggleWidget } from '../services/window';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useRecordsStore } from '../stores/useRecordsStore';
import { autoBackup } from '../services/backup';
import { useUiStore } from '../stores/useUiStore';
import { startReminder } from '../services/reminder';
import { CommandPalette } from './components/CommandPalette';
import { ToastHost } from './components/UndoToast';
import './app.css';
import './pages.css';
import './components/components.css';

/** ⌘/Ctrl+N 页面快捷键（NAV 注册表驱动，需在 Router 内拿 navigate） */
function NavHotkeys() {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && /^[1-9]$/.test(e.key)) {
        const item = NAV.find((n) => n.hotkeyIndex === Number(e.key));
        if (item) {
          e.preventDefault();
          navigate(item.to);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
  return null;
}

export function MainApp() {
  const settings = useSettingsStore((s) => s.settings);
  const load = useSettingsStore((s) => s.load);
  const fetchProjects = useProjectsStore((s) => s.fetch);
  const fetchTasks = useTasksStore((s) => s.fetch);
  const fetchRecords = useRecordsStore((s) => s.fetch);
  const [ready, setReady] = useState(false);

  // 主题单一通道：html[data-theme] 驱动 --dl- token（patch 侧已广播其它窗口）
  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  // 初始化：加载设置、拉取基础数据、应用自启
  useEffect(() => {
    void (async () => {
      const s = await load();
      await setAutostart(s.autostart).catch(() => undefined);
      await Promise.all([fetchProjects(), fetchTasks()]);
      setReady(true);
      // 启动时自动备份（按设置：开关/份数/目录；不阻塞主流程）
      void autoBackup(s).catch(() => undefined);
      // 下班提醒：每分钟检查（用 getter 实时读取最新设置）
      startReminder(() => useSettingsStore.getState().settings);
    })();
  }, [load, fetchProjects, fetchTasks]);

  // 快速记录热键（再次按下可关闭）
  useEffect(() => {
    if (!ready) return;
    void registerHotkey('capture', settings.hotkey, () => void toggleQuickCapture());
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

  // 主窗口呼出/收起热键
  useEffect(() => {
    if (!ready) return;
    void registerHotkey('main', settings.mainHotkey, () => void toggleMain());
    return () => {
      void unregisterHotkey('main');
    };
  }, [settings.mainHotkey, ready]);

  // 关闭主窗口（标题栏 X / Alt+F4）→ 收进托盘，而非退出（退出走托盘菜单「退出」）
  useEffect(() => {
    const w = getCurrentWebviewWindow();
    let unlisten: (() => void) | undefined;
    w.onCloseRequested((e) => {
      e.preventDefault();
      void w.hide();
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

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

  // 命令面板快捷键 Ctrl/Cmd+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        useUiStore.getState().openSearch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app-shell app-layout">
      <HashRouter>
        <NavHotkeys />
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
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/git" element={<GitPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          ) : (
            <div className="loading">
              <Spinner /> <span className="muted">加载中…</span>
            </div>
          )}
          </main>
        </div>
        <CommandPalette />
        <ToastHost />
      </HashRouter>
    </div>
  );
}
