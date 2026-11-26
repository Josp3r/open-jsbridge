# 多 Agent 团队状态看板（Team Status）

> 协作规范、Scope 锁与防冲突规则见根目录 [AGENTS.md](../AGENTS.md)。
> 本文件是所有 Agent 会话共享动态进展的中心入口：**开工前必读，状态跃迁时小步更新，长上下文交接写到 [docs/handoffs/](handoffs/README.md)。**

---

## 1. 当前基线快照（Baseline Snapshot）

- **最新主干基线**：`main` @ `1a1b580`（最后更新日期：`2026-11-26`）
- **版本线状态**：
  - 协议版本 `jsb`：`1.0`（Draft）
  - 三端 SDK 候选版本：Web `@open-jsbridge/web`、iOS SwiftPM `NativeIOSHost`、Android Maven `io.github.josp3r:open-jsbridge-android` 均对齐 **`0.2.0` 候选**（npm 线上稳定版仍为 `0.1.0`，`0.2.0` 走 `next` 频道）
- **首批 v1 标准能力（7 / 7 已合入 `main`）**：
  - 方法：`device.getInfo@1`、`network.getStatus@1`、`ui.toast.show@1`、`media.chooseMedia@1`
  - 事件：`network.statusChanged`、`app.foregrounded`、`app.backgrounded`
- **当前发版 / 验收阻塞项**：
  - 正式 SwiftPM `0.2.0` 标签与 Maven Central 发布等待 **Android 10–12 真机 Photo Picker 验收**完成（详见 [docs/native-release.md](native-release.md) 与 [CHANGELOG.md](../CHANGELOG.md)）。
- **主干活跃 Issue**：
  - `#21`：v1 标准能力集（首批 7 项与 26 项后续候选）
  - `#24`：媒体句柄 + 原生预览/上传方案（首批单图选图已落地，预览/上传/释放待后续推进）

---

## 2. Agent 角色与环境能力矩阵

不同会话具备不同工具链，认领任务或发起交接时请使用下表中的角色标识：

| 角色标识 | 典型会话 / 环境 | 可本地验证范围 | 局限与交接约定 |
|---|---|---|---|
| `macos-agent` | 本地 macOS（如 Codex worktree + Xcode） | Web/Mock、SwiftPM、iOS Release Simulator、Xcode 真机、Android JVM | 负责 iOS 编译/模拟器验收与双端发版验收 |
| `linux-agent` | 云端 Ubuntu 24.04（如 Antigravity VM） | Spec、Web SDK/Mock、Conformance、Android JVM/Gradle、GitHub CLI | 无本地 Swift/Xcode；涉及 Swift 改动时靠 GitHub Actions CI 或写交接单给 `macos-agent` |
| `other-agent` | 其他会话环境 | 按实际可用工具链在认领时注明 | 严格遵循 `AGENTS.md` 中的诚实验证原则 |

---

## 3. 进行中与已认领任务（Active Claims & Scope Locks）

> 状态流转：`planned` → `in-progress` → `handoff-needed` / `in-review` / `blocked` → `done`
> **冲突规则**：按 `Task ID` 递增单行维护；合并冲突时保留双方各自 Task 行，严禁覆盖他人状态。

| Task ID | 任务 | 状态 | 认领方 | 分支 / PR / Issue | 独占 Scope（文件/目录） | 备注 / 交接单 | 更新日期 |
|---|---|---|---|---|---|---|---|
| `T-002` | Schema Lint 与 TS Codegen 脚手架（`packages/codegen`） | `in-review` | `linux-agent (antigravity)` | `antigravity/codegen-ts` | `packages/codegen/**`, `scripts/codegen.mjs`, `packages/web-sdk/src/generated/**`, `packages/web-sdk/src/index.ts`, `conformance-tests/codegen.test.mjs`, `package.json`, `.github/workflows/conformance.yml` | 已实现 spec lint + Ajv 2020-12 校验 + TS 类型生成与 CI 漂移检查 | 2026-11-26 |

---

## 4. 跨 Agent 交接队列（Handoff Queue）

> 当某任务需要另一环境接力补全或验收时登记在此，详细上下文写入 `docs/handoffs/<Task-ID>-<slug>.md`。

| Task ID | 发起方 | 目标角色 | 交接事项 | 交接单 / PR | 状态 |
|---|---|---|---|---|---|
| — | — | — | 当前无待交接事项 | — | — |

---

## 5. 待认领候选池（Ready to Claim）

以下任务已按解耦程度、前置依赖与 Issue `#21`/`#24`/路线图整理，新会话可直接认领（认领后将条目迁入第 3 节并分配 `Task ID`）：

| 候选方向 | 建议优先级 | 建议角色 | 预估主要 Scope | 关联来源 / 说明 |
|---|---|---|---|---|
| **提取参考 `host-core` + 增强 `@open-jsbridge/web/mock`** | 高 | `linux-agent` / `macos-agent` | `packages/web-mock/**`, `conformance-tests/**` | 补齐 `media.chooseMedia`、`bridge.cancel`、`latency`/`failNext` mock，为 RN 方案 A 与差分测试打底 |
| **Issue #21 文档验收收口与 `TODO.md` 核对** | 高 | `linux-agent` / `macos-agent` | `docs/native-capability-catalog.md`, `README.md`, `TODO.md` | 核对 #21 验收项（明确 `request`/WebSocket/Canvas 不进桥、厂商前缀、`wx-compat` 定位）及 `SEC-JSI-DEFAULT-001` 回归状态 |
| **媒体句柄闭环：`media.release@1` + `media.preview@1`** | 中高 | `linux-agent` + `macos-agent` 接力 | `spec/methods/media/**`, `packages/web-sdk/src/media*`, `examples/native-android/**`, `examples/native-ios/**` | Refs #24, #21；补齐单图选择后的主动释放与原生全屏预览 |
| **流式回调协议 `bridge.progress`（`onCallback`）** | 中 | `linux-agent` | `spec/protocol/**`, `packages/web-sdk/src/bridge.ts`, `packages/web-mock/**`, `conformance-tests/**` | [docs/protocol.md](protocol.md) §8；是 `transfer.progress` 与持续流能力的前置依赖（注意 Web core ≤ 7 KiB 门禁） |
| **Web SDK 插件管线（`use(plugin)` / `onMetric`）与 `BrowserFallbackAdapter`** | 中 | `linux-agent` | `packages/web-sdk/src/**`, `conformance-tests/**` | [docs/web-sdk.md](web-sdk.md) §3 & §6.2；外投浏览器降级与可观测性基础 |
| **下一批标准能力（`ui.dialog.confirm` / `clipboard.*` / `permissions.getState` / `media.scan.qr`）** | 中 | `linux-agent` + `macos-agent` 接力 | `spec/methods/**`, `packages/web-sdk/**`, 双端原生宿主 | Refs #21 建议顺序；每项须先满足 `docs/native-capability-catalog.md` 四问并同步三端与 conformance |
| **`transfer.upload` 契约 RFC 与安全设计** | 中低 | `linux-agent` / `macos-agent` | `docs/protocol.md`, `spec/rfcs/**`（新建） | Refs #24；需先明确上传域名 ACL、宿主鉴权 header 注入、压缩参数与取消/错误码语义 |
| **React Native 方案 A 宿主（`@open-jsbridge/react-native`）** | 中低（依赖 `host-core`） | `linux-agent` / `macos-agent` | `packages/react-native/**` | [docs/react-native.md](react-native.md)；复用 `host-core` 并严格遵循 `trust: degraded` (S2) 约束 |

---

## 6. 共享决策与避坑清单（Shared Decisions & Gotchas）

> 记录已拍板的架构结论和真实踩坑经验，供所有新会话直接复用；新增条目请附日期与来源 PR/Issue。

- **[D-001 | 2026-11-25 | #24, #29] 媒体首版走主 frame RPC 回传有界缩略图，不引入原生 URL Scheme Handler**
  - `WKURLSchemeTask` 与 Android `WebResourceRequest` 在图片子资源请求中缺少可认证的发起 frame/document 会话元数据。
  - 首版 `media.chooseMedia@1` 统一在已验证的主 frame RPC 响应中返回 `id`（128-bit 32 位小写 hex 句柄）与 `thumbnailBase64`（JPEG 长边 ≤ 256 px、解码后 ≤ 32 KiB），Web SDK 转换为 `blob:` `thumbUrl` 并在过期/`pagehide`/`close()` 时撤销。原图留在宿主（5 分钟 / 20 MiB 上限）。
- **[D-002 | 2026-11-25 | #21, #28] 方法与事件命名冻结基线**
  - 新增标准能力方法使用 `domain.verbNoun`（已有 `ui.toast.show` 保留原名）。
  - 标准事件使用「名词 + 过去分词」（如 `network.statusChanged`），命名空间已指明主语时可用过去分词（`app.foregrounded`、`app.backgrounded`）。旧事件名 `network.changed` 已直接删除，禁止回退或混用。
  - `request`、WebSocket、Canvas 不进桥；支付、登录等走厂商命名空间（如 `wechat.pay.request`）；`wx-compat` 规划为可选薄适配层，不进核心包。
- **[D-003 | 2026-11-25 | #30] 安全来源与 JSON 键名保留约束**
  - 参考宿主仅支持一个或多个**精确 HTTPS origin**（`https://host[:port]`），禁止前缀/子串匹配；`rules` JSON 细粒度 ACL 仍属未实现的可选提案。
  - 解码器仅过滤任意层级的 `__proto__` 字段，**必须保留 `constructor` 与 `prototype` 等业务 JSON 键名**。
  - 编码器在入队前做严格 JSON 快照，拒绝 `Date`、访问器、稀疏数组、循环引用、超出安全整数范围的数字等非标准 JSON 值（`-32600` / `-32602`）。
- **[D-004 | 2026-11-26 | #19, #27, #31] Web SDK `0.2.0` 包边界与体积门禁**
  - 仅发布 ESM + TypeScript 声明，零运行时依赖；主入口 `@open-jsbridge/web` 只导出 `createBridge` 与核心类型/错误码，不自动初始化默认单例（默认单例在 `@open-jsbridge/web/auto`，按需能力在 `/app`、`/device`、`/network`、`/ui`、`/media`）。
  - 任何对 `packages/web-sdk` 或 `packages/protocol` 的修改都必须通过 `npm run size:web`（主入口 min+gzip ≤ 7 KiB；当前基线实测 `6498 / 7168 bytes`，剩余约 670 bytes 空间）。
- **[D-005 | 2026-11-25 | #29] Android Photo Picker 兼容策略**
  - 选图强制使用 iOS PHPicker / AndroidX `PickVisualMedia`，禁止为选图申请整库相册权限。
  - Android API 24–32 若设备缺少系统或已安装的 Photo Picker 回移版本，握手时**不声明** `media.chooseMedia`；回移配置由接入 App 自行声明（见 [docs/native-android.md](native-android.md)）。
- **[D-006 | 长期约束] 文档内 Shim 代码块受单测保护**
  - `conformance-tests/shim-docs.test.mjs` 会直接解析并执行 `docs/native-ios.md`、`docs/native-android.md`、`docs/flutter.md` 中的 `js` 代码块；调整这三个文档示例时务必运行 `npm test`。
- **[D-007 | 2026-11-26 | #33 已修复] npm 12 下 `scripts/pack-web.mjs` 兼容问题**
  - npm `12.x` 下 `npm pack --json` 返回按包名索引的对象映射而非数组；`#33` 已在 `scripts/pack-web.mjs` 兼容 npm ≤ 11 数组与 npm 12+ 对象两种格式。

---

## 7. 近期已完成（Recently Completed）

> 仅保留近期关键里程碑条目，完整历史见 `git log` 与 [CHANGELOG.md](../CHANGELOG.md)。

| 完成日期 | 摘要 | PR / Commit |
|---|---|---|
| 2026-11-26 | 修复 `scripts/pack-web.mjs` 对 npm 12 `npm pack --json` 返回格式的兼容 | `#33` (`1a1b580`) |
| 2026-11-26 | `T-001` 建立多 Agent 协作规范 `AGENTS.md`、中心状态看板与零冲突交接单模板 | `#32` (`15dd06d`) |
| 2026-11-26 | Web SDK `0.2.0` 发布与迁移说明（`docs/migrate-0.2.0.md`） | `#31` (`52d94f5`) |
| 2026-11-26 | 三端 `0.2.0` 候选发布工程化与 Android Photo Picker 回移文档 | `#27` (`d7149c2`) |
| 2026-11-25 | 强制精确 HTTPS origin 白名单并保留业务 JSON 键名 | `#30` (`2dec3e2`) |
| 2026-11-25 | Web SDK 生命周期加固（`reconnect` / `close` / `pagehide` 取消 / 参数快照） | `#25` (`0f2ccba`) |
| 2026-11-25 | `media.chooseMedia@1` 句柄 + 有界缩略图三端实现 | `#29` (`a751d82`) |
| 2026-11-25 | 标准事件 `network.statusChanged`、`app.foregrounded`、`app.backgrounded` 与多来源支持 | `#28` (`f2ffb19`) |
