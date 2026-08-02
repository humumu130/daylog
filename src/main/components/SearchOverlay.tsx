import { useEffect, useMemo, useRef, useState } from 'react';
import { SearchRegular, DismissRegular } from '@fluentui/react-icons';
import { useUiStore } from '../../stores/useUiStore';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useTasksStore } from '../../stores/useTasksStore';
import { searchRecords } from '../../services/db';
import type { WorkRecord } from '../../types/models';
import { formatYMDChinese } from '../../utils/date';
import { formatHM } from '../../utils/halfDay';
import { useNavigate } from 'react-router-dom';

/** 全局搜索：跨记录内容 / 项目 / 任务。点记录跳到对应日期的今日页。 */
export function SearchOverlay() {
  const open = useUiStore((s) => s.searchOpen);
  const close = useUiStore((s) => s.closeSearch);
  const requestGotoDay = useUiStore((s) => s.requestGotoDay);
  const projects = useProjectsStore((s) => s.projects);
  const tasks = useTasksStore((s) => s.tasks);
  const navigate = useNavigate();

  const [q, setQ] = useState('');
  const [records, setRecords] = useState<WorkRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开时聚焦、清空；Esc 关闭
  useEffect(() => {
    if (!open) return;
    setQ(''); setRecords([]);
    setTimeout(() => inputRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  // 防抖搜索（250ms）
  useEffect(() => {
    const query = q.trim();
    if (!query) { setRecords([]); setLoading(false); return; }
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

  const projName = (id: string | null) => (id ? projects.find((p) => p.id === id)?.name : undefined);
  const projColor = (id: string | null) => (id ? projects.find((p) => p.id === id)?.color : undefined);

  const matchedProjects = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    return projects.filter((p) => p.name.toLowerCase().includes(query) || p.keywords.some((k) => k.toLowerCase().includes(query))).slice(0, 5);
  }, [q, projects]);

  const matchedTasks = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    return tasks.filter((t) => t.title.toLowerCase().includes(query)).slice(0, 5);
  }, [q, tasks]);

  if (!open) return null;

  const hasQuery = q.trim().length > 0;
  const empty = hasQuery && !loading && records.length === 0 && matchedProjects.length === 0 && matchedTasks.length === 0;

  function gotoRecord(r: WorkRecord) {
    requestGotoDay(r.day);
    navigate('/today');
  }

  return (
    <div className="search-mask" onClick={close}>
      <div className="search-panel" onClick={(e) => e.stopPropagation()}>
        <div className="search-input-row">
          <SearchRegular className="search-icon" />
          <input
            ref={inputRef}
            className="search-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索记录 / 项目 / 任务…"
          />
          <button className="icon-btn" title="关闭 (Esc)" onClick={close}><DismissRegular /></button>
        </div>

        <div className="search-body">
          {!hasQuery && <div className="search-hint">输入关键词，搜索全部历史记录、项目、任务</div>}
          {empty && <div className="search-hint">没有匹配结果</div>}

          {matchedProjects.length > 0 && (
            <div className="search-group">
              <div className="search-group-h">项目</div>
              {matchedProjects.map((p) => (
                <div key={p.id} className="search-item">
                  <span className="wdot" style={{ background: p.color }} />
                  <span className="search-item-title">{p.name}</span>
                  {p.keywords.length > 0 && <span className="muted search-item-sub">{p.keywords.join('，')}</span>}
                </div>
              ))}
            </div>
          )}

          {matchedTasks.length > 0 && (
            <div className="search-group">
              <div className="search-group-h">任务</div>
              {matchedTasks.map((t) => (
                <div key={t.id} className="search-item">
                  <span className="search-item-title">{t.title}</span>
                  <span className="muted search-item-sub">{t.status === 'done' ? '已完成' : '进行中'}</span>
                </div>
              ))}
            </div>
          )}

          {records.length > 0 && (
            <div className="search-group">
              <div className="search-group-h">记录 ({records.length}{records.length >= 60 ? '+' : ''})</div>
              {records.map((r) => {
                const name = projName(r.projectId);
                const color = projColor(r.projectId);
                return (
                  <div key={r.id} className="search-item search-clickable" onClick={() => gotoRecord(r)}>
                    <span className="search-item-title">{r.content}</span>
                    {name && <span className="search-tag" style={{ background: (color ?? '#888') + '1a', color: color ?? '#888' }}>{name}</span>}
                    {r.durationMin != null && <span className="muted search-item-sub">{formatHM(r.durationMin)}</span>}
                    <span className="muted search-item-date">{formatYMDChinese(r.day)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
