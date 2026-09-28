// 空间制核心 store（P8b）：当前空间 + 空间清单。
// - 当前空间持久 localStorage（三窗口同 origin 共享：浮窗落库前 readPersistedWsId() 直读）
// - 切换空间广播 CHANGE_EVENT，各窗口收到后重拉数据（stores 的查询按 currentId 过滤）
// - 首启三选一：applyOnboardChoice（种子 'work' 行原位改造，零数据迁移）
// 存量升级：迁移 v40 已种子 'work'，用户不弹向导不多出任何东西（onboardDone=false 只对全新
// 数据判断——由 MainApp 侧综合判断，见 OnboardModal 接线）。

import { create } from 'zustand';
import * as db from '../services/db';
import { notifyChanged } from '../services/events';
import type { Workspace, WorkspaceKind } from '../types/models';

const LS_KEY = 'daylog.currentWs';

/** 非 hook 场景（浮窗落库前/服务模块）直读当前空间 id；无记录回退默认 'work' */
export function readPersistedWsId(): string {
  try {
    return localStorage.getItem(LS_KEY) || db.DEFAULT_WORKSPACE_ID;
  } catch {
    return db.DEFAULT_WORKSPACE_ID;
  }
}

function persistWsId(id: string): void {
  try {
    localStorage.setItem(LS_KEY, id);
  } catch {
    // localStorage 不可用（极端）：仅内存态，下次启动回默认
  }
}

interface WorkspaceState {
  workspaces: Workspace[];
  currentId: string;
  loaded: boolean;
  /** 当前空间（null=清单空且未加载完）；调用方兜底按 'work' 处理 */
  current: () => Workspace | null;
  /** 当前空间类型（守卫矩阵消费：work=工时/上报/报告；personal=成长/复盘） */
  currentKind: () => WorkspaceKind;
  load: () => Promise<Workspace[]>;
  switchTo: (id: string) => void;
  create: (input: { name: string; type: WorkspaceKind }) => Promise<string>;
  rename: (id: string, name: string) => Promise<void>;
  archive: (id: string, archived: boolean) => Promise<void>;
  setDefault: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** 首启三选一：'work'=只记工作（种子原样）；'personal'=只记个人（种子原位转 personal）；
   *  'both'=两者（种子保留 + 新建 personal）。返回最终空间清单 */
  applyOnboardChoice: (choice: 'work' | 'personal' | 'both') => Promise<Workspace[]>;
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  workspaces: [],
  currentId: readPersistedWsId(),
  loaded: false,

  current: () => {
    const { workspaces, currentId } = get();
    return workspaces.find((w) => w.id === currentId) ?? null;
  },
  currentKind: () => get().current()?.type ?? 'work',

  load: async () => {
    let list = await db.listWorkspaces();
    if (list.length === 0) {
      // 迁移兜底（理论不到这：v40 已种子）
      await db.createWorkspace({ id: db.DEFAULT_WORKSPACE_ID, name: '工作', type: 'work', isDefault: true });
      list = await db.listWorkspaces();
    }
    const active = list.filter((w) => !w.archived);
    const pool = active.length > 0 ? active : list;
    let cur = get().currentId;
    if (!pool.some((w) => w.id === cur)) {
      cur = pool.find((w) => w.isDefault)?.id ?? pool[0].id;
      persistWsId(cur);
    }
    set({ workspaces: list, currentId: cur, loaded: true });
    return list;
  },

  switchTo: (id) => {
    if (id === get().currentId) return;
    persistWsId(id);
    set({ currentId: id });
    void notifyChanged(); // 各窗口按新空间重拉数据
  },

  create: async (input) => {
    const id = await db.createWorkspace(input);
    await get().load();
    return id;
  },

  rename: async (id, name) => {
    await db.renameWorkspace(id, name);
    await get().load();
  },

  archive: async (id, archived) => {
    await db.archiveWorkspace(id, archived);
    await get().load();
  },

  setDefault: async (id) => {
    await db.setDefaultWorkspace(id);
    await get().load();
  },

  remove: async (id) => {
    await db.deleteWorkspace(id); // 空间非空时抛错，由 UI 捕获提示
    await get().load();
  },

  applyOnboardChoice: async (choice) => {
    if (choice === 'personal') {
      // 种子 'work' 原位转 personal：id 不变（records/projects/tasks 默认值零迁移），改名「个人」
      await db.setWorkspaceKind(db.DEFAULT_WORKSPACE_ID, 'personal');
      await db.renameWorkspace(db.DEFAULT_WORKSPACE_ID, '个人');
    } else if (choice === 'both') {
      await db.createWorkspace({ id: 'personal', name: '个人', type: 'personal' });
    }
    // 'work'：种子原样
    const list = await get().load();
    // 默认落在 work 型第一个空间
    const firstWork = list.find((w) => w.type === 'work');
    if (firstWork) await db.setDefaultWorkspace(firstWork.id);
    return await get().load();
  },
}));
