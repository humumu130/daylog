import { invoke } from '@tauri-apps/api/core';
import type { GitRepo } from '../types/models';

export interface GitCommit {
  repoId: string;
  repoPath: string;
  projectId: string | null;
  hash: string;
  subject: string;
  author: string;
  date: string; // YYYY-MM-DD
}

/** 扫描多个仓库的 git log（并行），返回提交列表 + 失败的仓库 */
export async function scanRepos(
  repos: GitRepo[],
  since: string,
  until?: string,
): Promise<{ commits: GitCommit[]; errors: { path: string; error: string }[] }> {
  // 并行扫描所有仓库，总耗时 ≈ 最慢的那个（而非相加）
  const results = await Promise.all(repos.map(async (repo) => {
    try {
      const out = await invoke<string>('git_log', {
        repo: repo.path,
        since,
        author: repo.author || null,
        until: until ?? null,
      });
      const commits: GitCommit[] = [];
      for (const line of out.split('\n')) {
        if (!line) continue;
        const parts = line.split('|');
        if (parts.length < 4) continue;
        const hash = parts[0];
        const date = parts[parts.length - 1];
        const author = parts[parts.length - 2];
        const subject = parts.slice(1, parts.length - 2).join('|');
        commits.push({ repoId: repo.id, repoPath: repo.path, projectId: repo.projectId, hash, subject, author, date });
      }
      return { commits, error: null as { path: string; error: string } | null };
    } catch (e) {
      return { commits: [] as GitCommit[], error: { path: repo.path, error: e instanceof Error ? e.message : String(e) } };
    }
  }));
  return {
    commits: results.flatMap((r) => r.commits),
    errors: results.map((r) => r.error).filter((e): e is { path: string; error: string } => e !== null),
  };
}
