import { useEffect, useState } from 'react';
import { Button, Spinner } from '@fluentui/react-components';
import { CopyRegular } from '@fluentui/react-icons';
import * as db from '../../services/db';
import { copyText } from '../../services/clipboard';
import type { LlmConfig, Project, Report, ReportTemplate, WorkRecord } from '../../types/models';
import { buildMonthSummary, generateAnnualReport, generateReport } from '../../services/llm';

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

export function ReportSection({ period, title, reportType, llmConfig, templates, year, ym, quarterMonths, records, projects }: Props) {
  const [reports, setReports] = useState<Report[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [templateId, setTemplateId] = useState('');

  useEffect(() => {
    void (async () => {
      const r = await db.listReports(period);
      setReports(r);
      const def = templates.find((t) => t.isDefault) ?? templates[0];
      if (def) setTemplateId(def.id);
    })();
  }, [period]);

  async function generate() {
    setLoading(true); setError('');
    try {
      const tpl = templates.find((t) => t.id === templateId);
      let text: string;
      if (reportType === 'month') {
        const summary = buildMonthSummary(records, projects, ym);
        const system = '你是一位工作月报撰写助手。根据用户提供的本月工作记录汇总撰写月报。若无范例，用清晰分段：本月概述、主要工作（按项目）、问题与改进、下月计划。只输出月报正文。';
        const user = (tpl?.body ? `【范例（请模仿风格）】\n${tpl.body}\n\n` : '') + `${summary}\n\n请据此撰写 ${ym} 的工作月报。`;
        text = await generateReport(llmConfig, system, user);
      } else {
        const [startM, endM] = reportType === 'year' ? [1, 12] : quarterMonths[Number(period.match(/Q(\d)/)?.[1] ?? 1)];
        const months: { month: string; body: string }[] = [];
        for (let m = startM; m <= endM; m++) {
          const mm = String(m).padStart(2, '0');
          const reps = await db.listReports(`${year}-${mm}`);
          if (reps.length > 0) months.push({ month: `${year}-${mm}`, body: reps[0].body });
        }
        text = await generateAnnualReport(months, period, llmConfig, tpl?.body);
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

      {error && <div className="warn-soft" style={{ marginTop: 6 }}>{error}</div>}

      {editing ? (
        <textarea className="rpt-textarea" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="生成的内容或粘贴的文本" />
      ) : reports.length === 0 ? (
        <div className="rpt-empty">
          {reportType === 'month' && records.length === 0
            ? '本月暂无记录。可直接粘贴外部月报文本后点「编辑」保存。'
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
