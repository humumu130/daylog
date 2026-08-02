import { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Spinner } from '@fluentui/react-components';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useRecordsStore } from '../../stores/useRecordsStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { scanRepos, type GitCommit } from '../../services/git';
import { consolidateCommits } from '../../services/llm';
import { notifyChanged } from '../../services/events';
import { currentYM, todayYMD } from '../../utils/date';
import { formatHours } from '../../utils/halfDay';
import * as db from '../../services/db';

type Period = 'today' | '7d' | '30d' | 'month';
type AnnotatedCommit = GitCommit & { imported: boolean };

interface SmartItem {
  title: string;
  count: number;
  day: string;
  projectId: string | null;
  hours: number;
  hashes: string[];
  imported: boolean;
  isExisting?: boolean;
}

const RAW_DEFAULT_MIN = 30;

export function GitPage() {
  const repos = useSettingsStore((s) => s.settings.repos);
  const gitMode = useSettingsStore((s) => s.settings.gitImportMode);
  const patchSettings = useSettingsStore((s) => s.patch);
  const llmConfig = useSettingsStore((s) => s.settings.llm);
  const projects = useProjectsStore((s) => s.projects);
  const create = useRecordsStore((s) => s.create);

  const [period, setPeriod] = useState<Period>('30d');
  const [pickMonth, setPickMonth] = useState(currentYM());
  const [commits, setCommits] = useState<AnnotatedCommit[]>([]);
  const [errors, setErrors] = useState<{ path: string; error: string }[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState('');
  const [smartItems, setSmartItems] = useState<SmartItem[]>([]);
  const [smartLoading, setSmartLoading] = useState(false);
  const [smartError, setSmartError] = useState('');
  const [hasConsolidated, setHasConsolidated] = useState(false);
  const knownHashesRef = useMemo(() => ({ current: new Set<string>() }), []);

  const { since, until } = useMemo(() => {
    if (period === 'today') return { since: 'today', until: undefined as string | undefined };
    if (period === '7d') return { since: '7 days ago', until: undefined };
    if (period === '30d') return { since: '30 days ago', until: undefined };
    const [y, m] = pickMonth.split('-').map(Number);
    const next = new Date(y, m, 1);
    return { since: `${pickMonth}-01`, until: `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-01` };
  }, [period, pickMonth]);

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

  async function runConsolidate(cs: GitCommit[], known: Set<string>) {
    setSmartLoading(true);
    setSmartError('');
    setHasConsolidated(true);
    try {
      const existing = await db.listRecordsByRange('2000-01-01', '2999-12-31');
      const existingInput = existing.map((r) => ({ content: r.content, project: undefined }));
      const items = await consolidateCommits(cs, llmConfig, existingInput);
      const mapped: SmartItem[] = items.map((it) => {
        const cs2 = cs.filter((c) => it.hashes.includes(c.hash));
        const day = cs2.map((c) => c.date).sort().pop() ?? todayYMD();
        const pids = new Set(cs2.map((c) => c.projectId).filter(Boolean) as string[]);
        const projectId = pids.size === 1 ? [...pids][0] : (cs2[0]?.projectId ?? null);
        const isExisting = it.status === 'existing';
        return {
          title: it.title,
          count: cs2.length,
          day,
          projectId,
          hours: it.hours ?? 1,
          hashes: it.hashes,
          imported: it.hashes.every((h) => known.has(h)),
          isExisting,
        };
      });
      setSmartItems(mapped);
      setChecked(new Set(mapped.filter((i) => !i.imported && !i.isExisting).map((_, i) => `s${i}`)));
    } catch (e) {
      setSmartError(e instanceof Error ? e.message : String(e));
      setSmartItems([]);
    } finally {
      setSmartLoading(false);
    }
  }

  async function scan() {
    setLoading(true);
    setErrors([]);
    setDone('');
    setSmartError('');
    try {
      const known = await loadKnownHashes();
      const res = await scanRepos(repos, since, until);
      const annotated: AnnotatedCommit[] = res.commits.map((c) => ({ ...c, imported: known.has(c.hash) }));
      setCommits(annotated);
      setErrors(res.errors);
      setChecked(new Set(annotated.filter((c) => !c.imported).map((c) => `r${c.hash}${c.repoId}`)));
      // 智能模式：仅首次自动整合，之后保留结果等用户手动触发
      if (gitMode === 'smart' && res.commits.length > 0 && !hasConsolidated) {
        await runConsolidate(res.commits, known);
      }
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
  }, [repos.length, period, pickMonth, gitMode]);

  function toggleMode(m: 'raw' | 'smart') {
    void patchSettings({ gitImportMode: m });
    if (m === 'smart' && commits.length > 0 && smartItems.length === 0 && !smartLoading) {
      void runConsolidate(commits, knownHashesRef.current);
    }
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

  async function doImport() {
    let count = 0;
    if (gitMode === 'smart') {
      const sel = smartItems.filter((_, i) => checked.has(`s${i}`));
      for (const it of sel) {
        await create({
          content: it.title,
          durationMin: Math.round(it.hours * 60),
          day: it.day,
          half: 'morning',
          taskId: null,
          projectId: it.projectId,
          source: 'git',
          meta: { git_hashes: it.hashes },
        });
        count++;
      }
    } else {
      const sel = commits.filter((c) => checked.has(`r${c.hash}${c.repoId}`));
      for (const c of sel) {
        await create({
          content: c.subject,
          durationMin: RAW_DEFAULT_MIN,
          day: c.date,
          half: 'morning',
          taskId: null,
          projectId: c.projectId,
          source: 'git',
          meta: { git_hash: c.hash },
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

  if (repos.length === 0) {
    return (
      <div className="empty" style={{ padding: 56 }}>
        还没配置 Git 仓库。去「设置 → Git 仓库」添加本地仓库路径（可映射到项目），这里会自动扫描提交供审核导入。
      </div>
    );
  }

  const showSmart = gitMode === 'smart';

  // 全选/取消全选（针对当前模式的可选条目：排除已导入/已有记录）
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

  return (
    <div>
      <div className="page-head">
        <div className="left">
          <h2 className="section-title">Git 扫描</h2>
          <span className="muted">配置仓库的提交 → 审核 → 导入</span>
        </div>
        <div className="row gap-sm wrap">
          <div className="seg">
            <button className={`seg-btn${!showSmart ? ' active' : ''}`} onClick={() => toggleMode('raw')}>原始提交</button>
            <button className={`seg-btn${showSmart ? ' active' : ''}`} onClick={() => toggleMode('smart')}>智能整合</button>
          </div>
        </div>
      </div>

      <div className="row gap-sm wrap" style={{ marginBottom: 16 }}>
        <Button size="small" appearance={period === 'today' ? 'primary' : 'secondary'} onClick={() => setPeriod('today')}>今天</Button>
        <Button size="small" appearance={period === '7d' ? 'primary' : 'secondary'} onClick={() => setPeriod('7d')}>最近7天</Button>
        <Button size="small" appearance={period === '30d' ? 'primary' : 'secondary'} onClick={() => setPeriod('30d')}>最近30天</Button>
        <input type="month" className={`sel git-month${period === 'month' ? ' is-active' : ''}`} value={pickMonth}
          onChange={(e) => { setPickMonth(e.target.value); setPeriod('month'); }} style={{ width: 'auto' }} />
        <Button onClick={() => void scan()} disabled={loading}>重新扫描</Button>
      </div>

      {showSmart && (
        <div className="set-tip" style={{ marginBottom: 12 }}>
          智能整合：LLM 自动合并相关提交（同一 bug/功能的代码+CI+部署+补丁）并估算耗时。
          {!llmConfig.apiKey && llmConfig.kind !== 'claude-code' && ' ⚠ 需在设置配置 LLM。'}
        </div>
      )}

      {errors.length > 0 && (
        <div className="warn-soft">
          {errors.map((e) => (
            <div key={e.path}>{e.path}：{e.error}</div>
          ))}
        </div>
      )}

      {loading && !showSmart && <Spinner label="扫描中…" />}
      {showSmart && smartLoading && <Spinner label="智能整合中…" />}
      {showSmart && smartError && <div className="warn-soft">⚠ 整合失败：{smartError}。可切回「原始提交」模式或点「重新整合」重试。</div>}

      {!loading && !showSmart && commits.length === 0 && errors.length === 0 && (
        <div className="empty" style={{ padding: 40 }}>该时段没有提交。</div>
      )}

      {/* 智能模式：还没整合时的提示 */}
      {!loading && showSmart && !smartLoading && smartItems.length === 0 && !smartError && commits.length > 0 && (
        <div className="empty" style={{ padding: 40 }}>
          扫描到 {commits.length} 条提交。点下方按钮开始智能整合。
          <div style={{ marginTop: 12 }}>
            <Button appearance="primary" onClick={() => void runConsolidate(commits, knownHashesRef.current)}>
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
                        <span className="git-subject">{c.subject}</span>
                        {c.imported && <span className="git-imported-badge">已导入</span>}
                        <span className="muted git-date">{c.date}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          <div className="row gap-sm" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
            {done && <span className="muted">{done}</span>}
            <Button size="small" appearance="subtle" onClick={toggleAll} disabled={selectableKeys.length === 0}>
              {allSelected ? '取消全选' : '全选'}
            </Button>
            <Button appearance="primary" onClick={() => void doImport()} disabled={checked.size === 0}>
              导入选中 ({checked.size})
            </Button>
          </div>
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
                <Button size="small" appearance="subtle" onClick={() => void runConsolidate(commits, knownHashesRef.current)} style={{ marginLeft: 'auto' }}>
                  重新整合
                </Button>
              </div>
              {smartItems.map((item, i) => {
                const key = `s${i}`;
                const proj = item.projectId ? projects.find((p) => p.id === item.projectId) : undefined;
                const dimmed = item.imported || item.isExisting;
                return (
                  <div key={key} className={`git-row${dimmed ? ' imported' : ''}`}>
                    <Checkbox checked={checked.has(key)} onChange={() => toggle(key)} />
                    <span className="git-subject">{item.title}</span>
                    {proj && <span className="tl-ptag" style={{ background: proj.color + '1a', color: proj.color }}>{proj.name}</span>}
                    <span className="git-smart-meta muted">{item.count} 提交 · {item.day}</span>
                    <span className="git-hours">{formatHours(Math.round(item.hours * 60))}</span>
                    {item.imported && <span className="git-imported-badge">已导入</span>}
                    {item.isExisting && !item.imported && <span className="git-existing-badge">已有记录</span>}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="row gap-sm" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
            {done && <span className="muted">{done}</span>}
            <Button size="small" appearance="subtle" onClick={toggleAll} disabled={selectableKeys.length === 0}>
              {allSelected ? '取消全选' : '全选'}
            </Button>
            <Button appearance="primary" onClick={() => void doImport()} disabled={checked.size === 0}>
              导入选中 ({checked.size})
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
