import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'default' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  /** 加载态：置禁用 + 内嵌小 Spinner */
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = 'default',
  size = 'md',
  loading = false,
  icon,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      data-variant={variant}
      data-size={size}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? (
        <span className="dl-btn-spin dl-spin" data-size="btn" />
      ) : (
        icon
      )}
      {children}
    </button>
  );
}
