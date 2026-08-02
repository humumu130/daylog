use tauri::{
    menu::{Menu, MenuEvent, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, Manager,
};

/// 创建系统托盘：
///  - 左键单击：切换主窗口显隐
///  - 右键菜单：打开主窗口 / 快速记录 / 退出
pub fn setup(app: &App) -> tauri::Result<()> {
    let show_main = MenuItem::with_id(app, "show_main", "打开主窗口", true, None::<&str>)?;
    let widget = MenuItem::with_id(app, "widget", "待办插件", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick", "快速记录", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_main, &widget, &quick, &quit])?;

    let mut builder = TrayIconBuilder::new()
        .tooltip("工作日志 WorkLog")
        .menu(&menu)
        .show_menu_on_left_click(false);

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder
        .on_menu_event(|app, e: MenuEvent| match e.id.as_ref() {
            "show_main" => show_window(app, "main"),
            "widget" => toggle_window(app, "widget"),
            "quick" => show_window(app, "quick-capture"),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|app, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(app.app_handle(), "main");
            }
        })
        .build(app)?;

    Ok(())
}

fn show_window(app: &tauri::AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_window(app: &tauri::AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}
