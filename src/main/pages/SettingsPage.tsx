import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Switch } from '../../ui';
import { Plus, ChevronDown, ChevronRight, Pencil, Trash2 } from 'lucide-react';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { setAutostart } from '../../services/autostart';
import { HotkeyField } from '../components/HotkeyField';
import { Select } from '../components/Select';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { HelpTip } from '../components/HelpTip';
import type { AppSettings, ChoerodonSettings, GitRepo, LlmConfig, ReportTemplate } from '../../types/models';
import * as db from '../../services/db';
import { generateReport } from '../../services/llm';
import { choerodonLogin, choerodonGetProjects, type ChoerodonConfig } from '../../services/choerodon';
import { exportToFile, importFromFile } from '../../services/backup';

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

      {/* 通用 */}
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
      </section>

      {/* LLM */}
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
            <div className="set-row"><div className="set-label"><span>API Key</span></div>
              <Input type="password" value={settings.llm.apiKey ?? ''} onChange={(e) => setLlm({ apiKey: e.target.value })} className="grow" placeholder="sk-..." />
            </div>
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

      {/* 数据备份 */}
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

      {/* 猪齿鱼对接（公司专属，不进开源） */}
      <ChoerodonSection settings={settings} patch={patch} flash={flash} />

      {/* 报告模板 */}
      <ReportTemplateSection />

      {/* 项目与仓库（整合） */}
      <section className="card set-section">
        <h3 className="set-h">项目与仓库</h3>
        <p className="set-tip">📌 项目用来给日志归类；每个项目可关联一个或多个本地 Git 仓库，用于自动扫描提交导入。点最下面「新建项目」，再在项目卡里「+ 关联仓库」。</p>

        <div className="set-row" style={{ marginTop: 8 }}>
          <div className="set-label"><span>Git 作者（全局）<HelpTip text="扫描时只取这个作者的提交；留空=取全部；各仓库单独填的作者可覆盖" /></span></div>
          <Input value={settings.gitAuthor} onChange={(e) => void patch({ gitAuthor: e.target.value })} placeholder="如 huanglin 或 huanglin@xx.com" className="grow" style={{ maxWidth: 280 }} />
        </div>

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
                          ))
                        }
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

/** 猪齿鱼对接设置区 */
function ChoerodonSection({ settings, patch, flash }: { settings: AppSettings; patch: (p: Partial<AppSettings>) => Promise<void>; flash: (m: string) => void }) {
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testMsg, setTestMsg] = useState('');
  const c = settings.choerodon;

  function patchC(partial: Partial<ChoerodonSettings>) {
    if (!c) return;
    void patch({ choerodon: { ...c, ...partial } });
  }

  async function testConnection() {
    if (!c || !c.username || !c.encryptedPassword) { flash('请填邮箱和加密密码'); return; }
    setTestStatus('testing'); setTestMsg('');
    try {
      const cfg: ChoerodonConfig = { baseUrl: c.baseUrl, username: c.username, encryptedPassword: c.encryptedPassword, orgId: c.orgId };
      const token = await choerodonLogin(cfg);
      const projects = await choerodonGetProjects(cfg, token);
      // 自动回填 orgId
      if (!c.orgId) void patch({ choerodon: { ...c, orgId: token.orgId } });
      setTestStatus('ok');
      setTestMsg(`✓ ${projects.length} 个项目可访问`);
    } catch (e) {
      setTestStatus('fail');
      setTestMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="card set-section">
      <h3 className="set-h">猪齿鱼对接 <HelpTip text="把工作日志自动上报到猪齿鱼系统。公司专属功能，不进开源仓库。需从浏览器 F12 抓 /oauth/login 请求体里 password= 后的加密密码(base64)。" /></h3>
      <div className="set-row">
        <div className="set-label"><span>启用</span></div>
        <Switch checked={!!c} onChange={(on) => void patch({ choerodon: on ? (c ?? { baseUrl: 'https://api.choerodon.com.cn', username: '', encryptedPassword: '', orgId: '' }) : null })} />
      </div>
      {c && (
        <>
          <div className="set-row">
            <div className="set-label"><span>API 地址</span></div>
            <Input value={c.baseUrl} onChange={(e) => patchC({ baseUrl: e.target.value })} className="grow" />
          </div>
          <div className="set-row">
            <div className="set-label"><span>用户名（邮箱）</span></div>
            <Input value={c.username} onChange={(e) => patchC({ username: e.target.value })} className="grow" placeholder="如 huanglin@shac.com.cn" />
          </div>
          <div className="set-row">
            <div className="set-label"><span>加密密码</span><HelpTip text="F12 → Network → POST /oauth/login → Payload → password= 后面的值(base64，含%3D%3D)" /></div>
            <Input type="password" value={c.encryptedPassword} onChange={(e) => patchC({ encryptedPassword: e.target.value })} className="grow" placeholder="GZ1Brj...%3D%3D" />
          </div>
          <div className="set-row">
            <div className="set-label"><span>组织 ID</span><HelpTip text="留空则登录后自动回填" /></div>
            <Input value={c.orgId} onChange={(e) => patchC({ orgId: e.target.value })} className="grow" placeholder="自动回填" />
          </div>
          <div className="set-row">
            <div className="set-label"><span>连接测试</span></div>
            <div className="row gap-sm">
              <Button size="sm" onClick={() => void testConnection()} disabled={testStatus === 'testing'}>
                {testStatus === 'testing' ? '测试中…' : '测试连接'}
              </Button>
              {testStatus === 'ok' && <span className="muted" style={{ color: 'var(--accent)' }}>{testMsg}</span>}
              {testStatus === 'fail' && <span className="muted" style={{ color: '#e81123', fontSize: 12 }}>✗ {testMsg.slice(0, 80)}</span>}
            </div>
          </div>
        </>
      )}
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
