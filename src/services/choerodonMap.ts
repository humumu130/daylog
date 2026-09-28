// P8·F1 项目映射建议：本地项目 ↔ 猪齿鱼远程项目的配对（规则优先、LLM 兜底精配）。
// 规则三路：keywords===远程 code（全等） / git 仓库路径尾段===远程 code / 名称归一化相等。
// 规则未命中 → 「待配」行（confidence 0），可送 LLM 精配或由用户在向导里手选。

import type { LlmConfig, Project } from '../types/models';
import type { RemoteProject } from './reporters/types';
import { generateReport } from './llm';
import { hasLlmApiKey } from './llmKey';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useProjectsStore } from '../stores/useProjectsStore';

export interface MapSuggestion {
  localProjectId: string;
  localName: string;
  remoteProjectId: string | null;
  remoteName: string | null;
  confidence: number;
  ruleBased: boolean;
  reason: string;
}

// ==================== 规则匹配（纯函数） ====================

/** 名称归一化：去首尾与内部空白、全小写、去掉结尾的「项目」后缀 */
function normalizeName(s: string): string {
  const t = s.trim().toLowerCase().replace(/\s+/g, '');
  return t.endsWith('项目') ? t.slice(0, -2) : t;
}

/** 仓库路径尾段（basename，去 .git 后缀，小写） */
function repoTail(path: string): string {
  const seg = path.trim().replace(/\/+$/, '').split(/[/\\]/).pop() ?? '';
  return seg.toLowerCase().replace(/\.git$/, '');
}

/**
 * 规则匹配：每个本地项目产出一条建议（命中=高置信 0.95；未命中=「待配」行 confidence 0）。
 * @param local 本地项目列表
 * @param remote 远程项目列表
 * @param repoPaths 本地项目 id → 该项目关联的 git 仓库路径（E1 git 特征；GitRepo.projectId 可组出此映射，可省略）
 */
export function ruleMatchProjects(
  local: Project[],
  remote: RemoteProject[],
  repoPaths: Record<string, string[]> = {},
): MapSuggestion[] {
  return local.map((p) => {
    const hit = (reason: string, r: RemoteProject): MapSuggestion => ({
      localProjectId: p.id,
      localName: p.name,
      remoteProjectId: r.id,
      remoteName: r.name,
      confidence: 0.95,
      ruleBased: true,
      reason,
    });
    const miss = (): MapSuggestion => ({
      localProjectId: p.id,
      localName: p.name,
      remoteProjectId: null,
      remoteName: null,
      confidence: 0,
      ruleBased: false,
      reason: '未找到可自动匹配的远程项目，待人工或 LLM 配对',
    });

    // 规则一：远程 code 与本地 keywords 任一全等（大小写不敏感）
    const kws = p.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
    const byKeyword = remote.find((r) => r.code.trim() !== '' && kws.includes(r.code.trim().toLowerCase()));
    if (byKeyword) return hit(`关键词与远程编码 ${byKeyword.code} 全等`, byKeyword);

    // 规则二：git remote 特征——本地项目仓库路径尾段 === 远程 code（大小写不敏感）
    const tails = (repoPaths[p.id] ?? []).map(repoTail).filter(Boolean);
    const byRepo = remote.find((r) => r.code.trim() !== '' && tails.includes(r.code.trim().toLowerCase()));
    if (byRepo) return hit(`git 仓库名与远程编码 ${byRepo.code} 一致`, byRepo);

    // 规则三：名称归一化相等（去空格/全小写/去「项目」后缀）
    const nName = normalizeName(p.name);
    if (nName) {
      const byName = remote.find((r) => normalizeName(r.name) === nName || normalizeName(r.code) === nName);
      if (byName) return hit(`本地名称与远程 ${byName.name} 归一化后一致`, byName);
    }

    return miss();
  });
}

// ==================== LLM 精配 ====================

function extractJsonArray(text: string): string {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) throw new Error('LLM 未返回有效 JSON');
  return text.slice(start, end + 1);
}

/** LLM 是否可用：claude-code 本地通道，或云端通道配齐 baseUrl + key（内联或 keychain） */
async function llmReady(llm: LlmConfig): Promise<boolean> {
  if (llm.kind === 'claude-code') return true;
  if (!(llm.baseUrl ?? '').trim()) return false;
  return hasLlmApiKey(llm);
}

/**
 * 把规则未命中的「待配」行送 LLM 精配。
 * 返回 LLM 给出的映射建议（ruleBased=false）；无 LLM key 直接返回空数组。
 * 载荷经 generateReport 脱敏总线统一处理，此处不做脱敏。
 */
export async function llmMatchProjects(
  rows: MapSuggestion[],
  remote: RemoteProject[],
  llm: LlmConfig,
): Promise<MapSuggestion[]> {
  const pending = rows.filter((r) => r.remoteProjectId === null);
  if (pending.length === 0 || remote.length === 0) return [];
  if (!(await llmReady(llm))) return [];

  const localText = pending.map((r) => `- ${r.localProjectId} ${r.localName}`).join('\n');
  const remoteText = remote.map((r) => `- ${r.id} ${r.name}（编码 ${r.code}）`).join('\n');
  const system =
    '你是项目映射助手。把本地项目与远程项目管理平台的项目配对。宁空勿错：仅当名称/编码语义高度相关才给映射，' +
    '不确定的不出现在结果里。输出 JSON 数组 [{localProjectId, remoteProjectId, confidence, reason}]，' +
    'confidence 为 0~1 的小数，reason 用一句中文说明匹配依据。只输出 JSON。';
  const user =
    `【本地项目（id 名称）】\n${localText}\n\n【远程项目（id 名称（编码））】\n${remoteText}\n\n` +
    '请给出高把握的配对结果（可为空数组）。';

  const text = await generateReport(llm, system, user);
  const arr = JSON.parse(extractJsonArray(text)) as {
    localProjectId?: string;
    remoteProjectId?: string;
    confidence?: number;
    reason?: string;
  }[];
  if (!Array.isArray(arr)) return [];

  const pendingById = new Map(pending.map((r) => [r.localProjectId, r]));
  const remoteById = new Map(remote.map((r) => [r.id, r]));
  const out: MapSuggestion[] = [];
  for (const m of arr) {
    if (!m || typeof m.localProjectId !== 'string' || typeof m.remoteProjectId !== 'string') continue;
    const row = pendingById.get(m.localProjectId);
    const r = remoteById.get(m.remoteProjectId);
    // 只接受「待配行 + 远程确实存在」的映射，LLM 幻觉 id 直接丢弃
    if (!row || !r) continue;
    const conf = typeof m.confidence === 'number' && Number.isFinite(m.confidence) ? Math.min(Math.max(m.confidence, 0), 1) : 0.5;
    out.push({
      localProjectId: row.localProjectId,
      localName: row.localName,
      remoteProjectId: r.id,
      remoteName: r.name,
      confidence: conf,
      ruleBased: false,
      reason: typeof m.reason === 'string' && m.reason ? m.reason : 'LLM 语义匹配',
    });
  }
  return out;
}

// ==================== 落库 ====================

/** 合并写入 settings.choerodon.projectMap（本地项目 id → 远程项目 id） */
export async function applyProjectMap(matches: { localProjectId: string; remoteProjectId: string }[]): Promise<void> {
  const { settings, patch } = useSettingsStore.getState();
  const ch = settings.choerodon;
  if (!ch) throw new Error('猪齿鱼未配置：请先在设置页完成连接后再应用映射');
  const merged = { ...ch.projectMap };
  for (const m of matches) merged[m.localProjectId] = m.remoteProjectId;
  await patch({ choerodon: { ...ch, projectMap: merged } });
}

/** E2 规则库：把远程项目 code 追加进本地项目 keywords（去重），下次规则匹配即可命中 */
export async function rememberRule(localProjectId: string, code: string): Promise<void> {
  const { projects, update } = useProjectsStore.getState();
  const p = projects.find((x) => x.id === localProjectId);
  if (!p) throw new Error(`本地项目不存在（${localProjectId}），无法记忆匹配规则`);
  const kw = code.trim();
  if (!kw) return;
  const keywords = p.keywords.includes(kw) ? p.keywords : [...p.keywords, kw];
  // update 是全量 ProjectInput（db.updateProject 签名），需带回原有字段
  await update(localProjectId, {
    name: p.name,
    color: p.color,
    keywords,
    isActive: p.isActive,
    sortOrder: p.sortOrder,
  });
}

// ==================== 健康检查 ====================

/** 映射健康：本地活跃项目无映射 → warnings；映射指向的远程 id 已不存在 → broken */
export function mapHealth(
  local: Project[],
  remote: RemoteProject[],
  projectMap: Record<string, string>,
): {
  warnings: { localProjectId: string; name: string }[];
  broken: { localProjectId: string; remoteId: string; name: string }[];
} {
  const remoteIds = new Set(remote.map((r) => r.id));
  const warnings: { localProjectId: string; name: string }[] = [];
  const broken: { localProjectId: string; remoteId: string; name: string }[] = [];
  for (const p of local) {
    const mapped = projectMap[p.id];
    if (mapped === undefined || mapped === '') {
      if (p.isActive) warnings.push({ localProjectId: p.id, name: p.name });
    } else if (!remoteIds.has(mapped)) {
      broken.push({ localProjectId: p.id, remoteId: mapped, name: p.name });
    }
  }
  return { warnings, broken };
}
