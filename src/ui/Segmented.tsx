import { useRef, type ReactNode } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  /** 屏幕阅读器组名 */
  'aria-label'?: string;
}

/** 分段单选：radiogroup 语义 + 左右方向键漫游 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  'aria-label': ariaLabel,
}: SegmentedProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (from: number, delta: number) => {
    const n = options.length;
    let i = from;
    for (let step = 0; step < n; step++) {
      i = (i + delta + n) % n;
      if (!options[i].disabled) {
        refs.current[i]?.focus();
        onChange(options[i].value);
        return;
      }
    }
  };

  return (
    <div className="dl-seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((opt, i) => {
        const on = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            data-on={on}
            data-size={size}
            tabIndex={on ? 0 : -1}
            disabled={opt.disabled}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                move(i, 1);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                move(i, -1);
              }
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
