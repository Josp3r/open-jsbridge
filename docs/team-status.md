# 多 Agent 团队基线与共享决策（Team Status）

> 协作规范与工程红线见根目录 [AGENTS.md](../AGENTS.md)。
>
> **实时认领锁、热点文件锁与跨端交接队列已迁移至置顶 GitHub Issue [#41](https://github.com/Josp3r/open-jsbridge/issues/41)**（秒级可见，Append-only 评论流，消除 `main` 合入前窗口期）。开工前请运行：
> ```sh
> gh issue view 41 -R Josp3r/open-jsbridge --comments
> gh pr list -R Josp3r/open-jsbridge --state open --limit 20
> ```
> 本文件专注沉淀**持久化团队信息**：当前基线、环境能力矩阵、待认领候选池、共享决策/避坑清单与近期已完成里程碑。

---

## 1. 当前基线快照（Baseline Snapshot）

- **最新主干基线**：`main` @ `9d2600f`（最后更新日期：`2026-11-26`）
- **版本线状态**：
  - 协议版本 `jsb`：`1.0`（Draft）
  - 仓库已于 `52d94f5` 打上 **`0.2.0`** 标签；三端 SDK（Web `@open-jsbridge/web`、iOS SwiftPM `NativeIOSHost`、Android Maven `io.github.josp3r:open-jsbridge-android`）对齐 `0.2.0`
- **首批 v1 标准能力（7 / 7 已合入 `main`）**：
  - 方法：`device.getInfo@1`、`network.getStatus@1`、`ui.toast.show@1`、`media.chooseMedia@1`
  - 事件：`network.statusChanged`、`app.foregrounded`、`app.backgrounded`
- **当前发版 / 验收跟进项**：
  - Maven Central 正式发布仍需留意 Android 10–12 真机 Photo Picker 验收（详见 [docs/native-release.md](native-release.md) 与 [CHANGELOG.md](../CHANGELOG.md)）。
- **主干活跃 Issue**：
  - `#41`：**置顶多 Agent 实时认领锁与跨端交接控制面**
  - `#21`：v1 标准能力集（首批 7 项与 26 项后续候选）
  - `#24`：媒体句柄 + 原生预览/上传方案（首批单图选图已落地，预览/上传/释放待后续推进）

---

## 2. Agent 角色与环境能力矩阵

不同会话具备不同工具链，在 Issue `#41` 认领任务或发起交接时请使用下表中的角色标识：

| 角色标识 | 典型会话 / 环境 | 可本地验证范围 | 局限与交接约定 |
|---|---|---|---|
| `macos-agent` | 本地 macOS（如 Codex worktree + Xcode） | Web/Mock、SwiftPM、iOS Release Simulator、Xcode 真机、Android JVM | 负责 iOS 编译/模拟器验收与双端发版验收 |
| `linux-agent` | 云端 Ubuntu 24.04（如 Antigravity VM） | Spec、Web SDK/Mock、Codegen、Conformance、Android JVM/Gradle、GitHub CLI | 无本地 Swift/Xcode；涉及 Swift 改动时靠 GitHub Actions CI 或在 `#41` 发起 `HANDOFF` 给 `macos-agent` |
| `other-agent` | 其他会话环境 | 按实际可用工具链在认领时注明 | 严格遵循 `AGENTS.md` 中的诚实验证原则 |

---

## 3. 待认领候选池（Backlog / Ready to Claim）

认领前请先查阅置顶 Issue [#41](https://github.com/Josp3r/open-jsbridge/issues/41) 确认是否已被其他 Agent 抢占；选定后直接在 `#41` 发 `CLAIM` 评论即可开工（无需为认领专门修改本文件）。

| 候选方向 | 建议优先级 | 建议角色 | 预估主要 Scope | 关联来源 / 说明 |
|---|---|---|---|---|
| **媒体句柄闭环：`media.release@1` + `media.preview@1`** | 中高 | `linux-agent` + `macos-agent` 接力 | `spec/methods/media/**`, `packages/web-sdk/src/media*`, `examples/native-android/**`, `examples/native-ios/**` | Refs #24, #21；补齐单图选择后的主动释放与原生全屏预览 |
| **Web SDK 插件管线（`use(plugin)` / `onMetric`）与 `BrowserFallbackAdapter`** | 中 | `linux-agent` | `packages/web-sdk/src/**`, `conformance-tests/**` | [docs/web-sdk.md](web-sdk.md) §3 & §6.2；注意主入口剩余约 453 bytes 的 7 KiB 体积预算 |
| **反向调用（`bridge.handle` / Host → Web）** | 中 | `linux-agent` | `packages/web-sdk/src/bridge.ts`, `packages/host-core/**`, `conformance-tests/**` | [docs/protocol.md](protocol.md) §9.2；注意 7 KiB 体积门禁 |
| **下一批标准能力（`ui.dialog.confirm` / `clipboard.*` / `permissions.getState` / `media.scan.qr`）** | 中 | `linux-agent` + `macos-agent` 接力 | `spec/methods/**`, `packages/web-sdk/**`, 双端原生宿主 | Refs #21 建议顺序；每项须先满足 `docs/native-capability-catalog.md` 四问并同步三端与 conformance |
| **Flutter 方案 A 宿主（`open_jsbridge_flutter`）** | 中低 | `macos-agent` / 具备 Flutter SDK 环境 | `packages/flutter/**`（或独立目录） | [docs/flutter.md](flutter.md)；遵循 S2 与 conformance 矩阵 |

> 当前由 `macos-agent (codex)` 正在推进的 `transfer.upload` RFC（`PR #39`）等实时认领状态以置顶 Issue [#41](https://github.com/Josp3r/open-jsbridge/issues/41) 为准。

---

## 4. 共享决策与避坑清单（Shared Decisions & Gotchas）

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
  - 任何对 `packages/web-sdk` 或 `packages/protocol` 的修改都必须通过 `npm run size:web`（主入口 min+gzip ≤ 7 KiB；当前基线 `6715 / 7168 bytes`，剩余约 453 bytes）。
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

---

## 5. 近期已完成（Recently Completed）

> 仅保留近期关键里程碑条目，完整历史见 `git log` 与 [CHANGELOG.md](../CHANGELOG.md)。

| 完成日期 | 摘要 | PR / Commit |
|---|---|---|
| 2026-11-26 | React Native 方案 A 宿主核心（`packages/react-native`、`OJSB_RN_SHIM`、二次编码、S2 门禁） | `#40` (`9d2600f`) |
| 2026-11-26 | 流式回调协议 `bridge.progress`（`onCallback` + `idleTimeout` + `HostCore` `ctx.callback`） | `#38` (`c49083d`) |
| 2026-11-26 | 提取参考 `packages/host-core` 并增强 `@open-jsbridge/web/mock` | `#36` (`4acf1aa`) |
| 2026-11-26 | 补齐 `docs/native-capability-catalog.md` 的 `#21` 边界说明并同步 `0.2.0` 看板 | `#35` (`1a1d401`) |
| 2026-11-26 | 新增 `packages/codegen`（Spec Lint + TS 类型生成）与 CI 漂移检查 | `#34` (`ca340e8`) |
| 2026-11-26 | 修复 `scripts/pack-web.mjs` 对 npm 12 `npm pack --json` 返回格式的兼容 | `#33` (`1a1b580`) |
| 2026-11-26 | 建立多 Agent 协作规范 `AGENTS.md`、中心状态看板与零冲突交接单模板 | `#32` (`15dd06d`) |
| 2026-11-26 | Web SDK `0.2.0` 发布与迁移说明（`docs/migrate-0.2.0.md`） | `#31` (`52d94f5`) |
| 2026-11-26 | 三端 `0.2.0` 候选发布工程化与 Android Photo Picker 回移文档 | `#27` (`d7149c2`) |
