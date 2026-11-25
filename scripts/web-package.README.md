# @open-jsbridge/web

面向 Open JSBridge 宿主的 Web SDK。包含 ESM 入口和 TypeScript 类型声明。

## 安装

```sh
npm install @open-jsbridge/web
```

验证仓库版本时，在仓库根目录运行 `npm run pack:web`，然后在项目中安装生成的 tarball。

```sh
npm install /path/to/open-jsbridge/dist/open-jsbridge-web-0.1.0.tgz
```

## App WebView

使用默认单例。第一次调用会等待原生 transport 并自动握手。下面的调用要求宿主启用 `device.getInfo`。

```ts
import { bridge } from '@open-jsbridge/web'

const device = await bridge.call('device.getInfo')
console.log(device)
```

宿主启用 Toast 后，可以使用同一单例上的类型化入口。

```ts
import { ui } from '@open-jsbridge/web'

await ui.toast.show({ text: '已保存' })
```

## 浏览器本地联调

从 `@open-jsbridge/web/mock` 显式安装 Mock transport。应用代码仍使用同一个 SDK 单例。

```ts
import { bridge } from '@open-jsbridge/web'
import { installMockTransport } from '@open-jsbridge/web/mock'

const mock = installMockTransport({ events: ['acme.app.configChanged'] })
const stop = bridge.on<{ theme: string }>('acme.app.configChanged', console.log)
await stop.ready
mock?.emit('acme.app.configChanged', { theme: 'dark' })
stop()
```

[项目仓库和宿主接入方式](https://github.com/Josp3r/open-jsbridge)

## 按需引入

可通过 `@open-jsbridge/web/device`、`/network`、`/app`、`/ui` 和 `/media` 单独导入能力。模块共用一个连接。应用用 `bridge.has()` 和 `bridge.hasEvent()` 检测当前宿主声明的能力。
