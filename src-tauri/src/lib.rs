// WorkLog backend: 仅承载必需的 Rust 部分
//  - SQL 迁移声明（tauri-plugin-sql 要求在 Rust Builder 中声明）
//  - 插件注册（store / clipboard / notification / global-shortcut / autostart）
//  - 系统托盘（左键切换主窗口；右键菜单）
// 热键注册、窗口控制、数据库 CRUD 均由前端 Tauri API 完成，便于配置与类型安全。
use tauri::Manager;

mod ai_scan;
mod commands;
mod db;
mod tray;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:worklog.db", db::migrations::migrations())
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // 窗口位置/尺寸记忆：仅主窗与待办浮窗；快速记录是热键唤出的浮条，不参与恢复
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["quick-capture"])
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::git_log,
            commands::run_claude,
            commands::auto_backup_cmd,
            commands::secret_put,
            commands::secret_get,
            commands::secret_delete,
            ai_scan::ai_session_list,
            ai_scan::ai_session_parse,
            ai_scan::ai_session_cwds,
            ai_scan::discover_repos,
        ])
        .setup(|app| {
            // 数据目录预建：plugin-sql 首次连接建库前目录必须存在（其 connect 内部也会
            // create_dir_all，但 setup 先行一次，消除首启多窗口并发时的目录竞态窗口）
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
            }
            // 开机自启插件（仅桌面端），启用/禁用由前端控制
            #[cfg(desktop)]
            {
                let _ = app.handle().plugin(tauri_plugin_autostart::init(
                    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                    None,
                ));
            }
            tray::setup(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
