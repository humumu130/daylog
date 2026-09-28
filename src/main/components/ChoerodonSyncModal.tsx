import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button, IconButton, Spinner } from '../../ui';
import type { ChoerodonSettings, Project, WorkRecord } from '../../types/models';
import type { ChoerodonConfig, ChoerodonProject, ChoerodonIssue, ChoerodonToken } from '../../services/choerodon';
import { choerodonLogin, choerodonGetProjects, choerodonGetIssues, choerodonCreateWorkLog } from '../../services/choerodon';
import { formatHM } from '../../utils/halfDay';
import { formatYMDChinese } from '../../utils/date';

interface Props {
  open: boolean;
  records: WorkRecord[];
  projects: Project[];
  choerodonCfg: ChoerodonSettings | null;
  onClose: () => void;
}

/** 上报到猪齿鱼：选项目 → 选我的任务 → 确认工时 → 一键上报 */
export function ChoerodonSyncModal({ open, records, projects, choerodonCfg, onClose }: Props) {
  const [step, setStep] = useState<'login' | 'main' | 'done'>('login');
  const [loading, setLoading] = useState('');
  const [error, setError] = useState('');
  const [token, setToken] = useState<ChoerodonToken | null>(null);
  const [choerodonProjects, setChoerodonProjects] = useState<ChoerodonProject[]>([]);
  const [selectedProjId, setSelectedProjId] = useState('');
  const [issues, setIssues] = useState<ChoerodonIssue[]>([]);
  const [selectedIssueId, setSelectedIssueId] = useState('');
  const [result, setResult] = useState<{ ok: number; fail: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(''); setResult(null); setStep('login');
    void doLogin();
  }, [open]); // eslint-disable-line

  async function doLogin() {
    if (!choerodonCfg) { setError('请先在设置里配置猪齿鱼'); return; }
    setLoading('登录中…');
    try {
      const cfg: ChoerodonConfig = { baseUrl: choerodonCfg.baseUrl, username: choerodonCfg.username, encryptedPassword: choerodonCfg.encryptedPassword, orgId: choerodonCfg.orgId };
      const t = await choerodonLogin(cfg);
      setToken(t);
      const projs = await choerodonGetProjects(cfg, t);
      setChoerodonProjects(projs);
      setStep('main');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(''); }
  }

  async function loadIssues(projId: string) {
    setSelectedProjId(projId);
    setSelectedIssueId('');
    setIssues([]);
    if (!token || !choerodonCfg || !projId) return;
    setLoading('加载任务…');
    try {
      const cfg: ChoerodonConfig = { baseUrl: choerodonCfg.baseUrl, username: choerodonCfg.username, encryptedPassword: choerodonCfg.encryptedPassword, orgId: choerodonCfg.orgId };
      const list = await choerodonGetIssues(cfg, token, projId);
      setIssues(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(''); }
  }

  async function submit() {
    if (!token || !choerodonCfg || !selectedProjId || !selectedIssueId) return;
    setLoading('上报中…'); setError('');
    const cfg: ChoerodonConfig = { baseUrl: choerodonCfg.baseUrl, username: choerodonCfg.username, encryptedPassword: choerodonCfg.encryptedPassword, orgId: choerodonCfg.orgId };
    let ok = 0, fail = 0;
    for (const r of records) {
      const hours = (r.durationMin ?? 0) / 60;
      if (hours <= 0) continue;
      try {
        await choerodonCreateWorkLog(cfg, token, selectedProjId, selectedIssueId, r.day, hours);
        ok++;
      } catch {
        fail++;
      }
    }
    setResult({ ok, fail });
    setLoading(''); setStep('done');
  }

  if (!open) return null;

  const totalHours = records.reduce((s, r) => s + (r.durationMin ?? 0), 0) / 60;
  const projName = (id: string) => projects.find((p) => p.id === id)?.name;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="card modal-card" onClick={(e) => e.stopPropagation()} style={{ width: 580, maxWidth: '94vw', maxHeight: '85vh', overflow: 'auto' }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 className="set-h">上报到猪齿鱼</h3>
          <IconButton title="关闭" size="sm" onClick={onClose}>
            <X size={14} />
          </IconButton>
        </div>

        {error && <div className="warn-soft" style={{ marginBottom: 10 }}>⚠ {error}</div>}

        {step === 'login' && loading && (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spinner label={loading} /> <span className="muted">{loading}</span>
          </div>
        )}

        {step === 'main' && (
          <>
            <div className="set-row" style={{ marginBottom: 8 }}>
              <div className="set-label"><span>猪齿鱼项目</span></div>
              <select className="sel grow" value={selectedProjId} onChange={(e) => void loadIssues(e.target.value)}>
                <option value="">选择项目…</option>
                {choerodonProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>

            {selectedProjId && (
              <div className="set-row" style={{ marginBottom: 8 }}>
                <div className="set-label"><span>任务</span><span className="subtle">按更新时间倒序</span></div>
                <select className="sel grow" value={selectedIssueId} onChange={(e) => setSelectedIssueId(e.target.value)} disabled={!!loading}>
                  <option value="">选择任务…</option>
                  {loading === '加载任务…' && <option>加载中…</option>}
                  {issues.map((i) => (
                    <option key={i.issueId} value={i.issueId}>{i.issueNum} {i.summary}</option>
                  ))}
                </select>
              </div>
            )}

            {selectedIssueId && (
              <>
                <div style={{ borderTop: '1px solid var(--border-soft)', margin: '12px 0', paddingTop: 8 }}>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                    将上报以下 {records.length} 条记录（共 {totalHours.toFixed(1)}h）到选中任务：
                  </div>
                  <div style={{ maxHeight: 200, overflow: 'auto' }}>
                    {records.map((r) => (
                      <div key={r.id} className="row gap-sm" style={{ padding: '4px 0', fontSize: 12 }}>
                        <span className="muted" style={{ width: 80, flex: 'none' }}>{formatYMDChinese(r.day)}</span>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.content}</span>
                        {r.projectId && <span className="muted">{projName(r.projectId)}</span>}
                        <span className="muted" style={{ flex: 'none' }}>{formatHM(r.durationMin ?? 0)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="row gap-sm" style={{ justifyContent: 'flex-end' }}>
                  <Button size="sm" onClick={onClose}>取消</Button>
                  <Button size="sm" variant="primary" onClick={() => void submit()} disabled={!!loading}>
                    {loading || `上报 ${records.length} 条`}
                  </Button>
                </div>
              </>
            )}
          </>
        )}

        {step === 'done' && result && (
          <div style={{ textAlign: 'center', padding: 30 }}>
            {result.fail === 0 ? (
              <><div style={{ fontSize: 32, marginBottom: 8 }}>✅</div><div>上报成功：{result.ok} 条</div></>
            ) : (
              <><div style={{ fontSize: 32, marginBottom: 8 }}>⚠️</div><div>成功 {result.ok} 条，失败 {result.fail} 条</div></>
            )}
            <Button size="sm" variant="primary" style={{ marginTop: 16 }} onClick={onClose}>完成</Button>
          </div>
        )}
      </div>
    </div>
  );
}

