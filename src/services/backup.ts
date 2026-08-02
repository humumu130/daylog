import Database from '@tauri-apps/plugin-sql';
import { invoke } from '@tauri-apps/api/core';


interface BackupData {
  version: number;
  exportedAt: string;
  records: unknown[];
  tasks: unknown[];
  projects: unknown[];
  templates: unknown[];
  reports: unknown[];
}

async function fetchAll(): Promise<string> {
  const db = await Database.load('sqlite:worklog.db');
  const [records, tasks, projects, templates, reports] = await Promise.all([
    db.select<unknown[]>('SELECT * FROM records'),
    db.select<unknown[]>('SELECT * FROM tasks'),
    db.select<unknown[]>('SELECT * FROM projects'),
    db.select<unknown[]>('SELECT * FROM templates'),
    db.select<unknown[]>('SELECT * FROM reports'),
  ]);
  const data: BackupData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    records, tasks, projects, templates, reports,
  };
  return JSON.stringify(data, null, 2);
}

/** 导出：用 Tauri dialog 选位置，写文件（全在 Rust/原生层） */
export async function exportToFile(): Promise<boolean> {
  const json = await fetchAll();
  // 用 dialog 插件选保存路径
  const filePath = await invoke<string | null>('plugin:dialog|save', {
    title: '导出备份',
    defaultPath: `worklog-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!filePath) return false;
  await invoke('plugin:fs|write_text_file', { path: filePath, contents: json });
  return true;
}

/** 各表允许的列（白名单，防止备份文件里的未知列破坏 INSERT / 注入标识符） */
const SCHEMA: Record<string, readonly string[]> = {
  projects: ['id', 'name', 'color', 'keywords', 'is_active', 'sort_order', 'created_at'],
  tasks: ['id', 'title', 'project_id', 'status', 'start_date', 'end_date', 'note', 'created_at', 'updated_at'],
  records: ['id', 'task_id', 'project_id', 'content', 'duration_min', 'day', 'half', 'source', 'created_at', 'updated_at', 'meta'],
  templates: ['id', 'name', 'body', 'is_default', 'created_at'],
  reports: ['id', 'month', 'template_id', 'body', 'provider', 'model', 'created_at'],
};
const TABLES = ['projects', 'tasks', 'records', 'templates', 'reports'] as const;

/** 导入：选文件 → 读 → 校验 → 事务内覆盖写回 DB（失败整体回滚，绝不留半空库） */
export async function importFromFile(): Promise<{ imported: number }> {
  const filePath = await invoke<string | null>('plugin:dialog|open', {
    title: '导入备份',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    multiple: false,
  });
  if (!filePath) return { imported: 0 };

  const json = await invoke<string>('plugin:fs|read_text_file', { path: filePath });
  const data = JSON.parse(json) as Partial<BackupData>;

  // 写库前先校验结构：每个表必须是数组
  for (const t of TABLES) {
    const v = (data as Record<string, unknown>)[t];
    if (!Array.isArray(v)) throw new Error(`备份文件损坏或格式不符：缺少 ${t}`);
  }

  const db = await Database.load('sqlite:worklog.db');
  await db.execute('BEGIN');
  let count = 0;
  try {
    for (const t of TABLES) await db.execute(`DELETE FROM ${t}`);
    for (const t of TABLES) {
      const allowed = SCHEMA[t];
      const rows = (data as Record<string, unknown>)[t] as Record<string, unknown>[];
      for (const row of rows) {
        const keys = Object.keys(row).filter((k) => allowed.includes(k));
        if (keys.length === 0) continue;
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        const values = keys.map((k) => {
          const v = row[k];
          if (typeof v === 'object' && v !== null) return JSON.stringify(v);
          return v;
        });
        await db.execute(`INSERT INTO ${t} (${keys.join(', ')}) VALUES (${placeholders})`, values);
        count++;
      }
    }
    await db.execute('COMMIT');
    return { imported: count };
  } catch (e) {
    await db.execute('ROLLBACK').catch(() => undefined);
    throw new Error('导入失败，已回滚（数据未改动）：' + (e instanceof Error ? e.message : String(e)));
  }
}

/** 启动时自动备份（Rust 端写文件到 app data） */
export async function autoBackup(): Promise<void> {
  try {
    const json = await fetchAll();
    await invoke('auto_backup_cmd', { data: json });
  } catch (e) {
    // 备份失败不阻塞主流程，但留痕便于排查（不静默吞掉）
    console.error('[autoBackup] 备份失败：', e);
  }
}
