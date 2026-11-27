# CHANGELOG

## 1.0.0

发布日期：`2026-11-27`。三端正式发布版本号统一对齐 `1.0.0`（npm `@open-jsbridge/web`、iOS SwiftPM `NativeIOSHost` 标签 `1.0.0`、Android Maven `io.github.josp3r:open-jsbridge-android:1.0.0`），外层协议规范 `jsb: 1.0` 正式冻结。`1.0.0` 达标发版后仓库转入维护模式（详见 [TODO.md](TODO.md) 与 [docs/team-status.md](docs/team-status.md) `D-013`）。

### 协议与 Spec

- 完成 M0 信封与握手规范一致性复核，[docs/protocol.md](docs/protocol.md) `jsb: 1.0` 正式冻结（#70）。
- 新增 `bridge.progress` 流式回调通知，请求可通过 `idleTimeout` 在无进度时超时（#38）。
- 新增 `media.release@1`，批量主动释放会话媒体句柄（#49）。
- 新增 `transfer.upload@1` 前台单图上传 RFC 与正式 Schema（#44、#58）。
- `packages/codegen` 提供 Spec Lint、TypeScript 类型生成及 CI 漂移检查（#34），并新增 Swift、Kotlin、Dart 生成目标（#51）。

### Web SDK（`@open-jsbridge/web@1.0.0`）

- 新增插件管线 `use(plugin)` / `onMetric` 及 `@open-jsbridge/web/fallback`（#43）。
- 新增 `@open-jsbridge/web/reverse`，支持 Host → Web 反向调用（protocol §9.2）（#46）。
- `@open-jsbridge/web/media` 新增 `media.release`（#56）；新增 `@open-jsbridge/web/transfer`，提供 `transfer.upload` 与进度回调（#58）。
- 插件管线 `use` / `onMetric` 位于主入口，其余新增能力均为按需子路径。保持零运行时依赖与 ESM-only；`npm run size:web` 保留为 CI 体积观测输出（非阻断，`D-011`）。
- `@open-jsbridge/web/mock` 新增 `releaseMedia`、`uploadMedia` / `allowedUploadUrls`、流式回调与反向调用支持（#38、#46、#56、#58）。

### 原生宿主（iOS SwiftPM & Android Maven `1.0.0`）

- iOS 与 Android 参考宿主三端对齐 `media.release@1`（#55、#57）、`bridge.progress` 进度回调发送端（#61、#62）与 `transfer.upload@1` 会话级单图前台上传（#47、#59、#65、#67）。
- 补齐 M0 原生回归测试：iOS 权限链异常隔离 `SEC-ACL-ERROR-001`（#68）与 Android 缺少 `WebMessageListener` / `DOCUMENT_START_SCRIPT` 时默认关闭回退通道 `SEC-JSI-DEFAULT-001`（#69）。
- 补齐 Android 11（API 30）Photo Picker 兼容仪器测试与 CI 替代验收任务 `Android 11 Photo Picker Compat`（#66，`D-014`）。
- 原生反向调用、原生 `rules` ACL、原生 iframe 文档绑定与 `media.preview@1` 明确推迟至 1.0 之后（握手按能力声明，不影响兼容）。

### 仓内参考实现（不随 1.0 单独发布）

- `packages/host-core`：参考宿主核心（#36），支持 protocol §11.3 `rules` ACL、限流与权限链异常隔离（#54）。
- `packages/react-native` 与 `packages/flutter`：方案 A 宿主核心与 shim（#40、#45）；Flutter Dart 静态分析与 66 项测试已接入 CI（#63）。
- `packages/devtools`：调用记录、HAR 导出与 Shadow DOM 浮层（#48），Web demo 可通过 `?devtools=1` 启用（#53）。

## 0.2.0

从 `0.1.x` 升级请参阅 [0.2.0 迁移说明](docs/migrate-0.2.0.md)。Web SDK 使用 npm 的 `next` 预览频道。三端 SDK 候选版本均为 `0.2.0`，协议线上的 `jsb` 版本仍为 `1.0`。

### Web SDK

- 主入口提供 `createBridge`、错误类型和核心类型。默认 `bridge` 移到 `@open-jsbridge/web/auto`，与 `/app`、`/device`、`/network`、`/ui` 和 `/media` 共用连接。`/mock` 提供浏览器联调。
- 标准网络事件使用 `network.statusChanged`。新增 `app.foregrounded` 和 `app.backgrounded` 两个前后台事件。
- 增加 `reconnect()` 和 `close()`。SDK 在入队前保存 JSON 参数快照。离页时结算待处理调用并撤销媒体预览 URL，关闭实例时还会解绑监听。

### 原生宿主

- iOS 和 Android 的参考宿主支持多个精确 HTTPS 来源。每个受信主文档重新握手，并按宿主声明检测能力。
- `media.chooseMedia@1` 支持系统相册单图。原图留在宿主，线上提供 `thumbnailBase64`，Web SDK 生成 `thumbUrl`。缺少系统或回移选择器的 Android 设备不会声明该能力。
- iOS SwiftPM 产品和 Android Maven AAR 都可本地验收。正式 SwiftPM 标签和 Maven Central 发布待 Android 10–12 真机验收完成。
