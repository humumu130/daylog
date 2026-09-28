// 配置建议（P5 骨架，P6 F2 完整落地）：规则初筛（确定性高置信）→ LLM 语义精配
// （带 confidence）→ SuggestionList 审核 → 一键应用。无 LLM key 时初筛独立生效，
// UI 显「规则模式」降级徽标——透明降级，不冒充 AI 判定。
// F1（猪齿鱼映射）与 F2（cwd 归组）共用本模型。

import type { LlmConfig, Project } from '../types/models';
import { invoke } from '@tauri-apps/api/core';
import { generateReport } from './llm';
import type { CwdSummary, DiscoveredRepo } from './collector/types';

export type SuggestKind = 'map-project' | 'new-project' | 'ignore';

export interface Suggestion {
  id: string;
  kind: SuggestKind;
  /** 待归组对象（cwd 或仓库路径） */
  source: string;
  /** 建议目标：map-project=项目 id；new-project=建议项目名；ignore=空 */
  targetId: string;
  targetName: string;
  confidence: number; // 0~1；≥0.85 视为高置信（默认勾选）
  reason: string;
  /** 规则模式产生（未经 LLM） */
  ruleBased: boolean;
}

const HIGH = 0.85;

/** F2 第一步：cwd 清单规则初筛（路径分段精确命中项目名/关键词=高置信） */
export function ruleSuggestCwds(cwds: CwdSummary[], projects: Project[], knownRepoPaths: string[]): Suggestion[] {
  const out: Suggestion[] = [];
  const known = new Set(knownRepoPaths.map((p) => p.replace(/\/+$/, '').toLowerCase()));
  for (const c of cwds) {
    const path = c.cwd.replace(/\/+$/, '');
    if (known.has(path.toLowerCase())) continue; // 已映射，不打扰
    const segs = path.toLowerCase().split('/').filter(Boolean);
    const hit = projects.find(
      (p) => p.isActive && (segs.includes(p.name.toLowerCase()) || p.keywords.some((k) => k && segs.includes(k.toLowerCase()))),
    );
    if (hit) {
      out.push({
        id: `cwd:${c.cwd}`,
        kind: 'map-project',
        source: c.cwd,
        targetId: hit.id,
        targetName: hit.name,
        confidence: HIGH,
        reason: `路径分段与项目「${hit.name}」名称/关键词精确命中（${c.sessions} 个会话）`,
        ruleBased: true,
      });
    }
    // 未命中的留给 LLM 精配或人工认领（P6 未映射面板）
  }
  return out;
}

/** F2 第二步：LLM 语义精配（低置信 cwd → 归现有/建新/忽略 三态建议） */
export async function llmRefineCwds(unmatched: CwdSummary[], projects: Project[], llm: LlmConfig, hasLlmKey: boolean): Promise<Suggestion[]> {
  if (unmatched.length === 0) return [];
  // 规则模式：目录名兜底建议（低置信，仅 new-project 提示可建）
  if (!hasLlmKey) {
    return unmatched.map((c) => {
      const name = c.cwd.split('/').filter(Boolean).pop() ?? c.cwd;
      return {
        id: `cwd:${c.cwd}`,
        kind: 'new-project',
        source: c.cwd,
        targetId: '',
        targetName: name,
        confidence: 0.5,
        reason: '规则模式：按目录名建议新建（未配 LLM，可在设置配置后获得语义匹配）',
        ruleBased: true,
      };
    });
  }
  const lines = unmatched.map((c) => `- ${c.cwd}${c.gitBranch ? `（分支 ${c.gitBranch}）` : ''}`).join('\n');
  const projList = projects.map((p) => `- ${p.name}（关键词：${p.keywords.join('/') || '无'}）`).join('\n');
  const system =
    '你是项目归组助手。给每个未映射的工作目录建议归属：归入已有项目 / 新建项目 / 忽略（临时目录/系统目录）。' +
    '宁空勿错：不确定就给 ignore。只输出 JSON。';
  const user =
    `已有项目：\n${projList}\n\n未映射目录：\n${lines}\n\n` +
    '输出 JSON 数组：[{"cwd":"...","kind":"map-project|new-project|ignore","project":"项目名或新名","confidence":0.9,"reason":"..."}]';
  const text = await generateReport(llm, system, user);
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  let parsed: { cwd?: string; kind?: string; project?: string; confidence?: number; reason?: string }[] = [];
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const out: Suggestion[] = [];
  for (const p of parsed) {
    if (!p?.cwd) continue;
    const kind: SuggestKind = p.kind === 'map-project' ? 'map-project' : p.kind === 'new-project' ? 'new-project' : 'ignore';
    const proj = kind === 'map-project' ? projects.find((x) => x.name === p.project) : undefined;
    out.push({
      id: `cwd:${p.cwd}`,
      kind: proj ? 'map-project' : kind === 'map-project' ? 'ignore' : kind,
      source: p.cwd,
      targetId: proj?.id ?? '',
      targetName: kind === 'new-project' ? (p.project ?? '') : (proj?.name ?? ''),
      confidence: Math.max(0, Math.min(1, Number(p.confidence) || 0)),
      reason: p.reason ?? '',
      ruleBased: false,
    });
  }
  return out;
}

/** 发现仓库（P6 F2 扫描根候选）：thin wrapper on Rust discover_repos */
export async function discoverRepos(roots: string[], maxDepth = 4): Promise<DiscoveredRepo[]> {
  try {
    return await invoke<DiscoveredRepo[]>('discover_repos', { roots, maxDepth });
  } catch {
    return [];
  }
}
