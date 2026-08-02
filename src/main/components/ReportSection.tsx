import { useEffect, useState } from 'react';
import { Button, Spinner } from '@fluentui/react-components';
import { CopyRegular } from '@fluentui/react-icons';
import * as db from '../../services/db';
import { copyText } from '../../services/clipboard';
import type { LlmConfig, Project, Report, ReportTemplate, WorkRecord } from '../../types/models';
import { buildMonthSummary, generateAnnualReport, generateReport } from '../../services/llm';
import { monthRange } from '../../utils/date';

interface Props {
  period: string;
  title: string;
  reportType: 'month' | 'quarter' | 'year';
  llmConfig: LlmConfig;
  templates: ReportTemplate[];
  year: string;
  ym: string;
  quarterMonths: Record<number, [number, number]>;
  records: WorkRecord[];
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

export function ReportSection({ period, title, reportType, llmConfig, templates, year, ym, quarterMonths, records, projects }: Props) {
  const [reports, setReports] = useState<Report[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [templateId, setTemplateId] = useState('');
  // 自定义起止日期（默认对齐自然周期，可改成 25 号结账周期等）
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

  // 切换周期时，把起止日期重置为该周期自然范围
  useEffect(() => {
    if (reportType === 'month') {
      const r = monthRange(ym);
      setFrom(r.from); setTo(r.to);
    } else if (reportType === 'year') {
      setFrom(`${year}-01-01`); setTo(`${year}-12-31`);
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
        // 按自定义区间取记录（支持 25 号结账等非自然月周期）
        const recs = await db.listRecordsByRange(from, to);
        const label = `${from} ~ ${to}`;
        const summary = buildMonthSummary(recs, projects, label);
        const system = '你是一位工作月报撰写助手。根据用户提供的本时段工作记录汇总撰写月报。若无范例，用清晰分段：本时段概述、主要工作（按项目）、问题与改进、下期计划。只输出月报正文。';
        const user = (tpl?.body ? `【范例（请模仿风格）】\n${tpl.body}\n\n` : '') + `${summary}\n\n请据此撰写 ${label} 的工作月报。`;
        text = await generateReport(llmConfig, system, user);
      } else {
        // 季报/年报：按自定义区间反推月份，聚合已保存的月报
        const months = monthsBetween(from, to);
        const monthlyReports: { month: string; body: string }[] = [];
        for (const mn of months) {
          const reps = await db.listReports(mn);
          if (reps.length > 0) monthlyReports.push({ month: mn, body: reps[0].body });
        }
        text = await generateAnnualReport(monthlyReports, period, llmConfig, tpl?.body);
      }
      setDraft(text);
      setEditing(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }

  async function save() {
    if (!draft.trim()) return;
    await db.saveReport({ month: period, templateId: templateId || null, body: draft, provider: llmConfig.kind, model: llmConfig.model ?? '' });
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
            <Spinner size="tiny" />
          ) : editing ? (
            <>
              <Button size="small" appearance="primary" onClick={() => void save()}>保存</Button>
              <Button size="small" onClick={() => { setEditing(false); setDraft(''); }}>取消</Button>
            </>
          ) : (
            <>
              {reports.length > 0 && latest && (
                <Button size="small" appearance="subtle" onClick={() => { setDraft(latest.body); setEditing(true); }}>编辑</Button>
              )}
              <Button size="small" icon={<CopyRegular />} onClick={() => void copyText(latest?.body ?? '')} disabled={reports.length === 0}>复制</Button>
              <Button size="small" appearance="primary" onClick={() => void generate()} disabled={!llmConfig.apiKey && llmConfig.kind !== 'claude-code'}>
                {reports.length > 0 ? '重新生成' : `生成${title}`}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* 自定义起止日期：默认自然周期，可改成 25 号结账周期等 */}
      <div className="rpt-range" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
        <input type="date" className="sel" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 138 }} />
        <span className="muted">至</span>
        <input type="date" className="sel" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 138 }} />
        <span className="muted" style={{ fontSize: 11 }}>可改起止日期（如 25 号结账周期）</span>
      </div>

      {error && <div className="warn-soft" style={{ marginTop: 6 }}>{error}</div>}

      {editing ? (
        <textarea className="rpt-textarea" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="生成的内容或粘贴的文本" />
      ) : reports.length === 0 ? (
        <div className="rpt-empty">
          {reportType === 'month' && records.length === 0
            ? '该时段暂无记录。可直接粘贴外部月报文本后点「编辑」保存。'
            : reportType !== 'month' && llmConfig.kind !== 'claude-code' && !llmConfig.apiKey
              ? '需在设置配置 LLM。或直接粘贴文本后保存。'
              : `点击「生成${title}」自动生成，或直接粘贴外部文本保存。`}
        </div>
      ) : (
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
