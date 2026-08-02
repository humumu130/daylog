import { create } from 'zustand';
import * as db from '../services/db';
import type { Project, WorkRecord } from '../types/models';
import { todayYMD } from '../utils/date';
import { matchProjectForContent } from '../utils/parseEntry';

interface RecordsState {
  records: WorkRecord[];
  from: string;
  to: string;
  loading: boolean;
  setRange: (from: string, to: string) => Promise<void>;
  fetch: () => Promise<void>;
  create: (input: db.RecordInput) => Promise<string>;
  update: (id: string, input: db.RecordInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
  rematchProjects: (projects: Project[]) => Promise<number>;
}

const t = todayYMD();

export const useRecordsStore = create<RecordsState>()((set, get) => ({
  records: [],
  from: t,
  to: t,
  loading: false,
  setRange: async (from, to) => {
    set({ from, to });
    await get().fetch();
  },
  fetch: async () => {
    const { from, to } = get();
    set({ loading: true });
    try {
      const records = await db.listRecordsByRange(from, to);
      set({ records });
    } finally {
      set({ loading: false });
    }
  },
  create: async (input) => {
    const id = await db.createRecord(input);
    await get().fetch();
    return id;
  },
  update: async (id, input) => {
    await db.updateRecord(id, input);
    await get().fetch();
  },
  remove: async (id) => {
    await db.deleteRecord(id);
    await get().fetch();
  },
  rematchProjects: async (projects) => {
    const all = await db.listRecordsByRange('2000-01-01', '2999-12-31');
    let changed = 0;
    for (const r of all) {
      if (r.projectId) continue;
      const p = matchProjectForContent(r.content, projects);
      if (p) {
        await db.updateRecord(r.id, {
          content: r.content,
          durationMin: r.durationMin,
          day: r.day,
          half: r.half,
          taskId: r.taskId,
          projectId: p.id,
          source: r.source,
          meta: r.meta,
        });
        changed++;
      }
    }
    await get().fetch();
    return changed;
  },
}));
