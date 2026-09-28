// P8b·首启向导（锁定式，不可关闭）：三选一定空间形态 → 配置清单引导。
// - 触发条件由 MainApp 判定（!onboardDone && 全库零记录），选定即 applyOnboardChoice
//   + patch({onboardDone:true})，此后永不再弹（存量升级有数据也不弹）。
// - 第二屏顶部是隐私信任第一触点：数据去向说明常驻；
//   三项配置引导（扫描根 / LLM 通道 / 猪齿鱼 PAT）可逐项「去设置」或跳过。
// 样式走本目录 components.css 的 ob-* 段（--dl-* token，对齐 Dialog 视觉）。

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Briefcase, CloudUpload, FolderSearch, Layers, ShieldCheck, Sparkles, Sprout } from 'lucide-react';
import { Button } from '../../ui';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';

type Choice = 'work' | 'personal' | 'both';

interface Props {
  open: boolean;
  /** 第二屏收尾（「全部跳过」或任一「去设置」离开向导） */
  onDone: () => void;
}

const CHOICES: { key: Choice; icon: typeof Briefcase; title: string; sub: string }[] = [
  {
    key: 'work',
    icon: Briefcase,
    title: '只记工作',
    sub: '工时填报、上报与报告全开',
  },
  {
    key: 'personal',
    icon: Sprout,
    title: '只记个人',
    sub: '成长记录/复盘；无工时填报与上报，专注学习与成长',
  },
  {
    key: 'both',
    icon: Layers,
    title: '两者都要',
    sub: '工作与个人双空间，随时切换',
  },
];

/** 第二屏配置引导：每项一行「去设置 →」跳对应分区；pane 值对齐 SettingsPage 分区键 */
const CONFIG_ROWS: { key: string; icon: typeof Briefcase; title: string; sub: string; pane: string }[] = [
  { key: 'roots', icon: FolderSearch, title: '扫描根目录', sub: 'AI 会话与 Git 仓库从哪里采集', pane: 'collect' },
  { key: 'llm', icon: Sparkles, title: 'LLM 通道', sub: '生成报告与智能匹配的模型来源', pane: 'llm' },
  { key: 'pat', icon: CloudUpload, title: '猪齿鱼 PAT', sub: '工时批量上报的直连凭据（可选）', pane: 'choerodon' },
];

export function OnboardModal({ open, onDone }: Props) {
  const navigate = useNavigate();
  const patch = useSettingsStore((s) => s.patch);
  const applyOnboardChoice = useWorkspaceStore((s) => s.applyOnboardChoice);
  const [step, setStep] = useState<1 | 2>(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [skipped, setSkipped] = useState<Set<string>>(new Set());

  // 每次打开从头开始（理论上只开一次，防御重复挂载）
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setBusy(false);
    setErr('');
    setSkipped(new Set());
  }, [open]);

  async function choose(c: Choice) {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      await applyOnboardChoice(c);
      await patch({ onboardDone: true });
      setStep(2);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function gotoSettings(pane: string) {
    onDone();
    navigate(`/settings?pane=${pane}`);
  }

  function skipRow(key: string) {
    setSkipped((prev) => new Set(prev).add(key));
  }

  if (!open) return null;

  return (
    <div className="ob-mask">
      <div className="ob-card" role="dialog" aria-modal="true" aria-label="欢迎使用日迹">
        {step === 1 ? (
          <>
            <div className="ob-head">
              <h3 className="ob-title">欢迎使用日迹</h3>
              <p className="ob-sub">先选一种记法——之后随时可以在设置里增加空间。</p>
            </div>
            <div className="ob-cards">
              {CHOICES.map(({ key, icon: Icon, title, sub }) => (
                <button
                  key={key}
                  type="button"
                  className="ob-choice"
                  disabled={busy}
                  onClick={() => void choose(key)}
                >
                  <Icon size={22} className="ob-choice-ico" aria-hidden="true" />
                  <span className="ob-choice-title">{title}</span>
                  <span className="ob-choice-sub">{sub}</span>
                </button>
              ))}
            </div>
            {err && <div className="ob-error">初始化失败：{err}</div>}
          </>
        ) : (
          <>
            <div className="ob-head">
              <h3 className="ob-title">基本配置</h3>
              <div className="ob-privacy">
                <ShieldCheck size={15} aria-hidden="true" />
                <span>AI 会话与 Git 提交在本机采集整合，出网内容经脱敏。</span>
              </div>
            </div>
            <div className="ob-rows">
              {CONFIG_ROWS.map(({ key, icon: Icon, title, sub, pane }) => (
                <div key={key} className={`ob-row${skipped.has(key) ? ' skipped' : ''}`}>
                  <Icon size={16} aria-hidden="true" />
                  <span className="ob-row-main">
                    <span className="ob-row-title">{title}</span>
                    <span className="ob-row-sub">{sub}</span>
                  </span>
                  {skipped.has(key) ? (
                    <span className="ob-row-skipmark">已跳过</span>
                  ) : (
                    <span className="ob-row-actions">
                      <Button size="sm" onClick={() => gotoSettings(pane)}>
                        去设置 <ArrowRight size={12} />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => skipRow(key)}>
                        跳过
                      </Button>
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div className="ob-actions">
              <Button variant="primary" onClick={onDone}>全部跳过，开始使用</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
