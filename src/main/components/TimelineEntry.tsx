import { useEffect, useRef, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Badge, SourceBadge } from '../../ui';
import type { Project, RecordSource, WorkRecord } from '../../types/models';
import type { RecordInput } from '../../services/db';
import { DurationStepper } from './DurationStepper';
import { ProjectChipSelect } from './ProjectChipSelect';

/** 行内可编辑字段（页面合并成全量 RecordInput 后落库） */
export interface EntryPatch {
  content?: string;
  durationMin?: number | null;
  projectId?: string | null;
}

/** 已有记录 → 全量落库载荷（保 meta/source 等字段不丢）；TimelineEntry 消费方共用 */
export function recordToInput(r: WorkRecord): RecordInput {
  return {
    content: r.content,
    durationMin: r.durationMin,
    day: r.day,
    half: r.half,
    taskId: r.taskId,
    projectId: r.projectId,
    source: r.source,
    meta: r.meta,
  };
}

export function truncateEntry(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

interface Props {
  record: WorkRecord;
  projects: Project[];
  onUpdate: (id: string, patch: EntryPatch) => void;
  /** 全字段编辑（RecordEditor 兜底）：行内 E 键 / 编辑按钮 */
  onEdit: (r: WorkRecord) => void;
  onDelete: (r: WorkRecord) => void;
}

const EXTRA_SRC_LABEL: Partial<Record<RecordSource, string>> = {
  timer: '计时',
  import: '导入',
};

function sourceBadge(source: RecordSource) {
  if (source === 'manual' || source === 'git') return <SourceBadge src={source} />;
  // timer/import（及 P5 后扩展值）在中性徽标里展示中文标签
  return <Badge tone="neutral">{EXTRA_SRC_LABEL[source] ?? source}</Badge>;
}

/**
 * 时间轴条目 v2：行内编辑（双击内容 / stepper 改时长 / chip 换项目）+ 键盘（E 编辑 · Del 删除 · ↑↓ 行导航）。
 * RecordEditor 退居全字段兜底。
 */
export function TimelineEntry({ record, projects, onUpdate, onEdit, onDelete }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(record.content);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(record.content);
  }, [record.content, editing]);

  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  function commitContent() {
    const t = draft.trim();
    if (t && t !== record.content) onUpdate(record.id, { content: t });
    setEditing(false);
  }

  /** 行级键盘：焦点在行自身（非内部控件）时生效 */
  function onRowKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'e' || e.key === 'E') {
      e.preventDefault();
      onEdit(record);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onDelete(record);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const row = e.currentTarget;
      const rows = Array.from(
        row.closest('.tl')?.querySelectorAll<HTMLElement>('.tl-row') ?? [],
      );
      const idx = rows.indexOf(row);
      const next = rows[idx + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) {
        e.preventDefault();
        next.focus();
      }
    }
  }

  const d = new Date(record.createdAt);
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

  return (
    <div className="tl-row" tabIndex={0} onKeyDown={onRowKeyDown}>
      <span className="tl-time">{time}</span>
      <div className="tl-axis">
        <span className="tl-dot" />
      </div>
      <div className="tl-body">
        {editing ? (
          <textarea
            ref={taRef}
            className="tl-content-edit"
            value={draft}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitContent}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                commitContent();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setDraft(record.content);
                setEditing(false);
              }
            }}
          />
        ) : (
          <span
            className="tl-content"
            title="双击编辑内容"
            onDoubleClick={() => setEditing(true)}
          >
            {record.content}
          </span>
        )}
        <ProjectChipSelect
          value={record.projectId}
          projects={projects}
          onChange={(projectId) => onUpdate(record.id, { projectId })}
        />
        <DurationStepper
          minutes={record.durationMin}
          onChange={(durationMin) => onUpdate(record.id, { durationMin })}
        />
        {sourceBadge(record.source)}
        <span className="tl-actions">
          <button
            className="icon-btn"
            title="编辑（全字段）"
            onClick={() => onEdit(record)}
          >
            <Pencil size={16} />
          </button>
          <button
            className="icon-btn"
            title="删除"
            onClick={() => onDelete(record)}
          >
            <Trash2 size={16} />
          </button>
        </span>
      </div>
    </div>
  );
}
