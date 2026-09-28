import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 必填：纯图标按钮的无障碍名称（tooltip 与 aria-label 共用） */
  title: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'default' | 'danger';
  children: ReactNode;
}

export function IconButton({
  title,
  size = 'md',
  variant = 'default',
  children,
  type = 'button',
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      title={title}
      aria-label={title}
      data-size={size}
      data-variant={variant}
      className={className ? `dl-iconbtn ${className}` : 'dl-iconbtn'}
      {...rest}
    >
      {children}
    </button>
  );
}
