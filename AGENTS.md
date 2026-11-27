# AGENTS.md — Open JSBridge 多 Agent 团队协作规范

> 本文件面向所有参与 `open-jsbridge` 开发的 AI Agent 会话（如 macOS 本地 Codex、云端 Linux Antigravity、Claude Code 等）。
> **协作分层**：
> - **静态规则与红线**：本文件（`AGENTS.md`）
> - **秒级实时控制面（认领锁 / 交接）**：置顶 GitHub Issue **[#41](https://github.com/Josp3r/open-jsbridge/issues/41)**（Append-only 评论流，消除 `main` 未合入前的可见性 Gap）
> - **持久化基线、候选池与共享决策**：[docs/team-status.md](docs/team-status.md)

---

## 1. 会话启动必做（Session Bootstrap）

每次开始新任务或恢复工作前，按以下顺序同步上下文：

1. **拉取最新主干**：确认本地状态并 `git fetch origin`，查看 `origin/main` 最新进展。
2. **读取实时控制面（Issue `#41` + Open PRs）**：
   ```sh
   gh issue view 41 -R Josp3r/open-jsbridge --comments
   gh pr list -R Josp3r/open-jsbridge --state open --limit 20
   gh issue list -R Josp3r/open-jsbridge --state open --limit 30
   ```
   - 根据 `#41` 评论流计算当前仍活跃的 `CLAIM`（尚未收到对应 `DONE`/`RELEASE` 且未超 TTL，或关联 PR 仍处于 `OPEN`）及其独占 Scope 与热点文件锁。
   - 检查是否有指派给当前角色的活跃 `HANDOFF` 交接请求。
3. **阅读持久化基线与决策**：阅读 [docs/team-status.md](docs/team-status.md)，重点关注：
   - 当前版本基线与候选池（Backlog）
   - **共享决策与避坑清单（`D-xxx`）**（严禁在未沟通的情况下推翻已拍板决策）
4. **按需阅读规范**：涉及协议、方法契约或三端行为变更前，先读 [docs/protocol.md](docs/protocol.md)、[docs/conformance.md](docs/conformance.md) 与 [docs/native-profiles.md](docs/native-profiles.md)。

---

## 2. 多 Agent 协作 SOP（实时锁 + 零冲突）

### 2.1 实时认领与乐观锁（GitHub Issue `#41`）

**只追加评论，绝不编辑 `#41` 正文**（保证评论流严格按服务端时间与 Comment ID 全序排列，永不丢失更新）。

1. **先查再领**：确认目标任务和独占 Scope 不与 `#41` 中任何活跃 `CLAIM` 或 open PR 重叠。
2. **发送 `CLAIM` 评论**：
   ```sh
   gh issue comment 41 -R Josp3r/open-jsbridge --body $'### CLAIM · `<branch>` · `<agent-role>`\n- **Task**: `<任务简述>`\n- **Refs**: `#xx`\n- **Scope**: `<独占修改的文件或目录>`\n- **Hot-file Lock**: `<命中的热点文件，或 none>`\n- **TTL**: `60m`'
   ```
3. **乐观锁复核（Tie-breaker）**：发送 `CLAIM` 后立刻再查看一次 `#41` 最近评论；若同一秒内有更早评论（Comment ID 更小）锁定了重叠 Scope，**先到先得**，后来者立即补发一条 `RELEASE` 评论并切换其他任务。
4. **TTL 防死锁**：默认租约 **60 分钟**；若已开启对应 PR，则锁随 PR 生命周期有效直至合并或关闭；超期未开 PR 且未续期视为自动释放。
5. **无需手编递增 `T-00x`**：直接以 **分支名 + 关联 PR/Issue 编号** 作为全局唯一标识，彻底避免并发撞号。
6. **无 `gh` 环境的兜底**：若个别本地受限环境无法调用 `gh`，不得修改已被锁定热点文件，并须在 PR 描述中明确声明 Scope 与环境限制，由维护者或其他 Agent 代为在 `#41` 同步。

### 2.2 热点文件串行原则

以下共享热点文件同一时间**只允许一个活跃 `CLAIM` 持有写锁**：

- `docs/protocol.md`、`spec/protocol/*`
- `packages/protocol/src/index.ts`、`packages/web-sdk/src/bridge.ts`
- `examples/native-ios/Sources/NativeIOSHost/WireHost.swift`
- `examples/native-android/host/src/main/java/dev/openjsbridge/host/RpcSession.kt`

若新任务必须修改已被锁定的热点文件，应等待前序 PR 合入并收到 `DONE`/`RELEASE` 后再基于最新 `main` 推进。

### 2.3 分支、PR 与防合并冲突规则

- 统一从最新 `main` 拉出特性分支，禁止直接推送 `main`。
- 推荐分支命名：`<agent>/<short-topic>`（例如 `codex/transfer-upload-rfc`、`antigravity/react-native-host`）。
- 每个 PR 保持单一主题与清晰边界，标题与正文注明关联 Issue（如 `Refs #21`）。
- **低冲突原则**：
  - 瞬态认领/释放/交接统一走 **Issue `#41` 评论**，功能 PR 无需仅为“抢锁”修改 `docs/team-status.md`，从而显著减少并行 PR 的 Git 合并冲突。
  - 仅当产生新的团队共享决策（`D-xxx`）、调整候选池或里程碑收尾时，小步更新 `docs/team-status.md`；若合并时表格冲突，**必须保留各方条目，绝不覆盖或删除其他 Agent 的记录**。
  - PR 合并或放弃后，立刻在 `#41` 补发一条 `### DONE · PR #xx`（或 `### RELEASE`）评论释放 Scope 锁。

### 2.4 跨环境交接（Handoff）

不同 Agent 环境工具链不同（例如 Linux 云端环境无 Xcode / iOS Simulator）：

- 允许某环境先完成 Spec、Web SDK、Mock、Android 及（按规范编写的）iOS 代码，但**必须诚实标注实际验证范围，不得宣称未运行平台的测试已通过**。
- 需要另一环境接力补端或本地真机/模拟器验收时：
  1. 若交接上下文较长，在 [docs/handoffs/](docs/handoffs/README.md) 下新建独立文件 `docs/handoffs/pr-<num>-<slug>.md`（一任务一文件，零冲突）；
  2. 在 Issue `#41` 发送 `### HANDOFF · PR #xx · <from> → <to-role>` 评论，附已验证项、待接力项和交接单路径；
  3. 接力完成并合入后，收尾 Agent 在 `#41` 发送 `### DONE` 评论并清理对应交接单文件。

### 2.5 停止扩张与准入规则（1.0 收尾期 / 维护模式）

为避免项目无限扩张或出现未经评审的新增包/新表面，所有 Agent MUST 遵守以下边界：

- **停止规则**：当 [docs/team-status.md](docs/team-status.md) 候选池中**没有 `高` 优先级项**，且待决议事项没有维护者新结论时，Agent **MUST NOT 自行开新功能任务或从低优/推迟池中挑活**；此时仅可在 Issue `#41` 报告空闲并等待维护者指令（明确指派的 bugfix、安全修复或平台兼容修复除外）。
- **准入审批（`D-012`）**：新增 `packages/*`、新增 `@open-jsbridge/web/*` 子路径或新增标准能力命名空间前，MUST 先在对应 Issue（如 `#21`）通过 [docs/native-capability-catalog.md](docs/native-capability-catalog.md) 准入四问并取得维护者明确批准，未经批准不得认领或开分支。
- **1.0 达标后转入维护模式**：满足 [TODO.md](TODO.md) 中的「1.0 退出标准」后，仓库默认只接受 bugfix、安全修复与平台兼容跟进，不再主动扩展能力面。

---

## 3. 项目工程红线（不可违背）

1. **Spec-first**：协议和标准能力以 `spec/` 与 `docs/protocol.md` 为单一事实来源；修改 `spec/` 后必须运行 `npm run codegen:ts` 并通过 `npm run codegen:check`。
2. **异步优先，绝不做同步桥接**：所有跨端调用返回异步结果，不引入 `prompt()` 劫持或阻塞 JS 线程的 API。
3. **Web SDK 包边界与体积观测**：`@open-jsbridge/web` 零运行时依赖、ESM-only，主入口不自动创建默认单例（默认单例在 `@open-jsbridge/web/auto`）。`npm run size:web` 保留为 CI 体积观测输出（非阻断，见 `D-011`）。
4. **默认安全**：参考宿主只接受精确 HTTPS origin，强绑定 WebView / main frame / document / `sid`；缺少可信来源信息的通道默认停用（`trust: degraded` 必须显式 opt-in，遵循 protocol S2）；解码仅过滤 `__proto__`（保留 `constructor` / `prototype`）。
5. **标准能力边界**：`request`、WebSocket、Canvas 不进桥；支付、登录、广告等走厂商命名空间；新增标准能力前须先核对 [docs/native-capability-catalog.md](docs/native-capability-catalog.md) 的准入四问与 Issue `#21` 并获维护者批准。
6. **文档测试约束**：`conformance-tests/shim-docs.test.mjs` 会直接抽取并执行 `docs/native-ios.md`、`docs/native-android.md`、`docs/flutter.md` 中的 JS shim 代码块，修改这三个文档的 shim 示例后务必跑 `npm test`。

---

## 4. 常用本地验证命令

```sh
# 1. Web / Protocol / Codegen / Mock / Conformance（所有环境均应通过）
npm ci
npm run lint
npm run codegen:check
npm test
npm run size:web
node --test examples/native-android/test/shim.test.mjs

# 2. Android JVM 单测与构建（需 JDK 17+ 与 Android SDK）
./examples/native-android/gradlew -p examples/native-android --no-daemon :host:testDebugUnitTest

# 3. iOS SwiftPM 单测（仅 macOS + Swift 工具链）
swift test --package-path examples/native-ios --skip WebKitHostTests
```

完整 CI 矩阵（含 macOS iOS Release WebView 模拟器与 Ubuntu Android Release WebView 模拟器）见 [.github/workflows/conformance.yml](.github/workflows/conformance.yml)。

---

## 5. 文档与控制面职责分工

| 位置 | 定位 | 更新频率 |
|---|---|---|
| [AGENTS.md](AGENTS.md) | 静态协作规则、工程红线、验证命令 | 低（流程调整时更新） |
| GitHub 置顶 Issue [#41](https://github.com/Josp3r/open-jsbridge/issues/41) | **秒级实时控制面**：`CLAIM` 锁、热点文件锁、`HANDOFF`、`DONE`/`RELEASE` | 实时（Append-only 评论） |
| [docs/team-status.md](docs/team-status.md) | **持久化团队知识**：当前基线、角色能力矩阵、候选池、共享决策（`D-xxx`）、近期里程碑 | 低至中（里程碑或新决策时） |
| [docs/handoffs/](docs/handoffs/README.md) | 按任务独立的跨 Agent 详细交接单（零冲突） | 按需创建，任务完结后清理 |
| [TODO.md](TODO.md) | 协议与里程碑级待办清单（M0/M1 等） | 低（里程碑验收时勾选） |
| [CHANGELOG.md](CHANGELOG.md) | 对外版本变更记录 | 发版前更新 |
| 其他 GitHub Issues / PRs | 需求讨论、方案评审与代码审查 | 持续 |
