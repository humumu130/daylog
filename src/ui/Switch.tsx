import type { ButtonHTMLAttributes } from 'react';

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'value'> {
  checked: boolean;
  onChange: (checked: boolean, e: React.MouseEvent<HTMLButtonElement>) => void;
  /** 配套文案（开关旁说明）由消费方布局，这里只出轨道 */
}

export function Switch({ checked, onChange, disabled, ...rest }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-on={checked}
      disabled={disabled}
      onClick={(e) => onChange(!checked, e)}
      {...rest}
    />
  );
}
