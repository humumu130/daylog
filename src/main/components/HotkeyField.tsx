import { useEffect, useState } from 'react';
import { Button, Input } from '@fluentui/react-components';

interface Props {
  value: string;
  onCommit: (accelerator: string) => void;
}

/** 热键捕获字段：点"重新设置"后监听下一次按键组合 */
export function HotkeyField({ value, onCommit }: Props) {
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    if (!capturing) return;
    function handler(e: KeyboardEvent) {
      e.preventDefault();
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      const mods: string[] = [];
      if (e.ctrlKey) mods.push('Control');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (e.metaKey) mods.push('Super');
      if (mods.length === 0) {
        setCapturing(false);
        return;
      }
      let key = e.key === ' ' ? 'Space' : e.key;
      if (key.length === 1) key = key.toUpperCase();
      onCommit([...mods, key].join('+'));
      setCapturing(false);
    }
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [capturing, onCommit]);

  return (
    <div className="row gap-sm">
      <Input value={value} readOnly className="hotkey-display" />
      <Button onClick={() => setCapturing(true)} appearance={capturing ? 'primary' : 'secondary'}>
        {capturing ? '按下组合键…' : '重新设置'}
      </Button>
    </div>
  );
}
