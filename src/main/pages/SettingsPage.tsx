import { useMemo, useState } from 'react';
import { Button, Input, Switch } from '@fluentui/react-components';
import { AddRegular, ChevronDownRegular, ChevronRightRegular, DeleteRegular, EditRegular } from '@fluentui/react-icons';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { setAutostart } from '../../services/autostart';
import { HotkeyField } from '../components/HotkeyField';
import { Select } from '../components/Select';
import type { GitRepo, LlmConfig } from '../../types/models';

export function SettingsPage() {
  const settings = useSettingsStore((s) => s.settings);
  const patch = useSettingsStore((s) => s.patch);
  const projects = useProjectsStore((s) => s.projects);
  const createProject = useProjectsStore((s) => s.create);
  const updateProject = useProjectsStore((s) => s.update);
  const removeProject = useProjectsStore((s) => s.remove);

  const [notice, setNotice] = useState('');
  const [pname, setPname] = useState('');
  const [pcolor, setPcolor] = useState('#0078d4');
  const [pkw, setPkw] = useState('');

  // 批量加仓库
  const [repoPaths, setRepoPaths] = useState('');
  const [repoProj, setRepoProj] = useState<string>('');
  const [repoAuthor, setRepoAuthor] = useState('');

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
    if (!pname.trim()) return;
    await createProject({ name: pname.trim(), color: pcolor, keywords: pkw.split(',').map((s) => s.trim()).filter(Boolean), isActive: true, sortOrder: projects.length });
    flash('已添加项目');
    setPname(''); setPkw('');
  }

  async function addRepos() {
    const paths = repoPaths.split('\n').map((s) => s.trim()).filter(Boolean);
    if (paths.length === 0) { flash('请先填写仓库路径'); return; }
    const pid = repoProj || null;
    const author = repoAuthor.trim();
    const newRepos: GitRepo[] = paths.map((p) => ({ id: crypto.randomUUID(), path: p, projectId: pid, author }));
    await patch({ repos: [...(settings.repos ?? []), ...newRepos] });
    flash(`已添加 ${newRepos.length} 个仓库`);
    setRepoPaths(''); setRepoAuthor('');
    if (pid) setExpanded((prev) => new Set(prev).add(pid));
  }
  async function removeRepo(id: string) { await patch({ repos: settings.repos.filter((r) => r.id !== id) }); }

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

  // 每个项目的仓库数
  const repoCountByProj = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of settings.repos) {
      const k = r.projectId ?? '__none';
      m[k] = (m[k] ?? 0) + 1;
    }
    return m;
  }, [settings.repos]);

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function reposOf(projId: string | null) {
    return settings.repos.filter((r) => (r.projectId ?? '__none') === (projId ?? '__none'));
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
        <div className="set-row"><div className="set-label"><span>深色模式</span></div>
          <Switch checked={settings.theme === 'dark'} onChange={(_, d) => void patch({ theme: d.checked ? 'dark' : 'light' })} />
        </div>
        <div className="set-row"><div className="set-label"><span>开机自启</span></div>
          <Switch checked={settings.autostart} onChange={(_, d) => void toggleAutostart(d.checked)} />
        </div>
      </section>

      {/* 月报 LLM */}
      <section className="card set-section">
        <h3 className="set-h">月报 LLM</h3>
        <div className="set-row"><div className="set-label"><span>模型来源</span></div>
          <div className="seg">
            <button className={`seg-btn${settings.llm.kind === 'openai-compat' ? ' active' : ''}`} onClick={() => setLlm({ kind: 'openai-compat' })}>云端 API</button>
            <button className={`seg-btn${settings.llm.kind === 'claude-code' ? ' active' : ''}`} onClick={() => setLlm({ kind: 'claude-code' })}>本地 Claude Code</button>
          </div>
        </div>
        {settings.llm.kind === 'openai-compat' && (
          <>
            <div className="set-row"><div className="set-label"><span>API 地址</span><span className="subtle">智谱默认 https://open.bigmodel.cn/v1</span></div>
              <Input value={settings.llm.baseUrl ?? ''} onChange={(_, d) => setLlm({ baseUrl: d.value })} className="grow" />
            </div>
            <div className="set-row"><div className="set-label"><span>API Key</span></div>
              <Input type="password" value={settings.llm.apiKey ?? ''} onChange={(_, d) => setLlm({ apiKey: d.value })} className="grow" placeholder="sk-..." />
            </div>
            <div className="set-row"><div className="set-label"><span>模型</span></div>
              <Input value={settings.llm.model ?? ''} onChange={(_, d) => setLlm({ model: d.value })} placeholder="glm-4-flash" />
            </div>
          </>
        )}
        {settings.llm.kind === 'claude-code' && (
          <div className="set-row"><span className="muted">使用本机已装的 claude CLI 生成，需 claude 在 PATH。</span></div>
        )}
      </section>

      {/* 项目与仓库（整合） */}
      <section className="card set-section">
        <h3 className="set-h">项目与仓库</h3>

        {/* 添加项目 */}
        <div className="row gap-sm proj-add">
          <Input value={pname} onChange={(_, d) => setPname(d.value)} placeholder="项目名" />
          <input type="color" value={pcolor} onChange={(e) => setPcolor(e.target.value)} className="color-input" aria-label="颜色" />
          <Input value={pkw} onChange={(_, d) => setPkw(d.value)} placeholder="关键词，逗号分隔" className="grow" />
          <Button appearance="primary" icon={<AddRegular />} onClick={() => void addProject()}>添加项目</Button>
        </div>

        {/* 批量加仓库 */}
        <div className="repo-add">
          <textarea className="sel" value={repoPaths} onChange={(e) => setRepoPaths(e.target.value)}
            placeholder={'批量添加仓库（每行一个路径），映射到下方选的项目：\nD:\\code\\pcs-user\nD:\\code\\pcs-order'} rows={3} />
          <div className="row gap-sm repo-add-meta">
            <div style={{ width: 200 }}>
              <Select value={repoProj} onChange={setRepoProj} options={projSelectOptions} />
            </div>
            <input className="sel" value={repoAuthor} onChange={(e) => setRepoAuthor(e.target.value)} placeholder="作者(可选)" style={{ flex: 1, width: 'auto' }} />
            <Button appearance="primary" icon={<AddRegular />} onClick={() => void addRepos()}>添加仓库</Button>
          </div>
        </div>

        {/* 项目列表（含仓库折叠） */}
        <div className="proj-repo-list">
          {projects.length === 0 && settings.repos.length === 0 && <div className="empty">还没有项目或仓库，在上方添加</div>}

          {projects.map((p) => {
            const projRepos = reposOf(p.id);
            const count = projRepos.length;
            const isOpen = expanded.has(p.id);
            return (
              <div key={p.id} className="proj-repo-item">
                {editPid === p.id ? (
                  <div className="row gap-sm proj-edit">
                    <Input value={editPname} onChange={(_, d) => setEditPname(d.value)} placeholder="项目名" className="grow" />
                    <input type="color" value={editPcolor} onChange={(e) => setEditPcolor(e.target.value)} className="color-input" aria-label="颜色" />
                    <Input value={editPkW} onChange={(_, d) => setEditPkW(d.value)} placeholder="关键词" className="grow" />
                    <Button size="small" appearance="primary" onClick={() => void saveEditProject()}>保存</Button>
                    <Button size="small" onClick={() => setEditPid(null)}>取消</Button>
                  </div>
                ) : (
                  <>
                    {/* 项目行（可点击展开） */}
                    <div className={`proj-repo-head${isOpen ? ' open' : ''}`} onClick={() => toggleExpand(p.id)}>
                      <span className="proj-repo-chevron">{isOpen ? <ChevronDownRegular /> : <ChevronRightRegular />}</span>
                      <span className="proj-dot" style={{ background: p.color }} />
                      <span className="proj-name">{p.name}</span>
                      {p.keywords.length > 0 && <span className="subtle" style={{ fontSize: 11 }}>{p.keywords.join('，')}</span>}
                      {count > 0 && <span className="repo-count-badge">{count}</span>}
                      <span className="proj-repo-actions" onClick={(e) => e.stopPropagation()}>
                        <button className="icon-btn" title="编辑" onClick={() => startEditProject(p.id, p.name, p.color, p.keywords)}><EditRegular /></button>
                        <Switch checked={p.isActive} onChange={(_, d) => void updateProject(p.id, { name: p.name, color: p.color, keywords: p.keywords, isActive: d.checked, sortOrder: p.sortOrder })} />
                        <button className="icon-btn" title="删除" onClick={() => void removeProject(p.id)}><DeleteRegular /></button>
                      </span>
                    </div>

                    {/* 展开后的仓库列表 */}
                    {isOpen && (
                      <div className="proj-repo-body">
                        {projRepos.length === 0 ? (
                          <div className="muted" style={{ fontSize: 12, padding: '4px 0 8px' }}>暂无仓库，用上方"批量添加"添加</div>
                        ) : (
                          projRepos.map((r) => (
                            <div key={r.id}>
                              {editRid === r.id ? (
                                <div className="row gap-sm wrap repo-edit">
                                  <Input value={editRpath} onChange={(_, d) => setEditRpath(d.value)} placeholder="仓库路径" className="grow" style={{ minWidth: 200 }} />
                                  <div style={{ width: 150 }}>
                                    <Select value={editRproj} onChange={setEditRproj} options={projSelectOptions} />
                                  </div>
                                  <Input value={editRauthor} onChange={(_, d) => setEditRauthor(d.value)} placeholder="作者" style={{ width: 110 }} />
                                  <Button size="small" appearance="primary" onClick={() => void saveEditRepo()}>保存</Button>
                                  <Button size="small" onClick={() => setEditRid(null)}>取消</Button>
                                </div>
                              ) : (
                                <div className="repo-row">
                                  <span className="repo-path">{r.path}</span>
                                  {r.author && <span className="muted">@{r.author}</span>}
                                  <button className="icon-btn" title="编辑" onClick={() => startEditRepo(r)}><EditRegular /></button>
                                  <button className="icon-btn" title="移除" onClick={() => void removeRepo(r.id)}><DeleteRegular /></button>
                                </div>
                              )}
                            </div>
                          ))
                        )}
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
                <span className="proj-repo-chevron">{expanded.has('__none') ? <ChevronDownRegular /> : <ChevronRightRegular />}</span>
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
                          <Input value={editRpath} onChange={(_, d) => setEditRpath(d.value)} placeholder="仓库路径" className="grow" style={{ minWidth: 200 }} />
                          <div style={{ width: 150 }}><Select value={editRproj} onChange={setEditRproj} options={projSelectOptions} /></div>
                          <Input value={editRauthor} onChange={(_, d) => setEditRauthor(d.value)} placeholder="作者" style={{ width: 110 }} />
                          <Button size="small" appearance="primary" onClick={() => void saveEditRepo()}>保存</Button>
                          <Button size="small" onClick={() => setEditRid(null)}>取消</Button>
                        </div>
                      ) : (
                        <div className="repo-row">
                          <span className="repo-path">{r.path}</span>
                          {r.author && <span className="muted">@{r.author}</span>}
                          <button className="icon-btn" title="编辑" onClick={() => startEditRepo(r)}><EditRegular /></button>
                          <button className="icon-btn" title="移除" onClick={() => void removeRepo(r.id)}><DeleteRegular /></button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
