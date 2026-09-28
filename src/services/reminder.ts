import { invoke } from '@tauri-apps/api/core';
import { listRecordsByDay } from './db';
import { notify } from './notification';
import { showQuickCapture } from './window';
import { defaultScanRoots } from './collector';
import { todayYMD } from '../utils/date';
import type { AppSettings } from '../types/models';

let timer: ReturnType<typeof setInterval> | null = null;
let lastRemindDay = ''; // 同一天只提醒一次（进程内）
let emptyDayReminded = false; // E5 空白天哨兵：每应用会话最多提醒一次

function parseHM(hm: string | undefined | null): number | null {
  if (typeof hm !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

async function tick(settings: AppSettings): Promise<void> {
  const target = parseHM(settings.remindTime);
  if (target === null) return; // 关闭或非法时间
  const today = todayYMD();
  if (lastRemindDay === today) return; // 今天已处理（提醒过 或 已达标）

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (nowMin < target) return; // 还没到点

  try {
    const records = await listRecordsByDay(today);
    const total = records.reduce((s, r) => s + (r.durationMin ?? 0), 0);
    if (total >= settings.remindMinMinutes) {
      lastRemindDay = today; // 已达标，今天不再轮询打扰
      return;
    }

    const hours = (settings.remindMinMinutes / 60).toFixed(1);
    const have = (total / 60).toFixed(1);
    await notify(
      '今日工作日志该补啦 📝',
      `今天只记了约 ${have}h，离 ${hours}h 还差一点。点开快速记录，随手补几笔？`,
    );
    lastRemindDay = today;
    // 通知后顺手把快速记录弹出来，方便补记（不阻塞）
    void showQuickCapture().catch(() => undefined);
  } catch {
    // 提醒失败不影响主流程
  }
}

/**
 * E5 空白天哨兵：「当天有 AI 会话活动、但日志为空」→ 提醒补扫。
 * 只在 18:00 之后触发（避免早上刚开工就催）；每应用会话最多提醒一次。
 * 与下班提醒共用同一轮询（不新建定时器），独立于 remindTime 开关。
 */
async function tickEmptyDay(settings: AppSettings): Promise<void> {
  if (emptyDayReminded) return;
  if (!settings.collect.enabled) return; // 采集关着就别劝补扫
  const now = new Date();
  if (now.getHours() < 18) return;

  const today = todayYMD();
  try {
    const records = await listRecordsByDay(today);
    if (records.length > 0) return; // 已有日志（含手写），不提醒

    // 活动判定：默认扫描根下近 1 天有会话文件，且确有"当天"的活动痕迹
    // （文件 mtime 或尾部事件时间戳落在今天本地零点之后——只看非空会把昨晚活动误算成今天）
    const roots = await defaultScanRoots();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    let hasActivity = false;
    for (const root of roots) {
      try {
        const list = await invoke<{ lastModified: number; lastEventTs: number | null }[]>(
          'ai_session_list',
          { roots: [root], lookbackDays: 1 },
        );
        if (
          list.some(
            (s) => s.lastModified >= todayStart || (s.lastEventTs != null && s.lastEventTs >= todayStart),
          )
        ) {
          hasActivity = true;
          break;
        }
      } catch {
        // 单根失败（目录不存在等）跳过，不拖垮哨兵
      }
    }
    if (!hasActivity) return;

    await notify('今天还没有日志', '今天有工作活动但还没有日志，要补扫生成吗？');
    emptyDayReminded = true;
  } catch {
    // 哨兵失败不影响主流程；提醒未发出，下一轮 tick 再试
  }
}

/** 启动下班提醒轮询（每分钟检查一次）。传入最新的 settings getter。 */
export function startReminder(getSettings: () => AppSettings): void {
  stopReminder();
  // 启动后先静默等一轮，避免刚开机就弹
  timer = setInterval(() => {
    void tick(getSettings());
    void tickEmptyDay(getSettings()); // E5 空白天哨兵（共用轮询）
  }, 60_000);
}

export function stopReminder(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
