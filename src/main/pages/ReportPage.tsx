import { useEffect, useState } from 'react';
import { Button, Spinner } from '@fluentui/react-components';
import { ArrowLeftRegular, ArrowRightRegular, CopyRegular } from '@fluentui/react-icons';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import * as db from '../../services/db';
import { buildMonthSummary, generateAnnualReport, generateReport } from '../../services/llm';
import { currentYM, monthRange } from '../../utils/date';
import type { ReportTemplate } from '../../types/models';
import { Select } from '../components/Select';
import { copyText } from '../../services/clipboard';

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function ReportPage() {
  const settings = useSettingsStore((s) => s.settings);
  const projects = useProjectsStore((s) => s.projects);
  const [reportMode, setReportMode] = useState<'month' | 'quarter' | 'year'>('month');
  const [ym, setYm] = useState(currentYM());
  const [year, setYear] = useState(currentYM().slice(0, 4));
  const [quarter, setQuarter] = useState(Math.ceil(Number(currentYM().slice(5, 7)) / 3) || 1);
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState('');
  const [tplOpen, setTplOpen] = useState(false);
  const [tplName, setTplName] = useState('');
  const [tplBody, setTplBody] = useState('');
  const [editingTplId, setEditingTplId] = useState<string | undefined>();

  const period = reportMode === 'month' ? ym : reportMode === 'quarter' ? `${year}Q${quarter}` : `${year}年报`;
  const quarterMonths: Record<number, [number, number]> = { 1: [1, 3], 2: [4, 6], 3: [7, 9], 4: [10, 12] };
  const modeLabel = reportMode === 'year' ? '年报' : reportMode === 'quarter' ? '季报' : '月报';

  useEffect(() => {
    void (async () => {
      const t = await db.listTemplates();
      setTemplates(t);
      const def = t.find((x) => x.isDefault) ?? t[0];
      if (def) setTemplateId(def.id);
    })();
  }, []);

  async function reloadAll() { /* no-op: reports are now browsed in calendar */ }

  function flash(m: string) { setNotice(m); setTimeout(() => setNotice(''), 1800); }

  function openNewTemplate() { setEditingTplId(undefined); setTplName(''); setTplBody(''); setTplOpen(true); }
  function openEditTemplate(t: ReportTemplate) { setEditingTplId(t.id); setTplName(t.name); setTplBody(t.body); setTplOpen(true); }
  async function saveTemplate() {
    if (!tplName.trim()) return;
    await db.saveTemplate({ id: editingTplId, name: tplName.trim(), body: tplBody, isDefault: templates.length === 0 && !editingTplId });
    setTplOpen(false);
    setTemplates(await db.listTemplates());
  }
  async function deleteTemplate(id: string) {
    await db.deleteTemplate(id);
    if (templateId === id) setTemplateId('');
    setTemplates(await db.listTemplates());
  }

  async function onGenerate() {
    setLoading(true); setError(''); setSaved(false);
    try {
      const tpl = templates.find((t) => t.id === templateId);
      if (reportMode === 'year' || reportMode === 'quarter') {
        const [startM, endM] = reportMode === 'year' ? [1, 12] : quarterMonths[quarter];
        const months: { month: string; body: string }[] = [];
        for (let m = startM; m <= endM; m++) {
          const mm = String(m).padStart(2, '0');
          const reps = await db.listReports(`${year}-${mm}`);
          if (reps.length > 0) months.push({ month: `${year}-${mm}`, body: reps[0].body });
        }
        const text = await generateAnnualReport(months, period, settings.llm, tpl?.body);
        setResult(text);
      } else {
        const { from, to } = monthRange(ym);
        const records = await db.listRecordsByRange(from, to);
        if (records.length === 0) {
          setError('该月份没有记录数据。你可以直接在下方文本框粘贴已有月报（从猪齿鱼/邮件等复制），点保存即可。');
          return;
        }
        const summary = buildMonthSummary(records, projects, ym);
        const system = '你是一位工作月报撰写助手。根据用户提供的本月工作记录汇总撰写月报。要求：1) 若提供了"范例月报"，严格模仿其格式、段落结构、语气和用词密度；2) 若无范例，用清晰分段：本月概述、主要工作（按项目）、问题与改进、下月计划；3) 只输出月报正文。';
        const user = (tpl?.body ? `【范例月报（请模仿其风格）】\n${tpl.body}\n\n` : '') + `${summary}\n\n请据此撰写 ${ym} 的工作月报。`;
        const text = await generateReport(settings.llm, system, user);
        setResult(text);
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }

  async function onSave() {
    if (!result.trim()) return;
    await db.saveReport({ month: period, templateId: templateId || null, body: result, provider: settings.llm.kind, model: settings.llm.model ?? '' });
    await reloadAll();
    setSaved(true); setTimeout(() => setSaved(false), 1800);
  }

  async function copyAs(label: string) {
    if (!result.trim()) return;
    await copyText(result);
    flash(`已复制（${label}）`);
  }

  const needKey = settings.llm.kind !== 'claude-code' && !settings.llm.apiKey;

  return (
    <div>
      <div className="page-head">
        <div className="left">
          <div className="seg">
            <button className={`seg-btn${reportMode === 'month' ? ' active' : ''}`} onClick={() => setReportMode('month')}>月报</button>
            <button className={`seg-btn${reportMode === 'quarter' ? ' active' : ''}`} onClick={() => setReportMode('quarter')}>季报</button>
            <button className={`seg-btn${reportMode === 'year' ? ' active' : ''}`} onClick={() => setReportMode('year')}>年报</button>
          </div>
        </div>
        <div className="row gap-sm">
          {reportMode === 'month' ? (
            <>
              <Button icon={<ArrowLeftRegular />} onClick={() => setYm((v) => shiftMonth(v, -1))} />
              <Button size="small" onClick={() => setYm(currentYM())}>本月</Button>
              <Button icon={<ArrowRightRegular />} onClick={() => setYm((v) => shiftMonth(v, 1))} />
            </>
          ) : reportMode === 'quarter' ? (
            <>
              <Button icon={<ArrowLeftRegular />} onClick={() => setYear((y) => String(Number(y) - 1))} />
              {[1, 2, 3, 4].map((q) => (
                <Button key={q} size="small" appearance={quarter === q ? 'primary' : 'secondary'} onClick={() => setQuarter(q)}>Q{q}</Button>
              ))}
              <Button icon={<ArrowRightRegular />} onClick={() => setYear((y) => String(Number(y) + 1))} />
            </>
          ) : (
            <>
              <Button icon={<ArrowLeftRegular />} onClick={() => setYear((y) => String(Number(y) - 1))} />
              <span style={{ fontWeight: 700, minWidth: 50, textAlign: 'center' }}>{year}</span>
              <Button icon={<ArrowRightRegular />} onClick={() => setYear((y) => String(Number(y) + 1))} />
            </>
          )}
        </div>
      </div>

      <div>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="row gap-md wrap" style={{ alignItems: 'flex-end' }}>
              <div className="col grow" style={{ minWidth: 180 }}>
                <span className="muted" style={{ fontSize: 12 }}>模板（范例，可选）</span>
                <div className="row gap-sm" style={{ marginTop: 4 }}>
                  <div style={{ flex: 1 }}>
                    <Select value={templateId} onChange={setTemplateId} options={[{ value: '', label: '无模板' }, ...templates.map((t) => ({ value: t.id, label: t.name }))]} />
                  </div>
                  <Button size="small" onClick={openNewTemplate}>新建</Button>
                </div>
              </div>
              <Button appearance="primary" onClick={() => void onGenerate()} disabled={loading}>
                {loading ? '生成中…' : `生成${modeLabel}`}
              </Button>
            </div>
            {templates.length > 0 && (
              <div className="tpl-list">
                {templates.map((t) => (
                  <span key={t.id} className="chip">
                    {t.name}
                    <button className="tpl-act" onClick={() => openEditTemplate(t)}>编辑</button>
                    <button className="tpl-act" onClick={() => void deleteTemplate(t.id)}>删</button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {(needKey || error) && (
            <div className="warn-soft">
              {needKey && '未配置 API Key，请到「设置 → 月报 LLM」填写。'}
              {error && `⚠ ${error}`}
            </div>
          )}
          {notice && <div className="notice">{notice}</div>}

          <div className="card">
            {loading ? (
              <Spinner label={`正在生成${modeLabel}…`} />
            ) : (
              <>
                <textarea className="report-area" value={result} onChange={(e) => setResult(e.target.value)}
                  placeholder={`点「生成${modeLabel}」后内容出现在此，也可直接粘贴已有文本`} />
                <div className="row gap-sm" style={{ justifyContent: 'flex-end', marginTop: 10, flexWrap: 'wrap' }}>
                  {saved && <span className="muted">已保存 ✓</span>}
                  <Button size="small" icon={<CopyRegular />} onClick={() => void copyAs('Markdown')}>复制 MD</Button>
                  <Button size="small" icon={<CopyRegular />} onClick={() => void copyAs('纯文本')}>复制纯文本</Button>
                  <Button appearance="primary" onClick={() => void onSave()} disabled={!result.trim()}>保存</Button>
                </div>
              </>
            )}
          </div>

          {(reportMode === 'year' || reportMode === 'quarter') && (
            <div className="set-tip" style={{ marginTop: 12 }}>
              {modeLabel}基于<b>已保存的各月月报</b>汇总生成。如果某月还没月报，先切到「月报」生成保存，或直接粘贴外部月报文本保存。已保存的报告可在「日历」页查看。
            </div>
          )}
      </div>

      {tplOpen && (
        <div className="modal-mask" onClick={() => setTplOpen(false)}>
          <div className="card modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="set-h">{editingTplId ? '编辑模板' : '新建模板'}</h3>
            <input className="tpl-name-input" value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="模板名（如：给领导的月报）" />
            <textarea className="sel" style={{ minHeight: 200, resize: 'vertical' }} value={tplBody} onChange={(e) => setTplBody(e.target.value)}
              placeholder="粘贴一份你满意的报告作为范例，AI 会模仿其格式和语气" />
            <div className="row gap-sm" style={{ justifyContent: 'flex-end' }}>
              <Button onClick={() => setTplOpen(false)}>取消</Button>
              <Button appearance="primary" onClick={() => void saveTemplate()}>保存模板</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
