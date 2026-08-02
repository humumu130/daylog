import type { Project, Task } from '../types/models';
import { addDays, formatYMD, todayYMD } from './date';

export interface ParsedEntry {
  content: string;
  durationMin: number | null;
  projectId: string | null;
  taskId: string | null;
  day: string | null; // 推断出的日期（如"昨天"→昨天），null=用当前选定日期
  raw: string;
}

interface ParseContext {
  projects: Project[];
  tasks: Task[];
}

const HOURS_RE = /(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?|小时)/gi;
const MINS_RE = /(\d+)\s*(?:m|min|mins|minutes?|分钟)/gi;
const PROJECT_RE = /#([^\s#@;；、]+)/g;
const TASK_RE = /@([^\s#@;；、]+)/g;

function matchProject(name: string, projects: Project[]): Project | undefined {
  const n = name.toLowerCase().trim();
  if (!n) return undefined;
  return (
    projects.find((p) => p.name.toLowerCase() === n) ??
    projects.find((p) => p.keywords.some((k) => k.toLowerCase() === n))
  );
}

function matchTask(name: string, tasks: Task[]): Task | undefined {
  const n = name.toLowerCase().trim();
  if (!n) return undefined;
  return (
    tasks.find((t) => t.title.toLowerCase() === n) ??
    tasks.find((t) => {
      const tt = t.title.toLowerCase();
      return tt.includes(n) || n.includes(tt);
    })
  );
}

/** 内容里出现项目名或关键词则自动归属（取最长匹配） */
export function matchProjectForContent(content: string, projects: Project[]): Project | undefined {
  const c = content.toLowerCase();
  let best: { p: Project; len: number } | undefined;
  for (const p of projects) {
    if (!p.isActive) continue;
    const candidates = [p.name, ...p.keywords].map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 2);
    for (const cand of candidates) {
      if (c.includes(cand) && (!best || cand.length > best.len)) {
        best = { p, len: cand.length };
      }
    }
  }
  return best?.p;
}

/** 解析日期关键词：昨天/前天/X号/X月X日 → 返回日期 + 需移除的文本段 */
function matchDate(text: string): { day: string | null; spans: Array<[number, number]> } {
  const today = todayYMD();
  // 大前天/前天/昨天（长的先匹配）
  for (const [kw, delta] of [['大前天', -3], ['前天', -2], ['昨天', -1]] as const) {
    const idx = text.indexOf(kw);
    if (idx >= 0) {
      return { day: addDays(today, delta), spans: [[idx, idx + kw.length]] };
    }
  }
  // X月X日 / X月X号
  const md = text.match(/(\d{1,2})月(\d{1,2})[号日]?/);
  if (md && md.index !== undefined) {
    const mo = parseInt(md[1], 10);
    const d = parseInt(md[2], 10);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const y = new Date().getFullYear();
      return { day: formatYMD(new Date(y, mo - 1, d)), spans: [[md.index, md.index + md[0].length]] };
    }
  }
  // X号 / X日（当月）
  const dMatch = text.match(/(?:^|[^\d])(\d{1,2})[号日](?!\d)/);
  if (dMatch && dMatch.index !== undefined) {
    const d = parseInt(dMatch[1], 10);
    const digitStart = dMatch.index + (dMatch[0].length - dMatch[1].length - 1);
    if (d >= 1 && d <= 31) {
      const now = new Date();
      return { day: formatYMD(new Date(now.getFullYear(), now.getMonth(), d)), spans: [[digitStart, digitStart + dMatch[1].length + 1]] };
    }
  }
  return { day: null, spans: [] };
}

function removeSpans(text: string, spans: Array<[number, number]>): string {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let result = '';
  let last = 0;
  for (const [s, e] of sorted) {
    if (s < last) continue;
    result += text.slice(last, s);
    last = Math.max(last, e);
  }
  result += text.slice(last);
  return result.replace(/\s{2,}/g, ' ').trim();
}

/** 解析单条文本 */
export function parseEntry(raw: string, ctx: ParseContext): ParsedEntry {
  const text = raw.trim();
  const spans: Array<[number, number]> = [];
  let durationMin = 0;
  let hasDur = false;

  for (const m of text.matchAll(HOURS_RE)) {
    if (m.index === undefined) continue;
    durationMin += parseFloat(m[1]) * 60;
    hasDur = true;
    spans.push([m.index, m.index + m[0].length]);
  }
  for (const m of text.matchAll(MINS_RE)) {
    if (m.index === undefined) continue;
    durationMin += parseInt(m[1], 10);
    hasDur = true;
    spans.push([m.index, m.index + m[0].length]);
  }

  let projectId: string | null = null;
  for (const m of text.matchAll(PROJECT_RE)) {
    if (m.index === undefined) continue;
    spans.push([m.index, m.index + m[0].length]);
    if (!projectId) {
      const p = matchProject(m[1], ctx.projects);
      if (p) projectId = p.id;
    }
  }

  let taskId: string | null = null;
  for (const m of text.matchAll(TASK_RE)) {
    if (m.index === undefined) continue;
    spans.push([m.index, m.index + m[0].length]);
    if (!taskId) {
      const t = matchTask(m[1], ctx.tasks);
      if (t) taskId = t.id;
    }
  }

  // 日期关键词
  const dateResult = matchDate(text);
  spans.push(...dateResult.spans);

  const content = removeSpans(text, spans);

  // 关键词自动匹配项目
  let finalProjectId = projectId;
  if (!finalProjectId) {
    const p = matchProjectForContent(content, ctx.projects);
    if (p) finalProjectId = p.id;
  }

  return {
    content,
    durationMin: hasDur ? Math.round(durationMin) : null,
    projectId: finalProjectId,
    taskId,
    day: dateResult.day,
    raw,
  };
}

/** 一行多条：按 ; ； 换行拆分 */
export function splitEntries(raw: string): string[] {
  return raw.split(/[;；\n]/).map((s) => s.trim()).filter(Boolean);
}

/** 解析可能含多条的输入 */
export function parseEntries(raw: string, ctx: ParseContext): ParsedEntry[] {
  return splitEntries(raw).map((s) => parseEntry(s, ctx));
}
