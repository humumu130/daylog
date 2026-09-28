// 待办摄入（P5·D）：AI 会话结构化 todo 事件 → 本地任务。
// 幂等键 externalKey = sha1(provider + normalize(subject) + projectId)；
// TodoWrite 取会话末次快照为终态（后写覆盖前写）；AI → 本地单向，不回写。

import type { Project } from '../../types/models';
import * as db from '../db';
import type { AiEvent, ProjectResolver } from './index';
import { eventFingerprint, sha256Hex } from './scan';
import { markIngested } from './state';

export interface TodoIngestResult {
  created: number;
  updated: number;
  skipped: number;
}

/** subject 归一化：空白折叠、去首尾标点、小写（中文无影响） */
function normalizeSubject(s: string): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().replace(/[。.!！?？,，、;；~～]+$/g, '').toLowerCase();
}

async function externalKey(provider: string, subject: string, projectId: string | null): Promise<string> {
  return sha256Hex(`${provider}|${normalizeSubject(subject)}|${projectId ?? ''}`);
}

/** 状态映射：会话侧 completed→done，其余一律 active（paused 语义本地独有，不自动降） */
function mapStatus(s: string | null): 'active' | 'done' {
  return s === 'completed' || s === 'done' ? 'done' : 'active';
}

interface TodoItem {
  subject: string;
  status: string | null;
}

/** 从 TodoWrite 快照文本（Rust 存的 input JSON）解析 todos 数组 */
function parseSnapshot(text: string): TodoItem[] {
  try {
    const p = JSON.parse(text) as { todos?: { content?: string; subject?: string; status?: string }[] };
    return (p.todos ?? [])
      .map((t) => ({ subject: t.subject ?? t.content ?? '', status: t.status ?? null }))
      .filter((t) => t.subject);
  } catch {
    return [];
  }
}

/**
 * 摄入一批 todo 事件（按 ts 升序应用：快照/更新按时间覆盖）。
 * 事件需为 kind==='todo_tool'；projectId 由事件 cwd 归组。
 * P8b：createTask 落条目归组项目的空间（projects 表查），无项目归 'work'。
 */
export async function ingestTodos(events: AiEvent[], resolver: ProjectResolver, projects: Project[]): Promise<TodoIngestResult> {
  const res: TodoIngestResult = { created: 0, updated: 0, skipped: 0 };
  const sorted = [...events].filter((e) => e.kind === 'todo_tool').sort((a, b) => a.ts - b.ts);
  // 处理完统一标记摄入（含跳过项：决策已做出，防每轮重放）；摄入后水位线才可提交
  const consumed: { fingerprint: string; provider: string; day: string; kind: string; payload: unknown }[] = [];
  // 项目 id → 所属空间（task 空间跟项目走；查不到兜底 'work'）
  const wsOfProject = new Map(projects.map((p) => [p.id, p.workspaceId ?? db.DEFAULT_WORKSPACE_ID]));

  for (const ev of sorted) {
    const project = resolver.resolve(ev.cwd);
    const projectId = project?.id ?? null;
    const wsId = (projectId ? wsOfProject.get(projectId) : undefined) ?? db.DEFAULT_WORKSPACE_ID;

    if (ev.todo?.action === 'write') {
      // TodoWrite：末次快照为终态——逐项 upsert
      const items = parseSnapshot(ev.text);
      if (items.length === 0) { res.skipped++; continue; }
      for (const item of items) await upsert(ev.provider, item, projectId, wsId, ev.day, res);
      continue;
    }

    const subject = ev.todo?.subject ?? '';
    if (!subject) { res.skipped++; continue; }
    if (ev.todo?.action === 'create') {
      await upsert(ev.provider, { subject, status: 'pending' }, projectId, wsId, ev.day, res);
    } else if (ev.todo?.action === 'update') {
      // TaskUpdate：按归一化 subject 定位（有 status 才有意义）
      const key = await externalKey(ev.provider, subject, projectId);
      const existing = await db.findTaskByExternalKey(key);
      if (!existing) { res.skipped++; continue; }
      const next = ev.todo?.status ?? null;
      if (!next) { res.skipped++; continue; }
      const status = mapStatus(next);
      if (existing.status !== status) {
        await db.updateTask(existing.id, {
          title: existing.title,
          projectId: existing.projectId,
          status,
          startDate: existing.startDate,
          endDate: status === 'done' ? (existing.endDate ?? ev.day) : existing.endDate,
          note: existing.note,
        });
        res.updated++;
      }
    }
  }
  for (const ev of sorted) {
    consumed.push({ fingerprint: await eventFingerprint(ev), provider: ev.provider, day: ev.day, kind: ev.kind, payload: { text: ev.text, ts: ev.ts, human: false } });
  }
  if (consumed.length > 0) await markIngested(consumed);
  return res;
}

async function upsert(provider: string, item: TodoItem, projectId: string | null, wsId: string, day: string, res: TodoIngestResult): Promise<void> {
  const key = await externalKey(provider, item.subject, projectId);
  const existing = await db.findTaskByExternalKey(key);
  const status = mapStatus(item.status);
  if (!existing) {
    await db.createTask({
      title: item.subject,
      projectId,
      status,
      startDate: day,
      endDate: status === 'done' ? day : null,
      note: '',
      source: 'ai',
      externalKey: key,
      workspaceId: wsId,
    });
    res.created++;
    return;
  }
  if (existing.status !== status) {
    await db.updateTask(existing.id, {
      title: existing.title,
      projectId: existing.projectId,
      status,
      startDate: existing.startDate,
      endDate: status === 'done' ? (existing.endDate ?? day) : existing.endDate,
      note: existing.note,
    });
    res.updated++;
  }
}
