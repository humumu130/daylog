import { useEffect, useRef, useState } from 'react';
import { ListTodo, Pencil, Trash2 } from 'lucide-react';
import { Badge, SourceBadge } from '../../ui';
import { RECORD_TYPE_LABELS, type Project, type RecordSource, type RecordType, type WorkRecord } from '../../types/models';
import type { RecordInput } from '../../services/db';
import { DurationStepper } from './DurationStepper';
import { ProjectChipSelect } from './ProjectChipSelect';

/** 行内可编辑字段（页面合并成全量 RecordInput 后落库） */
export interface EntryPatch {
  content?: string;
  durationMin?: number | null;
  projectId?: string | null;
  /** 学到什么（个人空间，行内整组覆写；每行一条由组件侧拆好） */
  learnings?: string[];
}

/** 个人空间记录类型徽标建议色（内联色值 + 1a 透明底，参照 SourceBadge/tl-ptag 做法；
 *  work 类型不显示徽标故不在表内） */
const RECORD_TYPE_COLORS: Partial<Record<RecordType, string>> = {
  learning: '#8b5cf6',
  practice: '#3b82f6',
  milestone: '#f59e0b',
  thought: '#94a3b8',
  retro: '#10b981',
};

/** 已有记录 → 全量落库载荷（保 meta/source 及 P8b 空间字段不丢）；TimelineEntry 消费方共用 */
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
    workspaceId: r.workspaceId,
    recordType: r.recordType,
    learnings: r.learnings,
    tags: r.tags,
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
  /** 转为待办（todo⇄record 双向的 record→todo 侧）；不传则不显示该按钮 */
  onToTodo?: (r: WorkRecord) => void;
}

const EXTRA_SRC_LABEL: Partial<Record<RecordSource, string>> = {
  timer: '计时',
  import: '导入',
};

function sourceBadge(source: RecordSource) {
  // 四色徽标直通（P5 后 ai/mixed 已是真实来源值）；timer/import 走中性徽标
  if (source === 'manual' || source === 'git' || source === 'ai' || source === 'mixed') return <SourceBadge src={source} />;
  return <Badge tone="neutral">{EXTRA_SRC_LABEL[source] ?? source}</Badge>;
}

/** 记录类型徽标（个人空间条目）；work 类型不显示 */
function recordTypeBadge(t: RecordType) {
  if (t === 'work') return null;
  const color = RECORD_TYPE_COLORS[t] ?? '#94a3b8';
  return (
    <span className="rt-type-badge" style={{ color, background: color + '1a' }}>
      {RECORD_TYPE_LABELS[t]}
    </span>
  );
}

/**
 * 时间轴条目 v2：行内编辑（双击内容 / stepper 改时长 / chip 换项目）+ 键盘（E 编辑 · Del 删除 · ↑↓ 行导航）。
 * RecordEditor 退居全字段兜底。
 */
export function TimelineEntry({ record, projects, onUpdate, onEdit, onDelete, onToTodo }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(record.content);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // 学到什么（P8b 个人空间）：行内展开编辑，每行一条（RecordEditor 不动，编辑走此内联）
  const isPersonal = record.recordType !== 'work';
  const [learnEditing, setLearnEditing] = useState(false);
  const [learnDraft, setLearnDraft] = useState(() => record.learnings.join('\n'));
  const learnTaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(record.content);
  }, [record.content, editing]);

  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!learnEditing) setLearnDraft(record.learnings.join('\n'));
  }, [record.learnings, learnEditing]);

  useEffect(() => {
    if (learnEditing) learnTaRef.current?.focus();
  }, [learnEditing]);

  function commitContent() {
    const t = draft.trim();
    if (t && t !== record.content) onUpdate(record.id, { content: t });
    setEditing(false);
  }

  /** 学到什么落库：按行拆分、去空去重（顺序保留） */
  function commitLearnings() {
    const lines = learnDraft
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const deduped = [...new Set(lines)];
    if (deduped.join('\n') !== record.learnings.join('\n')) onUpdate(record.id, { learnings: deduped });
    setLearnEditing(false);
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
        {isPersonal && recordTypeBadge(record.recordType)}
        {isPersonal && !learnEditing && (
          <button
            type="button"
            className={`rt-learn-chip${record.learnings.length === 0 ? ' is-empty' : ''}`}
            title="学到什么（每行一条）"
            onClick={() => setLearnEditing(true)}
          >
            {record.learnings.length > 0 ? `学到 ${record.learnings.length}` : '+ 学到'}
          </button>
        )}
        <span className="tl-actions">
          {onToTodo && (
            <button
              className="icon-btn"
              title="转为待办（进待办浮窗）"
              onClick={() => onToTodo(record)}
            >
              <ListTodo size={16} />
            </button>
          )}
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
      {isPersonal && learnEditing && (
        <div className="rt-entry-sub">
          <textarea
            ref={learnTaRef}
            className="rt-learn-edit"
            rows={Math.max(2, record.learnings.length + 1)}
            placeholder="学到什么，每行一条"
            value={learnDraft}
            onChange={(e) => setLearnDraft(e.target.value)}
            onBlur={commitLearnings}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setLearnDraft(record.learnings.join('\n'));
                setLearnEditing(false);
              }
            }}
          />
        </div>
      )}
      {isPersonal && !learnEditing && record.learnings.length > 0 && (
        <ul className="rt-entry-sub rt-learn-list" title="点击编辑学到什么">
          {record.learnings.map((l, i) => (
            <li key={i} onClick={() => setLearnEditing(true)}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
