// F2 未映射 cwd 建议 hook（P6，P8b 补持久）：
// ai_session_cwds 取清单 → resolver 滤已映射 → ruleSuggestCwds 规则初筛 → llmRefineCwds 语义精配
// → SuggestionRow[]（供 SuggestionList 审核后 apply 写回 repos/新建项目）。
// 输出由采集中心消费（CollectPage），本 hook 不依赖任何页面。
// 忽略记忆（suggestionsDismissed）持久在 settings.collect，跨会话不再打扰。

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { makeResolver, type CwdSummary } from '../../services/collector';
import { llmRefineCwds, ruleSuggestCwds, type Suggestion } from '../../services/configSuggest';
import { hasLlmApiKey } from '../../services/llmKey';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import type { GitRepo, Project } from '../../types/models';
import type { SuggestionRow } from '../components/SuggestionList';

/** targetOptions 里的「新建项目」哨兵值 */
export const NEW_TARGET = '__new__';
/** ignore 建议的固定目标 */
export const IGNORE_TARGET = '__ignore__';

const LOOKBACK_DAYS = 30;

function providerLabel(p: string): string {
  if (p === 'claude-code') return 'Claude Code';
  if (p === 'codex') return 'Codex';
  if (p === 'multi') return 'Claude Code + Codex';
  return p || '未知来源';
}

/** 同一 cwd 聚合（claude-code 多分支 / 双 provider 会拆成多行 CwdSummary，展示与建议按目录合并） */
function dedupeByCwd(cwds: CwdSummary[]): CwdSummary[] {
  const m = new Map<string, CwdSummary>();
  for (const c of cwds) {
    const key = c.cwd.replace(/\/+$/, '').toLowerCase();
    const prev = m.get(key);
    if (!prev) {
      m.set(key, { ...c });
    } else {
      m.set(key, {
        ...prev,
        provider: prev.provider === c.provider ? prev.provider : 'multi',
        sessions: prev.sessions + c.sessions,
        lastTs: Math.max(prev.lastTs ?? 0, c.lastTs ?? 0) || null,
      });
    }
  }
  return [...m.values()];
}

function toRow(s: Suggestion, c: CwdSummary, projects: Project[]): SuggestionRow {
  const detailParts = [providerLabel(c.provider)];
  if (c.gitBranch) detailParts.push(`分支 ${c.gitBranch}`);
  if (s.reason) detailParts.push(s.reason);
  const targetOptions =
    s.kind === 'ignore'
      ? [{ id: IGNORE_TARGET, label: '忽略' }]
      : [...projects.map((p) => ({ id: p.id, label: p.name })), { id: NEW_TARGET, label: '新建项目…' }];
  const targetId =
    s.kind === 'ignore'
      ? IGNORE_TARGET
      : s.kind === 'new-project'
        ? NEW_TARGET
        : s.targetId || projects[0]?.id || NEW_TARGET;
  return {
    id: s.id,
    summary: s.source,
    detail: detailParts.join(' · '),
    confidence: s.confidence,
    ruleBased: s.ruleBased,
    kind: s.kind,
    targetOptions,
    targetId,
  };
}

/** cwd 尾段（新项目名兜底） */
function baseName(p: string): string {
  return p.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? p;
}

export function useCwdSuggestions(): {
  rows: SuggestionRow[]; // 已滤除 dismissed（会话内 Set）
  loading: boolean;
  degraded: boolean; // 规则模式（无 LLM key 且非 claude-code 通道）
  error: string | null;
  reload: () => void;
  dismiss: (id: string) => void;
  setTarget: (id: string, targetId: string) => void; // 直连 SuggestionList.onTargetChange（契约外的补全）
  apply: (rows: SuggestionRow[]) => Promise<void>; // 写回映射并刷新
} {
  const [rows, setRows] = useState<SuggestionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // 响应式依赖：项目 / 仓库映射 / LLM 配置变化后自动重算（apply 改 repos 也会走到这里）
  const projects = useProjectsStore((s) => s.projects);
  const repos = useSettingsStore((s) => s.settings.repos);
  const llm = useSettingsStore((s) => s.settings.llm);
  const dismissedSetting = useSettingsStore((s) => s.settings.collect.suggestionsDismissed ?? []);

  const dismissed = useRef<Set<string>>(new Set(dismissedSetting));
  useEffect(() => {
    dismissed.current = new Set(dismissedSetting);
  }, [dismissedSetting]);

  /** 忽略持久化（settings.collect.suggestionsDismissed，跨会话不再打扰） */
  const persistDismiss = useCallback((id: string) => {
    const { settings, patch } = useSettingsStore.getState();
    const cur = settings.collect.suggestionsDismissed ?? [];
    if (cur.includes(id)) return;
    void patch({ collect: { ...settings.collect, suggestionsDismissed: [...cur, id] } });
  }, []);
  /** id → 用户手改的目标（跨 reload 保留，直连 SuggestionList.onTargetChange） */
  const targetOverrides = useRef<Map<string, string>>(new Map());
  /** id → 原始 Suggestion（apply 时取 new-project 建议名等原始信息） */
  const sugById = useRef<Map<string, Suggestion>>(new Map());
  /** id → cwd 摘要（apply 时取规范 cwd 路径） */
  const cwdById = useRef<Map<string, CwdSummary>>(new Map());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let stale = false; // deps 再变时旧一轮不回填
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const all = await invoke<CwdSummary[]>('ai_session_cwds', { lookbackDays: LOOKBACK_DAYS });
        const cwds = dedupeByCwd(all);
        // 只留 resolve 不到项目的 cwd（codex 行 gitBranch 恒 null：resolver 纯按路径判，同判无分支特例）
        const resolver = makeResolver(projects, repos);
        const unmatched = cwds.filter((c) => resolver.resolve(c.cwd) === null);
        // 已有 repo 映射的路径不再进规则初筛（ruleSuggestCwds 内部还会再挡一次）
        const knownPaths = repos.filter((r) => r.projectId).map((r) => r.path);
        const ruleHits = ruleSuggestCwds(unmatched, projects, knownPaths);
        const hitIds = new Set(ruleHits.map((s) => s.id));
        const rest = unmatched.filter((c) => !hitIds.has(`cwd:${c.cwd}`));

        // LLM 语义精配：有 key（云端内联/keychain 或 claude-code 本地通道）才真正出网；
        // 无 key 时 llmRefineCwds 内部走规则兜底（ruleBased 低置信 new-project），degraded=true
        const hasLlmKey = llm.kind === 'claude-code' || (Boolean(llm.baseUrl) && (await hasLlmApiKey(llm)));
        let refined: Suggestion[] = [];
        if (rest.length > 0) {
          try {
            refined = await llmRefineCwds(rest, projects, llm, hasLlmKey);
          } catch (e) {
            // LLM 精配失败：规则结果照常出，失败原因透出（不冒充语义匹配）
            if (!stale) setError(e instanceof Error ? e.message : String(e));
          }
        }

        if (stale || !mounted.current) return;
        setDegraded(!hasLlmKey);
        const cwdMap = new Map(cwds.map((c) => [`cwd:${c.cwd}`, c]));
        const byId = new Map<string, Suggestion>();
        for (const s of [...ruleHits, ...refined]) {
          if (!byId.has(s.id)) byId.set(s.id, s); // 规则优先，LLM 结果去重
        }
        sugById.current = byId;
        cwdById.current = cwdMap;
        const fallback = (s: Suggestion): CwdSummary => ({
          provider: '',
          cwd: s.source,
          gitBranch: null,
          sessions: 0,
          lastTs: null,
        });
        setRows(
          [...byId.values()]
            .filter((s) => !dismissed.current.has(s.id))
            .map((s) => {
              const row = toRow(s, cwdMap.get(s.id) ?? fallback(s), projects);
              const ov = targetOverrides.current.get(s.id);
              return ov ? { ...row, targetId: ov } : row;
            }),
        );
      } catch (e) {
        if (stale || !mounted.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setRows([]);
      } finally {
        if (!stale && mounted.current) setLoading(false);
      }
    };
    void run();
    return () => {
      stale = true;
    };
    // llm 只依赖三个原始字段（settings 对象身份变化不误触发重算）；
    // keychain 侧 key 变化不在此响应（设置页保存后返回时 reload 兜底）
  }, [tick, projects, repos, llm.kind, llm.baseUrl, llm.apiKey]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  /** 忽略单条：本地即时生效 + 持久记忆（不再打扰） */
  const dismiss = useCallback((id: string) => {
    dismissed.current.add(id);
    persistDismiss(id);
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, [persistDismiss]);

  /** 行内改目标（直连 SuggestionList.onTargetChange；会话内跨 reload 保留） */
  const setTarget = useCallback((id: string, targetId: string) => {
    targetOverrides.current.set(id, targetId);
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, targetId } : r)));
  }, []);

  /**
   * 应用勾选建议：
   * - map-project / 目标为现有项目 → 写 repos 映射（同路径旧条目先清）
   * - new-project（目标 __new__）→ 先建项目再写 repos
   * - ignore → 仅会话内 dismiss
   * 完成后自动 reload（repos 变更本身也会触发重算，ignore-only 场景靠 tick）
   */
  const apply = useCallback(async (selected: SuggestionRow[]) => {
    if (selected.length === 0) return;
    const { settings, patch } = useSettingsStore.getState();
    let reposNext: GitRepo[] = settings.repos;
    let reposChanged = false;
    const norm = (p: string) => p.replace(/\/+$/, '').toLowerCase();
    for (const row of selected) {
      if (row.kind === 'ignore' || row.targetId === IGNORE_TARGET) {
        dismissed.current.add(row.id);
        persistDismiss(row.id);
        continue;
      }
      const cwd =
        cwdById.current.get(row.id)?.cwd ?? sugById.current.get(row.id)?.source ?? row.summary;
      let projectId = row.targetId;
      if (projectId === NEW_TARGET) {
        const sug = sugById.current.get(row.id);
        const name =
          sug && sug.kind === 'new-project' && sug.targetName ? sug.targetName : baseName(cwd);
        projectId = await useProjectsStore.getState().create({
          name,
          color: '#0078d4',
          keywords: [],
          isActive: true,
          sortOrder: useProjectsStore.getState().projects.length,
        });
      }
      if (!projectId) continue;
      reposNext = [
        ...reposNext.filter((r) => norm(r.path) !== norm(cwd)),
        { id: crypto.randomUUID(), path: cwd, projectId, author: '' },
      ];
      reposChanged = true;
    }
    if (reposChanged) await patch({ repos: reposNext });
    setTick((t) => t + 1);
  }, [persistDismiss]);

  return { rows, loading, degraded, error, reload, dismiss, setTarget, apply };
}
