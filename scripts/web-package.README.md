# @open-jsbridge/web

面向 Open JSBridge 宿主的 Web SDK。仅支持 ESM，随包提供 TypeScript 类型声明。

## 安装

通过 npm 安装正式版，也可以从仓库运行 `npm run pack:web` 安装本地生成的 tarball。

```sh
npm install @open-jsbridge/web
```

[CHANGELOG](https://github.com/Josp3r/open-jsbridge/blob/main/CHANGELOG.md#100) · [从 0.1.x 升级](https://github.com/Josp3r/open-jsbridge/blob/main/docs/migrate-0.2.0.md)

## App WebView

使用默认单例。第一次调用会等待原生 transport 并自动握手。下面的调用要求宿主启用 `device.getInfo`。

```ts
import { bridge } from '@open-jsbridge/web/auto'

const device = await bridge.call('device.getInfo')
console.log(device)
```

宿主启用 Toast 后，可以使用同一单例上的类型化入口。

```ts
import { ui } from '@open-jsbridge/web/ui'

await ui.toast.show({ text: '已保存' })
```

## 浏览器本地联调

从 `@open-jsbridge/web/mock` 显式安装 Mock transport。应用代码仍使用同一个 SDK 单例。

```ts
import { bridge } from '@open-jsbridge/web/auto'
import { installMockTransport } from '@open-jsbridge/web/mock'

const mock = installMockTransport({ events: ['acme.app.configChanged'] })
const stop = bridge.on<{ theme: string }>('acme.app.configChanged', console.log)
await stop.ready
mock?.emit('acme.app.configChanged', { theme: 'dark' })
stop()
```

[项目仓库和宿主接入方式](https://github.com/Josp3r/open-jsbridge)

## 入口

从主入口 `@open-jsbridge/web` 导入 `createBridge` 可创建独立的连接，主入口加载时不会创建默认单例。0.1.x 用户可将默认 `bridge` 和能力的导入移到 `@open-jsbridge/web/auto`。

可通过 `@open-jsbridge/web/device`、`/network`、`/app`、`/ui`、`/media`、`/transfer`、`/reverse` 和 `/fallback` 单独导入能力。模块和 `/auto` 共用一个连接。应用用 `bridge.has()` 和 `bridge.hasEvent()` 检测当前宿主声明的能力。
