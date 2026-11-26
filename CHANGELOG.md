# CHANGELOG

## Unreleased

`0.2.0` 之后已合入 `main`、尚未发版的变更。协议线上的 `jsb` 版本仍为 `1.0`。下一版本范围尚待确定（见 [docs/team-status.md](docs/team-status.md) §5 O-003）。

### 协议与 Spec

- 新增 `bridge.progress` 流式回调通知，请求可通过 `idleTimeout` 在无进度时超时（#38）。
- 新增 `media.release@1`，批量主动释放会话媒体句柄（#49）。
- 新增 `transfer.upload@1` 前台图片上传 RFC 与正式 Schema（#44、#58）。
- `packages/codegen` 提供 Spec Lint、TypeScript 类型生成及 CI 漂移检查（#34），并新增 Swift、Kotlin、Dart 生成目标（#51）。

### Web SDK

- 新增插件管线 `use(plugin)` / `onMetric` 及 `@open-jsbridge/web/fallback`（#43）。
- 新增 `@open-jsbridge/web/reverse`，支持 Host → Web 反向调用（protocol §9.2）（#46）。
- `@open-jsbridge/web/media` 新增 `media.release`（#56）。新增 `@open-jsbridge/web/transfer`，提供 `transfer.upload` 与进度回调（#58）。
- 插件管线 `use` / `onMetric` 位于主入口，其余新增能力均为按需子路径。当前主入口 min+gzip 为 `7127 / 7168 bytes`。
- `@open-jsbridge/web/mock` 新增 `releaseMedia`、`uploadMedia` / `allowedUploadUrls`、流式回调与反向调用支持（#38、#46、#56、#58）。

### 原生宿主

- iOS 与 Android 参考宿主接入 `media.release@1`，释放后归还会话配额（#55、#57）。
- iOS 参考宿主新增前台上传前的图片预处理组件（#47），`transfer.upload@1` 尚未在原生宿主注册。
- iOS 与 Android 参考宿主尚未实现 `bridge.progress` 发送、反向调用和 `rules` ACL，握手时不会声明这些能力。

### 仓内参考实现（未单独发布）

- `packages/host-core`：参考宿主核心（#36），支持 protocol §11.3 `rules` ACL、限流与权限链异常隔离（#54）。
- `packages/react-native` 与 `packages/flutter`：方案 A 宿主核心与 shim（#40、#45）。
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
