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
        Migration {
            version: 15,
            description: "records_add_run_id",
            sql: "ALTER TABLE records ADD COLUMN run_id TEXT",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 16,
            description: "index_records_run",
            sql: "CREATE INDEX IF NOT EXISTS idx_records_run ON records(run_id)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 17,
            description: "create_collector_state",
            sql: "CREATE TABLE IF NOT EXISTS collector_state (provider TEXT NOT NULL, file TEXT NOT NULL, byte_offset INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (provider, file))",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 18,
            description: "create_ingested_events",
            sql: "CREATE TABLE IF NOT EXISTS ingested_events (fingerprint TEXT PRIMARY KEY, provider TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 19,
            description: "index_ingested_day",
            sql: "CREATE INDEX IF NOT EXISTS idx_ingested_day ON ingested_events(day)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 20,
            description: "create_consolidate_runs",
            sql: "CREATE TABLE IF NOT EXISTS consolidate_runs (id TEXT PRIMARY KEY, day TEXT NOT NULL, input_sig TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'success', summary TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 21,
            description: "index_runs_day",
            sql: "CREATE INDEX IF NOT EXISTS idx_runs_day ON consolidate_runs(day)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 22,
            description: "tasks_add_source",
            sql: "ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 23,
            description: "tasks_add_external_key",
            sql: "ALTER TABLE tasks ADD COLUMN external_key TEXT",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 24,
            description: "index_tasks_external_unique",
            sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_external_key ON tasks(external_key)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 25,
            description: "create_choerodon_sync_log",
            sql: "CREATE TABLE IF NOT EXISTS choerodon_sync_log (log_id TEXT PRIMARY KEY, record_id TEXT NOT NULL, day TEXT NOT NULL, minutes INTEGER NOT NULL DEFAULT 0, strategy_run_id TEXT, payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 26,
            description: "index_sync_log_record",
            sql: "CREATE INDEX IF NOT EXISTS idx_sync_log_record ON choerodon_sync_log(record_id)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 27,
            description: "create_noise_reviews",
            sql: "CREATE TABLE IF NOT EXISTS noise_reviews (fingerprint TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'work', status TEXT NOT NULL, digest TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 28,
            description: "index_noise_ws_status",
            sql: "CREATE INDEX IF NOT EXISTS idx_noise_ws_status ON noise_reviews(workspace_id, status)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 29,
            description: "create_workspaces",
            sql: "CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'work', is_default INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 30,
            description: "records_add_workspace",
            sql: "ALTER TABLE records ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'work'",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 31,
            description: "index_records_workspace",
            sql: "CREATE INDEX IF NOT EXISTS idx_records_workspace ON records(workspace_id)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 32,
            description: "projects_add_workspace",
            sql: "ALTER TABLE projects ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'work'",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 33,
            description: "tasks_add_workspace",
            sql: "ALTER TABLE tasks ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'work'",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 34,
            description: "records_add_record_type",
            sql: "ALTER TABLE records ADD COLUMN record_type TEXT NOT NULL DEFAULT 'work'",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 35,
            description: "records_add_learnings",
            sql: "ALTER TABLE records ADD COLUMN learnings TEXT NOT NULL DEFAULT '[]'",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 36,
            description: "records_add_tags",
            sql: "ALTER TABLE records ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 37,
            description: "create_retrospectives",
            sql: "CREATE TABLE IF NOT EXISTS retrospectives (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'work', period TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 38,
            description: "noise_reviews_add_day",
            sql: "ALTER TABLE noise_reviews ADD COLUMN day TEXT",
            kind: MigrationKind::Up,
        },
        Migration {
            // 注意：v29 已建 workspaces（旧结构无 archived），本条 IF NOT EXISTS 在新库/旧库上
            // 均恒被跳过（v29 先行），实际结构对齐由 v40 补列完成。保留作历史记录不删。
            version: 39,
            description: "create_workspaces",
            sql: "CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('work','personal')), is_default INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
            kind: MigrationKind::Up,
        },
        Migration {
            // v29 旧结构缺 archived 列（v39 因 IF NOT EXISTS 被跳过未能对齐），此处补列。
            // 原版 v40 是 INSERT 种子，因引用缺失列从未在任何库上成功应用过，改写安全。
            version: 40,
            description: "workspaces_add_archived",
            sql: "ALTER TABLE workspaces ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 41,
            description: "seed_default_workspace",
            sql: "INSERT OR IGNORE INTO workspaces (id, name, type, is_default, archived, created_at) VALUES ('work', '工作', 'work', 1, 0, 0)",
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 全量迁移重放（空库 → 终态断言）：2026-09-30 冒烟暴露 v29/v39 双建表冲突
    /// （v39 IF NOT EXISTS 恒被跳过、v40 引用缺失列失败中断），此测试防同类回归。
    /// 用 sqlite3 CLI 逐条执行（每条迁移恰好单语句），任何一条失败即整体失败。
    #[test]
    fn migrations_replay_clean_db() {
        let db = std::env::temp_dir().join("daylog-mig-replay-test.db");
        let _ = std::fs::remove_file(&db);
        for m in migrations() {
            let out = std::process::Command::new("sqlite3")
                .arg(&db)
                .arg(&m.sql)
                .output()
                .expect("sqlite3 应可用");
            assert!(
                out.status.success(),
                "迁移 v{} ({}) 失败：{}",
                m.version,
                m.description,
                String::from_utf8_lossy(&out.stderr)
            );
        }
        let q = |sql: &str| -> String {
            let out = std::process::Command::new("sqlite3")
                .arg(&db)
                .arg(sql)
                .output()
                .unwrap();
            assert!(out.status.success(), "查询失败：{sql}");
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        // workspaces 终态：archived 列存在 + 种子行就位（v29 旧结构 + v40 补列 + v41 种子）
        let cols = q("SELECT group_concat(name) FROM pragma_table_info('workspaces')");
        assert!(cols.contains("archived"), "workspaces 缺 archived 列：{cols}");
        let seed = q("SELECT type || ',' || is_default || ',' || archived FROM workspaces WHERE id='work'");
        assert_eq!(seed, "work,1,0", "默认工作空间种子行不符：{seed}");
        // 关键业务表齐备
        for t in [
            "records", "projects", "tasks", "workspaces", "collector_state",
            "ingested_events", "noise_reviews", "consolidate_runs",
            "choerodon_sync_log", "retrospectives", "settings",
        ] {
            assert_eq!(q(&format!("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='{t}'")), "1", "缺表 {t}");
        }
        let _ = std::fs::remove_file(&db);
    }

    /// 旧库升级路径：模拟「已应用到 v38 的存量库」（v29 建的旧 workspaces 无 archived），
    /// 断言 v39-v41 补齐结构不炸——存量用户升级零迁移错误。
    #[test]
    fn migrations_upgrade_from_v38() {
        let db = std::env::temp_dir().join("daylog-mig-upgrade-test.db");
        let _ = std::fs::remove_file(&db);
        for m in migrations().into_iter().filter(|m| m.version <= 38) {
            let out = std::process::Command::new("sqlite3")
                .arg(&db)
                .arg(&m.sql)
                .output()
                .expect("sqlite3 应可用");
            assert!(out.status.success(), "v{} 失败：{}", m.version, String::from_utf8_lossy(&out.stderr));
        }
        // 存量库上已有同名「work」行（如旧版前端兜底建的），升级段仍须成功
        std::process::Command::new("sqlite3")
            .arg(&db)
            .arg("INSERT INTO workspaces (id, name, type, is_default, created_at) VALUES ('work', '旧工作', 'work', 1, 100)")
            .output()
            .unwrap();
        for m in migrations().into_iter().filter(|m| m.version > 38) {
            let out = std::process::Command::new("sqlite3")
                .arg(&db)
                .arg(&m.sql)
                .output()
                .expect("sqlite3 应可用");
            assert!(
                out.status.success(),
                "升级迁移 v{} ({}) 失败：{}",
                m.version,
                m.description,
                String::from_utf8_lossy(&out.stderr)
            );
        }
        let q = |sql: &str| -> String {
            let out = std::process::Command::new("sqlite3").arg(&db).arg(sql).output().unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let cols = q("SELECT group_concat(name) FROM pragma_table_info('workspaces')");
        assert!(cols.contains("archived"), "升级后仍缺 archived：{cols}");
        // 存量行保留（OR IGNORE 不覆盖）且补上 archived 默认值
        assert_eq!(
            q("SELECT name || ',' || archived FROM workspaces WHERE id='work'"),
            "旧工作,0",
            "存量行应原样保留并带 archived=0"
        );
        let _ = std::fs::remove_file(&db);
    }
}
