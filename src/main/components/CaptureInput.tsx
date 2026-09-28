import type { KeyboardEvent, ReactNode, Ref } from 'react';
import { Input } from '../../ui';

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Enter（无 Shift）提交 */
  onSubmit: () => void;
  onEsc?: () => void;
  placeholder?: string;
  /** 前缀图标（默认场景铅笔、成功闪变 ✓ 由调用方传入） */
  icon?: ReactNode;
  inputRef?: Ref<HTMLInputElement>;
  /** 外层包裹类名（ui Input 前缀模式根节点不吃 className，故由本组件提供包裹层） */
  wrapClassName?: string;
}

/**
 * 捕获输入行（CaptureBar 与快速记录浮窗共用）：
 * NL 语法输入 + Enter 提交 + Esc 交由调用方处理（浮窗=隐藏，主窗=无操作）。
 */
export function CaptureInput({
  value,
  onChange,
  onSubmit,
  onEsc,
  placeholder,
  icon,
  inputRef,
  wrapClassName,
}: Props) {
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    } else if (e.key === 'Escape') {
      onEsc?.();
    }
  }
  return (
    <span className={wrapClassName ? `ci-wrap ${wrapClassName}` : 'ci-wrap'}>
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        prefix={icon}
      />
    </span>
  );
}
