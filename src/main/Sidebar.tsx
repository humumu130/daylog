import { ListTodo, Moon, Search, Sun } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { NAV } from './nav';
import { toggleWidget } from '../services/window';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useUiStore } from '../stores/useUiStore';

/** 图标轨：唯一导航。可选「图标+文字」模式（设置·通用 sidebarLabels，默认纯图标保持密度） */
export function Sidebar() {
  const theme = useSettingsStore((s) => s.settings.theme);
  const labels = useSettingsStore((s) => s.settings.sidebarLabels);
  const patch = useSettingsStore((s) => s.patch);
  const openPalette = useUiStore((s) => s.openSearch);
  const isDark = theme === 'dark';

  return (
    <aside className={`rail${labels ? ' labels' : ''}`}>
      <div className="rail-brand" title="日迹" data-tauri-drag-region>
        日迹
      </div>
      <nav className="rail-nav">
        <button className="rail-item" title="命令面板 (⌘K)" onClick={openPalette}>
          <Search size={18} className="rail-icon" />
          {labels && <span className="rail-label">搜索</span>}
        </button>
        {NAV.map(({ to, label, icon: Icon, hotkeyIndex }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `rail-item${isActive ? ' active' : ''}`}
            title={`${label} (⌘${hotkeyIndex})`}
          >
            <Icon size={18} className="rail-icon" />
            {labels && <span className="rail-label">{label}</span>}
          </NavLink>
        ))}
      </nav>
      <div className="rail-foot">
        <button className="rail-item" title="待办插件 (Alt+Shift+J)" onClick={() => void toggleWidget()}>
          <ListTodo size={18} className="rail-icon" />
          {labels && <span className="rail-label">待办</span>}
        </button>
        <button
          className="rail-item"
          title={isDark ? '切换浅色' : '切换深色'}
          onClick={() => void patch({ theme: isDark ? 'light' : 'dark' })}
        >
          {isDark ? <Sun size={18} className="rail-icon" /> : <Moon size={18} className="rail-icon" />}
          {labels && <span className="rail-label">主题</span>}
        </button>
      </div>
    </aside>
  );
}
