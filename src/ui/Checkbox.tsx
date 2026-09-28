import { useId, type ReactNode } from 'react';

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** 可选文字标签；不传则为纯方块（表格行内用） */
  label?: ReactNode;
  disabled?: boolean;
  /** 纯方块模式下给屏幕阅读器的名称 */
  ariaLabel?: string;
}

export function Checkbox({ checked, onChange, label, disabled, ariaLabel }: CheckboxProps) {
  const id = useId();
  const box = (
    <input
      id={label ? id : undefined}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label ? undefined : ariaLabel}
      onChange={(e) => onChange(e.target.checked)}
      style={{
        position: 'absolute',
        opacity: 0,
        width: 16,
        height: 16,
        margin: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    />
  );
  return (
    <label className="dl-check" style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}>
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        {box}
        <span className="dl-checkbox" data-on={checked} aria-hidden="true" />
      </span>
      {label != null && <span>{label}</span>}
    </label>
  );
}
