# AGENTS.md — Open JSBridge 多 Agent 团队协作规范

> 本文件面向所有参与 `open-jsbridge` 开发的 AI Agent 会话（如 macOS 本地 Codex、云端 Linux Antigravity、Claude Code 等）。
> **静态规则放本文件；动态进度、认领锁、交接与决策统一维护在 [docs/team-status.md](docs/team-status.md)。**

---

## 1. 会话启动必做（Session Bootstrap）

每次开始新任务或恢复工作前，按以下顺序同步上下文：

1. **拉取最新主干**：确认本地状态并 `git fetch origin`，查看 `origin/main` 最新进展。
2. **阅读中心状态看板**：完整阅读 [docs/team-status.md](docs/team-status.md)，重点关注：
   - 当前基线与阻塞事项
   - 已被其他 Agent 认领的任务与**独占 Scope**
   - 是否有指派给当前环境的 **Handoff（交接单）**
   - **共享决策与避坑清单**（严禁在未沟通的情况下推翻已拍板决策）
3. **核对线上实时态（若环境具备 `gh` 权限）**：
   ```sh
   gh pr list --state open --limit 20
   gh issue list --state open --limit 30
   ```
4. **按需阅读规范**：涉及协议、方法契约或三端行为变更前，先读 [docs/protocol.md](docs/protocol.md)、[docs/conformance.md](docs/conformance.md) 与 [docs/native-profiles.md](docs/native-profiles.md)。

---

## 2. 多 Agent 协作 SOP（解耦 + 防撞车）

### 2.1 认领与 Scope 锁定

- **先查再领**：确认目标任务不在「进行中」列表，且待改文件不与其他 `in-progress` 任务的独占 Scope 重叠。
- **登记信息**：在 [docs/team-status.md](docs/team-status.md) 的「进行中与已认领任务」表中新增一行，写清：
  - `Task ID`（递增编号，如 `T-001`）
  - 状态（`planned` / `in-progress` / `handoff-needed` / `in-review` / `blocked` / `done`）
  - 认领方（标明 Agent 与环境角色，如 `linux-agent (antigravity)`、`macos-agent (codex)`）
  - 分支 / PR / 关联 Issue
  - **独占 Scope**（具体到目录或核心文件）
- **热点文件串行原则**：以下共享热点文件同一时间**只允许一个 `in-progress` 任务持有写锁**：
  - `docs/protocol.md`、`spec/protocol/*`
  - `packages/protocol/src/index.ts`、`packages/web-sdk/src/bridge.ts`
  - `examples/native-ios/Sources/NativeIOSHost/WireHost.swift`
  - `examples/native-android/host/src/main/java/dev/openjsbridge/host/RpcSession.kt`
  - 若新任务必须修改已被锁定的热点文件，应标记为 `blocked` 并注明前置依赖，等前序 PR 合入后再基于新 `main` 推进。

### 2.2 分支与 PR 规范

- 统一从最新 `main` 拉出特性分支，禁止直接推送 `main`。
- 推荐分支命名：`<agent>/<short-topic>`（例如 `codex/media-preview`、`antigravity/codegen-ts`）。
- 每个 PR 保持单一主题与清晰边界，标题与正文写明对应 `Task ID` 及关联 Issue（如 `Refs #21`）。

### 2.3 防合并冲突规则（关键）

多个 Agent 并行开发时，按以下规则避免 `docs/team-status.md` 频繁冲突：

1. **表格单行化**：`docs/team-status.md` 的任务表与交接表严格保持「一任务一行」，按 `Task ID` 递增排序。
2. **长上下文独立文件化**：详细的跨 Agent 交接内容（改动清单、未覆盖测试、平台适配注意点等）**不要**大段写进 `docs/team-status.md`，改为在 [docs/handoffs/](docs/handoffs/README.md) 下新建独立文件 `docs/handoffs/<Task-ID>-<slug>.md`，中心看板只保留一行状态与链接。
3. **节制更新频率**：仅在关键状态跃迁（认领开始、进入 `handoff-needed` / `in-review`、阻塞、合入完成，或产生新的团队共享决策）时更新 `docs/team-status.md`。
4. **冲突解决铁律**：若合并时 `docs/team-status.md` 表格尾部发生冲突，**必须保留各方各自的 Task 行并按 `Task ID` 排序，绝不覆盖或删除其他 Agent 的状态行**。

### 2.4 跨环境交接（Handoff）

不同 Agent 环境工具链不同（例如 Linux 云端环境无 Xcode / iOS Simulator）：

- 允许某环境先完成 Spec、Web SDK、Mock、Android 及（按规范编写的）iOS 代码，但**必须诚实标注实际验证范围，不得宣称未运行平台的测试已通过**。
- 需要另一环境接力补端或本地真机/模拟器验收时：
  1. 在 `docs/handoffs/<Task-ID>-<slug>.md` 按模板写清已完成项、待接力项和复现命令；
  2. 在 `docs/team-status.md` 将状态置为 `handoff-needed` 并在「跨 Agent 交接队列」登记目标角色（如 `macos-agent`）；
  3. 接力完成并合入后，收尾 Agent 更新 `docs/team-status.md`（移入「近期已完成」）并清理对应交接单。

---

## 3. 项目工程红线（不可违背）

1. **Spec-first**：协议和标准能力以 `spec/` 与 `docs/protocol.md` 为单一事实来源；实现与规范冲突时先对齐规范并补 conformance 用例。
2. **异步优先，绝不做同步桥接**：所有跨端调用返回异步结果，不引入 `prompt()` 劫持或阻塞 JS 线程的 API。
3. **Web SDK 体积与依赖门禁**：`@open-jsbridge/web` 零运行时依赖、ESM-only、主入口 min+gzip **≤ 7 KiB**（由 `npm run size:web` 校验）。主入口不自动创建默认单例，默认单例在 `@open-jsbridge/web/auto`。
4. **默认安全**：参考宿主只接受精确 HTTPS origin，强绑定 WebView / main frame / document / `sid`；保留业务 JSON 键名，解码仅过滤 `__proto__`（保留 `constructor` / `prototype`）。
5. **标准能力边界**：`request`、WebSocket、Canvas 不进桥；支付、登录、广告等走厂商命名空间；新增标准能力前须先核对 [docs/native-capability-catalog.md](docs/native-capability-catalog.md) 的准入四问与 Issue `#21`。
6. **文档测试约束**：`conformance-tests/shim-docs.test.mjs` 会直接抽取并执行 `docs/native-ios.md`、`docs/native-android.md`、`docs/flutter.md` 中的 JS shim 代码块，修改这三个文档的 shim 示例后务必跑 `npm test`。

---

## 4. 常用本地验证命令

```sh
# 1. Web / Protocol / Mock / Conformance（所有环境均应通过）
npm ci
npm run lint
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

## 5. 文档职责分工

| 文档 / 位置 | 定位 | 更新频率 |
|---|---|---|
| [AGENTS.md](AGENTS.md) | 静态协作规则、工程红线、验证命令 | 低（流程调整时更新） |
| [docs/team-status.md](docs/team-status.md) | 多 Agent 共享动态态：基线、认领锁、交接队列、候选池、共享决策 | 中（任务状态跃迁时小步更新） |
| [docs/handoffs/](docs/handoffs/README.md) | 按任务独立的跨 Agent 详细交接单（零冲突） | 按需创建，任务完结后清理 |
| [TODO.md](TODO.md) | 协议与里程碑级待办清单（M0/M1 等） | 低（里程碑验收时勾选） |
| [CHANGELOG.md](CHANGELOG.md) | 对外版本变更记录 | 发版前更新 |
| GitHub Issues / PRs | 需求讨论、方案评审与代码审查 | 持续 |
