import { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Spinner } from '@fluentui/react-components';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useRecordsStore } from '../../stores/useRecordsStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { signatureOf, useGitStore } from '../../stores/useGitStore';
import { scanRepos, type GitCommit } from '../../services/git';
import { notifyChanged } from '../../services/events';
import { formatHours } from '../../utils/halfDay';
import * as db from '../../services/db';
import { RangeAllocModal, type SelectedItem } from '../components/RangeAllocModal';

type Period = 'today' | '7d' | '30d' | 'range';
type AnnotatedCommit = GitCommit & { imported: boolean };

const RAW_DEFAULT_MIN = 30;

/** 去掉 conventional-commit 前缀，如 fix(report): / feat: / chore(api)!:  */
function cleanSubject(s: string): string {
  const t = s.replace(/^(fixup! |squash! )?(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([^)]+\))?(!)?:\s*/i, '').trim();
  return t || s;
}

export function GitPage() {
  const repos = useSettingsStore((s) => s.settings.repos);
  const gitMode = useSettingsStore((s) => s.settings.gitImportMode);
  const patchSettings = useSettingsStore((s) => s.patch);
  const llmConfig = useSettingsStore((s) => s.settings.llm);
  const dailyCap = useSettingsStore((s) => s.settings.dailyCapHours);
  const projects = useProjectsStore((s) => s.projects);
  const create = useRecordsStore((s) => s.create);

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
    const all = await db.listRecordsByRange('2000-01-01', '2999-12-31');
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
      const res = await scanRepos(repos, since, until);
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
          taskId: null, projectId: it.projectId, source: 'git', meta: { git_hashes: it.hashes },
        });
        count++;
      }
    } else {
      const sel = commits.filter((c) => checked.has(`r${c.hash}${c.repoId}`));
      for (const c of sel) {
        await create({
          content: cleanSubject(c.subject), durationMin: RAW_DEFAULT_MIN, day: c.date, half: 'morning',
          taskId: null, projectId: c.projectId, source: 'git', meta: { git_hash: c.hash },
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
          taskId: null, projectId: it.projectId, source: 'git', meta: { git_hashes: it.hashes },
        });
        count++;
      }
    } else {
      for (const a of allocs) {
        const c = commits.find((cc) => `r${cc.hash}${cc.repoId}` === a.key);
        if (!c) continue;
        await create({
          content: cleanSubject(c.subject), durationMin: Math.round(a.hours * 60), day: a.day, half: 'morning',
          taskId: null, projectId: c.projectId, source: 'git', meta: { git_hash: c.hash },
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

  if (repos.length === 0) {
    return (
      <div className="empty" style={{ padding: 56 }}>
        还没配置 Git 仓库。去「设置 → 项目与仓库」添加本地仓库路径（关联到项目），这里会自动扫描提交供审核导入。
      </div>
    );
  }

  const selectedForRange = buildSelected();

  const ActionBar = (
    <div className="row gap-sm" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
      {done && <span className="muted">{done}</span>}
      <Button size="small" appearance="subtle" onClick={toggleAll} disabled={selectableKeys.length === 0}>
        {allSelected ? '取消全选' : '全选'}
      </Button>
      <Button size="small" appearance="secondary" onClick={() => setRangeOpen(true)} disabled={checked.size === 0}>
        分配到区间…
      </Button>
      <Button size="small" appearance="primary" onClick={() => void doImport()} disabled={checked.size === 0}>
        导入选中 ({checked.size})
      </Button>
    </div>
  );

  return (
    <div>
      <div className="page-head">
        <div className="left">
          <h2 className="section-title">Git 扫描</h2>
          <span className="muted">从 Git 提交导入工作日志</span>
        </div>
        <div className="row gap-sm wrap">
          <div className="seg">
            <button className={`seg-btn${!showSmart ? ' active' : ''}`} onClick={() => toggleMode('raw')}>原始提交</button>
            <button className={`seg-btn${showSmart ? ' active' : ''}`} onClick={() => toggleMode('smart')}>智能整合</button>
          </div>
        </div>
      </div>

      <div className="row gap-sm git-toolbar" style={{ marginBottom: 16, flexWrap: 'nowrap', overflow: 'auto' }}>
        <Button size="small" style={{ minWidth: 80 }} appearance={period === 'today' ? 'primary' : 'secondary'} onClick={() => setPeriod('today')}>今天</Button>
        <Button size="small" style={{ minWidth: 80 }} appearance={period === '7d' ? 'primary' : 'secondary'} onClick={() => setPeriod('7d')}>最近7天</Button>
        <Button size="small" style={{ minWidth: 80 }} appearance={period === '30d' ? 'primary' : 'secondary'} onClick={() => setPeriod('30d')}>最近30天</Button>
        <Button size="small" appearance={period === 'range' ? 'primary' : 'secondary'} onClick={() => setPeriod('range')}>自定义</Button>
        {period === 'range' && (
          <>
            <input type="date" className="sel git-period-input" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} />
            <span className="muted" style={{ fontSize: 12 }}>至</span>
            <input type="date" className="sel git-period-input" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} />
          </>
        )}
        <Button size="small" appearance="secondary" onClick={() => void scan()} disabled={loading}>重新扫描</Button>
      </div>

      {showSmart && !llmConfig.apiKey && llmConfig.kind !== 'claude-code' && (
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
          <Button size="small" appearance="primary" onClick={() => void runConsolidate(commits, llmConfig, knownHashesRef.current)}>
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
            <Button appearance="primary" onClick={() => void runConsolidate(commits, llmConfig, knownHashesRef.current)}>
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
                        <Checkbox checked={checked.has(key)} onChange={() => toggle(key)} />
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
                  {smartItems.filter((i) => !i.isExisting && !i.imported).length} 新增 · {smartItems.filter((i) => i.isExisting).length} 已有 · 合计 {formatHours(smartItems.reduce((s, i) => s + i.hours * 60, 0))}（可手改）
                </span>
                <Button size="small" appearance="subtle" onClick={() => void runConsolidate(commits, llmConfig, knownHashesRef.current)} style={{ marginLeft: 'auto' }}>
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
                      <Checkbox checked={checked.has(key)} onChange={() => toggle(key)} />
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
    </div>
  );
}
