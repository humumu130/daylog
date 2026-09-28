// 个人空间 Obsidian 每日导出（P8b·B 路）：兼容旧 worklog-hook.cjs 标记区协议
// （frontmatter + Summary 区 + raw callout）。renderDayMarkdown 纯函数负责格式，
// exportDay / exportRange 组合它做文件读写（fs 走 invoke，与 backup.ts 同机制）。

import { invoke } from '@tauri-apps/api/core';
import { listProjects, listRecordsByDay, listRecordsByRange } from './db';
import { useSettingsStore } from '../stores/useSettingsStore';
import { RECORD_TYPE_LABELS } from '../types/models';
import type { Project, WorkRecord } from '../types/models';

/** 读配置的 Obsidian 库路径；未配置抛错（空串/纯空白都算未配置） */
function requireObsidianDir(): string {
  const dir = (useSettingsStore.getState().settings.obsidianDir ?? '').trim().replace(/[\\/]+$/, '');
  if (!dir) throw new Error('未配置 Obsidian 库路径（请在设置中填写 Obsidian 库路径）');
  return dir;
}

/** 分钟 → 小时字面量（90→'1.5'、60→'1'、45→'0.75'） */
function fmtHours(min: number): string {
  const h = min / 60;
  return Number.isInteger(h) ? String(h) : String(Math.round(h * 100) / 100);
}

/** createdAt（ms）→ 本地 'HH:mm'，作条目时间戳 */
function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Summary 行：`- [HH:mm] （类型标签）内容（1.5h）`；无时长省略尾括号；内容折成单行 */
function summaryLine(r: WorkRecord): string {
  const label = RECORD_TYPE_LABELS[r.recordType] ?? r.recordType;
  const content = r.content.replace(/\r?\n/g, ' ');
  const dur = typeof r.durationMin === 'number' ? `（${fmtHours(r.durationMin)}h）` : '';
  return `- [${fmtClock(r.createdAt)}] （${label}）${content}${dur}`;
}

/** 纯函数：一天记录 → Markdown（不碰 IO）。day 取自首条记录；空记录渲染骨架（无 date 行） */
export function renderDayMarkdown(records: WorkRecord[], projects: Project[]): string {
  const nameOf = new Map(projects.map((p) => [p.id, p.name]));
  const day = records[0]?.day ?? null;

  // 当日涉及的项目名（按首次出现序，供 Obsidian 元数据/检索）
  const touched: string[] = [];
  for (const r of records) {
    const n = r.projectId ? nameOf.get(r.projectId) : undefined;
    if (n && !touched.includes(n)) touched.push(n);
  }

  const frontmatter = ['---', 'source: daylog'];
  if (day) frontmatter.push(`date: ${day}`);
  if (touched.length > 0) frontmatter.push(`projects: [${touched.map((n) => `"${n}"`).join(', ')}]`);
  frontmatter.push('---');

  // learnings 展开去重（保序，跳过空串）
  const seen = new Set<string>();
  const learnings: string[] = [];
  for (const r of records) {
    for (const l of r.learnings ?? []) {
      const key = l.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      learnings.push(l);
    }
  }

  const parts: string[] = [frontmatter.join('\n'), '', '## Summary', ''];
  for (const r of records) parts.push(summaryLine(r));

  if (learnings.length > 0) {
    parts.push('', '## Learnings', '', ...learnings.map((l) => `- ${l}`));
  }

  // 尾部 raw callout（旧 hook 标记区协议，保留原文字面；多行内容逐行带 > 前缀留在块内）
  parts.push('', '> [!record] 原始记录');
  for (const r of records) {
    const lines = r.content.split(/\r?\n/);
    parts.push(`> - ${lines[0]}`);
    for (const extra of lines.slice(1)) parts.push(`> ${extra}`);
  }

  return parts.join('\n') + '\n';
}

/** 合并追加：已有文件只把「文件中尚未出现」的新条目以「## 补充 HH:mm」段追加到文末；
 *  全部已存在 → null（幂等跳过，不动用户手工内容） */
function appendSupplement(prev: string, records: WorkRecord[]): string | null {
  const fresh = records.filter((r) => !prev.includes(r.content));
  if (fresh.length === 0) return null;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const lines = ['', `## 补充 ${hhmm}`, ''];
  for (const r of fresh) lines.push(summaryLine(r));
  return `${prev.replace(/\n+$/, '')}\n${lines.join('\n')}\n`;
}

/** 单日落盘：新文件整篇渲染；已有文件合并追加。返回写入的路径，幂等跳过返回 null */
async function writeDayFile(dir: string, day: string, records: WorkRecord[], projects: Project[]): Promise<string | null> {
  const recordDir = `${dir}/record`;
  await invoke('plugin:fs|mkdir', { path: recordDir, recursive: true });
  const path = `${recordDir}/${day}.md`;
  const exists = await invoke<boolean>('plugin:fs|exists', { path });
  let contents: string;
  if (!exists) {
    contents = renderDayMarkdown(records, projects);
  } else {
    const prev = await invoke<string>('plugin:fs|read_text_file', { path });
    const merged = appendSupplement(prev, records);
    if (merged === null) return null;
    contents = merged;
  }
  await invoke('plugin:fs|write_text_file', { path, contents });
  return path;
}

/** 导出单日：返回写入的文件绝对路径；未配置目录 / 该日无记录抛错 */
export async function exportDay(day: string, wsId: string): Promise<string> {
  const dir = requireObsidianDir();
  const [records, projects] = await Promise.all([listRecordsByDay(day, wsId), listProjects(wsId)]);
  if (records.length === 0) throw new Error(`${day} 无记录，未导出`);
  const wrote = await writeDayFile(dir, day, records, projects);
  return wrote ?? `${dir}/record/${day}.md`; // 幂等跳过时文件已存在，路径照常返回
}

/** 导出区间：按天分组落盘（无记录的天跳过），files=实际写入/追加的天数 */
export async function exportRange(from: string, to: string, wsId: string): Promise<{ files: number; dir: string }> {
  const dir = requireObsidianDir();
  const [records, projects] = await Promise.all([listRecordsByRange(from, to, wsId), listProjects(wsId)]);
  const byDay = new Map<string, WorkRecord[]>();
  for (const r of records) {
    const list = byDay.get(r.day) ?? [];
    list.push(r);
    byDay.set(r.day, list);
  }
  let files = 0;
  for (const [day, list] of byDay) {
    const wrote = await writeDayFile(dir, day, list, projects);
    if (wrote !== null) files += 1;
  }
  return { files, dir };
}
