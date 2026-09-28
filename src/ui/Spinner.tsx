export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  /** 屏幕阅读器文案 */
  label?: string;
}

export function Spinner({ size = 'md', label = '加载中' }: SpinnerProps) {
  return (
    <span
      className="dl-spin"
      data-size={size}
      role="status"
      aria-label={label}
    />
  );
}
