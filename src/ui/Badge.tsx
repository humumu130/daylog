import type { ReactNode } from 'react';

export type BadgeSrc = 'manual' | 'git' | 'ai' | 'mixed';
export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface BadgeProps {
  /** 来源徽标（四色）与语义 tone 二选一；都传时 src 优先 */
  src?: BadgeSrc;
  tone?: BadgeTone;
  /** 前置圆点（来源徽标默认带） */
  dot?: boolean;
  children: ReactNode;
}

const SRC_LABEL: Record<BadgeSrc, string> = {
  manual: '手动',
  git: 'Git',
  ai: 'AI',
  mixed: '混合',
};

export function Badge({ src, tone = 'neutral', dot, children }: BadgeProps) {
  const showDot = dot ?? src != null;
  return (
    <span className="dl-badge" data-src={src} data-tone={src ? undefined : tone}>
      {showDot && <span className="dl-badge-dot" aria-hidden="true" />}
      {children ?? (src ? SRC_LABEL[src] : null)}
    </span>
  );
}

/** 来源徽标快捷出口：默认文案 手动/Git/AI/混合 */
export function SourceBadge({ src, children }: { src: BadgeSrc; children?: ReactNode }) {
  return (
    <Badge src={src} dot>
      {children ?? SRC_LABEL[src]}
    </Badge>
  );
}
