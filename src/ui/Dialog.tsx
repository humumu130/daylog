import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 开关状态 hook：Dialog 的受控配套 */
export function useDialog(initial = false) {
  const [open, setOpen] = useState(initial);
  const openDialog = useCallback(() => setOpen(true), []);
  const closeDialog = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  return { open, setOpen, openDialog, closeDialog, toggle };
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** 内容宽度（默认 440） */
  width?: number;
}

/**
 * 模态对话框：焦点陷阱 + Esc 关闭 + 遮罩点击关闭 + 关闭后焦点还原。
 * 焦点圈定在对话框内（Tab 循环），替代 Fluent Dialog 的核心能力。
 */
export function Dialog({ open, onClose, title, children, width = 440 }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    // 记录打开者，关闭后还原焦点
    const opener = document.activeElement as HTMLElement | null;

    // 初始焦点：autofocus 元素优先，否则第一个可聚焦元素
    const panel = panelRef.current;
    if (panel) {
      const auto = panel.querySelector<HTMLElement>('[autofocus]');
      (auto ?? panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel).focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      opener?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="dl-dialog-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="dl-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ width }}
        tabIndex={-1}
      >
        <div className="dl-dialog-title" id={titleId}>
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}
