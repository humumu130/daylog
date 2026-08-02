use std::io::Write;

/// 读取 git 提交日志：返回 "hash|subject|author|date" 多行
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
            // -i: 作者匹配不区分大小写
            cmd.arg("-i").args(["--author", a]);
        }
    }
    cmd.args(["--pretty=format:%h|%s|%an|%ad", "--date=short"]);
    let out = cmd.output().map_err(|e| format!("执行 git 失败：{e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// 调用本地 claude CLI 生成文本（非交互，prompt 走 stdin）
#[tauri::command]
pub fn run_claude(prompt: String) -> Result<String, String> {
    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "claude", "-p", "--output-format", "json"]);
        c
    } else {
        let mut c = std::process::Command::new("claude");
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
        stdin.write_all(prompt.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let raw = String::from_utf8_lossy(&out.stdout).to_string();
    // 兼容 {result:"..."} / {text:"..."}
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
