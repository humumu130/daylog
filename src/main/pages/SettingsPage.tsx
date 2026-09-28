import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Input, Segmented, Switch } from '../../ui';
import { Plus, ChevronDown, ChevronRight, Pencil, Trash2 } from 'lucide-react';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { setAutostart } from '../../services/autostart';
import { HotkeyField } from '../components/HotkeyField';
import { Select } from '../components/Select';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { HelpTip } from '../components/HelpTip';
import { SuggestionList, type SuggestionRow } from '../components/SuggestionList';
import { setReportPolicy } from '../components/ChoerodonBatchModal';
import type { AppSettings, ChoerodonSettings, GitRepo, LlmConfig, ReportTemplate } from '../../types/models';
import * as db from '../../services/db';
import { generateReport } from '../../services/llm';
import {
  choerodonReporter,
  clearPat,
  getReporterCtx,
  savePat,
  type RemoteProject,
  type ReporterCtx,
} from '../../services/reporters';
import {
  applyProjectMap,
  llmMatchProjects,
  mapHealth,
  rememberRule,
  ruleMatchProjects,
} from '../../services/choerodonMap';
import { exportToFile, importFromFile } from '../../services/backup';
import { clearLlmKey, loadLlmKey, saveLlmKey } from '../../services/llmKey';
import { defaultScanRoots } from '../../services/collector';
import { addDays } from '../../utils/date';
import './settings-ia.css';

/** 设置页二级导航分区键（P4 信息架构重排：左导航 + 右分区条件渲染） */
type SetPaneKey = 'general' | 'llm' | 'collect' | 'backup' | 'choerodon' | 'projects' | 'templates';

const SET_PANES: { key: SetPaneKey; label: string }[] = [
  { key: 'general', label: '通用' },
  { key: 'llm', label: 'LLM' },
  { key: 'collect', label: '采集' },
  { key: 'backup', label: '备份' },
  { key: 'choerodon', label: '猪齿鱼' },
  { key: 'projects', label: '项目与目录' },
  { key: 'templates', label: '报告模板' },
];

export function SettingsPage() {
  const settings = useSettingsStore((s) => s.settings);
  const patch = useSettingsStore((s) => s.patch);
  const projects = useProjectsStore((s) => s.projects);
  const createProject = useProjectsStore((s) => s.create);
  const updateProject = useProjectsStore((s) => s.update);
  const removeProject = useProjectsStore((s) => s.remove);

  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);
  const [pname, setPname] = useState('');
  const [pcolor, setPcolor] = useState('#0078d4');
  const [pkw, setPkw] = useState('');
  const [newRepoPaths, setNewRepoPaths] = useState(''); // 新建项目时一并关联的仓库路径（每行一个，可选）

  // 二级导航：当前设置分区（右侧按此条件渲染）
  const [pane, setPane] = useState<SetPaneKey>('general');

  // 展开/折叠
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // 内联编辑：仓库
  const [editRid, setEditRid] = useState<string | null>(null);
  const [editRpath, setEditRpath] = useState('');
  const [editRproj, setEditRproj] = useState('');
  const [editRauthor, setEditRauthor] = useState('');

  // 内联编辑：项目
  const [editPid, setEditPid] = useState<string | null>(null);
  const [editPname, setEditPname] = useState('');
  const [editPcolor, setEditPcolor] = useState('#0078d4');
  const [editPkW, setEditPkW] = useState('');

  function flash(m: string) { setNotice(m); setTimeout(() => setNotice(''), 1800); }
  function setLlm(partial: Partial<LlmConfig>) { void patch({ llm: { ...settings.llm, ...partial } }); }
  async function toggleAutostart(on: boolean) { await patch({ autostart: on }); await setAutostart(on).catch(() => undefined); }

  async function addProject() {
    const name = pname.trim();
    if (!name) return;
    const pid = await createProject({ name, color: pcolor, keywords: pkw.split(',').map((s) => s.trim()).filter(Boolean), isActive: true, sortOrder: projects.length });
    // 可选：一并关联仓库（每行一个路径），点「新建项目」时一起建好
    const paths = newRepoPaths.split('\n').map((s) => s.trim()).filter(Boolean);
    if (paths.length > 0) {
      const newRepos: GitRepo[] = paths.map((p) => ({ id: crypto.randomUUID(), path: p, projectId: pid, author: '' }));
      await patch({ repos: [...settings.repos, ...newRepos] });
      flash(`已添加项目，并关联 ${newRepos.length} 个仓库`);
      setExpanded((prev) => new Set(prev).add(pid));
    } else {
      flash('已添加项目');
    }
    setPname(''); setPkw(''); setNewRepoPaths('');
  }

  async function removeRepo(id: string) { await patch({ repos: settings.repos.filter((r) => r.id !== id) }); }
  async function addRepoToProject(projectId: string, path: string, author: string) {
    const p = path.trim();
    if (!p) return;
    const r: GitRepo = { id: crypto.randomUUID(), path: p, projectId, author: author.trim() };
    await patch({ repos: [...settings.repos, r] });
    flash('已关联仓库');
    setExpanded((prev) => new Set(prev).add(projectId));
  }

  function startEditRepo(r: GitRepo) { setEditRid(r.id); setEditRpath(r.path); setEditRproj(r.projectId ?? ''); setEditRauthor(r.author); }
  async function saveEditRepo() {
    if (!editRid) return;
    await patch({ repos: settings.repos.map((r) => r.id === editRid ? { ...r, path: editRpath.trim() || r.path, projectId: editRproj || null, author: editRauthor.trim() } : r) });
    setEditRid(null); flash('已更新仓库');
  }

  function startEditProject(id: string, name: string, color: string, keywords: string[]) { setEditPid(id); setEditPname(name); setEditPcolor(color); setEditPkW(keywords.join(', ')); }
  async function saveEditProject() {
    if (!editPid) return;
    const p = projects.find((x) => x.id === editPid); if (!p) return;
    await updateProject(editPid, { name: editPname.trim() || p.name, color: editPcolor, keywords: editPkW.split(',').map((s) => s.trim()).filter(Boolean), isActive: p.isActive, sortOrder: p.sortOrder });
    setEditPid(null); flash('已更新项目');
  }

  // 每个项目的仓库数（projectId 为空 或 指向已删项目 → 算未映射 '__none'）
  const repoCountByProj = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of settings.repos) {
      const k = r.projectId && projects.some((p) => p.id === r.projectId) ? r.projectId : '__none';
      m[k] = (m[k] ?? 0) + 1;
    }
    return m;
  }, [settings.repos, projects]);

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function reposOf(projId: string | null) {
    return settings.repos.filter((r) => {
      const eff = r.projectId && projects.some((p) => p.id === r.projectId) ? r.projectId : null;
      return (eff ?? '__none') === (projId ?? '__none');
    });
  }

  const projSelectOptions = [{ value: '', label: '不映射' }, ...projects.filter((p) => p.isActive).map((p) => ({ value: p.id, label: p.name }))];

  return (
    <div className="settings">
      <div className="page-head"><div className="left"><h2 className="section-title">设置</h2></div></div>
      {notice && <div className="notice">{notice}</div>}

      {/* 左侧二级导航 + 右侧分区（P4 信息架构重排） */}
      <div className="set-layout">
        <nav className="set-nav" aria-label="设置分区">
          {SET_PANES.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`set-nav-item${pane === p.key ? ' active' : ''}`}
              aria-current={pane === p.key ? 'page' : undefined}
              onClick={() => setPane(p.key)}
            >
              {p.label}
            </button>
          ))}
        </nav>

        <div className="set-panes">
          {/* 通用 */}
          {pane === 'general' && (
            <section className="card set-section">
              <h3 className="set-h">通用</h3>
              <div className="set-row">
                <div className="set-label"><span>快速记录热键</span><span className="subtle">随时唤起记录面板</span></div>
                <HotkeyField value={settings.hotkey} onCommit={(a) => { void patch({ hotkey: a }); flash('快速记录热键：' + a); }} />
              </div>
              <div className="set-row">
                <div className="set-label"><span>待办插件热键</span><span className="subtle">显示/隐藏桌面待办插件</span></div>
                <HotkeyField value={settings.todoHotkey} onCommit={(a) => { void patch({ todoHotkey: a }); flash('待办插件热键：' + a); }} />
              </div>
              <div className="set-row">
                <div className="set-label"><span>主界面热键<HelpTip text="呼出/收起主窗口（收起后驻留托盘）" /></span></div>
                <HotkeyField value={settings.mainHotkey} onCommit={(a) => { void patch({ mainHotkey: a }); flash('主界面热键：' + a); }} />
              </div>
              <div className="set-row"><div className="set-label"><span>深色模式</span></div>
                <Switch checked={settings.theme === 'dark'} onChange={(c) => void patch({ theme: c ? 'dark' : 'light' })} />
              </div>
              <div className="set-row">
                <div className="set-label"><span>侧栏显示文字</span><span className="subtle">默认仅图标，紧凑</span></div>
                <Switch checked={settings.sidebarLabels} onChange={(c) => void patch({ sidebarLabels: c })} />
              </div>
              <div className="set-row"><div className="set-label"><span>开机自启</span></div>
                <Switch checked={settings.autostart} onChange={(c) => void toggleAutostart(c)} />
              </div>
              <div className="set-row">
                <div className="set-label"><span>下班提醒<HelpTip text="到点若今日记录不足，桌面通知提醒补记；留空关闭" /></span></div>
                <div className="row gap-sm">
                  <input
                    type="time"
                    className="sel"
                    value={settings.remindTime}
                    onChange={(e) => void patch({ remindTime: e.target.value })}
                    style={{ width: 92 }}
                  />
                  <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>不足</span>
                  <input
                    type="number"
                    className="sel"
                    min={1}
                    max={16}
                    value={Math.round(settings.remindMinMinutes / 60)}
                    onChange={(e) => void patch({ remindMinMinutes: Math.max(1, Number(e.target.value) || 8) * 60 })}
                    style={{ width: 56 }}
                  />
                  <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>小时提醒</span>
                </div>
              </div>
              <div className="set-row">
                <div className="set-label"><span>单日工时上限<HelpTip text="Git 区间分配时遵守；超出会标为加班" /></span></div>
                <div className="row gap-sm">
                  <input
                    type="number"
                    className="sel"
                    min={1}
                    max={16}
                    value={settings.dailyCapHours}
                    onChange={(e) => void patch({ dailyCapHours: Math.max(1, Number(e.target.value) || 8) })}
                    style={{ width: 64 }}
                  />
                  <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>小时/天</span>
                </div>
              </div>
              <div className="set-row">
                <div className="set-label">
                  <span>填报策略</span>
                  <span className="subtle">本地日志永远如实；策略只影响上报向导与导出的时长口径</span>
                </div>
                <Segmented
                  aria-label="填报策略"
                  size="sm"
                  options={[
                    { value: 'fact', label: '如实逐条' },
                    { value: 'fill', label: '按目标补齐' },
                  ]}
                  value={settings.reportPolicy}
                  onChange={(v) => void setReportPolicy(v)}
                />
              </div>
            </section>
          )}

          {/* LLM */}
          {pane === 'llm' && (
            <section className="card set-section">
              <h3 className="set-h">LLM</h3>
              <div className="set-row"><div className="set-label"><span>模型来源</span></div>
                <div className="seg">
                  <button className={`seg-btn${settings.llm.kind === 'openai-compat' ? ' active' : ''}`} onClick={() => setLlm({ kind: 'openai-compat' })}>云端 API</button>
                  <button className={`seg-btn${settings.llm.kind === 'claude-code' ? ' active' : ''}`} onClick={() => setLlm({ kind: 'claude-code' })}>本地 Claude Code</button>
                </div>
              </div>
              {settings.llm.kind === 'openai-compat' && (
                <>
                  <div className="set-row"><div className="set-label"><span>API 地址<HelpTip text="智谱默认 https://open.bigmodel.cn/v1" /></span></div>
                    <Input value={settings.llm.baseUrl ?? ''} onChange={(e) => setLlm({ baseUrl: e.target.value })} className="grow" />
                  </div>
                  <LlmKeyField config={settings.llm} onClearInline={() => setLlm({ apiKey: '' })} flash={flash} />
                  <div className="set-row"><div className="set-label"><span>模型</span></div>
                    <Input value={settings.llm.model ?? ''} onChange={(e) => setLlm({ model: e.target.value })} placeholder="glm-4-flash" />
                  </div>
                </>
              )}
              {settings.llm.kind === 'claude-code' && (
                <div className="set-row"><span className="muted">使用本机已装的 claude CLI 生成，需 claude 在 PATH。</span></div>
              )}
              <div className="set-row">
                <div className="set-label"><span>连接测试</span></div>
                <LlmTestButton config={settings.llm} />
              </div>
            </section>
          )}

          {/* 采集：总开关/噪音过滤/扫描参数/脱敏/扫描根（P6 F2）+ Git 作者 */}
          {pane === 'collect' && (
            <section className="card set-section">
              <h3 className="set-h">采集</h3>
              <div className="set-row" style={{ marginTop: 8 }}>
                <div className="set-label">
                  <span>采集开关<HelpTip text="总开关：关闭后后台调度不跑，手动补扫仍可用" /></span>
                  <span className="subtle">自动记录 AI 会话与 Git 提交</span>
                </div>
                <Switch checked={settings.collect.enabled} onChange={(c) => void patch({ collect: { ...settings.collect, enabled: c } })} />
              </div>
              <div className="set-row">
                <div className="set-label">
                  <span>噪音过滤</span>
                  <span className="subtle">过滤与工作无关的会话内容，可关</span>
                </div>
                <Switch checked={settings.collect.noiseFilter} onChange={(c) => void patch({ collect: { ...settings.collect, noiseFilter: c } })} />
              </div>
              <div className="set-row">
                <div className="set-label">
                  <span>过滤严格度</span>
                  <span className="subtle">宽松=更多自动排除；严格=更多进待确认</span>
                </div>
                <Segmented
                  aria-label="噪音过滤严格度"
                  size="sm"
                  options={[
                    { value: 'loose', label: '宽松' },
                    { value: 'strict', label: '严格' },
                  ]}
                  value={settings.collect.noiseStrict ? 'strict' : 'loose'}
                  onChange={(v) => void patch({ collect: { ...settings.collect, noiseStrict: v === 'strict' } })}
                />
              </div>
              <div className="set-row">
                <div className="set-label">
                  <span>启动补扫天数<HelpTip text="启动时回看的天数（水位线兜底）；源数据仅保留 30 天" /></span>
                </div>
                <div className="row gap-sm">
                  <input
                    type="number"
                    className="sel"
                    min={1}
                    max={30}
                    value={settings.collect.lookbackDays}
                    onChange={(e) => void patch({ collect: { ...settings.collect, lookbackDays: Math.min(30, Math.max(1, Number(e.target.value) || 7)) } })}
                    style={{ width: 64 }}
                  />
                  <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>天</span>
                </div>
              </div>
              <div className="set-row">
                <div className="set-label">
                  <span>保留期<HelpTip text="超过此天数的会话文件跳过不扫；对齐源数据 30 天保留期" /></span>
                </div>
                <div className="row gap-sm">
                  <input
                    type="number"
                    className="sel"
                    min={0}
                    max={90}
                    value={settings.collect.retentionDays}
                    onChange={(e) => void patch({ collect: { ...settings.collect, retentionDays: Math.min(90, Math.max(0, Number(e.target.value) || 30)) } })}
                    style={{ width: 64 }}
                  />
                  <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>天</span>
                </div>
              </div>
              <div className="set-row">
                <div className="set-label">
                  <span>切断间隔<HelpTip text="活跃区间判定：相邻事件间隔超过此值即切段计工时" /></span>
                </div>
                <div className="row gap-sm">
                  <input
                    type="number"
                    className="sel"
                    min={5}
                    max={60}
                    value={settings.collect.gapMinutes}
                    onChange={(e) => void patch({ collect: { ...settings.collect, gapMinutes: Math.min(60, Math.max(5, Number(e.target.value) || 15)) } })}
                    style={{ width: 64 }}
                  />
                  <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>分钟</span>
                </div>
              </div>
              <div className="set-row">
                <div className="set-label">
                  <span>出网脱敏<HelpTip text="送云端模型前替换密钥/连接串等敏感信息（本地 claude 通道不涉及）" /></span>
                </div>
                <Switch checked={settings.collect.scrubEnabled} onChange={(c) => void patch({ collect: { ...settings.collect, scrubEnabled: c } })} />
              </div>
              <div className="set-row">
                <div className="set-label">
                  <span>扫描根目录<HelpTip text="AI 会话扫描位置；恢复默认=~/.claude/projects 与 ~/.codex/sessions" /></span>
                  <span className="subtle">
                    {settings.collect.scanRoots.length > 0
                      ? `${settings.collect.scanRoots.length} 个自定义根目录`
                      : '默认：~/.claude/projects、~/.codex/sessions'}
                  </span>
                </div>
                <Button
                  size="sm"
                  onClick={() => {
                    void defaultScanRoots().then((roots) => patch({ collect: { ...settings.collect, scanRoots: roots } }));
                  }}
                >
                  恢复默认
                </Button>
              </div>
              {settings.collect.scanRoots.length > 0 && (
                <ul className="set-roots">
                  {settings.collect.scanRoots.map((r) => (
                    <li key={r} className="set-roots-item">{r}</li>
                  ))}
                </ul>
              )}
              <div className="set-row">
                <div className="set-label"><span>Git 作者（全局）<HelpTip text="扫描时只取这个作者的提交；留空=取全部；各仓库单独填的作者可覆盖" /></span></div>
                <Input value={settings.gitAuthor} onChange={(e) => void patch({ gitAuthor: e.target.value })} placeholder="如 huanglin 或 huanglin@xx.com" className="grow" style={{ maxWidth: 280 }} />
              </div>
            </section>
          )}

          {/* 数据备份 */}
          {pane === 'backup' && (
            <section className="card set-section">
              <h3 className="set-h">数据备份</h3>
              <div className="set-row">
                <div className="set-label"><span>导出 / 导入<HelpTip text="导出全部数据为 JSON 文件；导入会覆盖现有数据" /></span></div>
                <div className="row gap-sm">
                  <Button size="sm" onClick={async () => { const ok = await exportToFile(); flash(ok ? '已导出' : '已取消'); }}>导出</Button>
                  <Button size="sm" onClick={async () => { const r = await importFromFile(); if (r.imported > 0) { flash(`已导入 ${r.imported} 条，刷新中…`); setTimeout(() => location.reload(), 1000); } }}>导入</Button>
                </div>
              </div>
              <div className="set-row">
                <div className="set-label"><span>启用自动备份</span><span className="subtle">每次启动自动备份一份数据</span></div>
                <Switch checked={settings.autoBackupEnabled} onChange={(c) => void patch({ autoBackupEnabled: c })} />
              </div>
              {settings.autoBackupEnabled && (
                <>
                  <div className="set-row">
                    <div className="set-label"><span>保留份数</span><span className="subtle">超出份数的旧备份自动清理</span></div>
                    <div className="row gap-sm">
                      <input type="number" className="sel" min={1} max={99} value={settings.autoBackupKeep}
                        onChange={(e) => void patch({ autoBackupKeep: Math.max(1, Number(e.target.value) || 5) })} style={{ width: 64 }} />
                      <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>份</span>
                    </div>
                  </div>
                  <div className="set-row">
                    <div className="set-label"><span>备份目录</span><span className="subtle">留空则用下方灰色默认目录</span></div>
                    <Input value={settings.autoBackupDir} onChange={(e) => void patch({ autoBackupDir: e.target.value })} placeholder="%AppData%/com.worklog.app/backups/" className="grow" />
                  </div>
                </>
              )}
            </section>
          )}

          {/* 猪齿鱼对接（公司专属，不进开源） */}
          {pane === 'choerodon' && (
            <ChoerodonSection settings={settings} patch={patch} flash={flash} />
          )}

          {/* 报告模板 */}
          {pane === 'templates' && <ReportTemplateSection />}

          {/* 项目与目录：项目列表管理 + Git 仓库（repos 编辑 UI 完整保留，不与采集分区重复） */}
          {pane === 'projects' && (
            <>
              {/* 配置中心骨架：健康检查摘要条占位（采集中心上线后接入真实数据，此处不展示任何假数据） */}
              <div className="set-health-bar">
                <span className="set-health-text">配置健康检查将在采集中心上线后提供</span>
                <Badge tone="neutral">预告</Badge>
              </div>

              <section className="card set-section">
                <h3 className="set-h">项目与仓库</h3>
                <p className="set-tip">📌 项目用来给日志归类；每个项目可关联一个或多个本地 Git 仓库，用于自动扫描提交导入。点最下面「新建项目」，再在项目卡里「+ 关联仓库」。</p>

                {/* 项目列表（含仓库折叠） */}
                <div className="proj-repo-list">
                  {projects.length === 0 && settings.repos.length === 0 && <div className="empty">还没有项目，在下方新建一个</div>}

                  {projects.map((p) => {
                    const projRepos = reposOf(p.id);
                    const count = projRepos.length;
                    const isOpen = expanded.has(p.id);
                    return (
                      <div key={p.id} className="proj-repo-item">
                        {editPid === p.id ? (
                          <div className="row gap-sm proj-edit">
                            <Input value={editPname} onChange={(e) => setEditPname(e.target.value)} placeholder="项目名" className="grow" />
                            <input type="color" value={editPcolor} onChange={(e) => setEditPcolor(e.target.value)} className="color-input" aria-label="颜色" />
                            <Input value={editPkW} onChange={(e) => setEditPkW(e.target.value)} placeholder="关键词" className="grow" />
                            <Button size="sm" variant="primary" onClick={() => void saveEditProject()}>保存</Button>
                            <Button size="sm" onClick={() => setEditPid(null)}>取消</Button>
                          </div>
                        ) : (
                          <>
                            {/* 项目行（可点击展开） */}
                            <div className={`proj-repo-head${isOpen ? ' open' : ''}`} onClick={() => toggleExpand(p.id)}>
                              <span className="proj-repo-chevron">{isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
                              <span className="proj-dot" style={{ background: p.color }} />
                              <span className="proj-name">{p.name}</span>
                              {p.keywords.length > 0 && <span className="subtle" style={{ fontSize: 11 }}>{p.keywords.join('，')}</span>}
                              {count > 0 && <span className="repo-count-badge">{count}</span>}
                              <span className="proj-repo-actions" onClick={(e) => e.stopPropagation()}>
                                <button className="icon-btn" title="编辑" onClick={() => startEditProject(p.id, p.name, p.color, p.keywords)}><Pencil size={16} /></button>
                                <Switch checked={p.isActive} onChange={(c) => void updateProject(p.id, { name: p.name, color: p.color, keywords: p.keywords, isActive: c, sortOrder: p.sortOrder })} />
                                <button className="icon-btn" title="删除" onClick={() => setConfirm({
                                  title: `删除项目「${p.name}」？`,
                                  message: '项目下的历史记录不会被删除，但会失去项目归类。确定删除？',
                                  onConfirm: () => {
                                    // 级联：删项目同时移除其下仓库，避免孤儿仓库（Git 页仍扫但界面看不见）
                                    void patch({ repos: settings.repos.filter((r) => r.projectId !== p.id) });
                                    void removeProject(p.id);
                                    flash('已删除项目');
                                  },
                                })}><Trash2 size={16} /></button>
                              </span>
                            </div>

                            {/* 展开后的仓库列表 */}
                            {isOpen && (
                              <div className="proj-repo-body">
                                {projRepos.length === 0 && (
                                  <div className="muted" style={{ fontSize: 12, padding: '4px 0 8px' }}>还没有仓库，在下方输入路径关联一个。</div>
                                )}
                                {projRepos.map((r) => (
                                  <div key={r.id}>
                                    {editRid === r.id ? (
                                      <div className="row gap-sm wrap repo-edit">
                                        <Input value={editRpath} onChange={(e) => setEditRpath(e.target.value)} placeholder="仓库路径" className="grow" style={{ minWidth: 200 }} />
                                        <div style={{ width: 150 }}>
                                          <Select value={editRproj} onChange={setEditRproj} options={projSelectOptions} />
                                        </div>
                                        <Input value={editRauthor} onChange={(e) => setEditRauthor(e.target.value)} placeholder="作者" style={{ width: 110 }} />
                                        <Button size="sm" variant="primary" onClick={() => void saveEditRepo()}>保存</Button>
                                        <Button size="sm" onClick={() => setEditRid(null)}>取消</Button>
                                      </div>
                                    ) : (
                                      <div className="repo-row">
                                        <span className="repo-path">{r.path}</span>
                                        {r.author && <span className="muted">@{r.author}</span>}
                                        <button className="icon-btn" title="编辑" onClick={() => startEditRepo(r)}><Pencil size={16} /></button>
                                        <button className="icon-btn" title="移除" onClick={() => setConfirm({
                                  title: '移除该仓库？',
                                  message: `将从配置中移除：${r.path}`,
                                  onConfirm: () => { void removeRepo(r.id); flash('已移除仓库'); },
                                })}><Trash2 size={16} /></button>
                                      </div>
                                    )}
                                  </div>
                                ))}
                                <RepoAdder projectId={p.id} onAdd={(pid, path, author) => void addRepoToProject(pid, path, author)} />
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}

                  {/* 未映射仓库 */}
                  {(repoCountByProj['__none'] ?? 0) > 0 && (
                    <div className="proj-repo-item">
                      <div className={`proj-repo-head${expanded.has('__none') ? ' open' : ''}`} onClick={() => toggleExpand('__none')}>
                        <span className="proj-repo-chevron">{expanded.has('__none') ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
                        <span className="proj-dot" style={{ background: 'var(--text-3)' }} />
                        <span className="proj-name muted">未映射项目</span>
                        <span className="repo-count-badge">{repoCountByProj['__none']}</span>
                      </div>
                      {expanded.has('__none') && (
                        <div className="proj-repo-body">
                          {reposOf(null).map((r) => (
                            <div key={r.id}>
                              {editRid === r.id ? (
                                <div className="row gap-sm wrap repo-edit">
                                  <Input value={editRpath} onChange={(e) => setEditRpath(e.target.value)} placeholder="仓库路径" className="grow" style={{ minWidth: 200 }} />
                                  <div style={{ width: 150 }}><Select value={editRproj} onChange={setEditRproj} options={projSelectOptions} /></div>
                                  <Input value={editRauthor} onChange={(e) => setEditRauthor(e.target.value)} placeholder="作者" style={{ width: 110 }} />
                                  <Button size="sm" variant="primary" onClick={() => void saveEditRepo()}>保存</Button>
                                  <Button size="sm" onClick={() => setEditRid(null)}>取消</Button>
                                </div>
                              ) : (
                                <div className="repo-row">
                                  <span className="repo-path">{r.path}</span>
                                  {r.author && <span className="muted">@{r.author}</span>}
                                  <button className="icon-btn" title="编辑" onClick={() => startEditRepo(r)}><Pencil size={16} /></button>
                                  <button className="icon-btn" title="移除" onClick={() => setConfirm({
                                  title: '移除该仓库？',
                                  message: `将从配置中移除：${r.path}`,
                                  onConfirm: () => { void removeRepo(r.id); flash('已移除仓库'); },
                                })}><Trash2 size={16} /></button>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* 新建项目（放最下面）：项目信息 + 可选仓库路径，点「新建项目」一次建好 */}
                <div className="proj-add" style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div className="row gap-sm">
                    <Input value={pname} onChange={(e) => setPname(e.target.value)} placeholder="项目名（必填）" className="grow" />
                    <input type="color" value={pcolor} onChange={(e) => setPcolor(e.target.value)} className="color-input" aria-label="颜色" title="项目颜色" />
                    <Input value={pkw} onChange={(e) => setPkw(e.target.value)} placeholder="关键词（可选，逗号分隔）" style={{ width: 220 }} />
                  </div>
                  <textarea className="sel" value={newRepoPaths} onChange={(e) => setNewRepoPaths(e.target.value)}
                    placeholder="关联仓库路径（可选，每行一个，与本项目一起建好）：如 D:\\code\\pcs-user" rows={2} style={{ width: '100%' }} />
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <Button variant="primary" icon={<Plus size={14} />} onClick={() => void addProject()}>新建项目</Button>
                  </div>
                </div>
              </section>
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ''}
        message={confirm?.message ?? ''}
        confirmText="删除"
        destructive
        onCancel={() => setConfirm(null)}
        onConfirm={() => { confirm?.onConfirm(); setConfirm(null); }}
      />
    </div>
  );
}

function ReportTemplateSection() {
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [tplOpen, setTplOpen] = useState(false);
  const [tplName, setTplName] = useState('');
  const [tplBody, setTplBody] = useState('');
  const [editingId, setEditingId] = useState<string | undefined>();
  const [delId, setDelId] = useState<string | null>(null);

  useEffect(() => { void (async () => setTemplates(await db.listTemplates()))(); }, []);

  async function save() {
    if (!tplName.trim()) return;
    await db.saveTemplate({ id: editingId, name: tplName.trim(), body: tplBody, isDefault: templates.length === 0 && !editingId });
    setTemplates(await db.listTemplates());
    setTplOpen(false); setTplName(''); setTplBody(''); setEditingId(undefined);
  }
  async function del(id: string) {
    await db.deleteTemplate(id);
    setTemplates(await db.listTemplates());
  }

  return (
    <section className="card set-section">
      <h3 className="set-h">报告模板</h3>
      <p className="set-tip">提供一份满意的报告范例，AI 会模仿其格式和语气。月报/季报/年报共用。</p>
      <div className="tpl-list">
        {templates.length === 0 && <div className="empty">还没有模板</div>}
        {templates.map((t) => (
          <div key={t.id} className="proj-row">
            <span className="proj-name">{t.name}</span>
            {t.isDefault && <span className="chip" style={{ fontSize: 10 }}>默认</span>}
            <span className="muted proj-kw">{t.body.slice(0, 60).replace(/\n/g, ' ')}…</span>
            <button className="icon-btn" title="编辑" onClick={() => { setEditingId(t.id); setTplName(t.name); setTplBody(t.body); setTplOpen(true); }}><Pencil size={16} /></button>
            <button className="icon-btn" title="删除" onClick={() => setDelId(t.id)}><Trash2 size={16} /></button>
          </div>
        ))}
      </div>
      <Button size="sm" icon={<Plus size={14} />} onClick={() => { setEditingId(undefined); setTplName(''); setTplBody(''); setTplOpen(true); }} style={{ marginTop: 8 }}>新建模板</Button>

      {tplOpen && (
        <div className="modal-mask" onClick={() => setTplOpen(false)}>
          <div className="card modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="set-h">{editingId ? '编辑模板' : '新建模板'}</h3>
            <input className="tpl-name-input" value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="模板名" />
            <textarea className="sel" style={{ minHeight: 200, resize: 'vertical' }} value={tplBody} onChange={(e) => setTplBody(e.target.value)}
              placeholder="粘贴一份你满意的报告作为范例，AI 会模仿其格式和语气" />
            <div className="row gap-sm" style={{ justifyContent: 'flex-end' }}>
              <Button size="sm" onClick={() => setTplOpen(false)}>取消</Button>
              <Button size="sm" variant="primary" onClick={() => void save()}>保存</Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={delId !== null}
        title="删除该模板？"
        message="删除后无法恢复。确定要删除这个报告模板吗？"
        confirmText="删除"
        destructive
        onCancel={() => setDelId(null)}
        onConfirm={() => { if (delId) void del(delId); setDelId(null); }}
      />
    </section>
  );
}

/** LLM API Key 行（P8 keychain 化）：明文只进 OS 钥匙串；内联残留（迁移失败保留）随保存/清除一并清空 */
function LlmKeyField({ config, onClearInline, flash }: { config: LlmConfig; onClearInline: () => void; flash: (m: string) => void }) {
  const inlineLeft = (config.apiKey ?? '') !== '';
  const [stored, setStored] = useState(inlineLeft); // 内联残留先按已配置算
  const [showInput, setShowInput] = useState(!inlineLeft);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (inlineLeft) return; // 内联已有：不再探测 keychain
    let stale = false;
    void loadLlmKey().then((k) => {
      if (!stale) setStored(k !== null);
    });
    return () => {
      stale = true;
    };
  }, [inlineLeft]);

  async function save() {
    const k = draft.trim();
    if (!k) return;
    setBusy(true);
    try {
      await saveLlmKey(k);
      if (inlineLeft) onClearInline();
      setStored(true);
      setDraft('');
      setShowInput(false);
      flash('API Key 已保存到钥匙串');
    } catch (e) {
      flash(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    try {
      await clearLlmKey();
      if (inlineLeft) onClearInline();
      setStored(false);
      setShowInput(true);
      flash('已清除 API Key');
    } catch (e) {
      flash(`清除失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div className="set-row">
      <div className="set-label">
        <span>API Key<HelpTip text="明文只存系统钥匙串，配置文件不落盘；本地 Claude Code 通道无需配置" /></span>
        {stored && <span className="subtle cho-pat-tail">已保存</span>}
      </div>
      {!stored || showInput ? (
        <div className="row gap-sm">
          <Input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="sk-…"
            className="grow"
            style={{ maxWidth: 260 }}
          />
          <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>保存到钥匙串</Button>
          {stored && (
            <Button size="sm" onClick={() => { setShowInput(false); setDraft(''); }}>取消</Button>
          )}
        </div>
      ) : (
        <div className="row gap-sm">
          <Button size="sm" onClick={() => setShowInput(true)}>更换 Key</Button>
          <Button size="sm" variant="danger" onClick={() => void remove()}>清除</Button>
        </div>
      )}
    </div>
  );
}

function LlmTestButton({ config }: { config: LlmConfig }) {
  const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [msg, setMsg] = useState('');

  async function test() {
    setStatus('testing'); setMsg('');
    try {
      const reply = await generateReport(config, '你是测试助手', '请回复"连接成功"四个字。');
      setStatus('ok');
      setMsg(reply.slice(0, 30));
    } catch (e) {
      setStatus('fail');
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="row gap-sm">
      <Button size="sm" onClick={() => void test()} disabled={status === 'testing'}>
        {status === 'testing' ? '测试中…' : '测试连接'}
      </Button>
      {status === 'ok' && <span className="muted" style={{ color: 'var(--accent)' }}>✓ {msg}</span>}
      {status === 'fail' && <span className="muted" style={{ color: '#e81123', fontSize: 12 }}>✗ {msg.slice(0, 80)}</span>}
    </div>
  );
}

/** 猪齿鱼对接设置区（P8 重写：PAT 钥匙串 + 项目映射 AI 匹配 + 映射健康 + 上报窗口） */
function ChoerodonSection({ settings, patch, flash }: { settings: AppSettings; patch: (p: Partial<AppSettings>) => Promise<void>; flash: (m: string) => void }) {
  const projects = useProjectsStore((s) => s.projects);
  const [patDraft, setPatDraft] = useState('');
  const [showPatInput, setShowPatInput] = useState(false);
  const [patBusy, setPatBusy] = useState(false);
  const [test, setTest] = useState<{ phase: 'idle' | 's1' | 's2' | 'ok' | 'fail'; msg: string }>({ phase: 'idle', msg: '' });
  const [remoteProjects, setRemoteProjects] = useState<RemoteProject[]>([]);
  const [remoteError, setRemoteError] = useState('');
  const [matchRows, setMatchRows] = useState<SuggestionRow[] | null>(null);
  const [matchBusy, setMatchBusy] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);
  /** 建议行的原始目标（应用时对比出「用户改过目标」的行，用于 rememberRule 沉淀规则） */
  const matchOriginRef = useRef<Record<string, string>>({});

  const c = settings.choerodon;
  const activeProjects = useMemo(() => projects.filter((p) => p.isActive), [projects]);

  function patchC(partial: Partial<ChoerodonSettings>) {
    if (!c) return;
    void patch({ choerodon: { ...c, ...partial } });
  }

  function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  // ---- PAT（明文只进 OS 钥匙串；settings 只留尾 4 位） ----
  async function savePatDraft() {
    if (!c) return;
    const pat = patDraft.trim();
    if (!pat) return;
    setPatBusy(true);
    try {
      await savePat(pat);
      await patch({ choerodon: { ...c, patTail: pat.slice(-4) } });
      setPatDraft('');
      setShowPatInput(false);
      setTest({ phase: 'idle', msg: '' });
      flash('PAT 已保存到钥匙串');
    } catch (e) {
      flash(`保存失败：${errMsg(e)}`);
    } finally {
      setPatBusy(false);
    }
  }

  async function removePat() {
    if (!c) return;
    try {
      await clearPat();
      await patch({ choerodon: { ...c, patTail: '' } });
      setTest({ phase: 'idle', msg: '' });
      setRemoteProjects([]);
      setRemoteError('PAT 已清除，未连接');
      flash('已清除 PAT');
    } catch (e) {
      flash(`清除失败：${errMsg(e)}`);
    }
  }

  // ---- 连接（两段式测试：testConnection → listProjects） ----
  async function doTest() {
    if (!c) return;
    setTest({ phase: 's1', msg: '正在验证 PAT（用户 / 组织）…' });
    try {
      const base = await getReporterCtx();
      if (!base) {
        setTest({ phase: 'fail', msg: '未配置：请先填 API 地址并保存 PAT' });
        return;
      }
      const ids = await choerodonReporter.testConnection(base);
      if (!c.orgId && ids.orgId) void patch({ choerodon: { ...c, orgId: ids.orgId } });
      setTest({ phase: 's2', msg: `✓ 连接成功（用户 ${ids.userId} · 组织 ${ids.orgId || '—'}），正在拉取项目…` });
      const ctx: ReporterCtx = { ...base, userId: ids.userId, orgId: base.orgId || ids.orgId };
      const projs = await choerodonReporter.listProjects(ctx);
      setRemoteProjects(projs);
      setRemoteError('');
      setTest({ phase: 'ok', msg: `✓ 用户 ${ids.userId} · 组织 ${ids.orgId || '—'} · ${projs.length} 个项目可访问` });
    } catch (e) {
      setTest({ phase: 'fail', msg: errMsg(e) });
    }
  }

  /** 连接并拉远程项目列表（静默健康探测 / 重新匹配兜底共用） */
  async function connectAndLoad(): Promise<RemoteProject[]> {
    const base = await getReporterCtx();
    if (!base) throw new Error('未配置 PAT 或 API 地址');
    const ids = await choerodonReporter.testConnection(base);
    if (c && !c.orgId && ids.orgId) void patch({ choerodon: { ...c, orgId: ids.orgId } });
    const ctx: ReporterCtx = { ...base, userId: ids.userId, orgId: base.orgId || ids.orgId };
    return choerodonReporter.listProjects(ctx);
  }

  // 进入分区静默拉一次远程项目（mapHealth 需要）；失败只在健康条说明，不弹错
  useEffect(() => {
    if (!c || remoteProjects.length > 0 || remoteError !== '') return;
    let alive = true;
    void (async () => {
      try {
        const projs = await connectAndLoad();
        if (alive) setRemoteProjects(projs);
      } catch (e) {
        if (alive) setRemoteError(errMsg(e));
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c]);

  // ---- 映射健康（常驻：warnings 黄 / broken 红） ----
  const health = useMemo(() => {
    if (remoteProjects.length === 0) return null;
    return mapHealth(activeProjects, remoteProjects, c?.projectMap ?? {});
  }, [activeProjects, remoteProjects, c]);

  // ---- AI 匹配映射 ----
  async function runMatch(remote: RemoteProject[]) {
    if (!c) return;
    setMatchBusy(true);
    try {
      // 规则三路：keywords===code / 仓库尾段===code / 名称归一化；未命中行送 LLM 精配
      const repoPaths: Record<string, string[]> = {};
      for (const r of settings.repos) {
        if (r.projectId) (repoPaths[r.projectId] ??= []).push(r.path);
      }
      const rule = ruleMatchProjects(activeProjects, remote, repoPaths);
      let rows = rule;
      try {
        const llm = await llmMatchProjects(rule, remote, settings.llm);
        if (llm.length > 0) {
          const byId = new Map(llm.map((r) => [r.localProjectId, r]));
          rows = rule.map((r) => byId.get(r.localProjectId) ?? r);
        }
      } catch {
        // LLM 失败不影响规则结果，静默降级（行上「规则」徽标可辨）
      }
      const origin: Record<string, string> = {};
      for (const s of rows) origin[s.localProjectId] = s.remoteProjectId ?? '';
      matchOriginRef.current = origin;
      const opts = [
        { id: '', label: '不映射' },
        ...remote.map((r) => ({ id: r.id, label: `${r.name}（${r.code}）` })),
      ];
      setMatchRows(
        rows.map((s) => ({
          id: s.localProjectId,
          summary: s.localName,
          detail: s.remoteName ? `${s.reason} → ${s.remoteName}` : s.reason,
          confidence: s.confidence,
          ruleBased: s.ruleBased,
          kind: 'map-project' as const,
          targetOptions: opts,
          targetId: s.remoteProjectId ?? (c.projectMap[s.localProjectId] ?? ''),
        })),
      );
    } finally {
      setMatchBusy(false);
    }
  }

  async function rematch() {
    if (!c) return;
    if (remoteProjects.length === 0) {
      setMatchBusy(true);
      try {
        const projs = await connectAndLoad();
        setRemoteProjects(projs);
        setRemoteError('');
        setMatchBusy(false);
        await runMatch(projs);
      } catch (e) {
        setMatchBusy(false);
        flash(`连接失败：${errMsg(e)}`);
      }
      return;
    }
    await runMatch(remoteProjects);
  }

  function onMatchTarget(id: string, targetId: string) {
    setMatchRows((prev) => (prev ?? []).map((r) => (r.id === id ? { ...r, targetId } : r)));
  }
  function onMatchDismiss(id: string) {
    setMatchRows((prev) => (prev ?? []).filter((r) => r.id !== id));
  }

  async function applyMatches(selected: SuggestionRow[]) {
    const rows = selected.filter((r) => r.targetId !== '');
    if (rows.length === 0) return;
    try {
      await applyProjectMap(rows.map((r) => ({ localProjectId: r.id, remoteProjectId: r.targetId })));
      // 用户改过目标的行（≠建议原值）沉淀规则：远程 code 记进本地项目 keywords
      for (const r of rows) {
        if (matchOriginRef.current[r.id] === r.targetId) continue;
        const code = remoteProjects.find((p) => p.id === r.targetId)?.code;
        if (code) void rememberRule(r.id, code).catch(() => undefined);
      }
      flash(`已应用 ${rows.length} 项映射`);
      const applied = new Set(rows.map((r) => r.id));
      setMatchRows((prev) => (prev ?? []).filter((r) => !applied.has(r.id)));
    } catch (e) {
      flash(`应用失败：${errMsg(e)}`);
    }
  }

  /** 健康条 → 映射区一键跳转 */
  function scrollToMap() {
    mapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <section className="card set-section">
      <h3 className="set-h">猪齿鱼对接 <HelpTip text="把工作日志批量上报到猪齿鱼（PAT 直连，明文只存系统钥匙串）。公司专属功能，不进开源仓库。" /></h3>
      <div className="set-row">
        <div className="set-label"><span>启用</span></div>
        <Switch checked={!!c} onChange={(on) => void patch({ choerodon: on ? (c ?? { baseUrl: 'https://api.choerodon.com.cn', orgId: '', patTail: '', projectMap: {}, lastSyncDay: '' }) : null })} />
      </div>
      {c && (
        <>
          <div className="set-row">
            <div className="set-label"><span>API 地址</span></div>
            <Input value={c.baseUrl} onChange={(e) => patchC({ baseUrl: e.target.value })} className="grow" placeholder="https://api.choerodon.com.cn" />
          </div>
          <div className="set-row">
            <div className="set-label"><span>组织 ID<HelpTip text="留空则连接成功后自动回填" /></span></div>
            <Input value={c.orgId} onChange={(e) => patchC({ orgId: e.target.value })} className="grow" placeholder="自动回填" />
          </div>
          <div className="set-row">
            <div className="set-label">
              <span>PAT<HelpTip text="个人访问令牌：猪齿鱼 → 个人中心 → 个人访问令牌 生成；明文只存系统钥匙串，配置里仅留尾 4 位" /></span>
              {c.patTail && <span className="subtle cho-pat-tail">••••{c.patTail}</span>}
            </div>
            {c.patTail === '' || showPatInput ? (
              <div className="row gap-sm">
                <Input
                  type="password"
                  value={patDraft}
                  onChange={(e) => setPatDraft(e.target.value)}
                  placeholder="粘贴 PAT…"
                  className="grow"
                  style={{ maxWidth: 260 }}
                />
                <Button size="sm" variant="primary" loading={patBusy} onClick={() => void savePatDraft()}>保存到钥匙串</Button>
                {c.patTail !== '' && (
                  <Button size="sm" onClick={() => { setShowPatInput(false); setPatDraft(''); }}>取消</Button>
                )}
              </div>
            ) : (
              <div className="row gap-sm">
                <Button size="sm" onClick={() => setShowPatInput(true)}>更换 PAT</Button>
                <Button size="sm" variant="danger" onClick={() => void removePat()}>清除</Button>
              </div>
            )}
          </div>
          <div className="set-row">
            <div className="set-label"><span>连接测试</span><span className="subtle">两段式：先验证用户/组织，再拉取项目</span></div>
            <div className="cho-test">
              <Button size="sm" onClick={() => void doTest()} disabled={test.phase === 's1' || test.phase === 's2'}>
                {test.phase === 's1' || test.phase === 's2' ? '测试中…' : '测试连接'}
              </Button>
              {test.msg && (
                <span className={`cho-test-msg is-${test.phase}`}>{test.phase === 'fail' ? `✗ ${test.msg.slice(0, 120)}` : test.msg}</span>
              )}
            </div>
          </div>

          {/* 映射健康（常驻） */}
          <div className="cho-health">
            {remoteError !== '' ? (
              <div className="cho-health-item is-warn">
                <span>未能连接猪齿鱼，映射健康检查暂不可用（{remoteError.slice(0, 100)}）</span>
                <Button size="sm" onClick={() => void doTest()}>去测试连接</Button>
              </div>
            ) : health === null ? (
              <div className="cho-health-item is-info">正在连接猪齿鱼以检查映射…</div>
            ) : (
              <>
                {health.broken.length > 0 && (
                  <div className="cho-health-item is-danger">
                    <span>{health.broken.length} 个映射指向不存在的远程项目：{health.broken.map((b) => b.name).join('、')}</span>
                    <Button size="sm" onClick={scrollToMap}>查看映射</Button>
                  </div>
                )}
                {health.warnings.length > 0 && (
                  <div className="cho-health-item is-warn">
                    <span>{health.warnings.length} 个本地项目未映射（上报向导将跳过这些项目的记录）：{health.warnings.map((w) => w.name).join('、')}</span>
                    <Button size="sm" onClick={scrollToMap}>查看映射</Button>
                  </div>
                )}
                {health.broken.length === 0 && health.warnings.length === 0 && (
                  <div className="cho-health-item is-ok">映射健康：{activeProjects.length} 个本地项目全部有效映射</div>
                )}
              </>
            )}
          </div>

          {/* AI 匹配映射 */}
          <div ref={mapRef} className="cho-map-block">
            <div className="set-row" style={{ marginBottom: 0 }}>
              <div className="set-label">
                <span>AI 匹配映射<HelpTip text="规则三路（关键词/仓库名/名称归一化）优先，未命中行送 LLM 精配；应用后写回映射表" /></span>
                <span className="subtle">{remoteProjects.length > 0 ? `远程 ${remoteProjects.length} 个项目` : '未连接'}</span>
              </div>
              <Button size="sm" onClick={() => void rematch()} loading={matchBusy}>重新匹配</Button>
            </div>
            {matchRows !== null && (
              <div className="cho-map-list">
                <SuggestionList
                  title="项目映射建议（本地 → 猪齿鱼）"
                  items={matchRows}
                  busy={matchBusy}
                  onTargetChange={onMatchTarget}
                  onDismiss={onMatchDismiss}
                  onApply={(sel) => void applyMatches(sel)}
                />
              </div>
            )}
          </div>

          <div className="set-row">
            <div className="set-label">
              <span>上次上报<HelpTip text="批量上报全部成功后自动推进到窗口截止日" /></span>
              <span className="subtle">{c.lastSyncDay ? `${c.lastSyncDay}（下次默认从 ${addDays(c.lastSyncDay, 1)} 起）` : '从未上报'}</span>
            </div>
            <Button size="sm" variant="danger" disabled={!c.lastSyncDay} onClick={() => setResetOpen(true)}>重置窗口</Button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={resetOpen}
        title="重置上报窗口？"
        message="将清空「上次上报日」，下次批量上报需重新选择完整窗口；已上报过的条目仍会自动跳过，不会重复上报。"
        confirmText="重置"
        destructive
        onCancel={() => setResetOpen(false)}
        onConfirm={() => {
          setResetOpen(false);
          patchC({ lastSyncDay: '' });
          flash('已重置上报窗口');
        }}
      />
    </section>
  );
}

/** 项目卡内的内联「+ 关联仓库」：路径 + 作者，关联到所属项目 */
function RepoAdder({ projectId, onAdd }: { projectId: string; onAdd: (projectId: string, path: string, author: string) => void }) {
  const [path, setPath] = useState('');
  const [author, setAuthor] = useState('');
  return (
    <div className="row gap-sm" style={{ marginTop: 6 }}>
      <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="关联仓库路径，如 D:\\code\\xxx" className="grow" />
      <Input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="作者(可选)" style={{ width: 120 }} />
      <Button
        size="sm"
        variant="primary"
        icon={<Plus size={14} />}
        onClick={() => { if (path.trim()) { onAdd(projectId, path, author); setPath(''); setAuthor(''); } }}
      >
        关联
      </Button>
    </div>
  );
}
