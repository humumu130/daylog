import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import type { Project } from '../../types/models';

interface Props {
  value: string | null;
  projects: Project[];
  onChange: (projectId: string | null) => void;
}

/** 行内项目 chip 下拉：点 chip 换项目；无项目时是低调的「+ 项目」虚线 chip */
export function ProjectChipSelect({ value, projects, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const cur = value ? projects.find((p) => p.id === value) : undefined;
  // 活跃项目在前；当前值即使在非活跃里也可见
  const list = [
    ...projects.filter((p) => p.isActive),
    ...projects.filter((p) => !p.isActive && p.id === value),
  ];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function pick(id: string | null) {
    onChange(id);
    setOpen(false);
  }

  return (
    <span className="pcs" ref={rootRef}>
      {cur ? (
        <button
          type="button"
          className="pcs-chip"
          style={{ background: cur.color + '1a', color: cur.color }}
          title="点击更换项目"
          onClick={() => setOpen((o) => !o)}
        >
          <i className="pcs-dot" style={{ background: cur.color }} />
          {cur.name}
        </button>
      ) : (
        <button
          type="button"
          className="pcs-chip pcs-none"
          title="设置项目"
          aria-label="设置项目"
          onClick={() => setOpen((o) => !o)}
        >
          <Plus size={11} /> 项目
        </button>
      )}
      {open && (
        <div className="pcs-pop" role="listbox" aria-label="选择项目">
          {cur && (
            <button type="button" className="pcs-item" onClick={() => pick(null)}>
              移除项目归属
            </button>
          )}
          {list.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`pcs-item${p.id === value ? ' on' : ''}`}
              role="option"
              aria-selected={p.id === value}
              onClick={() => pick(p.id)}
            >
              <i className="pcs-dot" style={{ background: p.color }} />
              {p.name}
              {!p.isActive && <span className="pcs-off">已归档</span>}
            </button>
          ))}
          {list.length === 0 && !cur && <span className="pcs-empty">没有可选项目（设置里新建）</span>}
        </div>
      )}
    </span>
  );
}
