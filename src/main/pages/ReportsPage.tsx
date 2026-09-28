import { useEffect, useMemo, useState } from 'react';
import { Button, IconButton, Segmented } from '../../ui';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { ReportSection } from '../components/ReportSection';
import { RetroCard, isoWeekKey, mondayOfYMD, weekLabelOf } from '../components/RetroCard';
import type { ReportTemplate } from '../../types/models';
import * as db from '../../services/db';
import { addDays, currentYM, monthRange, todayYMD } from '../../utils/date';

type Kind = 'month' | 'quarter' | 'halfyear' | 'year';

const quarterMonths: Record<number, [number, number]> = { 1: [1, 3], 2: [4, 6], 3: [7, 9], 4: [10, 12] };

function quarterOf(ym: string): number {
  return Math.ceil(Number(ym.slice(5, 7)) / 3);
}

function shiftYM(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * 报告页（/reports）。P8b 空间分流：
 * - work：期选择器（月/季/半年/年）+ 单 ReportSection（原样零回归）
 * - personal：复盘视图——周/月切换 + RetroCard（实时聚合 / AI 复盘 / 快照 / Obsidian 导出）
 */
export function ReportsPage() {
  const wsKind = useWorkspaceStore((s) => s.currentKind());
  if (wsKind === 'personal') return <RetroView />;
  return <WorkReportsView />;
}

/** personal：复盘视图（周/月切换 + 期间导航 + RetroCard） */
function RetroView() {
  const wsId = useWorkspaceStore((s) => s.currentId);
  const [kind, setKind] = useState<'week' | 'month'>('week');
  // 周以周一锚定（ISO），月以 YYYY-MM；导航互不干扰
  const [weekMonday, setWeekMonday] = useState(() => mondayOfYMD(todayYMD()));
  const [ym, setYm] = useState(currentYM());

  const target = useMemo(() => {
    if (kind === 'week') {
      return { period: isoWeekKey(weekMonday), from: weekMonday, to: addDays(weekMonday, 6), title: weekLabelOf(weekMonday) };
    }
    const { from, to } = monthRange(ym);
    return { period: ym, from, to, title: `${ym} 月复盘` };
  }, [kind, weekMonday, ym]);

  return (
    <div>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div className="left">
          <h2 className="section-title">复盘</h2>
          <span className="muted">按周/月聚合回看 · AI 复盘快照 · 可导出 Obsidian</span>
        </div>
      </div>

      <div className="rpt-toolbar">
        <Segmented
          value={kind}
          onChange={(k) => setKind(k)}
          options={[
            { value: 'week', label: '周复盘' },
            { value: 'month', label: '月复盘' },
          ]}
        />
        <span className="rpt-picker row gap-sm">
          {kind === 'week' ? (
            <>
              <IconButton title="上一周" onClick={() => setWeekMonday((m) => addDays(m, -7))}><ArrowLeft size={16} /></IconButton>
              <span className="rpt-ym">{weekLabelOf(weekMonday)}</span>
              <IconButton title="下一周" onClick={() => setWeekMonday((m) => addDays(m, 7))}><ArrowRight size={16} /></IconButton>
              <Button size="sm" onClick={() => setWeekMonday(mondayOfYMD(todayYMD()))}>本周</Button>
            </>
          ) : (
            <>
              <IconButton title="上一月" onClick={() => setYm((v) => shiftYM(v, -1))}><ArrowLeft size={16} /></IconButton>
              <span className="rpt-ym num">{ym}</span>
              <IconButton title="下一月" onClick={() => setYm((v) => shiftYM(v, 1))}><ArrowRight size={16} /></IconButton>
              <Button size="sm" onClick={() => setYm(currentYM())}>本月</Button>
            </>
          )}
        </span>
      </div>

      <RetroCard
        key={`${kind}:${target.period}`}
        kind={kind}
        period={target.period}
        from={target.from}
        to={target.to}
        wsId={wsId}
      />
    </div>
  );
}

/** work：期选择器（月/季/半年/年）+ 单 ReportSection（起止日期可自定义，如 26 号→次月 25 号）——原路径 */
function WorkReportsView() {
  const [kind, setKind] = useState<Kind>('month');
  const [ym, setYm] = useState(currentYM());
  const [year, setYear] = useState<string>(currentYM().slice(0, 4));
  const [half, setHalf] = useState<'H1' | 'H2'>(Number(currentYM().slice(5, 7)) <= 6 ? 'H1' : 'H2');

  const projects = useProjectsStore((s) => s.projects);
  const llmConfig = useSettingsStore((s) => s.settings.llm);
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);

  useEffect(() => {
    void (async () => setTemplates(await db.listTemplates()))();
  }, []);

  const q = quarterOf(ym);

  /** 当前期的 period 键 / 标题（切期即换 ReportSection 实例，缓存各自列表） */
  const target = useMemo(() => {
    if (kind === 'month') return { period: ym, title: `${ym} 月报` };
    if (kind === 'quarter') return { period: `${year}Q${q}`, title: `${year} Q${q} 季报` };
    if (kind === 'halfyear') return { period: `${year}${half}`, title: `${year} ${half === 'H1' ? '上半年' : '下半年'}报` };
    return { period: `${year}年报`, title: `${year} 年报` };
  }, [kind, ym, year, q, half]);

  function shiftYear(delta: number) {
    setYear((y) => String(Number(y) + delta));
  }

  return (
    <div>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div className="left">
          <h2 className="section-title">报告</h2>
          <span className="muted">按期生成 · 分项目统计 · 可复制/导出</span>
        </div>
      </div>

      <div className="rpt-toolbar">
        <Segmented
          value={kind}
          onChange={(k) => setKind(k)}
          options={[
            { value: 'month', label: '月报' },
            { value: 'quarter', label: '季报' },
            { value: 'halfyear', label: '半年报' },
            { value: 'year', label: '年报' },
          ]}
        />
        <span className="rpt-picker row gap-sm">
          {kind === 'month' && (
            <>
              <IconButton title="上一月" onClick={() => setYm(shiftYM(ym, -1))}><ArrowLeft size={16} /></IconButton>
              <span className="rpt-ym num">{ym}</span>
              <IconButton title="下一月" onClick={() => setYm(shiftYM(ym, 1))}><ArrowRight size={16} /></IconButton>
              <Button size="sm" onClick={() => setYm(currentYM())}>本月</Button>
            </>
          )}
          {kind !== 'month' && (
            <>
              <IconButton title="上一年" onClick={() => shiftYear(-1)}><ArrowLeft size={16} /></IconButton>
              <span className="rpt-ym num">{year}</span>
              <IconButton title="下一年" onClick={() => shiftYear(1)}><ArrowRight size={16} /></IconButton>
              {Number(year) === Number(todayYMD().slice(0, 4)) ? null : (
                <Button size="sm" onClick={() => setYear(todayYMD().slice(0, 4))}>今年</Button>
              )}
            </>
          )}
          {kind === 'quarter' && (
            <span className="row gap-sm">
              {[1, 2, 3, 4].map((n) => (
                <Button key={n} size="sm" variant={q === n ? 'primary' : 'default'} onClick={() => setYm(`${year}-${String(n * 3).padStart(2, '0')}-01`)}>
                  Q{n}
                </Button>
              ))}
            </span>
          )}
          {kind === 'halfyear' && (
            <span className="row gap-sm">
              {(['H1', 'H2'] as const).map((h) => (
                <Button key={h} size="sm" variant={half === h ? 'primary' : 'default'} onClick={() => setHalf(h)}>
                  {h === 'H1' ? '上半年' : '下半年'}
                </Button>
              ))}
            </span>
          )}
        </span>
      </div>

      <ReportSection
        key={target.period}
        period={target.period}
        title={target.title}
        reportType={kind}
        llmConfig={llmConfig}
        templates={templates}
        year={year}
        ym={ym}
        quarterMonths={quarterMonths}
        projects={projects}
      />
    </div>
  );
}
