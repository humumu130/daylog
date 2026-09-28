// 通用建议审核列表（P6）：F1 猪齿鱼映射 / F2 未映射 cwd 归组两场景共用。
// SuggestionRow 契约由主会话与各消费页面依赖，形状变更需全局同步。
// 行为：仅 confidence ≥0.85 默认勾选；「应用 N 项」提交勾选项；行内可换目标/忽略单条；
// busy 时列表半透明 + Spinner；空态出 EmptyState。

import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Badge, Button, Checkbox, EmptyState, IconButton, Spinner } from '../../ui';
import { Select } from './Select';

export interface SuggestionRow {
  id: string;            // 唯一键
  summary: string;       // 主行（如 /Users/xdd/dev/foo）
  detail?: string;       // 次行说明（来源/会话数）
  confidence: number;    // 0~1
  ruleBased?: boolean;   // 规则模式降级徽标（「规则」小徽标，title=未配置 LLM，按规则初筛）
  kind: 'map-project' | 'new-project' | 'ignore';
  targetOptions: { id: string; label: string }[]; // 目标下拉候选（项目或「新建项目」）
  targetId: string;      // 当前选中
}

export interface SuggestionListProps {
  title: string;
  items: SuggestionRow[];
  busy?: boolean;
  onTargetChange: (id: string, targetId: string) => void;
  onDismiss: (id: string) => void;          // 忽略单条（本次会话不再出现）
  onApply: (selected: SuggestionRow[]) => void; // 应用勾选项
}

/** 默认勾选阈值（与 configSuggest 的 HIGH 一致） */
const DEFAULT_CHECK = 0.85;

const KIND_LABEL: Record<SuggestionRow['kind'], string> = {
  'map-project': '归组',
  'new-project': '新建',
  ignore: '忽略',
};
/** kind 三色中性徽标：归组=主题色 / 新建=绿 / 忽略=灰 */
const KIND_TONE: Record<SuggestionRow['kind'], 'accent' | 'success' | 'neutral'> = {
  'map-project': 'accent',
  'new-project': 'success',
  ignore: 'neutral',
};

export function SuggestionList({
  title,
  items,
  busy = false,
  onTargetChange,
  onDismiss,
  onApply,
}: SuggestionListProps) {
  // 勾选状态（id → 勾否）：新出现的行按 confidence≥0.85 给默认值，已在的行保留用户选择
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setChecked((prev) => {
      const next: Record<string, boolean> = {};
      let changed = Object.keys(prev).length !== items.length;
      for (const it of items) {
        const v = prev[it.id] ?? it.confidence >= DEFAULT_CHECK;
        next[it.id] = v;
        if (v !== prev[it.id]) changed = true;
      }
      return changed ? next : prev; // 内容未变沿用旧引用，避免多余渲染
    });
  }, [items]);

  const selected = useMemo(() => items.filter((it) => checked[it.id]), [items, checked]);

  if (items.length === 0) {
    return (
      <section className="sug-list" aria-busy={busy}>
        <h4 className="sug-title">{title}</h4>
        {busy ? (
          <div className="sug-loading">
            <Spinner size="sm" />
            <span>加载建议中…</span>
          </div>
        ) : (
          <EmptyState title="没有待处理建议" />
        )}
      </section>
    );
  }

  return (
    <section className="sug-list" aria-busy={busy}>
      <header className="sug-head">
        <h4 className="sug-title">{title}</h4>
        <div className="sug-head-actions">
          {busy && <Spinner size="sm" />}
          <Button
            variant="primary"
            size="sm"
            disabled={busy || selected.length === 0}
            onClick={() => onApply(selected)}
          >
            应用 {selected.length} 项
          </Button>
        </div>
      </header>
      <ul className={busy ? 'sug-rows is-busy' : 'sug-rows'}>
        {items.map((it) => (
          <li key={it.id} className="sug-row">
            <Checkbox
              checked={!!checked[it.id]}
              onChange={(c) => setChecked((prev) => ({ ...prev, [it.id]: c }))}
              ariaLabel={`选择建议 ${it.summary}`}
            />
            <div className="sug-main">
              <div className="sug-summary">
                <Badge tone={KIND_TONE[it.kind]}>{KIND_LABEL[it.kind]}</Badge>
                <span className="sug-path" title={it.summary}>
                  {it.summary}
                </span>
                {it.ruleBased && (
                  <span className="sug-rule" title="未配置 LLM，按规则初筛">
                    <Badge tone="warning">规则</Badge>
                  </span>
                )}
              </div>
              {it.detail && <div className="sug-detail">{it.detail}</div>}
            </div>
            <span className="sug-conf" title="建议置信度">
              {Math.round(it.confidence * 100)}%
            </span>
            <div className="sug-target">
              <Select
                value={it.targetId}
                options={it.targetOptions.map((o) => ({ value: o.id, label: o.label }))}
                onChange={(v) => onTargetChange(it.id, v)}
              />
            </div>
            <IconButton
              title="忽略此条（本次会话不再出现）"
              size="sm"
              disabled={busy}
              onClick={() => onDismiss(it.id)}
            >
              <X size={14} />
            </IconButton>
          </li>
        ))}
      </ul>
    </section>
  );
}
