# 日迹 Daylog

> 桌面工作日志应用 —— 自动采集 AI 会话与 Git 提交，LLM 整合入库，按策略上报项目管理系统；个人空间记录成长与复盘。

Tauri 2 (Rust) + React 19 + TypeScript + SQLite（tauri-plugin-sql）+ Zustand。三窗口：主窗、快速记录浮窗、待办浮窗。UI 为自建设计系统（`--dl-*` token，Linear/Raycast 质现代工具风，明暗双主题）。

应用标识 `com.worklog.app`（决定本地数据目录，请勿更改）。

## 工作流：尽量无感

北极星是**把日志填报的人工工作量压到趋近于零**：

1. **自动采集**（后台，启动补扫 + 30 分钟轮询）：读取本地 AI 会话存储（Claude Code，可扩展 Codex 等）与 Git 提交，水位线增量、事件指纹幂等——恰好一次语义，不重不漏。
2. **LLM 整合**：按「日 × 项目」把 AI 会话与 Git 提交交叉合并成成果式条目（同日同项目必进同一次调用）；活跃区间模型估时（消息/提交时间戳切区间，Σ ≤ 当日活跃总时长）；噪音三通道（高置信自动排除留痕可恢复 / 中置信待确认 / 用户判定沉淀规则）。
3. **自动入库**：高置信直接写（带来源徽标），按日撤销 / 单条移除并忽略同类 / 重整合幂等；用户编辑过的条目收养保护。
4. **智能上报**：猪齿鱼 PAT 批量上报三步向导——工时日历对账三分桶（已报勿动 / 已同步 / 待补报）、两档填报策略（如实 / 按目标补齐）、加班按工时边界证据测量（额度只提醒不硬塞）、sync_log 幂等防重、部分失败重跑只补缺口。

出网内容统一经本地脱敏总线（密钥/连接串/内网地址 → 占位符，保语义不保值，可视可审计）；PAT 与 LLM API Key 只存 OS 钥匙串，配置文件零明文。

## 双场景空间

- **工作空间**：工时 / 额度 / 上报 / 报告。
- **个人空间**：成长记录（学到什么 / 练习 / 里程碑 / 想法 / 复盘）、周月复盘卡（实时聚合 + AI 复盘 + 快照）、Obsidian 每日导出（兼容旧 hook 标记区协议，`record/YYYY-MM-DD.md` 续写）。
- 数据与模块按空间隔离（显隐 + 行为守卫双实施），采集引擎共享；首启三选一（只记工作 / 只记个人 / 两者），单空间 = 专用软件体验。

## 主要功能

- **今日页**：时间轴（上午/下午/晚间分组）、行内编辑（时长 ±30m / 项目 / 双击内容）、进度环、日菜单（重整合 / 撤销自动 / 批量上报 / 复制日报）、条目转待办
- **月历**：工时热度底色 + 周合计 + 已上报/手报角标 + 日详情抽屉；年历 12 宫格导航
- **报告**：月 / 季 / 半年 / 年 / 自定义期，AI 按模板生成，Markdown 预览 / 编辑 / 导出
- **采集中心**：源健康度（按 provider）、自动条目、噪音待确认与留痕恢复、未映射 cwd AI 建议认领、Git 手动导入（回溯工具）、聊天记录粘贴解析入库
- **命令面板** ⌘K：动作 / 跳日期 / 记录 / 项目任务全键盘
- 快速记录与待办浮窗（AI 采集待办自动分组，会话完成自动划掉）、全局热键、系统托盘、下班提醒与空白天哨兵、自动备份

## 安装与运行

### 前置依赖

- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install) 工具链（`cargo`）

### 本地开发

```bash
pnpm install
pnpm tauri dev
```

### 打包

```bash
# macOS
pnpm tauri build

# Windows：出 .exe 安装包（NSIS）
pnpm tauri build --bundles nsis
```

### 质量门禁

```bash
pnpm build   # tsc --noEmit + vite build
pnpm test    # vitest 单测
cd src-tauri && cargo check && cargo test
```

## 配置

- **LLM**：OpenAI 兼容云端 API（默认智谱 GLM）或本地 claude CLI（不出网）；API Key 存 OS 钥匙串
- **采集**：扫描根 / 回看天数 / 噪音严格度 / 脱敏开关 / 工时边界（上/下班时间、周末与早到计入加班）
- **上报**：猪齿鱼 API 地址 + PAT（钥匙串）+ 项目映射（规则初筛 + AI 精配，宁空勿错）+ 映射健康检查

扩展开发（新 AI 工具数据源 / 新上报平台）见 [CONTRIBUTING.md](./CONTRIBUTING.md)——双适配器架构，各是一个适配器的工作量。

## 数据

SQLite 单源（`worklog.db`）：records / projects / tasks / workspaces / collector_state（水位线）/ ingested_events（指纹）/ noise_reviews / consolidate_runs / choerodon_sync_log（上报幂等）/ retrospectives。迁移版本化（migrations.rs），迁移前自动备份。
