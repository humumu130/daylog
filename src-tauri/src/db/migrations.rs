use tauri_plugin_sql::{Migration, MigrationKind};

/// 初始 schema。每条 Migration 仅含一条 SQL 语句（sqlx 单语句执行），
/// 全部使用 IF NOT EXISTS，安全可重入。
pub fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create_projects",
            sql: "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#0078d4', keywords TEXT NOT NULL DEFAULT '[]', is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "create_tasks",
            sql: "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, project_id TEXT, status TEXT NOT NULL DEFAULT 'active', start_date TEXT NOT NULL, end_date TEXT, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "index_tasks_status",
            sql: "CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "index_tasks_project",
            sql: "CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "create_records",
            sql: "CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, task_id TEXT, project_id TEXT, content TEXT NOT NULL, duration_min INTEGER, day TEXT NOT NULL, half TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, meta TEXT NOT NULL DEFAULT '{}', FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL, FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "index_records_day_half",
            sql: "CREATE INDEX IF NOT EXISTS idx_records_day_half ON records(day, half)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "index_records_task",
            sql: "CREATE INDEX IF NOT EXISTS idx_records_task ON records(task_id)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "index_records_project",
            sql: "CREATE INDEX IF NOT EXISTS idx_records_project ON records(project_id)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "create_templates",
            sql: "CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', is_default INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "create_reports",
            sql: "CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, month TEXT NOT NULL, template_id TEXT, body TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "index_reports_month",
            sql: "CREATE INDEX IF NOT EXISTS idx_reports_month ON reports(month)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "create_settings",
            sql: "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 13,
            description: "reports_add_date_from",
            sql: "ALTER TABLE reports ADD COLUMN date_from TEXT",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 14,
            description: "reports_add_date_to",
            sql: "ALTER TABLE reports ADD COLUMN date_to TEXT",
            kind: MigrationKind::Up,
        },
    ]
}
