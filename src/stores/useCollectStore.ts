// 采集中心 store（P6）：页面只调这里，采集引擎 API 全部封装
// （含产出判定与 notifyChanged 广播，页面不直接碰 services/collector 细节）。

import { create } from 'zustand';
import * as db from '../services/db';
import { notifyChanged } from '../services/events';
import {
  collectorState,
  getLastPass,
  manualScanNow,
  rebuildDayNow,
  removeAndIgnoreKind,
  undoDay,
  type CollectPassResult,
  type NoiseReview,
} from '../services/collector';
import type { WorkRecord } from '../types/models';
import { addDays, todayYMD } from '../utils/date';

const WORKSPACE_ID = 'work';
/** 自动来源（引擎产出）：ai / git / mixed */
const AUTO_SOURCES = new Set(['ai', 'git', 'mixed']);
/** 自动条目展示窗口：近 14 天（含今日） */
const AUTO_WINDOW_BACK_DAYS = 13;

/** 最近一轮采集是否有实际产出（与调度器 runPass 同口径） */
function passProduced(result: CollectPassResult): boolean {
  return (
    result.todos.created + result.todos.updated > 0 ||
    Object.values(result.days).some((s) => s.created > 0 || s.pending > 0 || s.autoDropped > 0)
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface CollectState {
  /** 手动补扫进行中 */
  scanning: boolean;
  /** 单条/单日动作进行中（key = noise:<fp> / day:<day> / rec:<id>），驱动对应行按钮禁用 */
  busyKey: string | null;
  /** 最近一轮采集（at=0 且 result=null 表示从未跑过） */
  lastPass: { at: number; result: CollectPassResult | null } | null;
  pendingNoise: NoiseReview[];
  autoDroppedNoise: NoiseReview[];
  /** 近 14 天自动来源条目，按 day 倒序（同日内按创建序） */
  autoRecords: WorkRecord[];
  error: string | null;

  refresh: () => Promise<void>;
  scanNow: () => Promise<void>;
  /** 噪音判定：kept=计入工作（重整合该日）；否则确是噪音（沉淀 dropped 规则） */
  decideNoise: (fingerprint: string, kept: boolean) => Promise<void>;
  /** 恢复自动排除的内容（翻案 kept + 重整合该日） */
  restoreNoise: (fingerprint: string) => Promise<void>;
  undoDayAction: (day: string) => Promise<void>;
  removeIgnore: (record: { id: string; content: string; day: string }) => Promise<void>;
  rebuildAction: (day: string) => Promise<void>;
}

export const useCollectStore = create<CollectState>()((set, get) => ({
  scanning: false,
  busyKey: null,
  lastPass: null,
  pendingNoise: [],
  autoDroppedNoise: [],
  autoRecords: [],
  error: null,

  refresh: async () => {
    const [pending, autoDropped, records, pass] = await Promise.all([
      collectorState.listNoise(WORKSPACE_ID, 'pending'),
      collectorState.listNoise(WORKSPACE_ID, 'auto_dropped'),
      db.listRecordsByRange(addDays(todayYMD(), -AUTO_WINDOW_BACK_DAYS), todayYMD()),
      Promise.resolve(getLastPass()),
    ]);
    const autoRecords = records
      .filter((r) => AUTO_SOURCES.has(r.source))
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)); // 稳定排序：同日内保持 created_at 升序
    set({ pendingNoise: pending, autoDroppedNoise: autoDropped, autoRecords, lastPass: pass });
  },

  scanNow: async () => {
    if (get().scanning) return;
    set({ scanning: true, error: null });
    try {
      const result = await manualScanNow();
      await get().refresh();
      if (passProduced(result)) void notifyChanged();
    } catch (e) {
      set({ error: `补扫失败：${errMsg(e)}` });
    } finally {
      set({ scanning: false });
    }
  },

  decideNoise: async (fingerprint, kept) => {
    const key = `noise:${fingerprint}`;
    if (get().busyKey) return;
    set({ busyKey: key, error: null });
    try {
      if (kept) {
        const day = findNoiseDay(get(), fingerprint);
        await collectorState.setNoiseStatus(fingerprint, 'kept');
        if (day) await rebuildDayNow(day);
        await get().refresh();
        if (day) void notifyChanged();
      } else {
        await collectorState.setNoiseStatus(fingerprint, 'dropped');
        await get().refresh();
      }
    } catch (e) {
      set({ error: `判定失败：${errMsg(e)}` });
    } finally {
      set({ busyKey: null });
    }
  },

  restoreNoise: async (fingerprint) => {
    const key = `noise:${fingerprint}`;
    if (get().busyKey) return;
    set({ busyKey: key, error: null });
    try {
      const day = findNoiseDay(get(), fingerprint);
      await collectorState.setNoiseStatus(fingerprint, 'kept');
      if (day) await rebuildDayNow(day);
      await get().refresh();
      if (day) void notifyChanged();
    } catch (e) {
      set({ error: `恢复失败：${errMsg(e)}` });
    } finally {
      set({ busyKey: null });
    }
  },

  undoDayAction: async (day) => {
    const key = `day:${day}`;
    if (get().busyKey) return;
    set({ busyKey: key, error: null });
    try {
      await undoDay(day);
      await get().refresh();
      void notifyChanged();
    } catch (e) {
      set({ error: `撤销失败：${errMsg(e)}` });
    } finally {
      set({ busyKey: null });
    }
  },

  removeIgnore: async (record) => {
    const key = `rec:${record.id}`;
    if (get().busyKey) return;
    set({ busyKey: key, error: null });
    try {
      await removeAndIgnoreKind(record);
      await get().refresh();
      void notifyChanged();
    } catch (e) {
      set({ error: `移除失败：${errMsg(e)}` });
    } finally {
      set({ busyKey: null });
    }
  },

  rebuildAction: async (day) => {
    const key = `day:${day}`;
    if (get().busyKey) return;
    set({ busyKey: key, error: null });
    try {
      await rebuildDayNow(day);
      await get().refresh();
      void notifyChanged();
    } catch (e) {
      set({ error: `重整合失败：${errMsg(e)}` });
    } finally {
      set({ busyKey: null });
    }
  },
}));

/** 从当前列表里查噪音行的发生日（无 day 返回 null，跳过重整合） */
function findNoiseDay(state: CollectState, fingerprint: string): string | null {
  const row = [...state.pendingNoise, ...state.autoDroppedNoise].find((n) => n.fingerprint === fingerprint);
  return row?.day ?? null;
}
