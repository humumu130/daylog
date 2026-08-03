import { useEffect, useMemo, useState } from 'react';
import { Button } from '@fluentui/react-components';
import * as db from '../../services/db';
import { allocate, type AllocResult } from '../../services/allocate';
import { addDays, todayYMD } from '../../utils/date';
import { formatHours } from '../../utils/halfDay';

export interface SelectedItem {
  key: string;
  estHours: number;
}

interface Props {
  open: boolean;
  selected: SelectedItem[];
  dailyCap: number;
  onClose: () => void;
  onImport: (allocations: { key: string; day: string; hours: number }[]) => void;
}

/** 把选中的提交/整合项，按"总工时"智能摊到时间区间内的各天，自动避开已填满的天。 */
export function RangeAllocModal({ open, selected, dailyCap, onClose, onImport }: Props) {
  const estTotal = selected.reduce((s, x) => s + x.estHours, 0);
  const [start, setStart] = useState(addDays(todayYMD(), -5));
  const [end, setEnd] = useState(todayYMD());
  const [totalHours, setTotalHours] = useState(estTotal || 8);
  const [cap, setCap] = useState(dailyCap);
  const [skipWeekend, setSkipWeekend] = useState(true);
  const [existing, setExisting] = useState<Record<string, number>>({});

  // 打开时重置默认值（最近 6 天、总工时=估算合计、上限取设置）
  useEffect(() => {
    if (!open) return;
    setStart(addDays(todayYMD(), -5));
    setEnd(todayYMD());
    setTotalHours(estTotal || 8);
    setCap(dailyCap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 拉区间内已有工时（用于扣减每日容量）
  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const recs = await db.listRecordsByRange(start, end);
        const m: Record<string, number> = {};
        for (const r of recs) m[r.day] = (m[r.day] ?? 0) + (r.durationMin ?? 0) / 60;
        setExisting(m);
      } catch { /* ignore */ }
    })();
  }, [open, start, end]);

  const result: AllocResult = useMemo(
    () => allocate({
      items: selected.map((s) => ({ key: s.key })),
      start, end, totalHours, dailyCap: cap, skipWeekend, existing,
    }),
    [selected, start, end, totalHours, cap, skipWeekend, existing],
  );

  if (!open) return null;

  function confirm() {
    const alloc: { key: string; day: string; hours: number }[] = [];
    for (const d of result.days) {
      for (const it of d.items) alloc.push({ key: it.key, day: d.day, hours: it.hours });
    }
    onImport(alloc);
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="card modal-card" onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: '94vw' }}>
        <h3 className="set-h">分配到时间区间</h3>
        <p className="muted" style={{ fontSize: 12, marginTop: -2 }}>
          已选 {selected.length} 条 · 估算合计 {formatHours(estTotal * 60)}。按总工时智能摊到区间各天，自动避开已填满的天。
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
          <label className="ra-field">起始<input type="date" className="sel" value={start} onChange={(e) => setStart(e.target.value)} /></label>
          <label className="ra-field">结束<input type="date" className="sel" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
          <label className="ra-field">总工时(h)<input type="number" className="sel" min={0} step={0.5} value={totalHours} onChange={(e) => setTotalHours(Math.max(0, Number(e.target.value) || 0))} /></label>
          <label className="ra-field">单日上限(h)<input type="number" className="sel" min={1} max={16} value={cap} onChange={(e) => setCap(Math.max(1, Number(e.target.value) || 8))} /></label>
        </div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 10, fontSize: 13 }}>
          <input type="checkbox" checked={skipWeekend} onChange={(e) => setSkipWeekend(e.target.checked)} /> 跳过周末
        </label>

        <div style={{ marginTop: 12, maxHeight: 220, overflow: 'auto', border: '1px solid var(--border-soft)', borderRadius: 8 }}>
          {result.days.length === 0 && <div className="muted" style={{ padding: 16 }}>区间内没有工作日，请改日期或含周末。</div>}
          {result.days.map((d) => (
            <div key={d.day} style={{ display: 'flex', gap: 10, padding: '6px 10px', borderBottom: '1px solid var(--border-soft)', alignItems: 'center', fontSize: 12, background: d.overflow ? 'rgba(232,17,35,0.06)' : undefined }}>
              <span style={{ width: 92 }}>{d.day}</span>
              <span style={{ width: 46 }}>{d.items.length} 条</span>
              <span style={{ width: 56 }}>{formatHours(d.hours * 60)}</span>
              <span className="muted" style={{ flex: 1 }}>已有 {formatHours(d.existing * 60)}/{d.cap}h</span>
              {d.overflow && <span className="git-existing-badge" style={{ background: '#fff4ce', color: '#9a6700' }}>加班</span>}
            </div>
          ))}
        </div>

        {result.overflow && (
          <div className="warn-soft" style={{ marginTop: 10 }}>
            ⚠ 总工时 {result.totalAssigned}h 超过区间可用容量 {result.totalCapacity}h，部分天将标为加班。可扩大区间 / 提高上限，或直接继续导入。
          </div>
        )}

        <div className="row gap-sm" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <Button size="small" onClick={onClose}>取消</Button>
          <Button size="small" appearance="primary" onClick={confirm} disabled={result.days.length === 0 || selected.length === 0}>
            确认导入 ({selected.length})
          </Button>
        </div>
      </div>
    </div>
  );
}
