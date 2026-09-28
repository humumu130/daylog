import { useEffect, useMemo, useState } from 'react';
import { BookOpenCheck, Sparkles } from 'lucide-react';
import { Button, EmptyState, Spinner } from '../../ui';
import * as db from '../../services/db';
import { aggregateRetro, buildRetroPrompt } from '../../services/retro';
import { exportRange } from '../../services/obsidianExport';
import { generateReport } from '../../services/llm';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import type { WorkRecord } from '../../types/models';
import { toast } from './UndoToast';

/** ---------- 周/月期间工具（ISO 8601，与 services/retro.ts 的 isoWeekRange 互逆） ---------- */

function parseYMDLocal(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatYMDLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 某日所在 ISO 周的周一（本地时区；周一=0 … 周日=6 折算） */
export function mondayOfYMD(day: string): string {
  const d = parseYMDLocal(day);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return formatYMDLocal(monday);
}

/** ISO 周周一 → 'YYYY-Www'（周四定年法，与 services/retro.ts 的 isoWeekRange 互逆） */
export function isoWeekKey(monday: string): string {
  const mon = parseYMDLocal(monday);
  const thu = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 3);
  const year = thu.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const jan4Thu = new Date(jan4.getFullYear(), jan4.getMonth(), jan4.getDate() - ((jan4.getDay() + 6) % 7) + 3);
  const week = 1 + Math.round((thu.getTime() - jan4Thu.getTime()) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** 周标签：「9 月第 4 周（09-22 ~ 09-28）」（月份与第几周取该周周一） */
export function weekLabelOf(monday: string): string {
  const mon = parseYMDLocal(monday);
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  const p = (n: number) => String(n).padStart(2, '0');
  const nth = Math.ceil(mon.getDate() / 7);
  return `${mon.getMonth() + 1} 月第 ${nth} 周（${p(mon.getMonth() + 1)}-${p(mon.getDate())} ~ ${p(sun.getMonth() + 1)}-${p(sun.getDate())}）`;
}

/** ---------- 复盘卡（P8b 个人空间报告页主体） ---------- */

interface Props {
  kind: 'week' | 'month';
  /** 期间键：'YYYY-Www'（ISO 周）| 'YYYY-MM' */
  period: string;
  /** 期间起止（含端点，YYYY-MM-DD）；聚合窗口 / Obsidian 导出区间共用 */
  from: string;
  to: string;
  /** 空间 id（数据隔离） */
  wsId: string;
}

/**
 * 复盘卡：实时聚合展示（主题分布 / 学到什么 / 里程碑 / 条数天数）
 * + AI 生成复盘（可编辑正文）→ 保存快照 + 历史快照回看 + 导出 Obsidian。
 * 数据自查（db.listRecordsByRange 带 wsId），切换期间即重拉。
 */
export function RetroCard({ kind, period, from, to, wsId }: Props) {
  const projects = useProjectsStore((s) => s.projects);
  const llmConfig = useSettingsStore((s) => s.settings.llm);

  const [records, setRecords] = useState<WorkRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [aiText, setAiText] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genErr, setGenErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [snapshots, setSnapshots] = useState<db.RetrospectiveRow[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 期间/空间变化 → 重拉记录与快照；正文草稿清空（避免上一期的 AI 文误存进本期）
  useEffect(() => {
    let stale = false;
    setLoading(true);
    void (async () => {
      try {
        const [recs, snaps] = await Promise.all([
          db.listRecordsByRange(from, to, wsId),
          db.listRetrospectives(wsId, kind),
        ]);
        if (stale) return;
        setRecords(recs);
        setSnapshots(snaps);
      } finally {
        if (!stale) setLoading(false);
      }
    })();
    setAiText('');
    setGenErr('');
    setExpandedId(null);
    return () => {
      stale = true;
    };
  }, [from, to, wsId, kind, period]);

  const agg = useMemo(
    () => aggregateRetro(records, projects, period, kind),
    [records, projects, period, kind],
  );
  const maxThemeCount = useMemo(
    () => Math.max(1, ...agg.themeDist.map((t) => t.count)),
    [agg.themeDist],
  );

  /** AI 生成复盘正文（buildRetroPrompt + generateReport；正文进可编辑 textarea） */
  async function onGenerate() {
    if (generating) return;
    setGenerating(true);
    setGenErr('');
    try {
      const { system, user } = buildRetroPrompt(agg);
      const text = await generateReport(llmConfig, system, user);
      setAiText(text);
    } catch (e) {
      setGenErr(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  /** 保存快照（period/kind 对应本期；重复保存=同期多份，列表按时间倒序） */
  async function onSave() {
    const content = aiText.trim();
    if (!content || saving) return;
    setSaving(true);
    try {
      await db.saveRetrospective({ workspaceId: wsId, period, kind, content });
      setSnapshots(await db.listRetrospectives(wsId, kind));
      toast(`已保存${kind === 'week' ? '周' : '月'}复盘快照（${period}）`);
    } catch {
      toast('保存快照失败，请重试');
    } finally {
      setSaving(false);
    }
  }

  /** 导出本期到 Obsidian（未配置目录时 exportRange reject，错误信息直接展示） */
  async function onExport() {
    if (exporting) return;
    setExporting(true);
    setExportMsg(null);
    try {
      const { files, dir } = await exportRange(from, to, wsId);
      setExportMsg({ ok: true, text: files > 0 ? `已导出 ${files} 天到 ${dir}/record/` : '本期记录均已导出过，无新增内容' });
    } catch (e) {
      setExportMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setExporting(false);
    }
  }

  if (loading) {
    return (
      <div className="retro-loading">
        <Spinner label="聚合中…" />
      </div>
    );
  }

  const periodLabel = kind === 'week' ? `周复盘 · ${period}` : `月复盘 · ${period}`;

  return (
    <div className="retro-card">
      {/* 期间概览：条数 / 天数 / 时长（可选） */}
      <div className="retro-stats">
        <span className="retro-stat">
          <span className="retro-stat-num">{agg.entries}</span> 条记录
        </span>
        <span className="retro-stat">
          <span className="retro-stat-num">{agg.days}</span> 天有记录
        </span>
        {agg.totalMin !== null && (
          <span className="retro-stat">
            <span className="retro-stat-num">{Math.round((agg.totalMin / 60) * 10) / 10}</span> 小时
          </span>
        )}
      </div>

      {agg.entries === 0 ? (
        <EmptyState
          title="本期还没有记录"
          desc="先去今日页记几笔，回到这里就能看到聚合与复盘"
        />
      ) : (
        <div className="retro-grid">
          {/* 主题分布：条形清单 */}
          <section className="retro-sec">
            <h4 className="retro-sec-h">主题分布</h4>
            <div className="retro-themes">
              {agg.themeDist.map((t) => (
                <div key={t.name} className="retro-theme-row" title={`${t.name}：${t.count} 条`}>
                  <span className="retro-theme-name">{t.name}</span>
                  <span className="retro-theme-track">
                    <span className="retro-theme-bar" style={{ width: `${(t.count / maxThemeCount) * 100}%` }} />
                  </span>
                  <span className="retro-theme-count">{t.count} 条</span>
                </div>
              ))}
            </div>
          </section>

          {/* 学到什么 / 里程碑 */}
          <section className="retro-sec">
            <h4 className="retro-sec-h">学到什么 <span className="retro-sec-n">{agg.learnings.length}</span></h4>
            {agg.learnings.length === 0 ? (
              <div className="retro-empty-line">本期暂无</div>
            ) : (
              <ul className="retro-list">
                {agg.learnings.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            )}
            <h4 className="retro-sec-h retro-sec-h-2">里程碑 <span className="retro-sec-n">{agg.milestones.length}</span></h4>
            {agg.milestones.length === 0 ? (
              <div className="retro-empty-line">本期暂无</div>
            ) : (
              <ul className="retro-list retro-milestones">
                {agg.milestones.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {/* AI 复盘：生成 → 编辑 → 保存快照 */}
      <section className="retro-sec">
        <div className="retro-gen-head">
          <h4 className="retro-sec-h">{periodLabel}</h4>
          <div className="retro-gen-actions">
            <Button
              size="sm" variant="default" icon={<Sparkles size={14} />}
              loading={generating} disabled={generating}
              onClick={() => void onGenerate()}
            >
              {aiText ? '重新生成' : 'AI 生成复盘'}
            </Button>
            <Button
              size="sm" variant="primary"
              disabled={!aiText.trim() || saving} loading={saving}
              onClick={() => void onSave()}
            >
              保存快照
            </Button>
          </div>
        </div>
        {genErr && <div className="warn-soft" style={{ marginBottom: 8 }}>{genErr}</div>}
        <textarea
          className="rpt-textarea"
          rows={10}
          placeholder="点「AI 生成复盘」基于本期记录起草，正文可自由编辑后保存快照"
          value={aiText}
          onChange={(e) => setAiText(e.target.value)}
        />
      </section>

      {/* 历史快照：可展开回看 */}
      <section className="retro-sec">
        <h4 className="retro-sec-h">历史快照 <span className="retro-sec-n">{snapshots.length}</span></h4>
        {snapshots.length === 0 ? (
          <div className="retro-empty-line">还没有保存过{kind === 'week' ? '周' : '月'}复盘</div>
        ) : (
          <div className="retro-snaps">
            {snapshots.map((s) => {
              const expanded = expandedId === s.id;
              return (
                <div key={s.id} className="retro-snap">
                  <button
                    type="button"
                    className="retro-snap-row"
                    onClick={() => setExpandedId(expanded ? null : s.id)}
                  >
                    <span className="retro-snap-period">{s.period}</span>
                    <span className="retro-snap-preview">{s.content.split('\n')[0]}</span>
                    <span className="retro-snap-date">{new Date(s.createdAt).toLocaleDateString()}</span>
                    <span className="retro-snap-toggle">{expanded ? '收起' : '展开'}</span>
                  </button>
                  {expanded && <div className="retro-snap-full">{s.content}</div>}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 导出 Obsidian */}
      <div className="retro-export-row">
        <Button
          size="sm" variant="default" icon={<BookOpenCheck size={14} />}
          loading={exporting} disabled={exporting}
          onClick={() => void onExport()}
        >
          导出到 Obsidian（{from} ~ {to}）
        </Button>
        {exportMsg && (
          <span className={exportMsg.ok ? 'muted' : 'warn-soft'} style={{ fontSize: 12 }}>{exportMsg.text}</span>
        )}
      </div>
    </div>
  );
}
