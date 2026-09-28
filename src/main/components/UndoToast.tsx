import { useEffect, useRef, useState } from 'react';
import './palette.css'; // .dl-toast 样式与面板同文件

export interface ToastOptions {
  actionLabel?: string;
  onAction?: () => void;
  /** 停留时长（默认：带动作 5s / 纯提示 2.4s） */
  duration?: number;
}

type PushFn = (msg: string, opts?: ToastOptions) => void;

let push: PushFn | null = null;

/** 全局轻提示（任意组件可调）：toast('已删除', { actionLabel: '撤销', onAction: restore }) */
export function toast(msg: string, opts?: ToastOptions): void {
  push?.(msg, opts);
}

interface ToastItem {
  msg: string;
  opts?: ToastOptions;
  key: number;
}

/** 单槽 toast 宿主：挂在应用根部，后到覆盖先到 */
export function ToastHost() {
  const [item, setItem] = useState<ToastItem | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    push = (msg, opts) => setItem({ msg, opts, key: Date.now() });
    return () => {
      push = null;
    };
  }, []);

  useEffect(() => {
    if (!item) return;
    window.clearTimeout(timer.current);
    const ms =
      item.opts?.duration ?? (item.opts?.actionLabel ? 5000 : 2400);
    timer.current = window.setTimeout(() => setItem(null), ms);
    return () => window.clearTimeout(timer.current);
  }, [item]);

  if (!item) return null;
  return (
    <div className="dl-toast show" key={item.key} role="status">
      <span>{item.msg}</span>
      {item.opts?.actionLabel && (
        <button
          type="button"
          className="dl-toast-act"
          onClick={() => {
            item.opts?.onAction?.();
            setItem(null);
          }}
        >
          {item.opts.actionLabel}
        </button>
      )}
    </div>
  );
}
