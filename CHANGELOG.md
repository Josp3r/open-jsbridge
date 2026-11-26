# CHANGELOG

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
