import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, FolderGit2, Inbox, MessagesSquare } from 'lucide-react';
import { Button, Checkbox, EmptyState, SourceBadge, Spinner, Textarea } from '../../ui';
import { useCollectStore } from '../../stores/useCollectStore';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useRecordsStore } from '../../stores/useRecordsStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { signatureOf, useGitStore } from '../../stores/useGitStore';
import { scanRepos, type GitCommit } from '../../services/git';
import { notifyChanged } from '../../services/events';
import { formatHours } from '../../utils/halfDay';
import { formatYMDChinese, todayYMD } from '../../utils/date';
import type { RecordSource, WorkRecord } from '../../types/models';
import * as db from '../../services/db';
import { RangeAllocModal, type SelectedItem } from '../components/RangeAllocModal';
import { SuggestionList } from '../components/SuggestionList';
import { useCwdSuggestions } from '../hooks/useCwdSuggestions';
import { previewConsolidate } from '../../services/collector';
import { hasLlmApiKey } from '../../services/llmKey';
import './collect.css';

type Period = 'today' | '7d' | '30d' | 'range';
type AnnotatedCommit = GitCommit & { imported: boolean };

const RAW_DEFAULT_MIN = 30;

/** AI 会话源卡的健康度行（按 provider） */
const AI_PROVIDER_ROWS: { key: string; label: string }[] = [
  { key: 'claude-code', label: 'Claude Code' },
  { key: 'codex', label: 'Codex' },
];

/** 去掉 conventional-commit 前缀，如 fix(report): / feat: / chore(api)!:  */
function cleanSubject(s: string): string {
  const t = s.replace(/^(fixup! |squash! )?(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([^)]+\))?(!)?:\s*/i, '').trim();
  return t || s;
}

/** 相对时间：刚刚 / X 分钟前 / X 小时前 / 昨天 / MM-DD HH:mm */
function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = new Date(ts);
  const now = new Date();
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  if (dayStart(now) - dayStart(d) === 86_400_000) return '昨天';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 自动条目的来源徽标（autoRecords 只含 ai/git/mixed，其余按 ai 兜底显示） */
function autoBadgeSrc(s: RecordSource): 'ai' | 'git' | 'mixed' {
  if (s === 'git') return 'git';
  if (s === 'mixed') return 'mixed';
  return 'ai';
}

export function CollectPage() {
  const navigate = useNavigate();
  // P8b 空间分流：personal=文案中性化 + 未映射认领卡隐藏 + 查询/落库带 wsId；work 路径原样
  const wsKind = useWorkspaceStore((s) => s.currentKind());
  const wsId = useWorkspaceStore((s) => s.currentId);
  const isPersonal = wsKind === 'personal';
  const repos = useSettingsStore((s) => s.settings.repos);
  const gitMode = useSettingsStore((s) => s.settings.gitImportMode);
  const patchSettings = useSettingsStore((s) => s.patch);
  const llmConfig = useSettingsStore((s) => s.settings.llm);
  const dailyCap = useSettingsStore((s) => s.settings.dailyCapHours);
  const gitAuthor = useSettingsStore((s) => s.settings.gitAuthor);
  const scanRoots = useSettingsStore((s) => s.settings.collect.scanRoots);
  const noiseFilterOn = useSettingsStore((s) => s.settings.collect.noiseFilter);
  const collectCfg = useSettingsStore((s) => s.settings.collect);
  const projects = useProjectsStore((s) => s.projects);
  const create = useRecordsStore((s) => s.create);

  // ---- 采集中心 store（自动条目 / 噪音 / 补扫），页面只调 store ----
  const scanning = useCollectStore((s) => s.scanning);
  const busyKey = useCollectStore((s) => s.busyKey);
  const lastPass = useCollectStore((s) => s.lastPass);
  const pendingNoise = useCollectStore((s) => s.pendingNoise);
  const autoDroppedNoise = useCollectStore((s) => s.autoDroppedNoise);
  const autoRecords = useCollectStore((s) => s.autoRecords);
  const collectError = useCollectStore((s) => s.error);
  const refresh = useCollectStore((s) => s.refresh);
  const scanNow = useCollectStore((s) => s.scanNow);
  const decideNoise = useCollectStore((s) => s.decideNoise);
  const restoreNoise = useCollectStore((s) => s.restoreNoise);
  const undoDayAction = useCollectStore((s) => s.undoDayAction);
  const removeIgnore = useCollectStore((s) => s.removeIgnore);
  const rebuildAction = useCollectStore((s) => s.rebuildAction);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // LLM key 可用性（内联或 keychain，P8）：非同步，异步解析成 state 供提示判定
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

  // ---- 手动导入（Git）：原 CollectPage 逻辑原样保留 ----

  // 智能整合状态在 store 里（跨页面存活，切走不丢、不重跑）
  const smartItems = useGitStore((s) => s.smartItems);
  const smartStatus = useGitStore((s) => s.smartStatus);
  const smartError = useGitStore((s) => s.smartError);
  const consolidatedSignature = useGitStore((s) => s.consolidatedSignature);
  const runConsolidate = useGitStore((s) => s.runConsolidate);
  const setItemHours = useGitStore((s) => s.setItemHours);

  const [period, setPeriod] = useState<Period>('30d');
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  const [commits, setCommits] = useState<AnnotatedCommit[]>([]);
  const [errors, setErrors] = useState<{ path: string; error: string }[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [expandedSmart, setExpandedSmart] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState('');
  const [rangeOpen, setRangeOpen] = useState(false);
  const [noiseFoldOpen, setNoiseFoldOpen] = useState(false);
  // ---- 聊天记录导入（E1）：粘贴 → AI 解析预览 → 确认入库（L2 一次确认，不静默） ----
  const [pasteText, setPasteText] = useState('');
  const [pasteDay, setPasteDay] = useState(() => todayYMD());
  const [pastePreview, setPastePreview] = useState<{ title: string; hours: number }[] | null>(null);
  const [pasteChecked, setPasteChecked] = useState<Set<number>>(new Set());
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteErr, setPasteErr] = useState('');
  const [pasteDone, setPasteDone] = useState('');
  const knownHashesRef = useMemo(() => ({ current: new Set<string>() }), []);

  const showSmart = gitMode === 'smart';
  const smartLoading = smartStatus === 'loading';
  const currentSig = useMemo(() => signatureOf(commits), [commits]);
  // 原始提交是否已变化（有旧结果但指纹不同）→ 提示重新整合，不自动跑
  const smartStale = smartItems.length > 0 && consolidatedSignature !== currentSig && currentSig !== '';

  const { since, until } = useMemo(() => {
    if (period === 'today') return { since: 'today', until: undefined as string | undefined };
    if (period === '7d') return { since: '7 days ago', until: undefined };
    if (period === '30d') return { since: '30 days ago', until: undefined };
    return { since: rangeFrom, until: rangeTo || undefined }; // 自定义区间
  }, [period, rangeFrom, rangeTo]);

  async function loadKnownHashes() {
    const all = await db.listRecordsByRange('2000-01-01', '2999-12-31', wsId);
    const hashes = new Set<string>();
    for (const r of all) {
      const h = r.meta?.git_hash;
      if (typeof h === 'string') hashes.add(h);
      const hs = r.meta?.git_hashes;
      if (Array.isArray(hs)) for (const x of hs) if (typeof x === 'string') hashes.add(x);
    }
    knownHashesRef.current = hashes;
    return hashes;
  }

  async function scan() {
    setLoading(true);
    setErrors([]);
    setDone('');
    try {
      const known = await loadKnownHashes();
      const res = await scanRepos(repos, since, until, gitAuthor);
      const annotated: AnnotatedCommit[] = res.commits.map((c) => ({ ...c, imported: known.has(c.hash) }));
      setCommits(annotated);
      setErrors(res.errors);
      setChecked(new Set(annotated.filter((c) => !c.imported).map((c) => `r${c.hash}${c.repoId}`)));
    } catch (e) {
      setErrors([{ path: '', error: String(e) }]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (repos.length) void scan();
    else setCommits([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos.length, period, rangeFrom, rangeTo]);

  // 首次进入 smart 模式且没整合过 → 自动整合一次（之后切走回来不重跑；提交变化则提示）
  useEffect(() => {
    if (!showSmart || commits.length === 0) return;
    if (smartStatus === 'loading') return;
    if (smartItems.length === 0 && consolidatedSignature === null && smartStatus !== 'error') {
      void runConsolidate(commits, llmConfig, knownHashesRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSmart, commits, smartStatus, smartItems.length, consolidatedSignature]);

  // 整合结果变化时，重置勾选为新的可导入项
  useEffect(() => {
    if (showSmart && smartItems.length > 0) {
      setChecked(new Set(smartItems.map((it, i) => ({ it, i })).filter((x) => !x.it.imported && !x.it.isExisting).map((x) => `s${x.i}`)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smartItems]);

  function toggleMode(m: 'raw' | 'smart') {
    void patchSettings({ gitImportMode: m });
    if (m === 'raw') {
      setChecked(new Set(commits.filter((c) => !c.imported).map((c) => `r${c.hash}${c.repoId}`)));
    }
  }

  function toggle(key: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function toggleSmart(key: string) {
    setExpandedSmart((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const selectableKeys = showSmart
    ? smartItems.flatMap((item, i) => (!item.isExisting && !item.imported ? [`s${i}`] : []))
    : commits.filter((c) => !c.imported).map((c) => `r${c.hash}${c.repoId}`);
  const allSelected = selectableKeys.length > 0 && selectableKeys.every((k) => checked.has(k));
  function toggleAll() {
    setChecked((prev) => {
      const next = new Set(prev);
      if (allSelected) selectableKeys.forEach((k) => next.delete(k));
      else selectableKeys.forEach((k) => next.add(k));
      return next;
    });
  }

  async function doImport() {
    let count = 0;
    if (showSmart) {
      const sel = smartItems.filter((_, i) => checked.has(`s${i}`));
      for (const it of sel) {
        await create({
          content: it.title, durationMin: Math.round(it.hours * 60), day: it.day, half: 'morning',
          taskId: null, projectId: it.projectId, source: 'git', meta: { git_hashes: it.hashes }, workspaceId: wsId,
        });
        count++;
      }
    } else {
      const sel = commits.filter((c) => checked.has(`r${c.hash}${c.repoId}`));
      for (const c of sel) {
        await create({
          content: cleanSubject(c.subject), durationMin: RAW_DEFAULT_MIN, day: c.date, half: 'morning',
          taskId: null, projectId: c.projectId, source: 'git', meta: { git_hash: c.hash }, workspaceId: wsId,
        });
        count++;
      }
    }
    await notifyChanged();
    setDone(`已导入 ${count} 条`);
    setTimeout(() => setDone(''), 2000);
    setChecked(new Set());
    void loadKnownHashes();
  }

  // 构造给"分配到区间"弹窗的选中项
  function buildSelected(): SelectedItem[] {
    if (showSmart) {
      return smartItems
        .map((it, i) => ({ it, i }))
        .filter((x) => !x.it.imported && !x.it.isExisting && checked.has(`s${x.i}`))
        .map((x) => ({ key: `s${x.i}`, estHours: x.it.hours }));
    }
    return commits
      .filter((c) => !c.imported && checked.has(`r${c.hash}${c.repoId}`))
      .map((c) => ({ key: `r${c.hash}${c.repoId}`, estHours: RAW_DEFAULT_MIN / 60 }));
  }

  // 区间分配导入：每条按分配到的 day + hours 落库
  async function importAllocations(allocs: { key: string; day: string; hours: number }[]) {
    let count = 0;
    if (showSmart) {
      for (const a of allocs) {
        const it = smartItems[Number(a.key.slice(1))];
        if (!it) continue;
        await create({
          content: it.title, durationMin: Math.round(a.hours * 60), day: a.day, half: 'morning',
          taskId: null, projectId: it.projectId, source: 'git', meta: { git_hashes: it.hashes }, workspaceId: wsId,
        });
        count++;
      }
    } else {
      for (const a of allocs) {
        const c = commits.find((cc) => `r${cc.hash}${cc.repoId}` === a.key);
        if (!c) continue;
        await create({
          content: cleanSubject(c.subject), durationMin: Math.round(a.hours * 60), day: a.day, half: 'morning',
          taskId: null, projectId: c.projectId, source: 'git', meta: { git_hash: c.hash }, workspaceId: wsId,
        });
        count++;
      }
    }
    await notifyChanged();
    setRangeOpen(false);
    setDone(`已导入 ${count} 条`);
    setTimeout(() => setDone(''), 2000);
    setChecked(new Set());
    void loadKnownHashes();
  }

  // ---- 聊天记录导入（E1）处理：previewConsolidate 只预览不落库，确认才写 ----

  async function parsePaste() {
    const text = pasteText.trim();
    if (!text || pasteBusy) return;
    setPasteBusy(true);
    setPasteErr('');
    setPastePreview(null);
    try {
      const existing = await db.listRecordsByDay(pasteDay, wsId); // 当日已有记录给 LLM 做语义去重提示
      const res = await previewConsolidate(pasteDay, text, {
        settings: collectCfg, llm: llmConfig, projects, existingRecords: existing,
      });
      const rows = res.entries.map((e) => ({ title: e.title, hours: Math.max(0.5, Number(e.hours) || 0.5) }));
      setPastePreview(rows);
      setPasteChecked(new Set(rows.map((_, i) => i))); // 预览默认全勾，用户可去勾（L2 一次确认）
      if (rows.length === 0) setPasteErr('没解析出可入库的内容，可补充上下文后重试');
    } catch {
      setPasteErr('解析失败：请检查 LLM 配置（设置·LLM）后重试');
    } finally {
      setPasteBusy(false);
    }
  }

  function togglePasteRow(i: number) {
    setPasteChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  async function importPaste() {
    const items = (pastePreview ?? []).filter((_, i) => pasteChecked.has(i));
    if (items.length === 0 || pasteBusy) return;
    setPasteBusy(true);
    try {
      for (const it of items) {
        await create({
          content: it.title, durationMin: Math.max(30, Math.round(it.hours * 60)), day: pasteDay, half: 'allday',
          // user_edited=确认收养：撤销自动/重整合不删用户确认过的导入条目
          taskId: null, projectId: null, source: 'ai', meta: { confirmed: true, user_edited: true }, workspaceId: wsId,
        });
      }
      await notifyChanged();
      setPasteDone(`已入库 ${items.length} 条`);
      setPastePreview(null);
      setPasteText('');
      setPasteChecked(new Set());
      setTimeout(() => setPasteDone(''), 2000);
    } catch {
      setPasteErr('入库失败，请重试');
    } finally {
      setPasteBusy(false);
    }
  }

  // ---- 采集中心：状态头 ----
  const pass = lastPass?.result ?? null;
  const passAtText = lastPass && lastPass.at > 0 ? relTime(lastPass.at) : null;
  const aiScanText = scanning
    ? '扫描中…'
    : pass
      ? `${pass.files} 文件 · ${pass.events} 事件${passAtText ? ` · ${passAtText}` : ''}`
      : '尚未扫描';

  const collectHead = (
    <div className="collect-head">
      <div className="collect-src">
        <div className="collect-src-title">
          <MessagesSquare size={14} className="collect-src-icon" aria-hidden="true" />
          <span>AI 会话源</span>
          {scanning && <Spinner size="sm" label="扫描中" />}
        </div>
        <div className="collect-src-sub" title={scanRoots.length > 0 ? scanRoots.join('\n') : undefined}>
          {scanRoots.length > 0 ? scanRoots.join(' · ') : '默认根 ~/.claude/projects + ~/.codex/sessions'}
        </div>
        <div className="collect-src-rows">
          {AI_PROVIDER_ROWS.map((p) => (
            <div key={p.key} className="collect-src-row">
              <span className="collect-src-row-name">{p.label}</span>
              <span className="collect-src-row-meta">{aiScanText}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="collect-src">
        <div className="collect-src-title">
          <Inbox size={14} className="collect-src-icon" aria-hidden="true" />
          <span>待办采集</span>
        </div>
        <div className="collect-src-meta">
          {pass
            ? `新建 ${pass.todos.created} · 更新 ${pass.todos.updated} · 跳过 ${pass.todos.skipped}${passAtText ? ` · ${passAtText}` : ''}`
            : '尚未采集'}
        </div>
      </div>
      <div className="collect-src">
        <div className="collect-src-title">
          <FolderGit2 size={14} className="collect-src-icon" aria-hidden="true" />
          <span>Git 仓库源</span>
        </div>
        <div className="collect-src-meta">
          {repos.length} 个已配置仓库{pass ? ` · 最近一轮 ${pass.commits} 提交` : ''}
          <Button size="sm" variant="ghost" onClick={() => navigate('/settings')}>去设置 →</Button>
        </div>
      </div>
    </div>
  );

  // ---- 采集中心：自动条目（按日分组，日倒序）；空间隔离只看当前空间 ----
  const autoByDay = useMemo(() => {
    const groups = new Map<string, WorkRecord[]>();
    for (const r of autoRecords) {
      if (r.workspaceId !== wsId) continue;
      const arr = groups.get(r.day);
      if (arr) arr.push(r);
      else groups.set(r.day, [r]);
    }
    return [...groups.entries()]; // autoRecords 已按 day 倒序 → 分组自然倒序
  }, [autoRecords, wsId]);

  const autoSection = (
    <section className="collect-section">
      <div className="collect-section-h">
        <span className="collect-section-title">自动条目</span>
        <span className="muted collect-section-sub">AI 会话与 Git 提交自动整合生成 · 近 14 天</span>
      </div>
      {autoByDay.length === 0 ? (
        <EmptyState title="暂无自动条目" desc="启动补扫后会出现在这里" />
      ) : (
        autoByDay.map(([day, list]) => {
          const totalMin = list.reduce((s, r) => s + (r.durationMin ?? 0), 0);
          const dayBusy = busyKey === `day:${day}`;
          return (
            <div key={day} className="collect-card collect-day">
              <div className="collect-day-head">
                <span className="collect-day-date">{formatYMDChinese(day)}</span>
                <span className="muted">{list.length} 条 · 合计 {formatHours(totalMin) || '0h'}</span>
                <div className="collect-day-actions">
                  <Button
                    size="sm" variant="ghost" title="用当前设置重新整合该日"
                    loading={dayBusy} disabled={busyKey !== null}
                    onClick={() => void rebuildAction(day)}
                  >
                    重整合
                  </Button>
                  <Button
                    size="sm" variant="ghost" title="删除当日自动条目（保留手动条目）"
                    disabled={busyKey !== null}
                    onClick={() => void undoDayAction(day)}
                  >
                    撤销自动
                  </Button>
                </div>
              </div>
              {list.map((r) => {
                const proj = r.projectId ? projects.find((p) => p.id === r.projectId) : undefined;
                const conf = typeof r.meta?.confidence === 'number' ? (r.meta.confidence as number) : null;
                const confText = conf !== null ? `整合置信度 ${conf.toFixed(2)}` : null;
                return (
                  <div key={r.id} className="collect-auto-row">
                    <SourceBadge src={autoBadgeSrc(r.source)} />
                    <span className="collect-auto-content" title={r.content}>{r.content}</span>
                    {proj && <span className="tl-ptag" style={{ background: proj.color + '1a', color: proj.color }}>{proj.name}</span>}
                    {confText && <span className={`collect-conf${conf !== null && conf < 0.5 ? ' is-low' : ''}`} title={confText}>{conf !== null ? conf.toFixed(2) : ''}</span>}
                    <span className="collect-auto-dur">{formatHours(r.durationMin) || '未计时'}</span>
                    <Button
                      size="sm" variant="ghost" className="collect-auto-remove" title="同内容不再自动生成"
                      loading={busyKey === `rec:${r.id}`} disabled={busyKey !== null}
                      onClick={() => void removeIgnore({ id: r.id, content: r.content, day: r.day })}
                    >
                      移除并忽略同类
                    </Button>
                  </div>
                );
              })}
            </div>
          );
        })
      )}
    </section>
  );

  // ---- 采集中心：噪音过滤（personal 空间文案中性化：「计入记录 / 无记录价值」） ----
  const noiseSection = (
    <section className="collect-section">
      <div className="collect-section-h">
        <span className="collect-section-title">噪音过滤</span>
        <span className="muted collect-section-sub">
          {isPersonal ? '整合时被判为无记录价值的内容在此确认' : '整合时被判为与工作无关的内容在此确认'}
        </span>
      </div>
      {!noiseFilterOn ? (
        <div className="collect-note">噪音过滤已关闭（设置·采集可开）</div>
      ) : (
        <div className="collect-card">
          {pendingNoise.length === 0 ? (
            <div className="collect-empty-line">没有待确认内容</div>
          ) : (
            pendingNoise.map((n) => (
              <div key={n.fingerprint} className="collect-noise-row">
                <div className="collect-noise-main">
                  <span className="collect-noise-digest" title={n.digest}>{n.digest}</span>
                  <span className="collect-noise-reason" title={n.reason}>{n.reason}</span>
                </div>
                <span className="collect-conf" title={`噪音置信度 ${n.confidence.toFixed(2)}`}>{n.confidence.toFixed(2)}</span>
                <div className="collect-noise-actions">
                  <Button
                    size="sm" variant="default" title={isPersonal ? '按正常记录内容参与该日整合' : '按正常工作内容参与该日整合'}
                    loading={busyKey === `noise:${n.fingerprint}`} disabled={busyKey !== null}
                    onClick={() => void decideNoise(n.fingerprint, true)}
                  >
                    {isPersonal ? '计入记录' : '计入工作'}
                  </Button>
                  <Button
                    size="sm" variant="ghost" title="同类内容不再进入整合"
                    disabled={busyKey !== null}
                    onClick={() => void decideNoise(n.fingerprint, false)}
                  >
                    {isPersonal ? '无记录价值' : '确是噪音'}
                  </Button>
                </div>
              </div>
            ))
          )}
          <button type="button" className="collect-fold" aria-expanded={noiseFoldOpen} onClick={() => setNoiseFoldOpen((v) => !v)}>
            {noiseFoldOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
            已自动排除 ({autoDroppedNoise.length})
          </button>
          {noiseFoldOpen &&
            autoDroppedNoise.map((n) => (
              <div key={n.fingerprint} className="collect-noise-row is-dropped">
                <div className="collect-noise-main">
                  <span className="collect-noise-digest" title={n.digest}>{n.digest}</span>
                  <span className="collect-noise-reason" title={n.reason}>{n.reason}</span>
                </div>
                <span className="collect-conf" title={`噪音置信度 ${n.confidence.toFixed(2)}`}>{n.confidence.toFixed(2)}</span>
                <Button
                  size="sm" variant="ghost" title="重新参与整合（该日重整合）"
                  loading={busyKey === `noise:${n.fingerprint}`} disabled={busyKey !== null}
                  onClick={() => void restoreNoise(n.fingerprint)}
                >
                  恢复
                </Button>
              </div>
            ))}
        </div>
      )}
    </section>
  );

  // ---- 采集中心：未映射会话认领（F2：规则初筛 + LLM 精配 → 归组/新建/忽略一键应用） ----
  // P8b：项目归组是 work 空间概念，personal 整卡隐藏——抽成组件以免 hook（识别请求）在 personal 下也跑

  const unmappedSection = !isPersonal ? <UnmappedSection /> : null;

  // ---- 采集中心：手动导入（聊天记录·E1）——粘贴 → AI 解析预览 → 确认入库 ----
  const chatSection = (
    <section className="collect-section">
      <div className="collect-section-h">
        <span className="collect-section-title">手动导入（聊天记录）</span>
        <span className="muted collect-section-sub">粘贴微信/飞书等聊天文本，AI 解析为条目，确认后入库</span>
      </div>
      <div className="collect-card">
        <div className="collect-paste-head">
          <label className="muted" htmlFor="dl-paste-day">日期</label>
          <input
            id="dl-paste-day" type="date" className="sel" style={{ width: 138 }}
            value={pasteDay} onChange={(e) => setPasteDay(e.target.value)}
          />
        </div>
        <Textarea
          className="collect-paste-input"
          rows={6}
          placeholder="粘贴聊天记录文本（发给同事/群里的内容直接贴，多段一起贴）…"
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
        />
        <div className="row gap-sm" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
          {pasteErr && <span className="warn-soft">{pasteErr}</span>}
          {pasteDone && <span className="muted">{pasteDone}</span>}
          <Button size="sm" variant="default" loading={pasteBusy} disabled={pasteBusy || !pasteText.trim()} onClick={() => void parsePaste()}>
            AI 解析预览
          </Button>
        </div>
        {pastePreview && pastePreview.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {pastePreview.map((it, i) => (
              <div key={i} className="collect-auto-row">
                <Checkbox checked={pasteChecked.has(i)} onChange={() => togglePasteRow(i)} ariaLabel="选择该条目" />
                <span className="collect-auto-content" title={it.title}>{it.title}</span>
                <input
                  type="number" className="sel" min={0.5} step={0.5} style={{ width: 64 }}
                  title="估时（小时，可改）"
                  value={it.hours}
                  onChange={(e) =>
                    setPastePreview((p) =>
                      (p ?? []).map((x, j) => (j === i ? { ...x, hours: Math.max(0.5, Number(e.target.value) || 0.5) } : x)),
                    )
                  }
                />
              </div>
            ))}
            <div className="row gap-sm" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
              <Button size="sm" variant="primary" disabled={pasteBusy || pasteChecked.size === 0} onClick={() => void importPaste()}>
                入库选中 ({pasteChecked.size})
              </Button>
            </div>
          </div>
        )}
        {pastePreview && pastePreview.length === 0 && (
          <div className="collect-empty-line">没解析出可入库的内容</div>
        )}
      </div>
    </section>
  );

  // ---- 手动导入（Git）：ActionBar 与主体（原逻辑不变） ----

  const selectedForRange = buildSelected();

  const ActionBar = (
    <div className="row gap-sm" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
      {done && <span className="muted">{done}</span>}
      <Button size="sm" variant="default" onClick={toggleAll} disabled={selectableKeys.length === 0}>
        {allSelected ? '取消全选' : '全选'}
      </Button>
      <Button size="sm" variant="default" onClick={() => setRangeOpen(true)} disabled={checked.size === 0}>
        分配到区间…
      </Button>
      <Button size="sm" variant="primary" onClick={() => void doImport()} disabled={checked.size === 0}>
        导入选中 ({checked.size})
      </Button>
    </div>
  );

  const gitBody = (
    <>
      <div className="row gap-sm wrap" style={{ marginBottom: 12 }}>
        <Button size="sm" style={{ minWidth: 80 }} variant={period === 'today' ? 'primary' : 'default'} onClick={() => setPeriod('today')}>今天</Button>
        <Button size="sm" style={{ minWidth: 80 }} variant={period === '7d' ? 'primary' : 'default'} onClick={() => setPeriod('7d')}>最近7天</Button>
        <Button size="sm" style={{ minWidth: 80 }} variant={period === '30d' ? 'primary' : 'default'} onClick={() => setPeriod('30d')}>最近30天</Button>
        <Button size="sm" variant={period === 'range' ? 'primary' : 'default'} onClick={() => setPeriod('range')}>自定义</Button>
        <Button size="sm" variant="default" style={{ marginLeft: 'auto' }} onClick={() => void scan()} disabled={loading}>重新扫描</Button>
      </div>
      {period === 'range' && (
        <div className="row gap-sm" style={{ marginBottom: 16 }}>
          <input type="date" className="sel" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} style={{ width: 138 }} />
          <span className="muted">至</span>
          <input type="date" className="sel" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} style={{ width: 138 }} />
        </div>
      )}

      {showSmart && !llmKeyReady && llmConfig.kind !== 'claude-code' && (
        <div className="set-tip" style={{ marginBottom: 12 }}>⚠ 需在设置配置 LLM 才能智能整合。</div>
      )}

      {errors.length > 0 && (
        <div className="warn-soft">
          {errors.map((e) => (
            <div key={e.path}>{e.path}：{e.error}</div>
          ))}
        </div>
      )}

      {loading && !showSmart && <Spinner label="扫描中…" />}
      {showSmart && smartLoading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '72px 0' }}>
          <Spinner label="智能整合中…" />
        </div>
      )}
      {showSmart && smartError && (
        <div className="warn-soft">⚠ 整合失败：{smartError}。可切回「原始提交」或点「重新整合」重试。</div>
      )}
      {showSmart && smartStale && !smartLoading && (
        <div className="warn-soft">
          原始提交有变化（已重新扫描）。{` `}
          <Button size="sm" variant="primary" onClick={() => void runConsolidate(commits, llmConfig, knownHashesRef.current)}>
            重新整合
          </Button>
        </div>
      )}

      {!loading && !showSmart && commits.length === 0 && errors.length === 0 && (
        <div className="empty" style={{ padding: 40 }}>该时段没有提交。</div>
      )}

      {/* 智能模式：还没整合、也没在跑、也没错 → 手动开始（首次通常自动触发，这是兜底） */}
      {!loading && showSmart && !smartLoading && smartItems.length === 0 && !smartError && commits.length > 0 && (
        <div className="empty" style={{ padding: 40 }}>
          扫描到 {commits.length} 条提交。
          <div style={{ marginTop: 12 }}>
            <Button variant="primary" onClick={() => void runConsolidate(commits, llmConfig, knownHashesRef.current)}>
              开始智能整合
            </Button>
          </div>
        </div>
      )}

      {/* 原始提交模式 */}
      {!loading && !showSmart && commits.length > 0 && (
        <>
          <div className="git-groups">
            {Object.entries(
              commits.reduce((acc, c) => {
                (acc[c.repoPath] ??= []).push(c);
                return acc;
              }, {} as Record<string, AnnotatedCommit[]>),
            ).map(([path, list]) => {
              const proj = list[0].projectId ? projects.find((p) => p.id === list[0].projectId) : undefined;
              return (
                <div key={path} className="card git-group">
                  <div className="git-group-head">
                    <span className="git-repo-name">{proj ? proj.name : path}</span>
                    <span className="muted">{path} · {list.length} 条 · 每条 {formatHours(RAW_DEFAULT_MIN)}</span>
                  </div>
                  {list.map((c) => {
                    const key = `r${c.hash}${c.repoId}`;
                    return (
                      <div key={key} className={`git-row${c.imported ? ' imported' : ''}`}>
                        <Checkbox checked={checked.has(key)} onChange={() => toggle(key)} ariaLabel="选择该提交" />
                        <span className="git-hash">{c.hash}</span>
                        <span className="git-subject">{cleanSubject(c.subject)}</span>
                        {proj && <span className="tl-ptag" style={{ background: proj.color + '1a', color: proj.color }}>{proj.name}</span>}
                        {c.imported && <span className="git-imported-badge">已导入</span>}
                        <span className="muted git-date">{c.date}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {ActionBar}
        </>
      )}

      {/* 智能整合模式 */}
      {!loading && showSmart && !smartLoading && smartItems.length > 0 && (
        <>
          <div className="git-groups">
            <div className="git-group">
              <div className="git-group-head">
                <span className="git-repo-name">整合结果</span>
                <span className="muted">
                  {smartItems.filter((i) => !i.isExisting && !i.imported).length} 新增 · {smartItems.filter((i) => i.isExisting).length} 已有 · 合计 {formatHours(smartItems.reduce((s, i) => s + i.hours * 60, 0))}
                </span>
                <Button size="sm" variant="ghost" onClick={() => void runConsolidate(commits, llmConfig, knownHashesRef.current)} style={{ marginLeft: 'auto' }}>
                  重新整合
                </Button>
              </div>
              {smartItems.map((item, i) => {
                const key = `s${i}`;
                const proj = item.projectId ? projects.find((p) => p.id === item.projectId) : undefined;
                const dimmed = item.imported || item.isExisting;
                const expanded = expandedSmart.has(key);
                const bundled = commits.filter((c) => item.hashes.includes(c.hash));
                return (
                  <div key={key}>
                    <div className={`git-row${dimmed ? ' imported' : ''}`}>
                      <Checkbox checked={checked.has(key)} onChange={() => toggle(key)} ariaLabel="选择该整合项" />
                      <span className="git-subject">{item.title}</span>
                      {proj && <span className="tl-ptag" style={{ background: proj.color + '1a', color: proj.color }}>{proj.name}</span>}
                      <span className="git-smart-meta muted" style={{ cursor: bundled.length ? 'pointer' : 'default' }} onClick={() => bundled.length && toggleSmart(key)} title={bundled.length ? '点击展开原始提交' : ''}>
                        {item.count} 提交 · {item.day}{bundled.length ? (expanded ? ' ▾' : ' ▸') : ''}
                      </span>
                      <input
                        type="number"
                        className="sel git-hours-input"
                        step={0.5}
                        min={0}
                        value={item.hours}
                        disabled={dimmed}
                        onChange={(e) => setItemHours(i, Math.max(0, Number(e.target.value) || 0))}
                        title="估时（小时，可改）"
                        style={{ width: 60 }}
                      />
                      {item.imported && <span className="git-imported-badge">已导入</span>}
                      {item.isExisting && !item.imported && <span className="git-existing-badge">已有记录</span>}
                    </div>
                    {expanded && bundled.length > 0 && (
                      <div className="git-smart-detail">
                        {bundled.map((c) => (
                          <div key={c.hash} className="git-smart-commit">
                            <span className="git-hash">{c.hash}</span>
                            <span className="muted">{c.date}</span>
                            <span>{cleanSubject(c.subject)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          {ActionBar}
        </>
      )}

      <RangeAllocModal
        open={rangeOpen}
        selected={selectedForRange}
        dailyCap={dailyCap}
        onClose={() => setRangeOpen(false)}
        onImport={(allocs) => void importAllocations(allocs)}
      />
    </>
  );

  return (
    <div>
      <div className="page-head">
        <div className="left">
          <h2 className="section-title">采集中心</h2>
          <span className="muted">Git 提交与 AI 会话的审核入库</span>
        </div>
        <div className="row gap-sm wrap">
          <Button variant="primary" loading={scanning} onClick={() => void scanNow()}>立即补扫</Button>
        </div>
      </div>

      {collectHead}

      {collectError && <div className="warn-soft">{collectError}</div>}

      {autoSection}

      {unmappedSection}

      {noiseSection}

      {chatSection}

      <section className="collect-section">
        <div className="collect-section-h">
          <span className="collect-section-title">手动导入（Git）</span>
          <span className="muted collect-section-sub">回溯工具：扫描提交、审核后入库</span>
          <div className="seg">
            <button className={`seg-btn${!showSmart ? ' active' : ''}`} onClick={() => toggleMode('raw')}>原始提交</button>
            <button className={`seg-btn${showSmart ? ' active' : ''}`} onClick={() => toggleMode('smart')}>智能整合</button>
          </div>
        </div>
        {repos.length === 0 ? (
          <div className="empty" style={{ padding: 40 }}>
            还没有数据源。Git 仓库在设置·项目与仓库添加后，这里自动扫描供审核导入。
            <div style={{ marginTop: 12 }}>
              <Button variant="primary" onClick={() => navigate('/settings')}>去设置</Button>
            </div>
          </div>
        ) : (
          gitBody
        )}
      </section>
    </div>
  );
}

/** 未映射会话认领卡（work 空间专属，P8b personal 隐藏；独立组件以免隐藏时仍跑识别 hook） */
function UnmappedSection() {
  const cwdSug = useCwdSuggestions();
  return (
    <section className="collect-section">
      <div className="collect-section-h">
        <span className="collect-section-title">未映射会话认领</span>
        <span className="muted collect-section-sub">
          发现工作目录尚未归属项目{cwdSug.degraded ? ' · 规则模式（未配置 LLM）' : ''}
        </span>
        <Button
          size="sm" variant="ghost" style={{ marginLeft: 'auto' }}
          disabled={cwdSug.loading} onClick={() => void cwdSug.reload()}
        >
          重新识别
        </Button>
      </div>
      {cwdSug.error && <div className="warn-soft">{cwdSug.error}</div>}
      <SuggestionList
        title="AI 建议归组"
        items={cwdSug.rows}
        busy={cwdSug.loading}
        onTargetChange={cwdSug.setTarget}
        onDismiss={cwdSug.dismiss}
        onApply={(sel) => void cwdSug.apply(sel)}
      />
    </section>
  );
}
