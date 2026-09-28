import { create } from 'zustand';
import { consolidateCommits } from '../services/llm';
import * as db from '../services/db';
import { todayYMD } from '../utils/date';
import type { GitCommit } from '../services/git';
import type { LlmConfig } from '../types/models';

export interface SmartItem {
  title: string;
  count: number;
  day: string;
  projectId: string | null;
  hours: number;
  hashes: string[];
  imported: boolean;
  isExisting?: boolean;
}

type SmartStatus = 'idle' | 'loading' | 'done' | 'error';

interface GitState {
  smartItems: SmartItem[];
  smartStatus: SmartStatus;
  smartError: string;
  /** 本次整合所基于的提交集合指纹；用于判断"原始提交是否变化、要不要重新整合" */
  consolidatedSignature: string | null;
  runConsolidate: (commits: GitCommit[], config: LlmConfig, knownHashes: Set<string>) => Promise<void>;
  setItemHours: (index: number, hours: number) => void;
  clearSmart: () => void;
}

/** 提交集合指纹：hash@repoId 排序后拼接。相同指纹 = 同一批提交。 */
export function signatureOf(commits: { hash: string; repoId: string }[]): string {
  return commits.map((c) => `${c.hash}@${c.repoId}`).sort().join('|');
}

/**
 * 智能整合状态放在 store（模块单例），**跨页面存活**：
 * 切走采集页不会取消正在进行的整合，回来直接看结果；
 * 配合 consolidatedSignature 实现"提交没变就不重跑"。
 * 不持久化——关 app 后重开，raw 提交可能已变，缓存意义不大。
 */
export const useGitStore = create<GitState>()((set) => ({
  smartItems: [],
  smartStatus: 'idle',
  smartError: '',
  consolidatedSignature: null,

  runConsolidate: async (commits, config, knownHashes) => {
    set({ smartStatus: 'loading', smartError: '' });
    try {
      const existing = await db.listRecordsByRange('2000-01-01', '2999-12-31');
      const existingInput = existing.map((r) => ({ content: r.content, project: undefined }));
      const items = await consolidateCommits(commits, config, existingInput);
      const mapped: SmartItem[] = items.map((it) => {
        const cs2 = commits.filter((c) => it.hashes.includes(c.hash));
        const day = cs2.map((c) => c.date).sort().pop() ?? todayYMD();
        const pids = new Set(cs2.map((c) => c.projectId).filter(Boolean) as string[]);
        const projectId = pids.size === 1 ? [...pids][0] : (cs2[0]?.projectId ?? null);
        return {
          title: it.title,
          count: cs2.length,
          day,
          projectId,
          hours: it.hours ?? 1,
          hashes: it.hashes,
          imported: it.hashes.every((h) => knownHashes.has(h)),
          isExisting: it.status === 'existing',
        };
      });
      set({
        smartItems: mapped,
        smartStatus: 'done',
        smartError: '',
        consolidatedSignature: signatureOf(commits),
      });
    } catch (e) {
      set({
        smartError: e instanceof Error ? e.message : String(e),
        smartItems: [],
        smartStatus: 'error',
      });
    }
  },

  setItemHours: (index, hours) =>
    set((st) => ({
      smartItems: st.smartItems.map((it, i) => (i === index ? { ...it, hours } : it)),
    })),

  clearSmart: () =>
    set({ smartItems: [], smartStatus: 'idle', smartError: '', consolidatedSignature: null }),
}));
