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

/// 读取 git 提交日志
#[tauri::command]
pub fn git_log(repo: String, since: String, author: Option<String>, until: Option<String>) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
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
    cmd.args(["--no-merges", "--pretty=format:%h|%s|%an|%ad", "--date=short"]);
    let out = cmd.output().map_err(|e| format!("执行 git 失败：{e}"))?;
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
