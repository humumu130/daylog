import { listRecordsByDay } from './db';
import { notify } from './notification';
import { showQuickCapture } from './window';
import { todayYMD } from '../utils/date';
import type { AppSettings } from '../types/models';

let timer: ReturnType<typeof setInterval> | null = null;
let lastRemindDay = ''; // 同一天只提醒一次（进程内）

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

/** 启动下班提醒轮询（每分钟检查一次）。传入最新的 settings getter。 */
export function startReminder(getSettings: () => AppSettings): void {
  stopReminder();
  // 启动后先静默等一轮，避免刚开机就弹
  timer = setInterval(() => {
    void tick(getSettings());
  }, 60_000);
}

export function stopReminder(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
