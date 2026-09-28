import { useEffect, useState } from 'react';
import { Briefcase, ListTodo, Moon, Search, Sprout, Sun } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { NAV } from './nav';
import { toggleWidget } from '../services/window';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useUiStore } from '../stores/useUiStore';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';

/**
 * 图标轨：唯一导航。可选「图标+文字」模式（设置·通用 sidebarLabels，默认纯图标保持密度）。
 * P8b：底部空间切换器（仅未归档空间 >1 时渲染，单空间零打扰）；
 * 「报告」导航文案随当前空间类型（work=报告 / personal=复盘，路由不变，页面内 D 路分流）。
 */
export function Sidebar() {
  const theme = useSettingsStore((s) => s.settings.theme);
  const labels = useSettingsStore((s) => s.settings.sidebarLabels);
  const patch = useSettingsStore((s) => s.patch);
  const openPalette = useUiStore((s) => s.openSearch);
  const isDark = theme === 'dark';
  const wsKind = useWorkspaceStore((s) => s.current()?.type ?? 'work');

  // ⌘/Ctrl+⇧+W 循环切换空间（与 ⌘1..5 / ⌘K 不冲突；单空间时静默不响应）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== 'w') return;
      const st = useWorkspaceStore.getState();
      const pool = st.workspaces.filter((w) => !w.archived);
      if (pool.length < 2) return;
      e.preventDefault();
      const idx = pool.findIndex((w) => w.id === st.currentId);
      const next = pool[(idx + 1 + pool.length) % pool.length];
      if (next) st.switchTo(next.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
        {NAV.map(({ to, label, icon: Icon, hotkeyIndex }) => {
          // 报告/复盘 同页不同名：文案随空间类型，路由与快捷键不动
          const text = to === '/reports' && wsKind === 'personal' ? '复盘' : label;
          return (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `rail-item${isActive ? ' active' : ''}`}
              title={`${text} (⌘${hotkeyIndex})`}
            >
              <Icon size={18} className="rail-icon" />
              {labels && <span className="rail-label">{text}</span>}
            </NavLink>
          );
        })}
      </nav>
      <div className="rail-foot">
        <WorkspaceSwitcher labels={labels} />
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

/** 底部空间切换器：当前空间图标+名+类型徽标，点击弹小菜单列其它未归档空间 */
function WorkspaceSwitcher({ labels }: { labels: boolean }) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const currentId = useWorkspaceStore((s) => s.currentId);
  const [open, setOpen] = useState(false);

  const active = workspaces.filter((w) => !w.archived);
  const current = active.find((w) => w.id === currentId) ?? null;
  const others = active.filter((w) => w.id !== current?.id);
  // 单空间完全隐藏：零打扰（首启只选一种 / 未建第二空间时）
  if (active.length < 2 || !current) return null;

  const KindIcon = current.type === 'work' ? Briefcase : Sprout;
  const kindText = current.type === 'work' ? '工作' : '个人';

  return (
    <div className="ws-switch">
      <button
        type="button"
        className={`rail-item ws-switch-btn${open ? ' active' : ''}`}
        title={`空间：${current.name}（${kindText}）· 点击切换，⌘⇧W 循环`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <KindIcon size={18} className="rail-icon" />
        {!labels && current.type === 'personal' && <span className="ws-switch-badge" aria-hidden="true">个</span>}
        {labels && (
          <span className="rail-label ws-switch-label">
            <span className="ws-switch-name">{current.name}</span>
            <span className="ws-kind">{kindText}</span>
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="ws-menu-mask" onClick={() => setOpen(false)} />
          <div className="ws-menu" role="menu" aria-label="切换空间">
            <div className="ws-menu-h">切换空间</div>
            {others.map((w) => (
              <button
                key={w.id}
                type="button"
                role="menuitem"
                className="ws-menu-item"
                onClick={() => {
                  setOpen(false);
                  useWorkspaceStore.getState().switchTo(w.id);
                }}
              >
                {w.type === 'work' ? <Briefcase size={14} /> : <Sprout size={14} />}
                <span className="ws-menu-name">{w.name}</span>
                <span className="ws-kind">{w.type === 'work' ? '工作' : '个人'}</span>
                {w.isDefault && <span className="ws-menu-def">默认</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
