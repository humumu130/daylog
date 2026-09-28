import type { ReactNode } from 'react';

export interface EmptyStateProps {
  /** 图标（建议 lucide-react 组件，24~32px） */
  icon?: ReactNode;
  title: ReactNode;
  desc?: ReactNode;
  /** 操作区（如 Button） */
  action?: ReactNode;
}

export function EmptyState({ icon, title, desc, action }: EmptyStateProps) {
  return (
    <div className="dl-empty">
      {icon && <div className="dl-empty-icon" aria-hidden="true">{icon}</div>}
      <div className="dl-empty-title">{title}</div>
      {desc && <div className="dl-empty-desc">{desc}</div>}
      {action && <div className="dl-empty-action">{action}</div>}
    </div>
  );
}
