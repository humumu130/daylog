import type { ComponentType, SVGProps } from 'react';
import { NavLink } from 'react-router-dom';
import {
  AppsRegular,
  BranchRegular,
  CalendarMonthRegular,
  CalendarTodayRegular,
  SearchRegular,
  SettingsRegular,
  WeatherMoonRegular,
  WeatherSunnyRegular,
} from '@fluentui/react-icons';
import { toggleWidget } from '../services/window';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useUiStore } from '../stores/useUiStore';

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

const NAV: { to: string; label: string; icon: IconType }[] = [
  { to: '/today', label: '今日', icon: CalendarTodayRegular },
  { to: '/calendar', label: '月报', icon: CalendarMonthRegular },
  { to: '/git', label: 'Git', icon: BranchRegular },
  { to: '/settings', label: '设置', icon: SettingsRegular },
];

export function Sidebar() {
  const theme = useSettingsStore((s) => s.settings.theme);
  const patch = useSettingsStore((s) => s.patch);
  const openSearch = useUiStore((s) => s.openSearch);
  const isDark = theme === 'dark';

  return (
    <aside className="rail">
      <div className="rail-brand" title="日迹" data-tauri-drag-region>
        日迹
      </div>
      <nav className="rail-nav">
        <button className="rail-item" title="搜索 (Ctrl+K)" onClick={openSearch}>
          <SearchRegular className="rail-icon" />
        </button>
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `rail-item${isActive ? ' active' : ''}`}
            title={label}
          >
            <Icon className="rail-icon" />
          </NavLink>
        ))}
      </nav>
      <div className="rail-foot">
        <button className="rail-item" title="待办插件 (Alt+Shift+J)" onClick={() => void toggleWidget()}>
          <AppsRegular className="rail-icon" />
        </button>
        <button
          className="rail-item"
          title={isDark ? '切换浅色' : '切换深色'}
          onClick={() => void patch({ theme: isDark ? 'light' : 'dark' })}
        >
          {isDark ? <WeatherSunnyRegular className="rail-icon" /> : <WeatherMoonRegular className="rail-icon" />}
        </button>
      </div>
    </aside>
  );
}
