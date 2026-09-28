import { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { Button, Spinner } from '../../ui';
import * as db from '../../services/db';
import { copyText } from '../../services/clipboard';
import type { LlmConfig, Project, Report, ReportTemplate } from '../../types/models';
import { buildMonthSummary, generatePeriodReport, generateReport } from '../../services/llm';
import { hasLlmApiKey } from '../../services/llmKey';
import { addDays, monthRange, todayYMD } from '../../utils/date';
import { daysBetween } from '../../services/allocate';

interface Props {
  period: string;
  title: string;
  reportType: 'month' | 'quarter' | 'halfyear' | 'year';
  llmConfig: LlmConfig;
  templates: ReportTemplate[];
  year: string;
  ym: string;
  quarterMonths: Record<number, [number, number]>;
  projects: Project[];
}

/** 从 from~to 日期区间反推涉及的月份（含），用于季报/年报聚合已存月报 */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const fy = Number(from.slice(0, 4)), fm = Number(from.slice(5, 7));
  const ty = Number(to.slice(0, 4)), tm = Number(to.slice(5, 7));
  if (!fy || !ty) return out;
  let y = fy, m = fm;
  while ((y < ty || (y === ty && m <= tm)) && out.length < 36) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** 把 Markdown 报告转成纯文本（去掉井号、星号、反引号、列表标记等），用于"复制纯文本" */
function toPlainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function ReportSection({ period, title, reportType, llmConfig, templates, year, ym, quarterMonths, projects }: Props) {
  const [reports, setReports] = useState<Report[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [templateId, setTemplateId] = useState('');
  // 自定义起止日期（默认对齐自然周期，可改成自定义统计周期）
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => {
    void (async () => {
      const r = await db.listReports(period);
      setReports(r);
      const def = templates.find((t) => t.isDefault) ?? templates[0];
      if (def) setTemplateId(def.id);
    })();
  }, [period]);

  // LLM key 可用性（内联或 keychain，P8）：异步解析成 state 供生成按钮判定
  const [llmKeyReady, setLlmKeyReady] = useState(false);
  useEffect(() => {
    let stale = false;
    void hasLlmApiKey(llmConfig).then((ok) => {
      if (!stale) setLlmKeyReady(ok);
    });
    return () => {
      stale = true;
    };
  }, [llmConfig]);

  // 切换周期时，把起止日期重置为该周期自然范围
  useEffect(() => {
    if (reportType === 'month') {
      // 月报默认：起始 = 上一份月报结束日的后一天，结束 = 今天；没有历史则用自然月
      void (async () => {
        const latest = await db.getLatestReportRange().catch(() => null);
        if (latest?.to) {
          setFrom(addDays(latest.to, 1));
          setTo(todayYMD());
        } else {
          const r = monthRange(ym);
          setFrom(r.from); setTo(r.to);
        }
      })();
    } else if (reportType === 'year') {
      setFrom(`${year}-01-01`); setTo(`${year}-12-31`);
    } else if (reportType === 'halfyear') {
      // H1 = 1~6 月，H2 = 7~12 月
      const h = Number(period.match(/H(\d)/)?.[1] ?? 1);
      const s = h === 2 ? 7 : 1;
      const e = h === 2 ? 12 : 6;
      setFrom(`${year}-${String(s).padStart(2, '0')}-01`);
      setTo(monthRange(`${year}-${String(e).padStart(2, '0')}`).to);
    } else {
      const q = Number(period.match(/Q(\d)/)?.[1] ?? 1);
      const [s, e] = quarterMonths[q] ?? [1, 12];
      setFrom(`${year}-${String(s).padStart(2, '0')}-01`);
      setTo(monthRange(`${year}-${String(e).padStart(2, '0')}`).to);
    }
  }, [reportType, ym, year, period, quarterMonths]);

  async function generate() {
    setLoading(true); setError('');
    try {
      const tpl = templates.find((t) => t.id === templateId);
      let text: string;
      if (reportType === 'month') {
        // 按自定义区间取记录（支持非自然月周期）
        const recs = await db.listRecordsByRange(from, to);
        const label = `${from} ~ ${to}`;
        const summary = buildMonthSummary(recs, projects, label);
        const system = '你是一位工作月报撰写助手。根据用户提供的本时段工作记录汇总撰写月报。若无范例，用清晰分段：本时段概述、主要工作（按项目）、问题与改进、下期计划。只输出月报正文。';
        const user = (tpl?.body ? `【范例（请模仿风格）】\n${tpl.body}\n\n` : '') + `${summary}\n\n请据此撰写 ${label} 的工作月报。`;
        text = await generateReport(llmConfig, system, user);
      } else {
        // 季/年中/年报：优先用已存月报，月报未覆盖的漏天用日志补
        const months = monthsBetween(from, to);
        const monthReports: { month: string; body: string; from?: string; to?: string }[] = [];
        for (const mn of months) {
          const reps = await db.listReports(mn);
          if (reps.length > 0) {
            const r = reps[0];
            // 覆盖范围：有存就用存的范围，否则按该月自然月兜底
            const rf = r.dateFrom ?? `${mn}-01`;
            const rt = r.dateTo ?? monthRange(mn).to;
            monthReports.push({ month: mn, body: r.body, from: rf, to: rt });
          }
        }
        // 计算区间内未被任何月报覆盖的日期 → 漏天
        const allDays = daysBetween(from, to, false);
        const covered = new Set<string>();
        for (const r of monthReports) for (const d of daysBetween(r.from!, r.to!, false)) covered.add(d);
        const gapDays = allDays.filter((d) => !covered.has(d));
        let gapSummary = '';
        if (gapDays.length > 0) {
          const recs = await db.listRecordsByRange(from, to);
          const gapRecs = recs.filter((r) => gapDays.includes(r.day));
          if (gapRecs.length > 0) {
            gapSummary = buildMonthSummary(gapRecs, projects, `${gapDays[0]}~${gapDays[gapDays.length - 1]}（${gapDays.length} 天）`);
          }
        }
        text = await generatePeriodReport(monthReports, gapSummary, period, reportType, llmConfig, tpl?.body);
      }
      setDraft(text);
      setEditing(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }

  async function save() {
    if (!draft.trim()) return;
    await db.saveReport({ month: period, templateId: templateId || null, body: draft, provider: llmConfig.kind, model: llmConfig.model ?? '', dateFrom: from, dateTo: to });
    setReports(await db.listReports(period));
    setEditing(false); setDraft('');
  }

  const latest = reports[0];

  return (
    <div className="rpt-section">
      <div className="rpt-head">
        <span className="rpt-title">{title}</span>
        {reports.length > 0 && <span className="muted" style={{ fontSize: 11 }}>{reports.length} 份</span>}
        <div className="rpt-actions">
          {loading ? (
            <Spinner size="sm" />
          ) : editing ? (
            <>
              <Button size="sm" variant="primary" onClick={() => void save()}>保存</Button>
              <Button size="sm" onClick={() => { setEditing(false); setDraft(''); }}>取消</Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => { setDraft(latest?.body ?? ''); setEditing(true); }}>
                {reports.length > 0 ? '编辑' : '粘贴文本'}
              </Button>
              <Button size="sm" variant="ghost" icon={<Copy size={14} />} style={{ minWidth: 108 }} onClick={() => void copyText(latest?.body ?? '')} disabled={reports.length === 0} title="复制 Markdown 原文">复制 Markdown</Button>
              <Button size="sm" variant="ghost" icon={<Copy size={14} />} style={{ minWidth: 108 }} onClick={() => void copyText(toPlainText(latest?.body ?? ''))} disabled={reports.length === 0} title="复制纯文本（去掉格式）">复制纯文本</Button>
              <Button size="sm" variant="primary" style={{ minWidth: 100 }} onClick={() => void generate()} disabled={!llmKeyReady && llmConfig.kind !== 'claude-code'}>
                {reports.length > 0 ? '重新生成' : `生成${title}`}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* 自定义起止日期：默认自然周期，支持自定义统计周期 */}
      <div className="rpt-range" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
        <input type="date" className="sel" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 138 }} />
        <span className="muted">至</span>
        <input type="date" className="sel" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 138 }} />
        <span className="muted" style={{ fontSize: 11 }}>可改起止日期（如按 26 号到次月 25 号统计）</span>
      </div>

      {error && <div className="warn-soft" style={{ marginTop: 6 }}>{error}</div>}

      {editing ? (
        <textarea className="rpt-textarea" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="生成的内容或粘贴的文本" />
      ) : reports.length === 0 ? null : (
        <div className="rpt-list">
          {reports.map((r) => (
            <div key={r.id} className="rpt-item">
              <div className="rpt-item-head" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                <span className="muted" style={{ fontSize: 11 }}>
                  {new Date(r.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="muted rpt-item-preview">{r.body.slice(0, 80).replace(/\n/g, ' ')}…</span>
                <span className="rpt-toggle">{expanded === r.id ? '收起' : '展开'}</span>
              </div>
              {expanded === r.id && <pre className="rpt-full">{r.body}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
