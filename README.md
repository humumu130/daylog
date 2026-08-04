# 日迹 Daylog

> Windows / macOS 桌面工作日志插件 —— 随手记 → 一键导出日报，AI 自动生成月报 / 季报 / 年报。

Tauri 2 (Rust) + React 19 + TypeScript + Fluent UI v9 + SQLite + Zustand。

应用标识 `com.worklog.app`（决定本地数据目录，请勿更改）。

## 主要功能

- **NL 自然语言捕获**：`#项目` / `@任务` / 耗时（`2h`、`30m`） / 日期关键词（`昨天`、`5号`、`X月X日`） / `;` 多条
- **智能工时**：不填时长按 8h/天均分；满 8h 加班默认 +2h
- **今日页**：时间轴 + 日期导航（← →）+ 进度环统计
- **月历 / 年历视图**：按天总工时 + 项目色点
- **Git 扫描导入**：配置多仓库自动扫描，「原始提交 / 智能整合」（LLM 合并相关提交 + 估耗时 + 去重）双模式，过滤 merge 提交
- **LLM 月报 / 季报 / 年报**：OpenAI 兼容（默认智谱 GLM）；或本地 claude CLI
- **全局搜索**（Ctrl/Cmd + K）、下班提醒、数据备份（导出 / 导入 / 自动备份）、删除确认、错误边界
- 双全局热键、待办桌面浮窗、系统托盘、明暗主题

## 安装与运行

### 前置依赖

- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/)（推荐）或 npm
- [Rust](https://www.rust-lang.org/tools/install) 工具链（`cargo`）

### 本地开发

```bash
pnpm install
pnpm tauri dev
```

### 打包

```bash
# Windows：出 .exe 安装包（NSIS）
pnpm tauri build --bundles nsis

# macOS：universal 包（同时支持 Apple Silicon 和 Intel）
pnpm tauri build --target universal-apple-darwin
```

> Windows 不要用默认的 MSI：中文产品名「日迹」会让 WiX 的 `light.exe` 失败，统一用 NSIS。

## 数据目录

- 数据库：`%AppData%\com.worklog.app\worklog.db`（macOS：`~/Library/Application Support/com.worklog.app/`）
- 自动备份：同目录 `backups/` 下

## 发布流程

打 tag（如 `v1.0.0`）或在 GitHub Actions 页手动触发 `release` workflow，会自动在 macOS + Windows 上构建，产物挂到 Release：

```bash
git tag v1.0.0
git push origin v1.0.0
```

- Windows：`日迹_x.x.x_x64-setup.exe`
- macOS：`日迹_x.x.x_universal.dmg`（首次打开若提示「未识别开发者」，右键 → 打开）

## License

MIT
