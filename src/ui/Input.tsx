import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix' | 'suffix'> {
  invalid?: boolean;
  /** 前缀装饰（图标/单位）；使用后原边框移到容器上 */
  prefix?: ReactNode;
  suffix?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, prefix, suffix, className, ...rest },
  ref,
) {
  if (prefix || suffix) {
    return (
      <span className="dl-input-wrap">
        {prefix && <span className="dl-input-affix">{prefix}</span>}
        <input ref={ref} className="dl-input" aria-invalid={invalid || undefined} {...rest} />
        {suffix && <span className="dl-input-affix">{suffix}</span>}
      </span>
    );
  }
  return (
    <input
      ref={ref}
      className={className ? `dl-input ${className}` : 'dl-input'}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});
