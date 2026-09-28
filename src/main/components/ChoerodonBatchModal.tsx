// P8·猪齿鱼批量上报三步向导：1 范围与映射 → 2 对账与策略 → 3 执行与结果。
// 取代旧版「模拟登录 + 手选任务逐条上报」弹窗：
//   PAT 直连（getReporterCtx）+ 窗口批量 + projectMap 映射 + sync_log 幂等防重
//   + 平台工时日历对账（不可用时黄条降级，不静默装作对账成功）。
// 挂载于 MainApp（与 CommandPalette 同级），今日页日菜单 / 命令面板经
// window 事件 'daylog:open-batch-sync' 唤起——任意页面可用，单实例单监听。

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, Lock, RefreshCw, Settings, X } from 'lucide-react';
import { Badge, Button, IconButton, Segmented, Spinner } from '../../ui';
import { Select } from './Select';
import type { ReportPolicy, WorkRecord } from '../../types/models';
import {
  choerodonReporter,
  getReporterCtx,
  type RemoteIssue,
  type RemoteProject,
  type ReporterCtx,
} from '../../services/reporters';
import { applyProjectMap } from '../../services/choerodonMap';
import { insertSyncLog, isRecordSynced, listSyncLogDays } from '../../services/db';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useRecordsStore } from '../../stores/useRecordsStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { addDays, parseYMD, todayYMD, weekdayCN } from '../../utils/date';
import './choerodon-wizard.css';

/** 「上报目标任务」Select 的「新建任务」哨兵值 */
const CREATE_ISSUE = '__create__';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Phase = 'gate' | 'step1' | 'step2' | 'step3';
type Gate = 'checking' | 'noconfig' | 'error' | 'ok';
type DayBucket = 'platform' | 'synced' | 'pending';

interface RecPlan {
  id: string;
  content: string;
  baseMin: number; // 用户改过 / 证据时长（分钟）
  finalMin: number; // 封顶裁减 + fill 之后的最终上报分钟
  deductMin: number; // 按额度封顶裁掉的分钟
  fillMin: number; // 按目标补齐加上的分钟
  overtimeMin: number; // 证据加班分钟（meta.overtimeMin）
  synced: boolean; // 本地 sync_log 已有该条
  mapped: boolean;
  hasIssue: boolean;
  isCreate: boolean;
  issueLabel: string;
  localProjectId: string;
  remoteProjectId: string;
  uploadable: boolean;
}

interface DayPlan {
  day: string;
  bucket: DayBucket;
  platformMin: number; // 平台日历里已有的工时（分钟）
  syncedMin: number; // 本地留痕的已上报分钟
  locked: boolean; // meta.user_edited / 预览手改 / 封顶裁减 → 不参与 fill
  report: boolean; // 该日是否上报（平台已有工时日默认跳过，可勾选仍上报）
  overtimeMin: number;
  recs: RecPlan[];
  uploadMin: number;
  fillMin: number;
}

interface RunItem {
  recordId: string;
  day: string;
  content: string;
  minutes: number;
  localProjectName: string;
  remoteProjectId: string;
  issueChoice: string; // issueId | CREATE_ISSUE
}

type RunStatus = 'pending' | 'running' | 'done' | 'fail' | 'skipped';

interface RunRow extends RunItem {
  status: RunStatus;
  error?: string;
}

// ==================== 小工具 ====================

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function otOf(r: WorkRecord): number {
  return num(r.meta?.overtimeMin);
}
function userEdited(r: WorkRecord): boolean {
  return r.meta?.user_edited === true;
}
function fmtH(minutes: number): string {
  return `${(minutes / 60).toFixed(1)}h`;
}
function shortDay(day: string): string {
  const d = parseYMD(day);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${weekdayCN(d)}`;
}
function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 填报策略落库（store patch 已持久化 reportPolicy；导出供向导与设置页共用） */
export async function setReportPolicy(v: ReportPolicy): Promise<void> {
  const { patch } = useSettingsStore.getState();
  await patch({ reportPolicy: v });
}

/** fill 缺口分摊（0.5h 量化，单日合计 ≤ 上限）：返回 recordId → 增加分钟 */
function distributeFill(recs: { id: string; baseMin: number }[], capMin: number): Map<string, number> {
  const total = recs.reduce((s, r) => s + r.baseMin, 0);
  if (total <= 0) return new Map();
  const deficitUnits = Math.floor((capMin - total) / 30); // 0.5h = 30min
  if (deficitUnits <= 0) return new Map();
  const units = new Map<string, number>();
  let assigned = 0;
  const raw = recs.map((r) => ({ id: r.id, u: (deficitUnits * r.baseMin) / total }));
  for (const r of raw) {
    const u = Math.floor(r.u);
    if (u > 0) {
      units.set(r.id, u);
      assigned += u;
    }
  }
  // 取整余量按权重从大到小逐 0.5h 补（构造上不会越过 cap）
  const order = [...raw].sort((a, b) => b.u - a.u);
  let rest = deficitUnits - assigned;
  for (const r of order) {
    if (rest <= 0) break;
    units.set(r.id, (units.get(r.id) ?? 0) + 1);
    rest--;
  }
  const out = new Map<string, number>();
  for (const [id, u] of units) out.set(id, u * 30);
  return out;
}

/** 按额度封顶：把超额度部分从可上报记录的加班份额里裁掉（不裁穿正班部分） */
function trimOvertime(recs: RecPlan[], excessMin: number): Map<string, number> {
  const cands = recs.filter((r) => r.overtimeMin > 0 && r.uploadable);
  const otSum = cands.reduce((s, r) => s + r.overtimeMin, 0);
  if (otSum <= 0 || excessMin <= 0) return new Map();
  const out = new Map<string, number>();
  for (const r of cands) {
    const d = Math.min(Math.floor((excessMin * r.overtimeMin) / otSum), r.overtimeMin);
    if (d > 0) out.set(r.id, d);
  }
  return out;
}

// ==================== 组件 ====================

export function ChoerodonBatchModal({ open, onClose }: Props) {
  const navigate = useNavigate();
  const projects = useProjectsStore((s) => s.projects);
  const setRange = useRecordsStore((s) => s.setRange);
  const storeRecords = useRecordsStore((s) => s.records);
  const storeFrom = useRecordsStore((s) => s.from);
  const storeTo = useRecordsStore((s) => s.to);
  const reportPolicy = useSettingsStore((s) => s.settings.reportPolicy);
  const dailyCapHours = useSettingsStore((s) => s.settings.dailyCapHours);
  const overtimeCapHours = useSettingsStore((s) => s.settings.collect.overtimeCapHours);
  const choerodon = useSettingsStore((s) => s.settings.choerodon);

  const [phase, setPhase] = useState<Phase>('gate');
  const [gate, setGate] = useState<Gate>('checking');
  const [gateError, setGateError] = useState('');
  const [ctx, setCtx] = useState<ReporterCtx | null>(null);
  const [remoteProjects, setRemoteProjects] = useState<RemoteProject[]>([]);

  // 第 1 步
  const [from, setFrom] = useState(todayYMD());
  const [to, setTo] = useState(todayYMD());
  const [mapping, setMapping] = useState<Record<string, string>>({}); // localId → remoteId（''=不映射）
  const [issueChoice, setIssueChoice] = useState<Record<string, string>>({}); // localId → issueId | CREATE_ISSUE
  const [issues, setIssues] = useState<Record<string, RemoteIssue[]>>({}); // remoteId → 列表
  const [issueLoading, setIssueLoading] = useState<Set<string>>(new Set());
  const issueBusyRef = useRef<Set<string>>(new Set());
  const [stepBusy, setStepBusy] = useState(false);
  const [stepError, setStepError] = useState('');

  // 第 2 步
  const [overrides, setOverrides] = useState<Record<string, number>>({}); // recordId → 上报分钟（手改）
  const [editDrafts, setEditDrafts] = useState<Record<string, string>>({});
  const [manualDays, setManualDays] = useState<Set<string>>(new Set()); // 预览里手改过的天
  const [forceDays, setForceDays] = useState<Set<string>>(new Set()); // 平台已有工时但仍勾选上报的天
  const [trimOn, setTrimOn] = useState(false);
  const [calDegraded, setCalDegraded] = useState(false);
  const [remoteCal, setRemoteCal] = useState<Map<string, number> | null>(null); // day → 平台已有分钟
  const [syncDays, setSyncDays] = useState<Map<string, number>>(new Map()); // day → 本地留痕分钟
  const [syncedIds, setSyncedIds] = useState<Set<string>>(new Set());
  const [openDay, setOpenDay] = useState<string | null>(null);

  // 第 3 步
  const [runRows, setRunRows] = useState<RunRow[]>([]);
  const runRowsRef = useRef<RunRow[]>([]);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const lastSyncAdvancedRef = useRef(false);
  const createdIssueRef = useRef<Map<string, RemoteIssue>>(new Map()); // remoteId → 新建的任务

  const today = todayYMD();
  const activeProjects = useMemo(() => projects.filter((p) => p.isActive), [projects]);

  // 窗口内记录（store 区间可能滞后于向导窗口，先过滤防闪旧数据）
  const windowRecords = useMemo(
    () => storeRecords.filter((r) => r.day >= from && r.day <= to),
    [storeRecords, from, to],
  );
  const rangeStale = phase === 'step2' && (storeFrom !== from || storeTo !== to);

  // 自动补拉：向导窗口与 store 区间不一致（如页面切换导致 TodayPage 重挂载抢回区间）
  useEffect(() => {
    if (!rangeStale) return;
    void setRange(from, to);
  }, [rangeStale, from, to, setRange]);

  // ---- 打开：装配 ctx + testConnection + listProjects，失败给出明确引导 ----
  useEffect(() => {
    if (!open) return;
    // 重置（上次会话状态不带入）
    setPhase('gate'); setGate('checking'); setGateError(''); setCtx(null); setRemoteProjects([]);
    setMapping({}); setIssueChoice({}); setIssues({}); setIssueLoading(new Set());
    issueBusyRef.current = new Set();
    setStepBusy(false); setStepError('');
    setOverrides({}); setEditDrafts({}); setManualDays(new Set()); setForceDays(new Set());
    setTrimOn(false); setCalDegraded(false); setRemoteCal(null); setSyncDays(new Map()); setSyncedIds(new Set());
    setOpenDay(null); setRunRows([]); setRunning(false); setFinished(false);
    lastSyncAdvancedRef.current = false;
    createdIssueRef.current = new Map();
    const ch = useSettingsStore.getState().settings.choerodon;
    const startFrom = ch?.lastSyncDay ? addDays(ch.lastSyncDay, 1) : addDays(today, -6);
    setFrom(startFrom > today ? today : startFrom);
    setTo(today);

    void (async () => {
      let base: ReporterCtx | null = null;
      try {
        base = await getReporterCtx();
      } catch (e) {
        setGateError(errMsg(e));
        setGate('error');
        return;
      }
      if (!base) {
        setGate('noconfig');
        return;
      }
      try {
        const ids = await choerodonReporter.testConnection(base);
        const merged: ReporterCtx = { ...base, userId: ids.userId, orgId: base.orgId || ids.orgId };
        // orgId 回填（设置里留空时自动补全，日历/项目接口都依赖）
        const cur = useSettingsStore.getState().settings.choerodon;
        if (cur && !cur.orgId && ids.orgId) {
          void useSettingsStore.getState().patch({ choerodon: { ...cur, orgId: ids.orgId } });
        }
        const projs = await choerodonReporter.listProjects(merged);
        setCtx(merged);
        setRemoteProjects(projs);
        // 映射表预填：projectMap 已有 → 预选；否则待选
        const pre: Record<string, string> = {};
        for (const p of projects.filter((x) => x.isActive)) pre[p.id] = cur?.projectMap[p.id] ?? '';
        setMapping(pre);
        setGate('ok');
        setPhase('step1');
      } catch (e) {
        setGateError(errMsg(e));
        setGate('error');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ---- 第 1 步：目标任务懒加载（选中远程项目时 + 预填映射的存量行） ----
  async function ensureIssues(remoteId: string) {
    if (!ctx || remoteId === '' || issues[remoteId] || issueBusyRef.current.has(remoteId)) return;
    issueBusyRef.current.add(remoteId);
    setIssueLoading((prev) => new Set(prev).add(remoteId));
    try {
      const list = await choerodonReporter.searchIssues(ctx, remoteId);
      setIssues((prev) => ({ ...prev, [remoteId]: list }));
    } catch (e) {
      setIssues((prev) => ({ ...prev, [remoteId]: [] }));
      setStepError(`拉取「${remoteProjects.find((p) => p.id === remoteId)?.name ?? remoteId}」任务失败：${errMsg(e)}`);
    } finally {
      issueBusyRef.current.delete(remoteId);
      setIssueLoading((prev) => {
        const n = new Set(prev);
        n.delete(remoteId);
        return n;
      });
    }
  }

  useEffect(() => {
    if (phase !== 'step1' || !ctx) return;
    for (const p of activeProjects) {
      const rid = mapping[p.id];
      if (rid) void ensureIssues(rid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, ctx, mapping, activeProjects]);

  // 任务列表到位后给默认选择（最近更新的任务；空列表 → 新建任务）
  useEffect(() => {
    if (phase !== 'step1') return;
    setIssueChoice((prev) => {
      let next: Record<string, string> | null = null;
      for (const p of activeProjects) {
        const rid = mapping[p.id];
        if (!rid || prev[p.id]) continue;
        const list = issues[rid];
        if (list === undefined) continue; // 加载中，到位后本 effect 重跑
        const v = list.length > 0 ? (list[0]?.issueId ?? CREATE_ISSUE) : CREATE_ISSUE;
        next = next ?? { ...prev };
        next[p.id] = v;
      }
      return next ?? prev;
    });
  }, [phase, mapping, issues, activeProjects]);

  function onMapChange(localId: string, remoteId: string) {
    setMapping((prev) => ({ ...prev, [localId]: remoteId }));
    setIssueChoice((prev) => ({ ...prev, [localId]: '' })); // 换项目后重选任务
    if (remoteId) void ensureIssues(remoteId);
  }

  // ---- 第 1 步健康条（基于当前选择实时计算，不是落库值） ----
  const liveHealth = useMemo(() => {
    const remoteIds = new Set(remoteProjects.map((p) => p.id));
    const unmapped: string[] = [];
    const broken: string[] = [];
    for (const p of activeProjects) {
      const m = mapping[p.id] ?? '';
      if (m === '') unmapped.push(p.name);
      else if (!remoteIds.has(m)) broken.push(p.name);
    }
    return { unmapped, broken };
  }, [activeProjects, mapping, remoteProjects]);

  // ---- 第 2 步数据 ----
  const plans = useMemo<DayPlan[]>(() => {
    const capMin = Math.max(1, dailyCapHours) * 60;
    const byDay = new Map<string, WorkRecord[]>();
    for (const r of windowRecords) {
      const arr = byDay.get(r.day);
      if (arr) arr.push(r);
      else byDay.set(r.day, [r]);
    }
    const days = eachDay(from, to).filter((d) => byDay.has(d));
    const userEditedIds = new Set(windowRecords.filter(userEdited).map((r) => r.id));

    // 先产出基础行（时长 / 跳过原因 / 目标）
    const base = days.map((day) => {
      const recs: RecPlan[] = (byDay.get(day) ?? []).map((r) => {
        const remoteProjectId = mapping[r.projectId ?? ''] ?? '';
        const choice = issueChoice[r.projectId ?? ''] ?? '';
        const hasIssue = remoteProjectId !== '' && choice !== '';
        const isCreate = choice === CREATE_ISSUE;
        const list = remoteProjectId ? (issues[remoteProjectId] ?? []) : [];
        const iss = list.find((i) => i.issueId === choice);
        const issueLabel = !hasIssue ? '未选任务' : isCreate ? '＋新建任务' : iss ? `${iss.issueNum} ${iss.summary}` : '已选任务';
        const baseMin = overrides[r.id] ?? num(r.durationMin);
        return {
          id: r.id,
          content: r.content,
          baseMin,
          finalMin: baseMin,
          deductMin: 0,
          fillMin: 0,
          overtimeMin: otOf(r),
          synced: syncedIds.has(r.id),
          mapped: remoteProjectId !== '',
          hasIssue,
          isCreate,
          issueLabel,
          localProjectId: r.projectId ?? '',
          remoteProjectId,
          uploadable: baseMin > 0 && remoteProjectId !== '' && hasIssue && !syncedIds.has(r.id),
        };
      });
      const platformMin = remoteCal?.get(day) ?? 0;
      const bucket: DayBucket = platformMin > 0 ? 'platform' : syncDays.has(day) ? 'synced' : 'pending';
      return {
        day,
        bucket,
        platformMin,
        syncedMin: syncDays.get(day) ?? 0,
        locked: manualDays.has(day) || recs.some((r) => userEditedIds.has(r.id)),
        report: bucket === 'platform' ? forceDays.has(day) : true,
        overtimeMin: recs.reduce((s, r) => s + r.overtimeMin, 0),
        recs,
        uploadMin: 0,
        fillMin: 0,
      };
    });

    // 证据加班总量（窗口内全部记录，与是否上报无关）
    const otTotal = windowRecords.reduce((s, r) => s + otOf(r), 0);
    const capOtMin = Math.max(0, overtimeCapHours) * 60;

    // 按额度封顶：只在用户点了按钮之后裁（默认如实）
    if (trimOn && otTotal > capOtMin) {
      const all = plans0Uploadable(base);
      const deduct = trimOvertime(all, otTotal - capOtMin);
      for (const d of base) {
        let hit = false;
        for (const r of d.recs) {
          const cut = deduct.get(r.id);
          if (cut) {
            r.finalMin = Math.max(0, r.baseMin - cut);
            r.deductMin = cut;
            hit = true;
          }
        }
        if (hit) d.locked = true; // 封顶裁过的天锁定，fill 不再往回加
      }
    }

    // 按目标补齐：仅「待补报 + 未锁定 + 合计低于上限」的日
    if (reportPolicy === 'fill') {
      for (const d of base) {
        if (d.bucket !== 'pending' || !d.report || d.locked) continue;
        const ups = d.recs.filter((r) => r.uploadable && r.finalMin > 0);
        const add = distributeFill(ups.map((r) => ({ id: r.id, baseMin: r.finalMin })), capMin);
        if (add.size === 0) continue;
        for (const r of ups) {
          const m = add.get(r.id);
          if (m) {
            r.finalMin += m;
            r.fillMin += m;
          }
        }
      }
    }

    for (const d of base) {
      d.uploadMin = d.recs.filter((r) => r.uploadable && d.report).reduce((s, r) => s + r.finalMin, 0);
      d.fillMin = d.recs.reduce((s, r) => s + r.fillMin, 0);
    }
    return base;
  }, [windowRecords, from, to, mapping, issueChoice, issues, overrides, manualDays, forceDays, trimOn, remoteCal, syncDays, syncedIds, reportPolicy, dailyCapHours, overtimeCapHours]);

  const otTotalMin = useMemo(() => windowRecords.reduce((s, r) => s + otOf(r), 0), [windowRecords]);
  const otCapMin = Math.max(0, overtimeCapHours) * 60;
  const trimmedMin = useMemo(() => plans.reduce((s, d) => s + d.recs.reduce((x, r) => x + r.deductMin, 0), 0), [plans]);
  const runItems = useMemo<RunItem[]>(
    () =>
      plans
        .filter((d) => d.report)
        .flatMap((d) =>
          d.recs
            .filter((r) => r.uploadable && r.finalMin > 0)
            .map((r) => ({
              recordId: r.id,
              day: d.day,
              content: r.content,
              minutes: r.finalMin,
              localProjectName: projects.find((p) => p.id === r.localProjectId)?.name ?? '项目',
              remoteProjectId: r.remoteProjectId,
              issueChoice: issueChoice[r.localProjectId] ?? '',
            })),
        ),
    [plans, projects, issueChoice],
  );
  const windowUploadMin = runItems.reduce((s, it) => s + it.minutes, 0);
  const windowFillMin = plans.filter((d) => d.report).reduce((s, d) => s + d.fillMin, 0);

  function plans0Uploadable(base: DayPlan[]): RecPlan[] {
    return base.filter((d) => d.report).flatMap((d) => d.recs.filter((r) => r.uploadable));
  }

  function commitDraft(day: string, recordId: string) {
    const raw = editDrafts[recordId];
    if (raw === undefined) return;
    setEditDrafts((prev) => {
      const n = { ...prev };
      delete n[recordId];
      return n;
    });
    const h = Number(raw);
    if (Number.isFinite(h) && h >= 0) {
      setOverrides((prev) => ({ ...prev, [recordId]: Math.round(h * 60) }));
      setManualDays((prev) => new Set(prev).add(day)); // 手改过的天锁定，不参与 fill
    }
  }

  // ---- 步骤流转 ----
  async function goStep2() {
    if (!ctx || stepBusy) return;
    setStepBusy(true);
    setStepError('');
    try {
      // 映射写回（applyProjectMap 合并语义）；原映射被改为「不映射」的行直接清掉
      const pairs = activeProjects
        .filter((p) => (mapping[p.id] ?? '') !== '')
        .map((p) => ({ localProjectId: p.id, remoteProjectId: mapping[p.id] }));
      if (pairs.length > 0) await applyProjectMap(pairs);
      const cur = useSettingsStore.getState().settings.choerodon;
      if (cur) {
        const stale = Object.keys(cur.projectMap).filter((lid) => (mapping[lid] ?? undefined) === '' && cur.projectMap[lid]);
        if (stale.length > 0) {
          const pm = { ...cur.projectMap };
          for (const lid of stale) delete pm[lid];
          await useSettingsStore.getState().patch({ choerodon: { ...cur, projectMap: pm } });
        }
      }

      // 记录 + 对账数据
      await setRange(from, to);
      const recs = useRecordsStore.getState().records.filter((r) => r.day >= from && r.day <= to);
      const [sd, synced] = await Promise.all([
        listSyncLogDays(from, to),
        Promise.all(recs.map((r) => isRecordSynced(r.id))),
      ]);
      setSyncDays(sd);
      setSyncedIds(new Set(recs.filter((_, i) => synced[i]).map((r) => r.id)));

      // 平台工时日历（能力开关 + 方法存在才查；失败/缺能力 → 黄条降级，不静默）
      const cal = new Map<string, number>();
      const caps = choerodonReporter.capabilities();
      if (caps.queryWorkCalendar && choerodonReporter.queryWorkCalendar) {
        try {
          const rows = await choerodonReporter.queryWorkCalendar(ctx, from, to);
          for (const row of rows) if (row.minutes > 0) cal.set(row.date, row.minutes);
          setRemoteCal(cal);
          setCalDegraded(false);
        } catch (e) {
          // 黄条降级明示（详情进控制台），不静默装作对账成功
          setRemoteCal(null);
          setCalDegraded(true);
          console.warn('[choerodon-wizard] 工时日历拉取失败：', e);
        }
      } else {
        setRemoteCal(null);
        setCalDegraded(true);
      }
      setPhase('step2');
    } catch (e) {
      setStepError(errMsg(e));
    } finally {
      setStepBusy(false);
    }
  }

  async function resolveIssueId(item: RunItem): Promise<string> {
    if (item.issueChoice !== CREATE_ISSUE) return item.issueChoice;
    const cached = createdIssueRef.current.get(item.remoteProjectId);
    if (cached) return cached.issueId;
    if (!ctx) throw new Error('上下文丢失');
    const created = await choerodonReporter.createIssue(ctx, item.remoteProjectId, {
      summary: `${item.localProjectName} 工时上报 ${from}~${to}`,
    });
    createdIssueRef.current.set(item.remoteProjectId, created);
    return created.issueId;
  }

  /** 全成功才推进「上次上报日」（不回退已有水位）；调用方在运行循环里本地聚合成败，避免读到滞后状态 */
  async function advanceLastSyncIfAllDone(allOk: boolean) {
    if (!allOk || lastSyncAdvancedRef.current) return;
    const cur = useSettingsStore.getState().settings.choerodon;
    if (!cur) return;
    const next = cur.lastSyncDay && cur.lastSyncDay >= to ? cur.lastSyncDay : to;
    if (next !== cur.lastSyncDay) {
      await useSettingsStore.getState().patch({ choerodon: { ...cur, lastSyncDay: next } });
    }
    lastSyncAdvancedRef.current = true;
  }

  /** 执行单条；返回终态（done / skipped / fail），调用方据此聚合「是否全成功」 */
  async function runOne(idx: number): Promise<'done' | 'skipped' | 'fail'> {
    const item = runRowsRef.current[idx];
    if (!item || !ctx) return 'fail';
    setRunRows((prev) => prev.map((r, i) => (i === idx ? { ...r, status: 'running', error: undefined } : r)));
    try {
      if (await isRecordSynced(item.recordId)) {
        setRunRows((prev) => prev.map((r, i) => (i === idx ? { ...r, status: 'skipped' } : r)));
        return 'skipped';
      }
      const issueId = await resolveIssueId(item);
      const hours = Math.round((item.minutes / 60) * 100) / 100;
      const { logId } = await choerodonReporter.logWork(ctx, {
        issueId,
        projectId: item.remoteProjectId,
        date: item.day,
        hours,
      });
      await insertSyncLog({
        logId,
        recordId: item.recordId,
        day: item.day,
        minutes: item.minutes,
        payload: { hours, issueId, projectId: item.remoteProjectId, policy: reportPolicy },
      });
      setRunRows((prev) => prev.map((r, i) => (i === idx ? { ...r, status: 'done' } : r)));
      return 'done';
    } catch (e) {
      setRunRows((prev) =>
        prev.map((r, i) => (i === idx ? { ...r, status: 'fail', error: errMsg(e) } : r)),
      );
      return 'fail';
    }
  }

  async function startRun() {
    if (running || runItems.length === 0) return;
    setPhase('step3');
    const rows: RunRow[] = runItems.map((it) => ({ ...it, status: 'pending' }));
    setRunRows(rows);
    runRowsRef.current = rows;
    setFinished(false);
    setRunning(true);
    let allOk = true;
    for (let i = 0; i < rows.length; i++) {
      const st = await runOne(i);
      if (st === 'fail') allOk = false;
    }
    setRunning(false);
    setFinished(true);
    await advanceLastSyncIfAllDone(allOk);
  }

  async function retryFailures() {
    if (running) return;
    setRunning(true);
    let allOk = true;
    for (let i = 0; i < runRowsRef.current.length; i++) {
      if (runRowsRef.current[i]?.status === 'fail') {
        const st = await runOne(i);
        if (st === 'fail') allOk = false;
      }
    }
    setRunning(false);
    await advanceLastSyncIfAllDone(allOk);
  }

  /** 行级「重试该条」：修复后若已无其它失败项，补推进窗口（排除自身行避免读到滞后状态） */
  async function retryOne(i: number) {
    if (running) return;
    const st = await runOne(i);
    const othersFail = runRowsRef.current.some((r, j) => j !== i && r.status === 'fail');
    await advanceLastSyncIfAllDone(st !== 'fail' && !othersFail);
  }

  if (!open) return null;

  const stepIndex = phase === 'step1' ? 0 : phase === 'step2' ? 1 : phase === 'step3' ? 2 : -1;
  const steps = ['范围与映射', '对账与策略', '执行与结果'];
  const fails = runRows.filter((r) => r.status === 'fail');
  const doneCount = runRows.filter((r) => r.status === 'done').length;
  const skipCount = runRows.filter((r) => r.status === 'skipped').length;
  const attempted = runRows.filter((r) => r.status !== 'pending').length;

  function close() {
    if (running) return;
    onClose();
  }

  function gotoSettings() {
    close();
    navigate('/settings');
  }

  return (
    <div className="modal-mask" onClick={close}>
      <div className="card modal-card cw-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="批量上报到猪齿鱼">
        <header className="cw-head">
          <h3 className="set-h">批量上报到猪齿鱼</h3>
          <IconButton title={running ? '上报进行中…' : '关闭'} size="sm" onClick={close} disabled={running}>
            <X size={14} />
          </IconButton>
        </header>

        {stepIndex >= 0 && (
          <ol className="cw-steps">
            {steps.map((label, i) => (
              <li key={label} className={`cw-step${i === stepIndex ? ' active' : ''}${i < stepIndex ? ' done' : ''}`}>
                <span className="cw-step-num">{i < stepIndex ? '✓' : i + 1}</span>
                {label}
              </li>
            ))}
          </ol>
        )}

        {/* ============ 前置：装配 ctx / 连接测试 ============ */}
        {phase === 'gate' && (
          <div className="cw-gate">
            {gate === 'checking' && (
              <div className="cw-gate-loading">
                <Spinner label="正在连接猪齿鱼" />
                <span className="muted">正在连接猪齿鱼（验证 PAT、拉取项目）…</span>
              </div>
            )}
            {gate === 'noconfig' && (
              <>
                <div className="cw-banner warn">尚未配置猪齿鱼 PAT：请先到 设置 · 猪齿鱼 保存 PAT 并测试连接。</div>
                <div className="cw-footer">
                  <Button size="sm" onClick={close}>取消</Button>
                  <Button size="sm" variant="primary" icon={<Settings size={14} />} onClick={gotoSettings}>去设置</Button>
                </div>
              </>
            )}
            {gate === 'error' && (
              <>
                <div className="cw-banner danger">连接失败：{gateError}</div>
                <div className="cw-banner info">常见原因：PAT 无效或过期（重新生成并保存）、API 地址不对、公司网未连通。</div>
                <div className="cw-footer">
                  <Button size="sm" onClick={close}>取消</Button>
                  <Button size="sm" icon={<Settings size={14} />} onClick={gotoSettings}>去设置</Button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ============ 第 1 步：范围与映射 ============ */}
        {phase === 'step1' && ctx && (
          <>
            <div className="cw-dates">
              <label className="cw-field">
                <span className="muted">起始日</span>
                <input type="date" className="sel" value={from} max={to}
                  onChange={(e) => setFrom(e.target.value || from)} />
              </label>
              <span className="muted cw-dates-sep">→</span>
              <label className="cw-field">
                <span className="muted">截止日</span>
                <input type="date" className="sel" value={to} min={from} max={today}
                  onChange={(e) => setTo(e.target.value || to)} />
              </label>
              <span className="muted cw-dates-tip">
                {choerodon?.lastSyncDay
                  ? `上次上报至 ${choerodon.lastSyncDay}，默认从次日起`
                  : '首次上报，默认最近 7 天'}
              </span>
            </div>

            {liveHealth.broken.length > 0 && (
              <div className="cw-banner danger">映射指向不存在的远程项目：{liveHealth.broken.join('、')}</div>
            )}
            {liveHealth.unmapped.length > 0 && (
              <div className="cw-banner warn">
                {liveHealth.unmapped.length} 个本地项目未映射（{liveHealth.unmapped.join('、')}）——其记录将在下一步标灰跳过，可不映射
              </div>
            )}
            {stepError && <div className="cw-banner danger">{stepError}</div>}

            <div className="cw-map">
              <div className="cw-map-head muted">
                <span>本地项目</span><span>远程项目</span><span>上报目标任务</span>
              </div>
              {activeProjects.length === 0 && <div className="cw-map-empty muted">还没有本地项目，可先到 设置 · 项目与目录 创建</div>}
              {activeProjects.map((p) => {
                const rid = mapping[p.id] ?? '';
                const loading = rid !== '' && !issues[rid] && issueLoading.has(rid);
                return (
                  <div key={p.id} className="cw-map-row">
                    <span className="cw-map-name" title={p.name}>{p.name}</span>
                    <div className="cw-map-proj">
                      <Select
                        value={rid}
                        placeholder="不映射"
                        options={[{ value: '', label: '不映射（跳过该项目记录）' }, ...remoteProjects.map((rp) => ({ value: rp.id, label: `${rp.name}（${rp.code}）` }))]}
                        onChange={(v) => onMapChange(p.id, v)}
                      />
                    </div>
                    <div className="cw-map-issue">
                      {rid === '' ? (
                        <span className="muted cw-map-skip">—</span>
                      ) : (
                        <Select
                          value={issueChoice[p.id] ?? ''}
                          placeholder={loading ? '加载任务中…' : '选择任务'}
                          options={[
                            { value: CREATE_ISSUE, label: '＋ 新建任务（自动汇总）' },
                            ...(issues[rid] ?? []).map((i) => ({ value: i.issueId, label: `${i.issueNum} ${i.summary}` })),
                          ]}
                          onChange={(v) => setIssueChoice((prev) => ({ ...prev, [p.id]: v }))}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="cw-footer">
              <Button size="sm" onClick={close}>取消</Button>
              <Button size="sm" variant="primary" loading={stepBusy} onClick={() => void goStep2()}>下一步 · 对账</Button>
            </div>
          </>
        )}

        {/* ============ 第 2 步：对账与策略 ============ */}
        {phase === 'step2' && (
          <>
            {rangeStale && <div className="cw-banner info">正在载入窗口内记录…</div>}
            {calDegraded && (
              <div className="cw-banner warn">
                无法拉取平台工时日历，已报状态可能不全（仅按本地上报留痕判断），建议核对后继续
              </div>
            )}
            {stepError && <div className="cw-banner danger">{stepError}</div>}

            <div className="cw-policy">
              <span className="muted">填报策略</span>
              <Segmented
                aria-label="填报策略"
                size="sm"
                options={[
                  { value: 'fact', label: '如实逐条' },
                  { value: 'fill', label: `按目标补齐（补至 ${dailyCapHours}h/天）` },
                ]}
                value={reportPolicy}
                onChange={(v) => void setReportPolicy(v)}
              />
              <span className="muted cw-policy-tip">本地日志永远如实；策略只影响本次上报的时长口径。手动编辑过的天不参与补齐。</span>
            </div>

            <div className="cw-ot">
              <div className="cw-ot-line">
                <span>已累计加班 {fmtH(otTotalMin)} / {overtimeCapHours}h（证据测量，如实累计）</span>
                {otTotalMin > otCapMin && !trimOn && (
                  <Button size="sm" onClick={() => setTrimOn(true)}>按额度封顶</Button>
                )}
                {trimOn && (
                  <>
                    <Badge tone="warning">已封顶</Badge>
                    <span className="muted">预览共裁减 {fmtH(trimmedMin)}</span>
                    <Button size="sm" variant="ghost" onClick={() => setTrimOn(false)}>撤销封顶</Button>
                  </>
                )}
              </div>
              <div className="cw-otbar" role="progressbar" aria-valuemin={0} aria-valuemax={otCapMin} aria-valuenow={Math.min(otTotalMin, otCapMin)}>
                <div className={`cw-otbar-fill${otTotalMin > otCapMin ? ' over' : ''}`} style={{ width: `${Math.min(100, (otTotalMin / Math.max(1, otCapMin)) * 100)}%` }} />
              </div>
              {otTotalMin > otCapMin && !trimOn && (
                <div className="cw-banner warn">证据加班已超额度（超出 {fmtH(otTotalMin - otCapMin)}），可选择封顶或如实上报</div>
              )}
            </div>

            <div className="cw-sum muted">
              窗口 {from} ~ {to}：{plans.length} 个有记录的天 · 上报 {runItems.length} 条 · 合计 {fmtH(windowUploadMin)}
              {windowFillMin > 0 && `（含补齐 ${fmtH(windowFillMin)}）`}
            </div>

            <div className="cw-days">
              {plans.length === 0 && <div className="cw-map-empty muted">窗口内没有记录</div>}
              {plans.map((d) => {
                const isOpen = openDay === d.day;
                return (
                  <div key={d.day} className={`cw-day${d.report ? '' : ' is-skip'}`}>
                    <button type="button" className="cw-day-row" onClick={() => setOpenDay(isOpen ? null : d.day)}>
                      <span className="cw-day-chevron">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
                      <span className="cw-day-date">{shortDay(d.day)}</span>
                      <span className="muted">{d.recs.length} 条</span>
                      <span className="cw-day-total">{fmtH(d.uploadMin)}</span>
                      {d.overtimeMin > 0 && <span className="cw-day-ot">加班 +{fmtH(d.overtimeMin)}</span>}
                      {d.bucket === 'platform' && <Badge tone="neutral">{d.report ? '仍上报' : '已报/手报 勿动'}</Badge>}
                      {d.bucket === 'synced' && <Badge tone="accent">已同步</Badge>}
                      {d.bucket === 'pending' && d.uploadMin === 0 && <Badge tone="neutral">无可上报</Badge>}
                      {d.locked && (
                        <span className="cw-lock" title="用户编辑过 / 预览手改 / 封顶裁减：不参与补齐调整"><Lock size={12} /> 锁定</span>
                      )}
                    </button>
                    {isOpen && (
                      <div className="cw-day-body">
                        {d.bucket === 'platform' && (
                          <div className="cw-day-note">
                            平台已有工时 {fmtH(d.platformMin)}，默认跳过该日；
                            <label className="cw-force">
                              <input
                                type="checkbox"
                                checked={d.report}
                                onChange={(e) => setForceDays((prev) => {
                                  const n = new Set(prev);
                                  if (e.target.checked) n.add(d.day); else n.delete(d.day);
                                  return n;
                                })}
                              />
                              仍上报该日
                            </label>
                          </div>
                        )}
                        {d.bucket === 'synced' && <div className="cw-day-note">本地留痕：该日已上报 {fmtH(d.syncedMin)}（已上报的条目自动跳过）</div>}
                        {d.recs.map((r) => (
                          <div key={r.id} className={`cw-rec${r.uploadable && d.report ? '' : ' is-gray'}`}>
                            <span className="cw-rec-content" title={r.content}>{r.content || '（无内容）'}</span>
                            <span className="muted cw-rec-issue">{r.issueLabel}</span>
                            {r.fillMin > 0 && <Badge tone="accent">补 {fmtH(r.fillMin)}</Badge>}
                            {r.deductMin > 0 && <Badge tone="warning">裁 {fmtH(r.deductMin)}</Badge>}
                            {r.synced ? (
                              <Badge tone="neutral">已报</Badge>
                            ) : !r.mapped ? (
                              <Badge tone="neutral">未映射</Badge>
                            ) : !r.hasIssue ? (
                              <Badge tone="warning">未选任务</Badge>
                            ) : r.baseMin <= 0 ? (
                              <Badge tone="neutral">无时长</Badge>
                            ) : null}
                            <input
                              type="number"
                              className="sel cw-num"
                              min={0}
                              step={0.5}
                              aria-label={`上报时长（小时）：${r.content}`}
                              disabled={r.synced || !r.mapped || !r.hasIssue || !d.report}
                              value={editDrafts[r.id] ?? String(+(r.baseMin / 60).toFixed(2))}
                              onChange={(e) => setEditDrafts((prev) => ({ ...prev, [r.id]: e.target.value }))}
                              onBlur={() => commitDraft(d.day, r.id)}
                              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                            />
                            <span className="muted cw-rec-unit">h</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="cw-footer">
              <Button size="sm" onClick={() => setPhase('step1')}>上一步</Button>
              <Button size="sm" variant="primary" disabled={runItems.length === 0} onClick={() => void startRun()}>
                {reportPolicy === 'fill' ? '开始补齐上报' : '开始上报'} {runItems.length} 条 · {fmtH(windowUploadMin)}
              </Button>
            </div>
          </>
        )}

        {/* ============ 第 3 步：执行与结果 ============ */}
        {phase === 'step3' && (
          <>
            <div className="cw-sum">
              {running ? (
                <>正在上报 {attempted}/{runRows.length} …</>
              ) : finished ? (
                <>
                  上报完成：成功 {doneCount} · 跳过 {skipCount}（已报防重）· 失败 {fails.length}
                  {fails.length === 0 ? (
                    <Badge tone="success">窗口已推进至 {to}</Badge>
                  ) : (
                    <Badge tone="warning">有失败项，上报窗口未推进</Badge>
                  )}
                </>
              ) : (
                <>准备上报 {runRows.length} 条 …</>
              )}
            </div>
            {finished && fails.length > 0 && (
              <div className="cw-banner warn">
                失败项处理后再点「重试失败项」即可；已成功条目与本次新推进不会重复上报（重跑自动覆盖缺口）。全部成功后窗口才会推进。
              </div>
            )}
            {finished && fails.length === 0 && (
              <div className="cw-banner info">已把「上次上报」推进到 {to}；下次向导默认从 {addDays(to, 1)} 开始。</div>
            )}

            <div className="cw-run">
              {runRows.map((r, i) => (
                <div key={r.recordId} className={`cw-run-row is-${r.status}`}>
                  <span className="cw-run-status" aria-label={r.status}>
                    {r.status === 'done' && '✓'}
                    {r.status === 'skipped' && '⏭'}
                    {r.status === 'fail' && '✗'}
                    {r.status === 'running' && <Spinner size="sm" label="上报中" />}
                    {r.status === 'pending' && '·'}
                  </span>
                  <span className="muted cw-run-day">{shortDay(r.day)}</span>
                  <span className="cw-run-content" title={r.content}>{r.content || '（无内容）'}</span>
                  <span className="muted">{fmtH(r.minutes)}</span>
                  {r.status === 'fail' && (
                    <>
                      <span className="cw-run-err" title={r.error}>{r.error}</span>
                      <Button size="sm" disabled={running} icon={<RefreshCw size={12} />} onClick={() => void retryOne(i)}>重试该条</Button>
                    </>
                  )}
                </div>
              ))}
            </div>

            <div className="cw-footer">
              {finished && fails.length > 0 && (
                <Button size="sm" icon={<RefreshCw size={14} />} disabled={running} onClick={() => void retryFailures()}>
                  重试失败项（{fails.length}）
                </Button>
              )}
              <Button size="sm" variant="primary" disabled={running} onClick={close}>完成</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
