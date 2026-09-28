# 贡献指南

日迹（Daylog）是 Tauri 2 + React 19 的桌面工作日志应用：自动采集 AI 会话与 Git 提交，LLM 整合入库，按策略上报项目管理系统。两条扩展轴对称——**采集侧**（新数据源进来）与**上报侧**（新平台出去），各是一个适配器。

## 环境与门禁

```bash
pnpm install
pnpm build        # tsc --noEmit + vite build，零错零警
pnpm test         # vitest 单测全绿
cd src-tauri && ~/.cargo/bin/cargo check && cargo test
```

所有 PR 必须四条全过；新增功能带单测（`tests/unit/`）。凭据（PAT/API Key）一律走 OS keychain，**任何明文密钥不得进 settings.json、代码或提交历史**。

## 采集适配器（新 AI 工具 / 数据源）

适用：Claude Code、Codex、Cursor 等本地留有会话存储的 AI 工具。

**契约位置**：`src-tauri/src/ai_scan.rs`（Rust 四命令）+ `src/services/collector/types.ts`（TS 镜像类型）。

新增一个 provider 的步骤：

1. **先取样本**：在装有该工具的机器上确认存储布局（路径/格式/schema）。布局不明不排实现——历史上 Codex 从 jsonl 漂移成 SQLite 就是先 spike 后实现。
2. `detect_provider()` 加路径判定分支，返回稳定 provider 标识（进事件指纹，**不可变更**——变了等于全部事件重报）。
3. 解析实现进 `ai_session_parse` 的对应分支：seek + 按行增量读、坏行跳过、未知 type 忽略、`isSidechain` 类噪声过滤。只读，永不写入用户数据。
4. TS 侧 `AiEvent.provider` 联动；`src/services/collector/scan.ts` 的水位线与指纹机制对 provider 透明，无需改动。
5. 健康度：采集中心状态头按 provider 显示正常/降级/不可读；单 provider 解析失败必须隔离降级，不拖垮整体扫描。

**验收口径**：真实样本连扫两遍零重复；人为改坏一行样本只软告警不崩；拔掉该 provider 的目录后状态头如实显示不可读。

## 上报适配器（新项目管理系统）

适用：Jira / TAPD / Teambition / GitHub Issues 等工时填报平台。

**契约位置**：`src/services/reporters/types.ts`（`ReporterAdapter` 接口，签名一字不能差）+ `src/services/reporters/index.ts`（注册表）。

新增一个平台的步骤：

1. 实现 `ReporterAdapter`：`capabilities()` 如实声明（UI 按能力探测渲染——不支持子任务则向导自动隐藏该粒度）；`queryWorkCalendar` 可选，缺省时向导降级为仅本地 sync_log 防重并**明示**用户（不静默装作对账成功）。
2. 认证只支持 `authKind: 'pat'`：PAT 存取复用 `secrets.ts` 的 keychain 机制（service='daylog'，account='<platform>-pat'），明文不落盘。
3. 统一 fetch 封装：超时（15s）+ 401/403 语义化错误（「PAT 无效或过期」）+ 大整数雪花 id 转字符串（防精度丢失）。
4. 端点常量集中一处并标注验证状态（`// 已装机验证` / `// 待装机探测`）。
5. 在 `index.ts` 注册表登记，设置页「上报系统」即可挂载。

**验收口径**：PAT 连接测试通过；一次真实上报 ≤3 点击；重复执行零重单（sync_log 幂等）；部分失败重跑只补缺口（窗口只认最后全成功日）；PAT 错误信息可读；对账 API 不可用时黄条降级不静默。

## 通用约定

- UI 只用 `src/ui/` 原语与 `--dl-*` design token（`src/styles/tokens.css`），不引入组件库；图标 `lucide-react`。
- 数据库迁移：`src-tauri/src/db/migrations.rs` 版本号递增，每条 Migration 单语句、`IF NOT EXISTS` 可重入；迁移前自动备份已内置。
- 出网 LLM 载荷必经 `llm.ts` 脱敏总线，禁止旁路新开通道。
- 工时最小粒度 0.5h 全链路统一；本地记录永远如实，策略只影响上报口径。
- 提交信息中文，格式参照 `git log` 现有风格。
