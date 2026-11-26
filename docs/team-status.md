# 多 Agent 团队基线与共享决策（Team Status）

> 协作规范与工程红线见根目录 [AGENTS.md](../AGENTS.md)。
>
> **实时认领锁、热点文件锁与跨端交接队列已迁移至置顶 GitHub Issue [#41](https://github.com/Josp3r/open-jsbridge/issues/41)**（秒级可见，Append-only 评论流，消除 `main` 合入前窗口期）。开工前请运行：
> ```sh
> gh issue view 41 -R Josp3r/open-jsbridge --comments
> gh pr list -R Josp3r/open-jsbridge --state open --limit 20
> ```
> 本文件专注沉淀**持久化团队信息**：当前基线、环境能力矩阵、三端能力对齐矩阵、待认领候选池、待决议事项、共享决策/避坑清单与近期已完成里程碑。
>
> **维护约定**：每合入一个改变能力边界或候选池的功能 PR 后，收尾 Agent 应顺手（或在下一个文档 PR 中）同步本文件 §1、§3、§4、§7，避免后续会话认领已完成的任务。

---

## 1. 当前基线快照（Baseline Snapshot）

- **最新主干基线**：`main` @ `a56de2c`（最后更新日期：`2026-11-26`）
- **本地验证基线**（`linux-agent`，`a56de2c`）：`npm test` 236/236、`npm run codegen:check` 通过、`npm run size:web` **`7127 / 7168 bytes`（仅剩 41 bytes，见 §5 O-001）**
- **版本线状态**：
  - 协议版本 `jsb`：`1.0`（Draft）
  - 仓库已于 `52d94f5` 打上 **`0.2.0`** 标签；三端 SDK（Web `@open-jsbridge/web`、iOS SwiftPM `NativeIOSHost`、Android Maven `io.github.josp3r:open-jsbridge-android`）对齐 `0.2.0`
  - `0.2.0` 之后合入的能力尚未发版，记录在 [CHANGELOG.md](../CHANGELOG.md) 的 `Unreleased` 段；下一版本范围见 §5 O-003
- **v1 标准能力（三端已合入 `main`）**：
  - 方法：`device.getInfo@1`、`network.getStatus@1`、`ui.toast.show@1`、`media.chooseMedia@1`、`media.release@1`
  - 事件：`network.statusChanged`、`app.foregrounded`、`app.backgrounded`
- **已定契约、原生宿主未完成**：`transfer.upload@1`（RFC #44 + Schema/Web/Mock #58；iOS 图片预处理 #47 已合入，详见 §3）
- **Web SDK 子路径**：`/auto`、`/app`、`/device`、`/network`、`/ui`、`/media`、`/transfer`、`/reverse`、`/fallback`、`/mock`
- **仓内参考实现（未单独发布）**：`packages/host-core`、`packages/devtools`、`packages/react-native`、`packages/codegen`、`packages/flutter`（`publish_to: none`）
- **当前发版 / 验收跟进项**：
  - Maven Central 正式发布仍需 Android 10–12 真机 Photo Picker 验收（详见 [docs/native-release.md](native-release.md)），**目前无认领人**（见 §5 O-004）。
- **主干活跃 Issue**：
  - `#41`：**置顶多 Agent 实时认领锁与跨端交接控制面**
  - `#21`：v1 标准能力集（首批 7 项与后续候选）
  - `#24`：媒体句柄 + 原生预览/上传方案（选图、主动释放已三端落地；上传契约已定、原生投递未完成；预览未开始）

---

## 2. Agent 角色与环境能力矩阵

不同会话具备不同工具链，在 Issue `#41` 认领任务或发起交接时请使用下表中的角色标识：

| 角色标识 | 典型会话 / 环境 | 可本地验证范围 | 局限与交接约定 |
|---|---|---|---|
| `macos-agent` | 本地 macOS（如 Codex worktree + Xcode） | Web/Mock、SwiftPM、iOS Release Simulator、Xcode 真机、Android JVM | 负责 iOS 编译/模拟器验收与双端发版验收 |
| `linux-agent` | 云端 Ubuntu 24.04（如 Antigravity VM） | Spec、Web SDK/Mock、Codegen、Conformance、Android JVM/Gradle、GitHub CLI | 无本地 Swift/Xcode；涉及 Swift 改动时靠 GitHub Actions CI 或在 `#41` 发起 `HANDOFF` 给 `macos-agent` |
| `other-agent` | 其他会话环境 | 按实际可用工具链在认领时注明 | 严格遵循 `AGENTS.md` 中的诚实验证原则 |

---

## 3. 三端能力对齐矩阵（Parity Matrix）

> `✅` 已合入 `main`；`🚧` 部分完成或进行中；`—` 未实现。Web 侧能力能否使用仍以握手声明为准，原生宿主未实现时不会声明对应能力。

| 能力 | Web SDK | Mock / `host-core` | iOS 参考宿主 | Android 参考宿主 | 备注 |
|---|---|---|---|---|---|
| 首批 7 项 v1 能力 | ✅ | ✅ | ✅ | ✅ | `0.2.0` |
| `media.release@1` | ✅ #56 | ✅ #56 | ✅ #55 | ✅ #57 | #49 契约 |
| `bridge.progress` 流式回调 | ✅ #38 | ✅ #38 | — | — | Android 仅把入站 `bridge.progress` 当通知忽略；Flutter 已实现 |
| Host → Web 反向调用（§9.2） | ✅ #46（`/reverse`） | ✅ #46 | — | — | Flutter / RN 经 host-core 支持 |
| `transfer.upload@1` | ✅ #58（`/transfer`） | ✅ #58 | 🚧 图片预处理 #47 | 🚧 图片预处理认领中 | 网络投递 + RPC 注册未认领；依赖原生 `bridge.progress` |
| `rules` ACL / 限流（§11.3） | n/a | ✅ #54 | — | — | 原生宿主仍只支持精确 HTTPS origin 白名单 |
| `media.preview@1` | — | — | — | — | 无契约 |

---

## 4. 待认领候选池（Backlog / Ready to Claim）

认领前请先查阅置顶 Issue [#41](https://github.com/Josp3r/open-jsbridge/issues/41) 确认是否已被其他 Agent 抢占；选定后直接在 `#41` 发 `CLAIM` 评论即可开工（无需为认领专门修改本文件）。

| 候选方向 | 建议优先级 | 建议角色 | 预估主要 Scope | 关联来源 / 说明 |
|---|---|---|---|---|
| **原生 `bridge.progress` 发送端（iOS + Android）** | 高 | `linux-agent`（Android）+ `macos-agent`（iOS） | `RpcSession.kt`、`WireHost.swift`（**均为热点文件，须串行**）及对应测试 | `transfer.upload` 原生落地的前置；对齐 [docs/protocol.md](protocol.md) 与 `conformance-tests/progress.test.mjs` 语义 |
| **原生 `transfer.upload@1` 网络投递与 RPC 注册** | 高 | `linux-agent`（Android）+ `macos-agent`（iOS） | 双端宿主上传模块、`RpcSession.kt` / `WireHost.swift` | Refs #24、#44、#58；依赖上一项及双端图片预处理（iOS #47 已合入，Android 认领中） |
| **原生反向调用（§9.2）** | 中 | `linux-agent` + `macos-agent` 接力 | 双端宿主会话层（热点文件） | Web/host-core 已于 #46 落地；原生未实现前不得声明能力 |
| **Flutter Dart 测试接入 CI** | 中 | 具备 Flutter SDK 的环境 | `.github/workflows/conformance.yml` | `packages/flutter/test/flutter_host_test.dart` 目前未在 CI 执行，仅有 Node 侧 shim 测试 |
| **M0 收尾：补两条原生回归用例** | 中 | `macos-agent`（iOS）/ `linux-agent`（Android） | `examples/native-ios/Tests/**`、`examples/native-android/host/src/test/**` | 见 [TODO.md](../TODO.md) M0：iOS 权限链抛错时 handler 零调用并返回 `-32603`；Android 缺少 WebMessageListener 时 `attach` 返回 `null` |
| **`media.preview@1` 契约** | 中 | `macos-agent` / `linux-agent` | `spec/methods/media/**`、双端宿主 | Refs #24；先出契约 PR，再分端实现 |
| **下一批标准能力（`ui.dialog.confirm` / `clipboard.*` / `permissions.getState` / `media.scan.qr`）** | 中低 | `linux-agent` + `macos-agent` 接力 | `spec/methods/**`、`packages/web-sdk/**`、双端原生宿主 | Refs #21 建议顺序；每项须先满足 `docs/native-capability-catalog.md` 四问并同步三端与 conformance；**受 §5 O-001 体积预算约束** |
| **原生 `rules` ACL** | 低 | 按需 | 双端宿主安全模块 | host-core 已于 #54 实现；原生是否跟进待维护者确认 |

---

## 5. 待决议事项（Open Decisions）

> 以下事项需要维护者拍板后再转为 `D-xxx` 决策；在决议前，相关候选任务请勿自行选择方案。

- **[O-001 | 2026-11-26] Web SDK 主入口体积余量仅剩 41 bytes**
  - 现状：主入口 `7127 / 7168 bytes`，此前候选池中的"约 453 bytes"说法已过期。任何需要改动 `packages/web-sdk/src/bridge.ts` 或 `packages/protocol` 的功能几乎都会触发门禁。
  - 可选方向：(a) 上调门禁上限；(b) 把更多逻辑迁到按需子路径；(c) 先做一轮主入口瘦身。
- **[O-002 | 2026-11-26] 新增包 / 新命名空间的准入流程**
  - 背景：`wx-compat` 在 #50 合入后数分钟即被 #52 回滚，D-010 为事后补录。
  - 建议：新增 `packages/*`、新 Web 子路径或新标准命名空间前，先在 Issue 中取得维护者确认，再认领编码。
- **[O-003 | 2026-11-26] 下一版本（`0.3.0`）范围与发版节奏**
  - `0.2.0` 之后已累积插件管线、fallback、反向调用、流式回调、`media.release`、`transfer.upload`（Web/Mock）等能力，但原生宿主只跟进了 `media.release`。需确定下一版本是否以"原生对齐"为门槛。
- **[O-004 | 2026-11-26] Android 10–12 真机 Photo Picker 验收无负责人**
  - Maven Central 正式发布被该项阻塞，需指定具备真机条件的会话或维护者负责。

---

## 6. 共享决策与避坑清单（Shared Decisions & Gotchas）

> 记录已拍板的架构结论和真实踩坑经验，供所有新会话直接复用；新增条目请附日期与来源 PR/Issue。

- **[D-001 | 2026-11-25 | #24, #29] 媒体首版走主 frame RPC 回传有界缩略图，不引入原生 URL Scheme Handler**
  - `WKURLSchemeTask` 与 Android `WebResourceRequest` 在图片子资源请求中缺少可认证的发起 frame/document 会话元数据。
  - 首版 `media.chooseMedia@1` 统一在已验证的主 frame RPC 响应中返回 `id`（128-bit 32 位小写 hex 句柄）与 `thumbnailBase64`（JPEG 长边 ≤ 256 px、解码后 ≤ 32 KiB），Web SDK 转换为 `blob:` `thumbUrl` 并在过期/`pagehide`/`close()` 时撤销。原图留在宿主（5 分钟 / 20 MiB 上限）。
- **[D-002 | 2026-11-25 | #21, #28] 方法与事件命名冻结基线**
  - 新增标准能力方法使用 `domain.verbNoun`（已有 `ui.toast.show` 保留原名）。
  - 标准事件使用「名词 + 过去分词」（如 `network.statusChanged`），命名空间已指明主语时可用过去分词（`app.foregrounded`、`app.backgrounded`）。旧事件名 `network.changed` 已直接删除，禁止回退或混用。
  - `request`、WebSocket、Canvas 不进桥；支付、登录等走厂商命名空间（如 `wechat.pay.request`）；官方仓不维护第三方方言兼容包（见 `D-010`）。
- **[D-003 | 2026-11-25 | #30] 安全来源与 JSON 键名保留约束**
  - 参考宿主仅支持一个或多个**精确 HTTPS origin**（`https://host[:port]`），禁止前缀/子串匹配；`rules` JSON 细粒度 ACL 仍属未实现的可选提案。
  - 解码器仅过滤任意层级的 `__proto__` 字段，**必须保留 `constructor` 与 `prototype` 等业务 JSON 键名**。
  - 编码器在入队前做严格 JSON 快照，拒绝 `Date`、访问器、稀疏数组、循环引用、超出安全整数范围的数字等非标准 JSON 值（`-32600` / `-32602`）。
  - **补充（2026-11-26 · #54）**：`rules` JSON（含 `rateLimit` 与权限链异常隔离 `SEC-ACL-ERROR-001`）已在 TypeScript 参考 `packages/host-core`（`createAclPolicy`）实现；**iOS / Android 原生参考宿主仍未实现**，上述精确 origin 约束对原生宿主继续有效。
- **[D-004 | 2026-11-26 | #19, #27, #31] Web SDK `0.2.0` 包边界与体积门禁**
  - 仅发布 ESM + TypeScript 声明，零运行时依赖；主入口 `@open-jsbridge/web` 只导出 `createBridge` 与核心类型/错误码，不自动初始化默认单例（默认单例在 `@open-jsbridge/web/auto`，按需能力在 `/app`、`/device`、`/network`、`/ui`、`/media`）。
  - 任何对 `packages/web-sdk` 或 `packages/protocol` 的修改都必须通过 `npm run size:web`（主入口 min+gzip ≤ 7 KiB；当前基线 `7127 / 7168 bytes`）。
  - **补充（2026-11-26 · #43, #46, #58）**：插件管线 `use` / `onMetric` 位于主入口；`/fallback`、`/reverse`、`/transfer` 为新增按需子路径。主入口余量仅 41 bytes，见 §5 O-001。
- **[D-005 | 2026-11-25 | #29] Android Photo Picker 兼容策略**
  - 选图强制使用 iOS PHPicker / AndroidX `PickVisualMedia`，禁止为选图申请整库相册权限。
  - Android API 24–32 若设备缺少系统或已安装的 Photo Picker 回移版本，握手时**不声明** `media.chooseMedia`；回移配置由接入 App 自行声明（见 [docs/native-android.md](native-android.md)）。
- **[D-006 | 长期约束] 文档内 Shim 代码块受单测保护**
  - `conformance-tests/shim-docs.test.mjs` 会直接解析并执行 `docs/native-ios.md`、`docs/native-android.md`、`docs/flutter.md` 中的 `js` 代码块；调整这三个文档示例时务必运行 `npm test`。
- **[D-007 | 2026-11-26 | #33 已修复] npm 12 下 `scripts/pack-web.mjs` 兼容问题**
  - npm `12.x` 下 `npm pack --json` 返回按包名索引的对象映射而非数组；`#33` 已在 `scripts/pack-web.mjs` 兼容 npm ≤ 11 数组与 npm 12+ 对象两种格式。
- **[D-008 | 2026-11-26 | #34] `spec/` 修改必须同步 TS Codegen**
  - 新增或修改 `spec/schemas/`、`spec/methods/` 或 `spec/protocol/errors.json` 后，必须运行 `npm run codegen:ts` 更新 `packages/web-sdk/src/generated/spec.ts`，CI 已接入 `npm run codegen:check` 拦截漂移与不合规 schema。
- **[D-009 | 2026-11-26 | #41] 实时认领锁与交接走置顶 GitHub Issue `#41`**
  - 为彻底消除 `main` 分支合入前的可见性 Gap 及并行 PR 对 `docs/team-status.md` 的合并冲突，所有瞬态 `CLAIM` / `HANDOFF` / `DONE` / `RELEASE` 统一以 Append-only 评论发到 Issue `#41`（60m TTL + Comment ID 乐观锁仲裁），本文件仅保留持久化基线、候选池与共享决策。
- **[D-010 | 2026-11-26 | #50 Revert] 官方仓库不维护第三方方言兼容包（如 `wx-compat`）**
  - 为保持 Open JSBridge 单一标准心智、避免给开发者造成「多套规范并存」或「兼容微信全量运行时」的误解，官方仓库不提供 `wx-compat` 一类第三方方言封装包；有存量迁移需求的接入方可在自有业务仓或外部社区自行封装异步薄层。

---

## 7. 近期已完成（Recently Completed）

> 仅保留近期关键里程碑条目，完整历史见 `git log` 与 [CHANGELOG.md](../CHANGELOG.md)。

| 完成日期 | 摘要 | PR / Commit |
|---|---|---|
| 2026-11-26 | iOS 参考宿主接入 `media.release@1`（批量释放、会话配额回收） | `#55` (`a56de2c`) |
| 2026-11-26 | Android 参考宿主接入 `media.release@1` | `#57` (`b1393f9`) |
| 2026-11-26 | `transfer.upload@1` Schema、`@open-jsbridge/web/transfer` 与 Mock `uploadMedia` | `#58` (`915256b`) |
| 2026-11-26 | Web `/media` 与 Mock 支持 `media.release@1` | `#56` (`f3aba04`) |
| 2026-11-26 | `host-core` 实现 §11.3 `rules` ACL、限流与 `SEC-ACL-ERROR-001` | `#54` (`a45ad0b`) |
| 2026-11-26 | Web demo 补齐 ES 模块服务、`?devtools=1` 浮层与 HTTP 模块图测试 | `#53` (`515972b`) |
| 2026-11-26 | 回滚 `wx-compat` 并记录 D-010 | `#52` (`5457802`)，回滚 `#50` |
| 2026-11-26 | Codegen 新增 Swift / Kotlin / Dart 生成目标 | `#51` (`617a18c`) |
| 2026-11-26 | `media.release@1` 契约 | `#49` (`a0d266d`) |
| 2026-11-26 | `packages/devtools`（记录器、HAR 导出、Shadow DOM 浮层） | `#48` (`594237f`) |
| 2026-11-26 | iOS 前台上传图片预处理 | `#47` (`d2a2ac0`) |
| 2026-11-26 | Host → Web 反向调用（§9.2，Web `/reverse` + host-core） | `#46` (`0f917cd`) |
| 2026-11-26 | Flutter 方案 A Dart 宿主核心与 shim | `#45` (`fb33a6e`) |
| 2026-11-26 | `transfer.upload` 前台图片上传 RFC（`spec/rfcs/transfer-upload.md`） | `#44` (`40f6795`) |
| 2026-11-26 | Web SDK 插件管线（`use` / `onMetric`）与 `/fallback` | `#43` (`c56e6a9`) |
| 2026-11-26 | 实时认领与交接迁移到置顶 Issue `#41` | `#42` (`ce3a69e`) |
| 2026-11-26 | React Native 方案 A 宿主核心（`packages/react-native`、`OJSB_RN_SHIM`、二次编码、S2 门禁） | `#40` (`9d2600f`) |
| 2026-11-26 | 流式回调协议 `bridge.progress`（`onCallback` + `idleTimeout` + `HostCore` `ctx.callback`） | `#38` (`c49083d`) |
| 2026-11-26 | 提取参考 `packages/host-core` 并增强 `@open-jsbridge/web/mock` | `#36` (`4acf1aa`) |
| 2026-11-26 | 补齐 `docs/native-capability-catalog.md` 的 `#21` 边界说明并同步 `0.2.0` 看板 | `#35` (`1a1d401`) |
| 2026-11-26 | 新增 `packages/codegen`（Spec Lint + TS 类型生成）与 CI 漂移检查 | `#34` (`ca340e8`) |
| 2026-11-26 | 修复 `scripts/pack-web.mjs` 对 npm 12 `npm pack --json` 返回格式的兼容 | `#33` (`1a1b580`) |
| 2026-11-26 | 建立多 Agent 协作规范 `AGENTS.md`、中心状态看板与零冲突交接单模板 | `#32` (`15dd06d`) |
| 2026-11-26 | Web SDK `0.2.0` 发布与迁移说明（`docs/migrate-0.2.0.md`） | `#31` (`52d94f5`) |
| 2026-11-26 | 三端 `0.2.0` 候选发布工程化与 Android Photo Picker 回移文档 | `#27` (`d7149c2`) |
