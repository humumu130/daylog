// 扫描器（P5）：AI 会话增量扫描——水位线推进 + 指纹幂等 + 保留期过滤。
// 幂等三层：①字节水位线（正常路径零重读）②指纹查重（水位线被清/文件被改的兜底）
// ③retention 跳老文件（源数据 30 天保留期对齐）。

import { invoke } from '@tauri-apps/api/core';
import { homeDir } from '@tauri-apps/api/path';
import type { CollectSettings, Project } from '../../types/models';
import type { AiEvent, AiParseResult, AiSessionInfo, EngineInput } from './types';
import type { WatermarkEntry } from './state';
import { filterIngested, getWatermark, setWatermark } from './state';

/** 默认扫描根（Claude Code ~/.claude/projects + Codex ~/.codex/sessions；根不存在由 Rust 静默跳过） */
export async function defaultScanRoots(): Promise<string[]> {
  try {
    const home = await homeDir();
    return [`${home}/.claude/projects`, `${home}/.codex/sessions`];
  } catch {
    return [];
  }
}

export interface ScanOutcome {
  /** 新事件（已滤除已摄入指纹），供整合引擎与 todo 摄入 */
  freshEvents: AiEvent[];
  /** 扫过的文件数 / 解析错误行数 */
  files: number;
  parseErrors: number;
  /** 跳过的文件（超保留期/无新字节） */
  skippedFiles: number;
  /** 待提交水位线（事件全部消费后由调用方 commitWatermarks；失败不提交→下轮重解析+指纹去重） */
  pendingWatermarks: WatermarkEntry[];
}

function isOlderThanRetention(lastModified: number, retentionDays: number): boolean {
  if (retentionDays <= 0) return false;
  return Date.now() - lastModified > retentionDays * 24 * 3600 * 1000;
}

/**
 * 增量扫描所有会话文件（不推进水位线——由调用方在消费成功后提交）。
 * lookbackDays 只作用于"从未见过的新文件"（mtime 过滤），已有水位线的文件不受影响。
 */
export async function scanSessions(settings: CollectSettings): Promise<ScanOutcome> {
  const roots = settings.scanRoots.length > 0 ? settings.scanRoots : await defaultScanRoots();
  const out: ScanOutcome = { freshEvents: [], files: 0, parseErrors: 0, skippedFiles: 0, pendingWatermarks: [] };
  if (roots.length === 0) return out;

  let sessions: AiSessionInfo[] = [];
  for (const root of roots) {
    try {
      const list = await invoke<AiSessionInfo[]>('ai_session_list', { roots: [root], lookbackDays: settings.lookbackDays });
      sessions = sessions.concat(list);
    } catch {
      // 单根失败（目录不存在等）不拖垮整体扫描
    }
  }

  const known = new Set<string>();
  for (const s of sessions) {
    if (known.has(s.file)) continue;
    known.add(s.file);
    const wm = await getWatermark(s.provider, s.file);
    if (wm === 0 && isOlderThanRetention(s.lastModified, settings.retentionDays)) {
      // 从未消费过且超保留期的老文件：整文件视为已消费（防每次重复判断），不出事件
      await setWatermark(s.provider, s.file, s.sizeBytes);
      out.skippedFiles++;
      continue;
    }
    if (wm >= s.sizeBytes) {
      out.skippedFiles++;
      continue;
    }
    try {
      const res = await invoke<AiParseResult>('ai_session_parse', { path: s.file, fromByte: wm });
      out.files++;
      out.parseErrors += res.parseErrors;
      out.freshEvents.push(...res.events);
      out.pendingWatermarks.push({ provider: s.provider, file: s.file, byteOffset: res.sizeBytes });
    } catch {
      // 单文件解析失败：水位线不推进，下次重试
    }
  }
  return out;
}

// ---------- 指纹 ----------

/** 事件指纹：sha256(provider|kind|ts|cwd|text)。crypto.subtle 异步。 */
export async function eventFingerprint(e: AiEvent): Promise<string> {
  const raw = `${e.provider}|${e.kind}|${e.ts}|${e.cwd}|${e.text}`;
  return sha256Hex(raw);
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Git 提交指纹：provider=git + hash（天然唯一） */
export async function commitFingerprint(hash: string): Promise<string> {
  return sha256Hex(`git|commit|${hash}`);
}

// ---------- cwd → 项目（最长前缀匹配） ----------

export interface ProjectResolver {
  /** cwd/仓库路径 → 项目；无匹配返回 null。repos 精确前缀优先，keywords 兜底 */
  resolve: (path: string) => Project | null;
}

export function makeResolver(projects: Project[], repos: { path: string; projectId: string | null }[]): ProjectResolver {
  // 仓库路径表：按路径长度降序，最长前缀优先
  const repoPaths = repos
    .filter((r) => r.projectId)
    .map((r) => ({ path: normalizePath(r.path), projectId: r.projectId as string }))
    .sort((a, b) => b.path.length - a.path.length);

  return {
    resolve(path: string): Project | null {
      const p = normalizePath(path);
      if (p) {
        for (const r of repoPaths) {
          if (p === r.path || p.startsWith(`${r.path}/`)) {
            const proj = projects.find((x) => x.id === r.projectId);
            if (proj) return proj;
          }
        }
      }
      // 关键词兜底：路径分段命中项目关键词
      const segs = p.split('/').filter(Boolean);
      for (const proj of projects) {
        if (!proj.isActive) continue;
        for (const kw of proj.keywords) {
          if (kw && segs.includes(kw)) return proj;
        }
      }
      return null;
    },
  };
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// ---------- 事件 → 引擎输入 ----------

/** 把新事件转成引擎输入（过滤已摄入指纹 + 解析项目归属） */
export async function toEngineInputs(
  events: AiEvent[],
  resolver: ProjectResolver,
): Promise<EngineInput[]> {
  const stamped = await Promise.all(
    events.map(async (e) => ({ e, fp: await eventFingerprint(e) })),
  );
  const ingested = await filterIngested(stamped.map((x) => x.fp));
  return stamped
    .filter((x) => !ingested.has(x.fp))
    .map(({ e, fp }) => ({
      fingerprint: fp,
      provider: (e.provider === 'codex' ? 'codex' : 'claude-code') as EngineInput['provider'],
      day: e.day,
      projectId: resolver.resolve(e.cwd)?.id ?? null,
      kind: e.kind,
      ts: e.ts,
      text: e.text,
      human: e.kind === 'human_prompt',
    }));
}
