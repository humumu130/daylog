import { useEffect, useRef } from 'react';
import { Button } from '@fluentui/react-components';

interface Props {
  open: boolean;
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 轻量确认弹窗：防止误删数据。Esc 取消，回车确认。 */
export function ConfirmDialog({
  open,
  title = '确认操作',
  message,
  confirmText = '确认',
  cancelText = '取消',
  destructive = false,
  onConfirm,
  onCancel,
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  // 防止回车在一次打开内重复触发确认
  const confirmedRef = useRef(false);

  // 打开时聚焦卡片，让 Esc/回车生效（按钮 autofocus 对 div 无效）
  useEffect(() => {
    if (!open) return;
    confirmedRef.current = false;
    cardRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const doConfirm = () => {
    if (confirmedRef.current) return;
    confirmedRef.current = true;
    onConfirm();
  };

  return (
    <div className="cf-mask" onClick={onCancel}>
      <div
        ref={cardRef}
        className="cf-card"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // 卡片自身（非按钮）按键：Esc 取消、回车确认
          if (e.key === 'Escape') onCancel();
          else if (e.key === 'Enter') doConfirm();
        }}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        <h3 className="cf-title">{title}</h3>
        <p className="cf-msg">{message}</p>
        <div className="cf-actions">
          <Button size="small" onClick={onCancel}>{cancelText}</Button>
          <Button
            size="small"
            appearance="primary"
            className={destructive ? 'cf-danger' : ''}
            onClick={doConfirm}
          >
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  );
}
