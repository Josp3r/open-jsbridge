# 从 Web SDK 0.1.x 升级到 0.2.0

通过 npm 的 `next` 频道安装 0.2.0 预览版。也可以指定 `@open-jsbridge/web@0.2.0` 锁定版本。Web SDK 继续使用 ESM，随包提供 TypeScript 类型。

```sh
npm install @open-jsbridge/web@next
```

## 更新导入

0.1.x 的写法

```ts
import { bridge, ui } from '@open-jsbridge/web'
```

0.2.0 的写法

```ts
import { bridge } from '@open-jsbridge/web/auto'
import { ui } from '@open-jsbridge/web/ui'
```

也可以从 `/auto` 一起导入 `bridge` 和 `ui`。首次业务调用仍自动握手。`createBridge`、`BridgeError`、`ErrorCode` 和核心类型继续从主入口 `@open-jsbridge/web` 导入。浏览器联调继续从 `@open-jsbridge/web/mock` 导入 `installMockTransport`。

## 更新事件订阅

适配发布了新版标准事件的宿主时，把 `network.changed` 改为 `network.statusChanged`。新网络事件与 `network.getStatus` 使用同一个 `{ type }` 结构。两种宿主并存时，先等待握手并按 `bridge.hasEvent()` 检查事件名。

```ts
import { bridge } from '@open-jsbridge/web/auto'
import { network } from '@open-jsbridge/web/network'

await bridge.ready()

if (bridge.hasEvent('network.statusChanged')) {
  const stop = network.onStatusChanged(({ type }) => console.log(type))
  await stop.ready
  // 在组件卸载时调用 stop()。
}
```

宿主声明 `app.foregrounded` 和 `app.backgrounded` 时，可以通过 `/app` 订阅应用前后台事件。握手完成仍使用 `bridge.ready()`。

## 检查调用参数和实例生命周期

调用参数应由普通 JSON 数据组成。将 `Date` 转成 ISO 字符串，省略值为 `undefined` 的可选属性。SDK 在入队时保存参数快照。手写的 `Bridge` 测试替身需要提供 `reconnect()` 和 `close()`。使用 `createBridge()` 创建独立连接的代码可以在销毁时调用 `close()`。

## 启用原生能力

Web 通过握手检测宿主提供的能力。要使用系统相册单图，先确认 `bridge.has('media.chooseMedia', 1)`，再从 `/media` 调用 `media.chooseMedia()`。选中后用 `files[0].thumbUrl` 显示缩略图。系统选择器关闭时返回 `cancelled`。Android API 24–32 的回移配置由接入 App 管理。[原生能力接入](native-profiles.md) · [Android 接入](native-android.md)
