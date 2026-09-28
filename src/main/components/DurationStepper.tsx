import { useEffect, useRef, useState } from 'react';
import { HALF_HOUR_MIN, quantizeMinutes } from '../../services/duration';

/** 快捷档（小时）：弹层一键设值 */
const QUICK_HOURS = [0.5, 1, 1.5, 2, 3, 4, 6, 8];

interface Props {
  /** 当前时长（分钟）；null = 无时长（起步 0.5h） */
  minutes: number | null;
  /** 提交量化后的分钟数（0.5h 粒度，最低 0.5h） */
  onChange: (min: number) => void;
}

function fmtH(min: number): string {
  return min % 60 === 0 ? `${min / 60}h` : `${(min / 60).toFixed(1)}h`;
}

/** 行内时长步进器：−/+ 每次 30 分钟；点中间值展开快捷档与键入 */
export function DurationStepper({ minutes, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [typing, setTyping] = useState(''); // 键入小时
  const rootRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 外点 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    setTimeout(() => inputRef.current?.select(), 30);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function commitTyped() {
    const h = parseFloat(typing);
    if (!Number.isNaN(h)) onChange(quantizeMinutes(h * 60));
    setOpen(false);
  }

  const cur = minutes ?? 0;

  return (
    <span className="dur-step" ref={rootRef}>
      <button
        type="button"
        className="dur-btn"
        title={`减 ${HALF_HOUR_MIN} 分钟`}
        aria-label="减少 30 分钟"
        onClick={() => onChange(quantizeMinutes(cur - HALF_HOUR_MIN))}
      >
        −
      </button>
      <button
        type="button"
        className="dur-val"
        title="点击选择时长"
        onClick={() => {
          setTyping(minutes != null ? String(minutes / 60) : '');
          setOpen((o) => !o);
        }}
      >
        {minutes == null ? '—' : fmtH(minutes)}
      </button>
      <button
        type="button"
        className="dur-btn"
        title={`加 ${HALF_HOUR_MIN} 分钟`}
        aria-label="增加 30 分钟"
        onClick={() => onChange(quantizeMinutes(cur + HALF_HOUR_MIN))}
      >
        ＋
      </button>
      {open && (
        <div className="dur-pop" role="dialog" aria-label="设置时长">
          <input
            ref={inputRef}
            className="dur-type"
            type="number"
            min={0.5}
            step={0.5}
            placeholder="小时"
            value={typing}
            onChange={(e) => setTyping(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitTyped();
              }
            }}
          />
          <span className="dur-quick">
            {QUICK_HOURS.map((h) => (
              <button
                key={h}
                type="button"
                className={`dur-q${minutes === h * 60 ? ' on' : ''}`}
                onClick={() => {
                  onChange(h * 60);
                  setOpen(false);
                }}
              >
                {fmtH(h * 60)}
              </button>
            ))}
          </span>
          <div className="dur-hint">步进 30 分钟 · 最低 0.5h</div>
        </div>
      )}
    </span>
  );
}
