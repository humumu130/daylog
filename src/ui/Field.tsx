import { useId, type ReactNode } from 'react';

export interface FieldProps {
  label?: ReactNode;
  /** 关联控件 id（消费方传给 Input 等的同一 id） */
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
}

/** 表单字段布局：label + 控件 + hint/error，aria 语义接线 */
export function Field({ label, htmlFor, hint, error, required, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `dl-field-hint-${id}` : undefined;
  const errorId = error ? `dl-field-error-${id}` : undefined;
  return (
    <div className="dl-field">
      {label != null && (
        <label className="dl-field-label" htmlFor={htmlFor}>
          {label}
          {required && <span className="dl-field-req" aria-hidden="true">*</span>}
        </label>
      )}
      {children}
      {hint && (
        <div className="dl-field-hint" id={hintId}>
          {hint}
        </div>
      )}
      {error && (
        <div className="dl-field-error" id={errorId} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
