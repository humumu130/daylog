import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { Kbd, Spinner } from '../../ui';
import { COMMANDS, loadRecents, pushRecent, type Command } from '../commands';
import { useUiStore } from '../../stores/useUiStore';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useTasksStore } from '../../stores/useTasksStore';
import { searchRecords } from '../../services/db';
import type { WorkRecord } from '../../types/models';
import { formatYMDChinese } from '../../utils/date';
import { formatHM } from '../../utils/halfDay';
import './palette.css';

interface PalItem {
  key: string;
  icon?: React.ReactNode;
  main: React.ReactNode;
  sub?: string;
  hotkey?: string;
  /** 右侧彩色小标签（记录行的项目归属） */
  tag?: { text: string; color?: string };
  run: () => void;
}

/** 命令面板（⌘K）：命令注册表 + 跨源搜索（记录/项目/任务），全键盘操作 */
export function CommandPalette() {
  const open = useUiStore((s) => s.searchOpen);
  const close = useUiStore((s) => s.closeSearch);
  const requestGotoDay = useUiStore((s) => s.requestGotoDay);
  const projects = useProjectsStore((s) => s.projects);
  const tasks = useTasksStore((s) => s.tasks);
  const navigate = useNavigate();

  const [q, setQ] = useState('');
  const [records, setRecords] = useState<WorkRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 打开：清空、聚焦；Esc 关闭
  useEffect(() => {
    if (!open) return;
    setQ('');
    setRecords([]);
    setCursor(0);
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  // 防抖搜索记录（250ms）
  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setRecords([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        setRecords(await searchRecords(query));
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const query = q.trim().toLowerCase();

  const matchedCommands = useMemo(
    () =>
      COMMANDS.filter(
        (c) =>
          !query ||
          c.title.toLowerCase().includes(query) ||
          (c.sub?.toLowerCase().includes(query) ?? false) ||
          (c.keywords?.some((k) => k.toLowerCase().includes(query)) ?? false),
      ),
    [query],
  );

  const recentCmds = useMemo(() => {
    if (query) return [];
    const byId = new Map(COMMANDS.map((c) => [c.id, c]));
    return loadRecents()
      .map((id) => byId.get(id))
      .filter((c): c is Command => Boolean(c))
      .slice(0, 5);
  }, [query]);

  const matchedProjects = useMemo(() => {
    if (!query) return [];
    return projects
      .filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          p.keywords.some((k) => k.toLowerCase().includes(query)),
      )
      .slice(0, 5);
  }, [query, projects]);

  const matchedTasks = useMemo(() => {
    if (!query) return [];
    return tasks.filter((t) => t.title.toLowerCase().includes(query)).slice(0, 5);
  }, [query, tasks]);

  const ctx = useMemo(
    () => ({ navigate: (to: string) => void navigate(to), requestGotoDay }),
    [navigate, requestGotoDay],
  );
  const projName = (id: string | null) =>
    id ? projects.find((p) => p.id === id)?.name : undefined;
  const projColor = (id: string | null) =>
    id ? projects.find((p) => p.id === id)?.color : undefined;

  // 分区 → 扁平项（键盘光标作用其上）
  const sections = useMemo(() => {
    const secs: { label: string; items: PalItem[] }[] = [];
    const cmdItem = (c: Command): PalItem => ({
      key: `cmd-${c.id}`,
      icon: <c.icon size={16} />,
      main: c.title,
      sub: c.sub,
      hotkey: c.hotkey,
      run: () => {
        pushRecent(c.id);
        c.run(ctx);
        close();
      },
    });
    if (recentCmds.length) {
      secs.push({ label: '最近使用', items: recentCmds.map(cmdItem) });
    }
    for (const g of ['快捷操作', '页面', '跳转日期'] as const) {
      const items = matchedCommands.filter((c) => c.group === g).map(cmdItem);
      if (items.length) secs.push({ label: g, items });
    }
    if (matchedProjects.length) {
      secs.push({
        label: '项目',
        items: matchedProjects.map((p) => ({
          key: `proj-${p.id}`,
          icon: (
            <span
              className="pal-wdot"
              style={{ background: p.color, margin: '0 4px' }}
            />
          ),
          main: p.name,
          sub: p.keywords.length ? p.keywords.join('，') : undefined,
          run: () => {
            navigate('/settings');
            close();
          },
        })),
      });
    }
    if (matchedTasks.length) {
      secs.push({
        label: '任务',
        items: matchedTasks.map((t) => ({
          key: `task-${t.id}`,
          main: t.title,
          sub: t.status === 'done' ? '已完成' : '进行中',
          run: () => {
            navigate('/today');
            close();
          },
        })),
      });
    }
    if (records.length) {
      secs.push({
        label: `记录 (${records.length}${records.length >= 60 ? '+' : ''})`,
        items: records.map<PalItem>((r) => {
          const name = projName(r.projectId);
          const color = projColor(r.projectId);
          return {
            key: `rec-${r.id}`,
            main: r.content,
            sub: r.day
              ? formatYMDChinese(r.day) +
                (r.durationMin != null ? ` · ${formatHM(r.durationMin)}` : '')
              : undefined,
            tag: name ? { text: name, color } : undefined,
            run: () => {
              if (r.day) requestGotoDay(r.day);
              navigate('/today');
              close();
            },
          };
        }),
      });
    }
    return secs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentCmds, matchedCommands, matchedProjects, matchedTasks, records, ctx]);

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  // 光标重置（结果变化时）
  useEffect(() => {
    setCursor(0);
  }, [q]);

  // 滚动跟随光标
  useEffect(() => {
    bodyRef.current
      ?.querySelectorAll('.pal-item')
      [cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!open) return null;

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (flat.length ? (c + 1) % flat.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (flat.length ? (c - 1 + flat.length) % flat.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      flat[cursor]?.run();
    } else if (e.key === 'Tab') {
      // Tab：跳到下一分区首项
      e.preventDefault();
      let acc = 0;
      for (const s of sections) {
        acc += s.items.length;
        if (acc > cursor) {
          setCursor(Math.min(acc, flat.length - 1));
          return;
        }
      }
    }
  }

  const empty =
    query && !loading && flat.length === 0 && matchedProjects.length === 0;

  return (
    <div
      className="pal-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="pal-panel" onKeyDown={onKey}>
        <div className="pal-input-row">
          <Search size={18} />
          <input
            ref={inputRef}
            className="pal-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索命令 / 记录 / 项目 / 任务…"
            spellCheck={false}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div className="pal-body" ref={bodyRef}>
          {!query && (
            <div className="pal-group-h">输入关键词搜索全部记录；或直接执行命令</div>
          )}
          {empty && <div className="pal-empty">没有匹配结果</div>}
          {loading && (
            <div className="pal-loading">
              <Spinner size="sm" /> 搜索记录中…
            </div>
          )}
          {sections.map((s) => (
            <div key={s.label}>
              <div className="pal-group-h">{s.label}</div>
              {s.items.map((it) => {
                const idx = flat.indexOf(it);
                const on = idx === cursor;
                return (
                  <button
                    key={it.key}
                    type="button"
                    className={`pal-item${on ? ' on' : ''}`}
                    onMouseEnter={() => setCursor(idx)}
                    onClick={() => it.run()}
                  >
                    {it.icon}
                    <span className="pal-item-main">{it.main}</span>
                    {it.sub && <span className="pal-item-sub">{it.sub}</span>}
                    {it.tag && (
                      <span
                        className="pal-tag"
                        style={{
                          background: (it.tag.color ?? '#888') + '1a',
                          color: it.tag.color ?? '#888',
                        }}
                      >
                        {it.tag.text}
                      </span>
                    )}
                    {it.hotkey && <span className="pal-item-hk">{it.hotkey}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="pal-foot">
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> 选择
          </span>
          <span>
            <Kbd>↵</Kbd> 执行
          </span>
          <span>
            <Kbd>Tab</Kbd> 切组
          </span>
          <span>
            <Kbd>Esc</Kbd> 关闭
          </span>
        </div>
      </div>
    </div>
  );
}
