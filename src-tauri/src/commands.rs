/// 自动备份：data=JSON 内容；keep=保留份数(None=5，0=不清理)；dir=自定义目录(None/空=默认 com.worklog.app/backups)
#[tauri::command]
pub fn auto_backup_cmd(data: String, keep: Option<usize>, dir: Option<String>) -> Result<String, String> {
    use std::path::PathBuf;
    let backup_dir: PathBuf = match dir {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => {
            let app_data = dirs_next::data_dir().ok_or("找不到 app data 目录")?;
            app_data.join("com.worklog.app").join("backups")
        }
    };
    std::fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("创建备份目录失败：{e}"))?;

    let ts = chrono::Local::now().format("%Y-%m-%d_%H%M%S");
    let file_name = format!("backup-{}.json", ts);
    let file_path = backup_dir.join(&file_name);
    std::fs::write(&file_path, &data)
        .map_err(|e| format!("写入备份失败：{e}"))?;

    // 清理旧备份，保留最近 keep 份（0 = 不清理）
    let keep_n = keep.unwrap_or(5);
    if keep_n > 0 {
        let mut backups: Vec<_> = std::fs::read_dir(&backup_dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("backup-"))
            .collect();
        backups.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
        for old in backups.iter().skip(keep_n) {
            let _ = std::fs::remove_file(old.path());
        }
    }
    Ok(file_path.to_string_lossy().to_string())
}

/// 读取 git 提交日志（异步 + 40s 超时，避免大仓/慢盘/锁住时卡死 UI）；
/// with_time=Some(true) 时输出 ISO8601 精确时间（%aI + --date=iso-strict），默认 None 保持仅日期
#[tauri::command]
pub async fn git_log(repo: String, since: String, author: Option<String>, until: Option<String>, with_time: Option<bool>) -> Result<String, String> {
    use std::process::Stdio;
    let mut cmd = tokio::process::Command::new("git");
    #[cfg(windows)] { cmd.creation_flags(0x0800_0000); } // CREATE_NO_WINDOW，避免闪控制台黑框
    cmd.current_dir(&repo).arg("log");
    if !since.is_empty() {
        cmd.args(["--since", &since]);
    }
    if let Some(u) = &until {
        if !u.is_empty() {
            cmd.args(["--until", u]);
        }
    }
    if let Some(a) = &author {
        if !a.is_empty() {
            cmd.arg("-i").args(["--author", a]);
        }
    }
    if with_time == Some(true) {
        // 含精确时间模式：ISO8601 严格格式（如 2026-09-28T21:05:00+08:00）
        cmd.args(["--no-merges", "--pretty=format:%h|%s|%an|%aI", "--date=iso-strict"]);
    } else {
        // 默认模式：仅日期，保持与既有调用方字节级一致
        cmd.args(["--no-merges", "--pretty=format:%h|%s|%an|%ad", "--date=short"]);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = tokio::time::timeout(std::time::Duration::from_secs(40), cmd.output())
        .await
        .map_err(|_| format!("git log 超时（40s），仓库可能过大或 .git 被锁：{repo}"))?
        .map_err(|e| format!("执行 git 失败：{e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// 调用本地 claude CLI 生成文本（异步，不阻塞 UI）
#[tauri::command]
pub async fn run_claude(prompt: String) -> Result<String, String> {
    use tokio::io::AsyncWriteExt;

    let mut cmd = if cfg!(windows) {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", "claude", "-p", "--output-format", "json"]);
        c
    } else {
        let mut c = tokio::process::Command::new("claude");
        c.args(["-p", "--output-format", "json"]);
        c
    };
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)] { cmd.creation_flags(0x0800_0000); } // CREATE_NO_WINDOW，claude 子进程不弹黑框

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 claude：{e}（确认已装并在 PATH）"))?;

    {
        let stdin = child.stdin.as_mut().ok_or("打开 stdin 失败")?;
        stdin.write_all(prompt.as_bytes()).await.map_err(|e| e.to_string())?;
    }

    let out = child.wait_with_output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let raw = String::from_utf8_lossy(&out.stdout).to_string();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
        if let Some(s) = v.get("result").and_then(|x| x.as_str()) {
            return Ok(s.to_string());
        }
        if let Some(s) = v.get("text").and_then(|x| x.as_str()) {
            return Ok(s.to_string());
        }
    }
    Ok(raw)
}

/// OS keychain 写入凭据（service + account 定位条目，值非空字符串）
#[tauri::command]
pub async fn secret_put(service: String, account: String, value: String) -> Result<(), String> {
    let entry = keyring::Entry::new(&service, &account).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

/// OS keychain 读取凭据：条目不存在返回 Ok(None)（与「存在但值为空」区分）
#[tauri::command]
pub async fn secret_get(service: String, account: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(&service, &account).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// OS keychain 删除凭据：条目不存在视为成功
#[tauri::command]
pub async fn secret_delete(service: String, account: String) -> Result<(), String> {
    let entry = keyring::Entry::new(&service, &account).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
