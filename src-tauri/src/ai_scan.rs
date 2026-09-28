//! AI 会话采集（P5）：读取 Claude Code（~/.claude/projects）与 Codex（~/.codex/sessions）
//! 本地 JSONL 会话文件并容错解析。Rust 侧只做「读文件 + 容错解析」，指纹/去重/LLM 整合由前端完成。
//! 容错总则：单文件/单行错误一律静默跳过（parse 级计数），绝不 panic；只有命令级错误才返回 Err。

use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// 提供方标识，前端按此分支处理
const PROVIDER: &str = "claude-code";

/// 会话文件摘要（ai_session_list 返回项）
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionInfo {
    pub provider: String,
    pub file: String,
    pub size_bytes: u64,
    pub last_modified: i64,        // mtime，ms epoch
    pub last_event_ts: Option<i64>, // 文件尾部最后一个可解析 timestamp，ms
}

/// 单条解析出的事件（前端整合引擎的输入）
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiEvent {
    pub provider: String,
    pub kind: String, // human_prompt | assistant_tail | todo_tool
    pub ts: i64,      // ms epoch
    pub day: String,  // 本地时区 YYYY-MM-DD
    pub cwd: String,
    pub git_branch: Option<String>,
    pub text: String,
    pub todo: Option<AiTodo>,
}

/// todo_tool 事件的待办信息
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct AiTodo {
    pub action: String, // create | update | write
    pub subject: String,
    pub status: Option<String>,
}

/// ai_session_parse 返回结构
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiParseResult {
    pub file: String,
    pub size_bytes: u64,
    pub parse_errors: u64,
    pub events: Vec<AiEvent>,
}

/// cwd 聚合摘要（ai_session_cwds 返回项）
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CwdSummary {
    pub provider: String,
    pub cwd: String,
    pub git_branch: Option<String>,
    pub sessions: u64,
    pub last_ts: Option<i64>,
}

/// 仓库发现结果（discover_repos 返回项）
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredRepo {
    pub path: String,
    pub remote: Option<String>,
    pub readme_title: Option<String>,
    pub has_package_json: bool,
}

// ---------- 基础小工具（全容错，无 panic） ----------

/// 当前时间，ms epoch（取不到返回 0）
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 文件 mtime，ms epoch
fn mtime_ms(md: &std::fs::Metadata) -> Option<i64> {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

/// 解析行内 timestamp 字段：RFC3339 字符串或毫秒数字（含数字字符串兜底），失败返回 None
fn ts_ms(v: &Value) -> Option<i64> {
    match v.get("timestamp")? {
        Value::String(s) => {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                return Some(dt.timestamp_millis());
            }
            s.parse::<i64>().ok() // 数字字符串按 ms 兜底
        }
        Value::Number(n) => n.as_i64(), // 毫秒数字
        _ => None,
    }
}

/// ms epoch → 本地时区 YYYY-MM-DD（用 chrono::Local，不用 UTC）
fn local_day(ms: i64) -> String {
    use chrono::TimeZone;
    chrono::Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// 按 char 边界截断（绝不切坏 UTF-8）
fn truncate_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

/// 用行级公共字段组装 AiEvent
fn build_event(provider: &str, ts: i64, cwd: &str, git_branch: Option<String>, kind: &str, text: String, todo: Option<AiTodo>) -> AiEvent {
    AiEvent {
        provider: provider.to_string(),
        kind: kind.to_string(),
        ts,
        day: local_day(ts),
        cwd: cwd.to_string(),
        git_branch,
        text,
        todo,
    }
}

/// 按路径识别 provider：Codex 官方 rollout 在 ~/.codex/sessions 下；其余按 Claude Code
fn detect_provider(path: &str) -> &'static str {
    if path.contains("/.codex/sessions") {
        "codex"
    } else {
        PROVIDER
    }
}

/// 从 Claude Code 行提取 cwd/gitBranch（build_event 的 claude 侧便捷封装）
fn claude_ctx(v: &Value) -> (String, Option<String>) {
    (
        v.get("cwd").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        v.get("gitBranch").and_then(|x| x.as_str()).map(|s| s.to_string()),
    )
}

/// 提取人类输入文本：origin.kind 存在时优先采信（非 human 一律跳过）；
/// content 为 String 或数组含 type=text 记文本；数组仅含 tool_result（机器回显）返回 None
fn human_prompt_text(v: &Value) -> Option<String> {
    let origin_kind = v
        .get("origin")
        .and_then(|o| o.get("kind"))
        .and_then(|k| k.as_str());
    let content = v.get("message").and_then(|m| m.get("content"))?;
    let text = match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => {
            let parts: Vec<String> = items
                .iter()
                .filter(|it| it.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|it| it.get("text").and_then(|t| t.as_str()))
                .map(|s| s.to_string())
                .collect();
            if parts.is_empty() {
                None // 无 text block：tool_result 回显等，跳过
            } else {
                Some(parts.join("\n"))
            }
        }
        _ => None,
    }?;
    if let Some(kind) = origin_kind {
        if kind != "human" {
            return None; // origin 存在时优先采信：非 human 视为机器回显
        }
    }
    if text.trim().is_empty() {
        return None;
    }
    Some(text)
}

/// 提取 assistant 消息文本（各 text block 拼接）；无 text block 返回 None
fn assistant_text(v: &Value) -> Option<String> {
    let content = v.get("message").and_then(|m| m.get("content"))?;
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => {
            let parts: Vec<String> = items
                .iter()
                .filter(|it| it.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|it| it.get("text").and_then(|t| t.as_str()))
                .map(|s| s.to_string())
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        _ => None,
    }
}

/// 提取 assistant 消息里的待办工具调用（TaskCreate/TaskUpdate/TodoWrite），每个 tool_use 一条事件
fn todo_tool_events(v: &Value, ts: i64) -> Vec<AiEvent> {
    let Some(items) = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return vec![];
    };
    let mut out = vec![];
    for it in items {
        if it.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
            continue;
        }
        let name = it.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let action = match name {
            "TaskCreate" => "create",
            "TaskUpdate" => "update",
            "TodoWrite" => "write",
            _ => continue, // 其它工具不关心
        };
        let input = it.get("input").cloned().unwrap_or(Value::Null);
        let (subject, status, text) = if name == "TodoWrite" {
            // TodoWrite 是整份待办快照：subject 固定占位，text 放原始 input JSON 供前端解析 todos
            (
                "(待办快照)".to_string(),
                None,
                serde_json::to_string(&input).unwrap_or_default(),
            )
        } else {
            // 历史版本字段叫 content，新版叫 subject，两个都兼容
            let subject = input
                .get("subject")
                .and_then(|x| x.as_str())
                .or_else(|| input.get("content").and_then(|x| x.as_str()))
                .unwrap_or("")
                .to_string();
            let status = if name == "TaskUpdate" {
                input.get("status").and_then(|x| x.as_str()).map(|s| s.to_string())
            } else {
                None
            };
            let text = subject.clone();
            (subject, status, text)
        };
        out.push(build_event(
            PROVIDER,
            ts,
            &claude_ctx(v).0,
            claude_ctx(v).1,
            "todo_tool",
            text,
            Some(AiTodo {
                action: action.to_string(),
                subject,
                status,
            }),
        ));
    }
    out
}

/// Codex rollout 行解析（~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl，cli 0.92 实测布局）：
/// 行结构 {timestamp, type, payload}；cwd 无逐行字段，由 session_meta/turn_context 的 payload.cwd 维护
/// （turn_context 每轮出现，后写覆盖）。schema 跨版本漂移——全程容错，未知子类型静默忽略。
/// event_msg(payload.type=user_message)=干净人类输入；response_item(payload.type=message) 中
/// role=user 是 harness 注入噪音（环境上下文等）跳过，仅 assistant 取 content[] 的 output_text。
/// 无 gitBranch。
fn codex_handle_line(
    v: &Value,
    ts: i64,
    cwd_state: &mut String,
    events: &mut Vec<AiEvent>,
    assistant_buf: &mut Vec<AiEvent>,
) {
    let payload = v.get("payload").cloned().unwrap_or(Value::Null);
    match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
        "session_meta" | "turn_context" => {
            if let Some(c) = payload.get("cwd").and_then(|x| x.as_str()) {
                if !c.is_empty() {
                    *cwd_state = c.to_string();
                }
            }
        }
        "event_msg" => {
            if payload.get("type").and_then(|t| t.as_str()) != Some("user_message") {
                return; // agent_message 等其它子类型忽略（assistant 走 response_item，防双计）
            }
            let text = payload
                .get("message")
                .and_then(|m| m.as_str())
                .or_else(|| payload.get("text").and_then(|t| t.as_str()))
                .unwrap_or("");
            if !text.trim().is_empty() {
                events.push(build_event(
                    "codex",
                    ts,
                    cwd_state,
                    None,
                    "human_prompt",
                    truncate_chars(text, 200),
                    None,
                ));
            }
        }
        "response_item" => {
            if payload.get("type").and_then(|t| t.as_str()) != Some("message") {
                return; // function_call 等其它 item 不关心
            }
            if payload.get("role").and_then(|r| r.as_str()) != Some("assistant") {
                return; // role=user/developer：harness 注入噪音，跳过
            }
            let Some(items) = payload.get("content").and_then(|c| c.as_array()) else {
                return;
            };
            let parts: Vec<&str> = items
                .iter()
                .filter(|it| it.get("type").and_then(|t| t.as_str()) == Some("output_text"))
                .filter_map(|it| it.get("text").and_then(|t| t.as_str()))
                .collect();
            if parts.is_empty() {
                return;
            }
            assistant_buf.push(build_event(
                "codex",
                ts,
                cwd_state,
                None,
                "assistant_tail",
                truncate_chars(&parts.join("\n"), 500),
                None,
            ));
        }
        _ => {} // 未知类型忽略（不计数，防版本漂移误报坏行）
    }
}

/// 水位线续读时的 Codex 头部 cwd 嗅探：读文件头 64KB，取「起始字节在 from_byte 之前」的
/// 最后一个 session_meta/turn_context 的 payload.cwd（turn_context 每轮覆盖，最后一个即续读点
/// 前的最新 cwd）。截断行解析失败自然跳过。
fn sniff_codex_cwd(p: &Path, from_byte: u64) -> Option<String> {
    let f = File::open(p).ok()?;
    let mut buf = Vec::new();
    if f.take(64 * 1024).read_to_end(&mut buf).is_err() {
        return None;
    }
    let text = String::from_utf8_lossy(&buf);
    let mut last: Option<String> = None;
    let mut offset = 0usize;
    for line in text.split('\n') {
        let line_start = offset;
        offset += line.len() + 1;
        if line_start as u64 >= from_byte {
            break; // 只看续读点之前的行
        }
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if ty != "session_meta" && ty != "turn_context" {
            continue;
        }
        if let Some(c) = v.get("payload").and_then(|p| p.get("cwd")).and_then(|x| x.as_str()) {
            if !c.is_empty() {
                last = Some(c.to_string());
            }
        }
    }
    last
}

// ---------- 解析核心 ----------

/// 解析单个 JSONL 会话文件：从 from_byte 起读（>0 时先对齐行界），容错逐行解析。
/// 坏行跳过并计数；isSidechain 行整行跳过；未知 type 忽略；
/// human_prompt 截前 200 字符，assistant_tail 拼接后截前 500 字符且只保留末 3 条，
/// todo_tool 每个 tool_use 一条；事件按 ts 升序返回。
fn parse_file(path: &str, from_byte: u64) -> Result<AiParseResult, String> {
    let p = Path::new(path);
    let mut f = File::open(p).map_err(|e| format!("打开会话文件失败：{e}"))?;
    let len = f.metadata().map_err(|e| format!("读取文件元数据失败：{e}"))?.len();
    let empty = |errors: u64| AiParseResult {
        file: path.to_string(),
        size_bytes: len,
        parse_errors: errors,
        events: vec![],
    };
    if from_byte >= len {
        return Ok(empty(0)); // 无新增内容
    }

    // 读原始字节：from_byte>0 时多读 1 字节用于判断是否已在行界
    let read_from = from_byte.saturating_sub(1);
    f.seek(SeekFrom::Start(read_from))
        .map_err(|e| format!("定位读取偏移失败：{e}"))?;
    let mut raw = Vec::new();
    f.read_to_end(&mut raw)
        .map_err(|e| format!("读取会话文件失败：{e}"))?;
    let content: String = if from_byte == 0 {
        String::from_utf8_lossy(&raw).to_string()
    } else if raw.first() == Some(&b'\n') {
        // 前一字节是 \n：已对齐行界（collector 存的偏移通常正好在行首），从 from_byte 直接解析
        String::from_utf8_lossy(&raw[1..]).to_string()
    } else {
        // 起在行中间：丢弃到下一个 \n 之后对齐
        match raw.iter().position(|&b| b == b'\n') {
            Some(pos) => String::from_utf8_lossy(&raw[pos + 1..]).to_string(),
            None => String::new(), // 剩余无完整行
        }
    };

    let mut parse_errors: u64 = 0;
    let mut events: Vec<AiEvent> = Vec::new();
    let mut assistant_buf: Vec<AiEvent> = Vec::new();
    let provider = detect_provider(path);
    // Codex 的 cwd 在 session_meta/turn_context 行内维护；水位线续读时头部已消费，
    // 需先嗅探文件头恢复初始 cwd
    let mut cwd_state = if provider == "codex" && from_byte > 0 {
        sniff_codex_cwd(p, from_byte).unwrap_or_default()
    } else {
        String::new()
    };
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            parse_errors += 1; // 坏行跳过并计数
            continue;
        };
        if !v.is_object() {
            parse_errors += 1;
            continue;
        }
        let Some(ts) = ts_ms(&v) else {
            continue; // 无有效时间戳（真实数据 user/assistant 行恒有），跳过不计数
        };
        if provider == "codex" {
            codex_handle_line(&v, ts, &mut cwd_state, &mut events, &mut assistant_buf);
            continue;
        }
        if v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false) {
            continue; // 侧链行整行跳过（claude-code 专属）
        }
        match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "user" => {
                if let Some(t) = human_prompt_text(&v) {
                    let (cwd, branch) = claude_ctx(&v);
                    events.push(build_event(PROVIDER, ts, &cwd, branch, "human_prompt", truncate_chars(&t, 200), None));
                }
            }
            "assistant" => {
                if let Some(t) = assistant_text(&v) {
                    let (cwd, branch) = claude_ctx(&v);
                    assistant_buf.push(build_event(
                        PROVIDER,
                        ts,
                        &cwd,
                        branch,
                        "assistant_tail",
                        truncate_chars(&t, 500),
                        None,
                    ));
                }
                events.extend(todo_tool_events(&v, ts)); // 同行既有 text 又有 tool_use：两类都发
            }
            _ => {} // summary 等未知类型忽略（不计数）
        }
    }
    // assistant_tail 只保留末 3 条（时间戳最大的 3 条语义：JSONL 按时间追加，末 3 条即最大）
    let skip = assistant_buf.len().saturating_sub(3);
    events.extend(assistant_buf.into_iter().skip(skip));
    // 稳定排序：同 ts 保持文件内出现顺序
    events.sort_by(|a, b| a.ts.cmp(&b.ts));
    Ok(AiParseResult {
        file: path.to_string(),
        size_bytes: len,
        parse_errors,
        events,
    })
}

/// 增量解析单个 AI 会话文件（from_byte=上次消费到的字节偏移，返回该偏移之后的新事件）
#[tauri::command]
pub async fn ai_session_parse(path: String, from_byte: u64) -> Result<AiParseResult, String> {
    tokio::task::spawn_blocking(move || parse_file(&path, from_byte))
        .await
        .map_err(|e| format!("解析任务失败：{e}"))?
}

// ---------- 会话文件扫描（ai_session_list） ----------

/// 递归收集目录下的 *.jsonl（跳过隐藏目录与 node_modules/target，不跟符号链接目录，访问数封顶防病态树）
fn scan_jsonl_files(dir: &Path, out: &mut Vec<PathBuf>, visited: &mut usize) {
    const MAX_VISIT: usize = 20_000;
    *visited += 1;
    if *visited > MAX_VISIT {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        if ft.is_dir() {
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }
            scan_jsonl_files(&entry.path(), out, visited);
        } else if name.ends_with(".jsonl") {
            out.push(entry.path());
        }
    }
}

/// 读文件尾部 8KB，找最后一个含可解析 timestamp 的行（估算会话最后活动时间）
fn last_event_ts(path: &Path) -> Option<i64> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(8 * 1024);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.take(8 * 1024).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let mut last: Option<i64> = None;
    for line in text.lines() {
        if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
            if let Some(ts) = ts_ms(&v) {
                last = Some(ts);
            }
        }
    }
    last
}

/// list 的阻塞主体：扫各 root 下的 jsonl，按 mtime 过滤 lookback_days 天（0=不限），
/// root 不存在或单文件错误一律静默跳过
fn list_blocking(roots: &[String], lookback_days: u64) -> Vec<AiSessionInfo> {
    let cutoff = if lookback_days == 0 {
        i64::MIN
    } else {
        now_ms().saturating_sub((lookback_days as i64) * 86_400_000)
    };
    let mut out = Vec::new();
    for root in roots {
        let root_path = PathBuf::from(root);
        if !root_path.is_dir() {
            continue; // root 不存在：跳过不报错
        }
        let mut files = Vec::new();
        let mut visited = 0usize;
        scan_jsonl_files(&root_path, &mut files, &mut visited);
        for f in files {
            let Ok(md) = std::fs::metadata(&f) else { continue };
            let Some(mt) = mtime_ms(&md) else { continue };
            if mt < cutoff {
                continue;
            }
            out.push(AiSessionInfo {
                provider: detect_provider(&f.to_string_lossy()).to_string(),
                file: f.to_string_lossy().to_string(),
                size_bytes: md.len(),
                last_modified: mt,
                last_event_ts: last_event_ts(&f),
            });
        }
    }
    // 最近修改在前，次序稳定便于前端增量消费
    out.sort_by(|a, b| b.last_modified.cmp(&a.last_modified).then(a.file.cmp(&b.file)));
    out
}

/// 列出各 root 下 lookback_days 天内有活动的 AI 会话文件（mtime 过滤；0=不限），供前端增量解析
#[tauri::command]
pub async fn ai_session_list(roots: Vec<String>, lookback_days: u64) -> Result<Vec<AiSessionInfo>, String> {
    let list = tokio::task::spawn_blocking(move || list_blocking(&roots, lookback_days))
        .await
        .map_err(|e| format!("扫描任务失败：{e}"))?;
    Ok(list)
}

// ---------- cwd 聚合（ai_session_cwds） ----------

/// 聚合指定目录下各会话文件前 64KB 内的 (provider, cwd, gitBranch)：
/// Claude Code 行内直接有 cwd/gitBranch；Codex 的 cwd 在 session_meta/turn_context 的 payload 内。
/// 按 (provider, cwd, gitBranch) 去重，sessions=出现该组合的文件数，lastTs=提供该组合行的最大
/// timestamp；mtime 超 lookback 跳过
fn summarize_cwds(root: &Path, lookback_days: u64) -> Vec<CwdSummary> {
    let cutoff = if lookback_days == 0 {
        i64::MIN
    } else {
        now_ms().saturating_sub((lookback_days as i64) * 86_400_000)
    };
    let mut files = Vec::new();
    let mut visited = 0usize;
    scan_jsonl_files(root, &mut files, &mut visited);

    // (provider, cwd, gitBranch) → (sessions, last_ts)
    let mut agg: HashMap<(String, String, Option<String>), (u64, Option<i64>)> = HashMap::new();
    for f in files {
        let Ok(md) = std::fs::metadata(&f) else { continue };
        let Some(mt) = mtime_ms(&md) else { continue };
        if mt < cutoff {
            continue;
        }
        let provider = detect_provider(&f.to_string_lossy());
        // 只读前 64KB：cwd/gitBranch 通常在前几行
        let Ok(fh) = File::open(&f) else { continue };
        let mut buf = Vec::new();
        if fh.take(64 * 1024).read_to_end(&mut buf).is_err() {
            continue;
        }
        let text = String::from_utf8_lossy(&buf);
        let mut seen: HashSet<(String, String, Option<String>)> = HashSet::new();
        for line in text.lines() {
            let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
                continue; // 截断行/坏行静默跳过
            };
            let key = if provider == "codex" {
                // Codex：cwd 只在 session_meta/turn_context 行的 payload 内，无 gitBranch
                let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if ty != "session_meta" && ty != "turn_context" {
                    continue;
                }
                let Some(cwd) = v.get("payload").and_then(|p| p.get("cwd")).and_then(|x| x.as_str()) else {
                    continue;
                };
                (provider.to_string(), cwd.to_string(), None)
            } else {
                let Some(cwd) = v.get("cwd").and_then(|x| x.as_str()) else {
                    continue;
                };
                (
                    provider.to_string(),
                    cwd.to_string(),
                    v.get("gitBranch").and_then(|x| x.as_str()).map(|s| s.to_string()),
                )
            };
            let ts = ts_ms(&v);
            let e = agg.entry(key.clone()).or_insert((0, None));
            if seen.insert(key) {
                e.0 += 1; // 每个文件对同一 (provider, cwd, gitBranch) 只计 1 个 session
            }
            if let Some(t) = ts {
                e.1 = Some(e.1.map_or(t, |old| old.max(t)));
            }
        }
    }
    let mut out: Vec<CwdSummary> = agg
        .into_iter()
        .map(|((provider, cwd, git_branch), (sessions, last_ts))| CwdSummary {
            provider,
            cwd,
            git_branch,
            sessions,
            last_ts,
        })
        .collect();
    out.sort_by(|a, b| a.cwd.cmp(&b.cwd).then(a.git_branch.cmp(&b.git_branch)));
    out
}

/// 聚合 AI 会话的工作目录画像（Claude Code ~/.claude/projects + Codex ~/.codex/sessions 双根
/// 写死；不存在的根静默空结果），供前端项目识别
#[tauri::command]
pub async fn ai_session_cwds(lookback_days: u64) -> Result<Vec<CwdSummary>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<CwdSummary>, String> {
        let home = dirs_next::home_dir().ok_or("找不到用户主目录")?;
        let mut out = summarize_cwds(&home.join(".claude").join("projects"), lookback_days);
        out.extend(summarize_cwds(&home.join(".codex").join("sessions"), lookback_days));
        Ok(out)
    })
    .await
    .map_err(|e| format!("聚合任务失败：{e}"))?
}

// ---------- 仓库发现（discover_repos） ----------

/// 有界 BFS 找含 .git 的目录（.git 可为目录或文件/worktree 指针）。
/// 深度 ≤ max_depth；每根访问目录数上限 3000；每根墙钟上限 3 秒（超了优雅返回已发现部分）。
fn discover_in_root(root: &Path, max_depth: u32, out: &mut Vec<DiscoveredRepo>) {
    const MAX_VISIT: usize = 3000;
    const SKIP_DIRS: [&str; 10] = [
        "node_modules", ".git", "target", "dist", "build", ".venv", "venv", "__pycache__",
        ".next", ".cache",
    ];
    let deadline = Instant::now() + std::time::Duration::from_secs(3);
    if !root.is_dir() {
        return; // root 不存在：跳过
    }
    let mut queue: VecDeque<(PathBuf, u32)> = VecDeque::new();
    queue.push_back((root.to_path_buf(), 0));
    let mut visited = 0usize;
    while let Some((dir, depth)) = queue.pop_front() {
        if visited >= MAX_VISIT || Instant::now() >= deadline {
            break; // 超预算/超时：优雅返回已发现部分
        }
        visited += 1;
        // .git 存在性标记（目录或文件/worktree 指针均算）
        let git_path = dir.join(".git");
        if git_path.symlink_metadata().is_ok() {
            out.push(DiscoveredRepo {
                path: dir.to_string_lossy().to_string(),
                remote: read_remote(&git_path),
                readme_title: readme_title(&dir),
                has_package_json: dir.join("package.json").is_file(),
            });
        }
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue; // 无权限等：跳过该目录
        };
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if !ft.is_dir() {
                continue; // 不跟符号链接目录，防环
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // 隐藏子目录与依赖/构建目录不下钻（.git 作为标记已在上面检查）
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            if depth < max_depth {
                queue.push_back((entry.path(), depth + 1));
            }
        }
    }
}

/// 读 .git/config 找 remote url（[remote "origin"] 优先，找不到 origin 取首个 remote）；
/// .git 是文件（worktree 指针）→ None
fn read_remote(git_path: &Path) -> Option<String> {
    if !git_path.metadata().ok()?.is_dir() {
        return None; // worktree/子模块指针文件，不解析
    }
    let config = std::fs::read_to_string(git_path.join("config")).ok()?;
    let mut origin: Option<String> = None;
    let mut first: Option<String> = None;
    let (mut in_remote, mut is_origin) = (false, false);
    for line in config.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_remote = t.starts_with("[remote");
            is_origin = t == "[remote \"origin\"]";
            continue;
        }
        if !in_remote {
            continue;
        }
        if let Some((k, v)) = t.split_once('=') {
            if k.trim() == "url" {
                let url = v.trim().to_string();
                if is_origin && origin.is_none() {
                    origin = Some(url.clone());
                }
                if first.is_none() {
                    first = Some(url);
                }
            }
        }
    }
    origin.or(first)
}

/// 读 README（.md 大小写变体都试，前 4KB）首个以 # 开头的行，去掉 # 与空白作为标题
fn readme_title(dir: &Path) -> Option<String> {
    for name in ["README.md", "Readme.md", "readme.md", "README.MD"] {
        let Ok(f) = File::open(dir.join(name)) else {
            continue;
        };
        let mut buf = Vec::new();
        let _ = f.take(4 * 1024).read_to_end(&mut buf);
        let text = String::from_utf8_lossy(&buf);
        for line in text.lines() {
            let t = line.trim();
            if t.starts_with('#') {
                let title = t.trim_start_matches('#').trim();
                if !title.is_empty() {
                    return Some(title.to_string());
                }
            }
        }
        return None; // 找到 README 但无标题行
    }
    None
}

/// discover_repos 的阻塞主体（每根独立预算）
fn discover_repos_blocking(roots: Vec<String>, max_depth: u32) -> Vec<DiscoveredRepo> {
    let max_depth = if max_depth == 0 { 4 } else { max_depth }; // 0 视为默认 4
    let mut out = Vec::new();
    for r in roots {
        discover_in_root(Path::new(&r), max_depth, &mut out);
    }
    out
}

/// 在各 root 下有界 BFS 发现 git 仓库（深度默认 4、每根 3000 目录/3 秒，整体 10 秒兜底超时）
#[tauri::command]
pub async fn discover_repos(roots: Vec<String>, max_depth: u32) -> Result<Vec<DiscoveredRepo>, String> {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::task::spawn_blocking(move || discover_repos_blocking(roots, max_depth))
            .await
            .map_err(|e| format!("发现任务失败：{e}"))
    })
    .await
    .map_err(|_| "仓库发现整体超时（10s）".to_string())?
}

// ---------- 单元测试（内嵌 fixture，不依赖真实 ~/.claude） ----------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    /// 写临时 fixture 文件，返回路径
    fn write_fixture(content: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "daylog_ai_test_{}_{}.jsonl",
            std::process::id(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::write(&p, content).unwrap();
        p
    }

    /// 写临时 fixture 目录，返回路径
    fn write_dir(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "daylog_ai_dir_{}_{}_{}",
            name,
            std::process::id(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn rfc3339_ms(s: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(s).unwrap().timestamp_millis()
    }

    /// human_prompt / assistant_tail / todo_tool 三类正常解析
    #[test]
    fn test_parse_three_kinds() {
        let ts1 = "2026-09-28T01:23:45.678Z";
        let ts2 = "2026-09-28T02:00:00.000Z";
        let ts3 = "2026-09-28T03:00:00.000Z";
        let l1 = json!({"type":"user","cwd":"/Users/xdd/dev/foo","gitBranch":"main",
            "message":{"role":"user","content":"帮我写周报"},"origin":{"kind":"human"},"timestamp":ts1});
        let l2 = json!({"type":"assistant","cwd":"/Users/xdd/dev/foo","gitBranch":"main",
            "message":{"role":"assistant","content":[{"type":"text","text":"好的，这是草稿"}]},"timestamp":ts2});
        let l3 = json!({"type":"assistant","cwd":"/Users/xdd/dev/foo","gitBranch":"main",
            "message":{"role":"assistant","content":[{"type":"tool_use","name":"TaskCreate",
            "input":{"subject":"写周报","status":"pending"}}]},"timestamp":ts3});
        let p = write_fixture(&format!("{l1}\n{l2}\n{l3}\n"));
        let r = parse_file(&p.to_string_lossy(), 0).unwrap();

        assert_eq!(r.parse_errors, 0);
        assert_eq!(r.size_bytes, std::fs::metadata(&p).unwrap().len());
        assert_eq!(r.events.len(), 3);
        // 按 ts 升序
        assert!(r.events[0].ts <= r.events[1].ts && r.events[1].ts <= r.events[2].ts);

        let e0 = &r.events[0];
        assert_eq!((e0.kind.as_str(), e0.text.as_str(), e0.provider.as_str()),
            ("human_prompt", "帮我写周报", "claude-code"));
        assert_eq!(e0.ts, rfc3339_ms(ts1));
        assert_eq!(e0.cwd, "/Users/xdd/dev/foo");
        assert_eq!(e0.git_branch.as_deref(), Some("main"));
        assert_eq!(e0.day, local_day(e0.ts));
        assert_eq!(e0.day.len(), 10); // YYYY-MM-DD

        assert_eq!((r.events[1].kind.as_str(), r.events[1].text.as_str()),
            ("assistant_tail", "好的，这是草稿"));

        let e2 = &r.events[2];
        assert_eq!(e2.kind, "todo_tool");
        let todo = e2.todo.as_ref().unwrap();
        assert_eq!((todo.action.as_str(), todo.subject.as_str()), ("create", "写周报"));
        assert_eq!(todo.status, None); // TaskCreate 即使 input 带 status 也为 null
        assert_eq!(e2.text, "写周报");
    }

    /// 数组变体 human 记录；tool_result 回显、isSidechain、未知 type 跳过
    #[test]
    fn test_skip_echo_sidechain_unknown() {
        let ts = "2026-09-28T01:00:00.000Z";
        let arr_human = json!({"type":"user","cwd":"/p","timestamp":ts,
            "message":{"role":"user","content":[{"type":"text","text":"数组输入"}]}});
        let echo = json!({"type":"user","cwd":"/p","timestamp":ts,
            "message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}});
        let side = json!({"type":"user","isSidechain":true,"origin":{"kind":"human"},
            "cwd":"/p","timestamp":ts,"message":{"content":"侧链输入"}});
        let summary = json!({"type":"summary","summary":"s","timestamp":ts});
        let p = write_fixture(&format!("{arr_human}\n{echo}\n{side}\n{summary}\n"));
        let r = parse_file(&p.to_string_lossy(), 0).unwrap();

        assert_eq!(r.parse_errors, 0); // 这些都是合法 JSON，不算坏行
        assert_eq!(r.events.len(), 1);
        assert_eq!((r.events[0].kind.as_str(), r.events[0].text.as_str()),
            ("human_prompt", "数组输入"));
    }

    /// 坏行跳过并计数，其余行不受影响
    #[test]
    fn test_bad_line_counted() {
        let ts = "2026-09-28T01:00:00.000Z";
        let good = json!({"type":"user","origin":{"kind":"human"},"cwd":"/p",
            "timestamp":ts,"message":{"content":"正常行"}});
        let p = write_fixture(&format!("垃圾行{{{{\n{good}\n[1,2,3]\n"));
        let r = parse_file(&p.to_string_lossy(), 0).unwrap();
        assert_eq!(r.parse_errors, 2); // 非 JSON 行 + 非 JSON 对象行
        assert_eq!(r.events.len(), 1);
        assert_eq!(r.events[0].text, "正常行");
    }

    /// RFC3339 与毫秒数字两种 timestamp 均可解析（含带时区偏移的 RFC3339）
    #[test]
    fn test_timestamp_formats() {
        let num_ts = 1_760_000_000_000i64;
        let num_line = json!({"type":"user","origin":{"kind":"human"},"cwd":"/p",
            "timestamp":num_ts,"message":{"content":"数字时间"}});
        let rfc = "2026-09-28T21:05:00+08:00";
        let rfc_line = json!({"type":"user","origin":{"kind":"human"},"cwd":"/p",
            "timestamp":rfc,"message":{"content":"字符串时间"}});
        let p = write_fixture(&format!("{num_line}\n{rfc_line}\n"));
        let r = parse_file(&p.to_string_lossy(), 0).unwrap();
        assert_eq!(r.events.len(), 2);
        assert_eq!(r.events.iter().find(|e| e.text == "数字时间").unwrap().ts, num_ts);
        assert_eq!(r.events.iter().find(|e| e.text == "字符串时间").unwrap().ts, rfc3339_ms(rfc));
    }

    /// assistant_tail 每次调用只保留末 3 条；human 不受影响；整体按 ts 升序
    #[test]
    fn test_assistant_tail_keep_last_3() {
        let mut content = String::new();
        for i in 1..=6 {
            let ts = format!("2026-09-28T0{i}:00:00.000Z");
            let line = json!({"type":"assistant","cwd":"/p","timestamp":ts,
                "message":{"role":"assistant","content":[{"type":"text","text":format!("消息{i}")}]}});
            content.push_str(&line.to_string());
            content.push('\n');
        }
        let human = json!({"type":"user","origin":{"kind":"human"},"cwd":"/p",
            "timestamp":"2026-09-28T07:00:00.000Z","message":{"content":"人类输入"}});
        content.push_str(&human.to_string());
        content.push('\n');

        let r = parse_file(&write_fixture(&content).to_string_lossy(), 0).unwrap();
        let tails: Vec<&AiEvent> = r.events.iter().filter(|e| e.kind == "assistant_tail").collect();
        assert_eq!(tails.len(), 3);
        assert_eq!(tails.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), ["消息4", "消息5", "消息6"]);
        // human 事件保留
        assert!(r.events.iter().any(|e| e.kind == "human_prompt" && e.text == "人类输入"));
        // 整体 ts 升序
        let mut ts_sorted = true;
        for w in r.events.windows(2) {
            if w[0].ts > w[1].ts {
                ts_sorted = false;
            }
        }
        assert!(ts_sorted);
    }

    /// UTF-8 截断按 char 边界：human 200 / assistant 500，不切坏汉字
    #[test]
    fn test_utf8_truncation() {
        let h = "汉".repeat(250);
        let a = "字".repeat(600);
        let l1 = json!({"type":"user","origin":{"kind":"human"},"cwd":"/p",
            "timestamp":"2026-09-28T01:00:00.000Z","message":{"content":h}});
        let l2 = json!({"type":"assistant","cwd":"/p",
            "timestamp":"2026-09-28T02:00:00.000Z",
            "message":{"role":"assistant","content":[{"type":"text","text":a}]}});
        let r = parse_file(&write_fixture(&format!("{l1}\n{l2}\n")).to_string_lossy(), 0).unwrap();
        let hp = r.events.iter().find(|e| e.kind == "human_prompt").unwrap();
        assert_eq!(hp.text.chars().count(), 200);
        assert!(hp.text.chars().all(|c| c == '汉'));
        let at = r.events.iter().find(|e| e.kind == "assistant_tail").unwrap();
        assert_eq!(at.text.chars().count(), 500);
        assert!(at.text.chars().all(|c| c == '字'));
    }

    /// todo 三工具与新旧字段兼容；同一 assistant 行 text+tool_use 双事件
    #[test]
    fn test_todo_tool_variants() {
        let ts = "2026-09-28T01:00:00.000Z";
        let old_field = json!({"type":"assistant","cwd":"/p","timestamp":ts,
            "message":{"role":"assistant","content":[{"type":"tool_use","name":"TaskCreate",
            "input":{"content":"旧字段任务"}}]}});
        let update = json!({"type":"assistant","cwd":"/p","timestamp":ts,
            "message":{"role":"assistant","content":[{"type":"tool_use","name":"TaskUpdate",
            "input":{"subject":"改名","status":"done"}}]}});
        let write = json!({"type":"assistant","cwd":"/p","timestamp":ts,
            "message":{"role":"assistant","content":[{"type":"tool_use","name":"TodoWrite",
            "input":{"todos":[{"content":"买牛奶","status":"pending"}]}}]}});
        let mixed = json!({"type":"assistant","cwd":"/p","timestamp":ts,
            "message":{"role":"assistant","content":[
                {"type":"text","text":"我建个任务"},
                {"type":"tool_use","name":"TaskCreate","input":{"subject":"混合行任务"}}]}});
        let other = json!({"type":"assistant","cwd":"/p","timestamp":ts,
            "message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash",
            "input":{"command":"ls"}}]}});
        let p = write_fixture(&format!("{old_field}\n{update}\n{write}\n{mixed}\n{other}\n"));
        let r = parse_file(&p.to_string_lossy(), 0).unwrap();

        let todos: Vec<&AiEvent> = r.events.iter().filter(|e| e.kind == "todo_tool").collect();
        assert_eq!(todos.len(), 4); // Bash 工具不算
        let by_subject = |s: &str| todos.iter().find(|e| e.todo.as_ref().unwrap().subject == s).unwrap();

        let t = by_subject("旧字段任务").todo.as_ref().unwrap();
        assert_eq!((t.action.as_str(), t.status.as_deref()), ("create", None));
        let t = by_subject("改名").todo.as_ref().unwrap();
        assert_eq!((t.action.as_str(), t.status.as_deref()), ("update", Some("done")));
        let t = by_subject("(待办快照)").todo.as_ref().unwrap();
        assert_eq!((t.action.as_str(), t.status.as_deref()), ("write", None));
        let snap = by_subject("(待办快照)");
        assert!(snap.text.starts_with('{') && snap.text.contains("买牛奶")); // 前端解析 todos 用
        // 同行 text+tool_use：两类事件都发
        assert!(r.events.iter().any(|e| e.kind == "assistant_tail" && e.text == "我建个任务"));
        assert!(todos.iter().any(|e| e.todo.as_ref().unwrap().subject == "混合行任务"));
    }

    /// from_byte 行对齐：行首偏移不丢行、行中偏移跳到下一个 \n、越界返回空
    #[test]
    fn test_from_byte_alignment() {
        let l1 = json!({"type":"user","origin":{"kind":"human"},"cwd":"/p",
            "timestamp":"2026-09-28T01:00:00.000Z","message":{"content":"第一条"}});
        let l2 = json!({"type":"user","origin":{"kind":"human"},"cwd":"/p",
            "timestamp":"2026-09-28T02:00:00.000Z","message":{"content":"第二条"}});
        let l3 = json!({"type":"user","origin":{"kind":"human"},"cwd":"/p",
            "timestamp":"2026-09-28T03:00:00.000Z","message":{"content":"第三条"}});
        let content = format!("{l1}\n{l2}\n{l3}\n");
        let p = write_fixture(&content);
        let path = p.to_string_lossy().to_string();

        // 全量：3 条
        let r = parse_file(&path, 0).unwrap();
        assert_eq!(r.events.len(), 3);

        // 行首偏移（第 2 条的起始字节，即第 1 个 \n 之后）：l2/l3 都在，不丢 l2
        let l2_start = (content.find('\n').unwrap() + 1) as u64;
        let r = parse_file(&path, l2_start).unwrap();
        assert_eq!(r.parse_errors, 0);
        assert_eq!(
            r.events.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(),
            ["第二条", "第三条"]
        );

        // 行中偏移（字节 5）：对齐到下一个 \n，l1 残段丢弃不算坏行，l2/l3 完整
        let r = parse_file(&path, 5).unwrap();
        assert_eq!(r.parse_errors, 0);
        assert_eq!(
            r.events.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(),
            ["第二条", "第三条"]
        );

        // 越界：空事件
        let r = parse_file(&path, content.len() as u64 + 10).unwrap();
        assert_eq!(r.events.len(), 0);
        assert_eq!(r.parse_errors, 0);
        assert_eq!(r.size_bytes, content.len() as u64);

        let _ = std::fs::remove_file(&p);
    }

    /// ai_session_list：扫 .jsonl、跳过隐藏/node_modules、尾部 8KB 取最后时间戳、root 不存在跳过
    #[test]
    fn test_list_scan_and_tail_ts() {
        let dir = write_dir("list");
        let ts1 = "2026-09-28T01:00:00.000Z";
        let ts2 = "2026-09-28T02:00:00.000Z";
        let body = format!(
            "{}\n{}\n",
            json!({"type":"user","cwd":"/p","timestamp":ts1,"message":{"content":"a"}}),
            json!({"type":"user","cwd":"/p","timestamp":ts2,"message":{"content":"b"}})
        );
        let main = dir.join("a.jsonl");
        std::fs::write(&main, &body).unwrap();
        // 应被跳过的：隐藏目录、node_modules、非 jsonl 后缀
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        std::fs::write(dir.join(".hidden/b.jsonl"), &body).unwrap();
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("node_modules/c.jsonl"), &body).unwrap();
        std::fs::write(dir.join("d.txt"), &body).unwrap();

        let list = list_blocking(&[dir.to_string_lossy().to_string()], 0);
        assert_eq!(list.len(), 1);
        let s = &list[0];
        assert!(s.file.ends_with("a.jsonl"));
        assert_eq!(s.provider, "claude-code");
        assert_eq!(s.size_bytes, body.len() as u64);
        assert!(s.last_modified > 0);
        assert_eq!(s.last_event_ts, Some(rfc3339_ms(ts2)));
        // 7 天回看同样命中（文件刚写，mtime 新）
        assert_eq!(list_blocking(&[dir.to_string_lossy().to_string()], 7).len(), 1);
        // root 不存在：跳过不报错
        assert!(list_blocking(&["/nonexistent-daylog-xyz".to_string()], 0).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// cwd 聚合：按 (cwd, gitBranch) 去重，sessions=文件数，lastTs=最大时间戳
    #[test]
    fn test_cwds_summarize() {
        let dir = write_dir("cwds");
        let t1 = rfc3339_ms("2026-09-27T01:00:00.000Z");
        let t2 = rfc3339_ms("2026-09-28T02:00:00.000Z");
        let t3 = rfc3339_ms("2026-09-28T03:00:00.000Z");
        let t4 = rfc3339_ms("2026-09-28T09:00:00.000Z");
        // 文件 1：/a+main 两行（同文件同组合只计 1 session）+ /b 无分支一行
        let f1 = format!(
            "{}\n{}\n{}\n",
            json!({"type":"user","cwd":"/a","gitBranch":"main","timestamp":t1,"message":{"content":"1"}}),
            json!({"type":"user","cwd":"/a","gitBranch":"main","timestamp":t2,"message":{"content":"2"}}),
            json!({"type":"user","cwd":"/b","timestamp":t3,"message":{"content":"3"}})
        );
        // 文件 2：/a+main 一行
        let f2 = format!(
            "{}\n",
            json!({"type":"user","cwd":"/a","gitBranch":"main","timestamp":t4,"message":{"content":"4"}})
        );
        std::fs::write(dir.join("s1.jsonl"), &f1).unwrap();
        std::fs::write(dir.join("s2.jsonl"), &f2).unwrap();

        let out = summarize_cwds(&dir, 0);
        assert_eq!(out.len(), 2);
        let main_row = out.iter().find(|c| c.cwd == "/a" && c.git_branch.as_deref() == Some("main")).unwrap();
        assert_eq!((main_row.sessions, main_row.last_ts, main_row.provider.as_str()), (2, Some(t4), "claude-code"));
        let b_row = out.iter().find(|c| c.cwd == "/b").unwrap();
        assert_eq!(b_row.git_branch, None);
        assert_eq!((b_row.sessions, b_row.last_ts), (1, Some(t3)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Codex rollout 解析：session_meta/turn_context 维护 cwd（后写覆盖）、event_msg(user_message)
    /// →human_prompt、assistant 取 content[] 的 output_text 拼接、role=user 注入噪音跳过、无 gitBranch；
    /// from_byte 续读靠头部嗅探恢复最近 cwd
    #[test]
    fn test_codex_parse() {
        let base = write_dir("codex");
        let sess = base.join(".codex/sessions/2026/09/13");
        std::fs::create_dir_all(&sess).unwrap();
        let meta = json!({"timestamp":"2026-09-13T01:00:00.000Z","type":"session_meta",
            "payload":{"cwd":"/Users/xdd/dev/projA"}});
        let h1 = json!({"timestamp":"2026-09-13T01:01:00.000Z","type":"event_msg",
            "payload":{"type":"user_message","message":"帮我重构解析器"}});
        let turn = json!({"timestamp":"2026-09-13T01:10:00.000Z","type":"turn_context",
            "payload":{"cwd":"/Users/xdd/dev/projB"}});
        let h2 = json!({"timestamp":"2026-09-13T01:11:00.000Z","type":"event_msg",
            "payload":{"type":"user_message","message":"继续，改扫描层"}});
        let asst = json!({"timestamp":"2026-09-13T01:12:00.000Z","type":"response_item",
            "payload":{"type":"message","role":"assistant","content":[
                {"type":"output_text","text":"好的"},{"type":"output_text","text":"已完成扫描层重构"}]}});
        let echo = json!({"timestamp":"2026-09-13T01:13:00.000Z","type":"response_item",
            "payload":{"type":"message","role":"user","content":[
                {"type":"input_text","text":"<environment_context>…"}]}});
        let other = json!({"timestamp":"2026-09-13T01:14:00.000Z","type":"event_msg",
            "payload":{"type":"agent_message","message":"assistant 消息（走 response_item，防双计）"}});
        let p = sess.join("rollout-test.jsonl");
        std::fs::write(&p, format!("{meta}\n{h1}\n{turn}\n{h2}\n{asst}\n{echo}\n{other}\n")).unwrap();
        let path = p.to_string_lossy().to_string();

        let r = parse_file(&path, 0).unwrap();
        assert_eq!(r.parse_errors, 0);
        // human×2 + assistant_tail×1；role=user 回显与 agent_message 不产事件
        assert_eq!(r.events.len(), 3);
        assert!(r.events.iter().all(|e| e.provider == "codex" && e.git_branch.is_none()));

        let humans: Vec<&AiEvent> = r.events.iter().filter(|e| e.kind == "human_prompt").collect();
        assert_eq!(humans.len(), 2);
        assert_eq!(
            (humans[0].cwd.as_str(), humans[0].text.as_str()),
            ("/Users/xdd/dev/projA", "帮我重构解析器")
        );
        assert_eq!(
            (humans[1].cwd.as_str(), humans[1].text.as_str()),
            ("/Users/xdd/dev/projB", "继续，改扫描层")
        );
        let tail = r.events.iter().find(|e| e.kind == "assistant_tail").unwrap();
        assert_eq!(tail.text, "好的\n已完成扫描层重构"); // 多 output_text 块拼接
        assert_eq!(tail.cwd, "/Users/xdd/dev/projB"); // turn_context 后写覆盖 session_meta

        // from_byte 续读（跳过 meta/turn 头部）：嗅探恢复最近 cwd=projB，h2/asst 正常解析
        let off = (meta.to_string().len() + h1.to_string().len() + turn.to_string().len() + 3) as u64;
        let r2 = parse_file(&path, off).unwrap();
        assert_eq!(r2.events.len(), 2);
        assert!(r2.events.iter().all(|e| e.cwd == "/Users/xdd/dev/projB"));
        assert!(r2.events.iter().any(|e| e.kind == "human_prompt" && e.text == "继续，改扫描层"));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Codex cwd 聚合：payload.cwd 计权 + provider=codex + gitBranch=null；消息行无 cwd 不参与
    #[test]
    fn test_cwds_codex() {
        let base = write_dir("cwdscodex");
        let root = base.join(".codex/sessions/2026/09/13");
        std::fs::create_dir_all(&root).unwrap();
        let meta = json!({"timestamp":"2026-09-13T01:00:00.000Z","type":"session_meta",
            "payload":{"cwd":"/p/codex"}});
        let turn = json!({"timestamp":"2026-09-13T02:00:00.000Z","type":"turn_context",
            "payload":{"cwd":"/p/other"}});
        let msg = json!({"timestamp":"2026-09-13T03:00:00.000Z","type":"event_msg",
            "payload":{"type":"user_message","message":"hi"}});
        std::fs::write(root.join("rollout-a.jsonl"), format!("{meta}\n{turn}\n{msg}\n")).unwrap();

        let out = summarize_cwds(&root, 0);
        assert_eq!(out.len(), 2); // 消息行不产 cwd；turn_context 的 /p/other 独立成行
        let row = out.iter().find(|c| c.cwd == "/p/codex").unwrap();
        assert_eq!(
            (row.provider.as_str(), row.git_branch.as_deref(), row.sessions),
            ("codex", None, 1)
        );
        assert_eq!(row.last_ts, Some(rfc3339_ms("2026-09-13T01:00:00.000Z")));
        assert!(out.iter().any(|c| c.cwd == "/p/other"));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// ai_session_list 对 codex 文件打 provider 标（root 直指 sessions 日期目录，.codex 在根之上不参与遍历）
    #[test]
    fn test_list_provider_codex() {
        let base = write_dir("listcodex");
        let root = base.join(".codex/sessions/2026/09/13");
        std::fs::create_dir_all(&root).unwrap();
        let line = json!({"timestamp":"2026-09-13T01:00:00.000Z","type":"session_meta",
            "payload":{"cwd":"/p"}});
        std::fs::write(root.join("rollout-x.jsonl"), format!("{line}\n")).unwrap();
        let list = list_blocking(&[root.to_string_lossy().to_string()], 0);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].provider, "codex");
        assert_eq!(list[0].last_event_ts, Some(rfc3339_ms("2026-09-13T01:00:00.000Z")));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 真实 Codex 冒烟：~/.codex/sessions 有会话则全量解析不应 Err 且 provider 全为 codex；无则跳过
    #[test]
    #[ignore = "依赖真实 ~/.codex 数据，手动 cargo test -- --ignored 运行"]
    fn codex_real_scan() {
        let home = dirs_next::home_dir().expect("取 home 目录失败");
        let root = home.join(".codex").join("sessions");
        let sessions = list_blocking(&[root.to_string_lossy().to_string()], 30);
        for s in sessions.iter().take(3) {
            let r = parse_file(&s.file, 0).expect("真实 codex 会话全量解析不应 Err");
            assert_eq!(r.size_bytes, s.size_bytes);
            assert!(r.events.iter().all(|e| e.provider == "codex"));
        }
    }

    /// 仓库发现：.git 目录/文件均识别、remote 解析（origin 优先）、README 标题、package.json、深度与跳过规则
    #[test]
    fn test_discover_repos() {
        let root = write_dir("disc");
        // repoA：.git 目录 + origin remote + README.md + package.json
        let repo_a = root.join("repoA");
        let git_a = repo_a.join(".git");
        std::fs::create_dir_all(&git_a).unwrap();
        std::fs::write(
            git_a.join("config"),
            "[core]\n\trepositoryformatversion = 0\n[remote \"upstream\"]\n\turl = git@up:x/y.git\n[remote \"origin\"]\n\turl = https://github.com/a/b.git\n\tfetch = +refs\n",
        )
        .unwrap();
        std::fs::write(repo_a.join("README.md"), "说明见下文\n\n# 项目甲\n正文\n").unwrap();
        std::fs::write(repo_a.join("package.json"), "{}").unwrap();
        // repoB：.git 是文件（worktree 指针）→ remote=None，小写 readme.md 无标题行
        let repo_b = root.join("repoB");
        std::fs::create_dir_all(&repo_b).unwrap();
        std::fs::write(repo_b.join(".git"), "gitdir: /elsewhere/.git/worktrees/w1\n").unwrap();
        std::fs::write(repo_b.join("readme.md"), "没有标题的说明\n").unwrap();
        // 深度 3 的嵌套仓库：a/b/c
        let deep = root.join("a/b/c/.git");
        std::fs::create_dir_all(&deep).unwrap();
        // 应跳过的：node_modules 内仓库、隐藏目录内仓库
        let nm = root.join("node_modules/pkg/.git");
        std::fs::create_dir_all(&nm).unwrap();
        let hidden = root.join(".hidden/r/.git");
        std::fs::create_dir_all(&hidden).unwrap();

        let out = discover_repos_blocking(vec![root.to_string_lossy().to_string()], 4);
        let paths: Vec<&str> = out.iter().map(|r| r.path.as_str()).collect();
        assert!(paths.contains(&repo_a.to_string_lossy().to_string().as_str()));
        assert!(paths.contains(&repo_b.to_string_lossy().to_string().as_str()));
        assert!(paths.contains(&deep.parent().unwrap().to_string_lossy().to_string().as_str()));
        assert!(!paths.iter().any(|p| p.contains("node_modules")));
        assert!(!paths.iter().any(|p| p.contains(".hidden")));

        let a = out.iter().find(|r| r.path.contains("repoA")).unwrap();
        assert_eq!(a.remote.as_deref(), Some("https://github.com/a/b.git")); // origin 优先于 upstream
        assert_eq!(a.readme_title.as_deref(), Some("项目甲")); // 首个 # 行，跳过无 # 行
        assert!(a.has_package_json);
        let b = out.iter().find(|r| r.path.contains("repoB")).unwrap();
        assert_eq!(b.remote, None); // .git 是文件 → remote=null
        assert_eq!(b.readme_title, None);
        assert!(!b.has_package_json);

        // 深度约束：max_depth=2 时 c（深度 3）不可达
        let out2 = discover_repos_blocking(vec![root.to_string_lossy().to_string()], 2);
        assert!(!out2.iter().any(|r| r.path.contains("/a/b/c")));
        // root 不存在：空结果不报错
        assert!(discover_repos_blocking(vec!["/nonexistent-daylog-xyz".into()], 4).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 真实数据冒烟：扫 ~/.claude/projects 近 7 天会话，全量解析前几个文件不应 Err。
    /// 依赖本机真实 Claude Code 数据，平时跳过：cargo test -- --ignored
    #[test]
    #[ignore = "依赖真实 ~/.claude 数据，手动 cargo test -- --ignored 运行"]
    fn ai_real_scan() {
        let home = dirs_next::home_dir().expect("取 home 目录失败");
        let root = home.join(".claude").join("projects");
        let sessions = list_blocking(&[root.to_string_lossy().to_string()], 7);
        assert!(!sessions.is_empty(), "近 7 天应能扫到真实会话文件");
        for s in sessions.iter().take(5) {
            let r = parse_file(&s.file, 0).expect("真实会话文件全量解析不应 Err");
            assert_eq!(r.size_bytes, s.size_bytes);
        }
    }
}
