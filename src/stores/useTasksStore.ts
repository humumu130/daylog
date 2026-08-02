import { create } from 'zustand';
import * as db from '../services/db';
import type { Task, TaskStatus } from '../types/models';

interface TasksState {
  tasks: Task[];
  loading: boolean;
  fetch: () => Promise<void>;
  create: (input: db.TaskInput) => Promise<string>;
  update: (id: string, input: db.TaskInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setStatus: (id: string, status: TaskStatus) => Promise<void>;
  activeTasks: () => Task[];
}

export const useTasksStore = create<TasksState>()((set, get) => ({
  tasks: [],
  loading: false,
  fetch: async () => {
    set({ loading: true });
    try {
      const tasks = await db.listTasks();
      set({ tasks });
    } finally {
      set({ loading: false });
    }
  },
  create: async (input) => {
    const id = await db.createTask(input);
    await get().fetch();
    return id;
  },
  update: async (id, input) => {
    await db.updateTask(id, input);
    await get().fetch();
  },
  remove: async (id) => {
    await db.deleteTask(id);
    await get().fetch();
  },
  setStatus: async (id, status) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    await db.updateTask(id, {
      title: task.title,
      projectId: task.projectId,
      status,
      startDate: task.startDate,
      endDate: status === 'done' ? task.endDate ?? task.startDate : task.endDate,
      note: task.note,
    });
    await get().fetch();
  },
  activeTasks: () => get().tasks.filter((t) => t.status === 'active'),
}));
