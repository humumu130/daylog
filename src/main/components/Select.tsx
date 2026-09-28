import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}

/** 自定义下拉：不依赖组件库弹出层（避免白屏），也不丑陋（非原生 select）。内联定位，点击外部收起。 */
export function Select({ value, options, onChange, placeholder, className }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className={`select ${className ?? ''}`} ref={ref}>
      <button type="button" className="select-trigger" onClick={() => setOpen((o) => !o)}>
        <span className={selected ? '' : 'select-placeholder'}>{selected?.label ?? placeholder ?? '请选择'}</span>
        <ChevronDown size={12} className={`select-chevron${open ? ' open' : ''}`} />
      </button>
      {open && (
        <div className="select-popover">
          {options.map((o) => (
            <button
              type="button"
              key={o.value}
              className={`select-option${o.value === value ? ' active' : ''}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
