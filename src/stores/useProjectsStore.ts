import { create } from 'zustand';
import * as db from '../services/db';
import type { Project } from '../types/models';

interface ProjectsState {
  projects: Project[];
  loading: boolean;
  fetch: () => Promise<void>;
  create: (input: db.ProjectInput) => Promise<string>;
  update: (id: string, input: db.ProjectInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useProjectsStore = create<ProjectsState>()((set, get) => ({
  projects: [],
  loading: false,
  fetch: async () => {
    set({ loading: true });
    try {
      const projects = await db.listProjects();
      set({ projects });
    } finally {
      set({ loading: false });
    }
  },
  create: async (input) => {
    const id = await db.createProject(input);
    await get().fetch();
    return id;
  },
  update: async (id, input) => {
    await db.updateProject(id, input);
    await get().fetch();
  },
  remove: async (id) => {
    await db.deleteProject(id);
    await get().fetch();
  },
}));
