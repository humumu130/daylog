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

/// 读取 git 提交日志（异步 + 25s 超时，避免大仓/慢盘/锁住时卡死 UI）
#[tauri::command]
pub async fn git_log(repo: String, since: String, author: Option<String>, until: Option<String>) -> Result<String, String> {
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
    cmd.args(["--no-merges", "--pretty=format:%h|%s|%an|%ad", "--date=short"]);
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

/// 猪齿鱼登录：2 步 curl（GET 建 session → POST + 跟随重定向 → 从最终 URL 提取 token）
#[tauri::command]
pub async fn choerodon_login_cmd(base_url: String, username: String, encrypted_password: String) -> Result<String, String> {
    use std::process::Stdio;

    let cookie_file = std::env::temp_dir().join(format!("choerodon_{}.txt", std::process::id()));
    let cookie_path = cookie_file.to_string_lossy().to_string();
    let login_url = format!("{}/oauth/login", base_url);
    let devnull = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let flags = 0x0800_0000u32;

    async fn run_curl(args: Vec<String>, flags: u32) -> Result<String, String> {
        let mut cmd = tokio::process::Command::new("curl");
        cmd.args(&args);
        #[cfg(windows)] { cmd.creation_flags(flags); }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        let out = cmd.output().await.map_err(|e| format!("curl 失败：{e}"))?;
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    // 1. GET 登录页（建 session，存 cookie）
    let _ = run_curl(vec![
        "-s".into(), "-o".into(), devnull.into(),
        "-c".into(), cookie_path.clone(),
        login_url.clone(),
    ], flags).await?;

    // 2. POST 登录 + -L 跟随所有重定向（用 --data-urlencode 自动编码，避免 +/= 破坏表单）
    let result = run_curl(vec![
        "-s".into(), "-L".into(),
        "-o".into(), devnull.into(),
        "-w".into(), "\n___FINAL_URL___%{url_effective}".into(),
        "-b".into(), cookie_path.clone(),
        "-c".into(), cookie_path.clone(),
        "--data-urlencode".into(), format!("username={}", username),
        "--data-urlencode".into(), format!("password={}", encrypted_password),
        login_url.clone(),
    ], flags).await?;

    let _ = std::fs::remove_file(&cookie_file);

    // 从输出里找 ___FINAL_URL___ 标记后的最终 URL
    let final_url = result
        .split("___FINAL_URL___")
        .nth(1)
        .unwrap_or("")
        .trim()
        .to_string();

    if final_url.contains("access_token=") {
        if let Some(token) = final_url.split("access_token=").nth(1).and_then(|s| s.split('&').next()) {
            if !token.is_empty() { return Ok(token.to_string()); }
        }
    }

    Err(format!("登录失败。最终 URL：{}", &final_url[..final_url.len().min(200)]))
}
