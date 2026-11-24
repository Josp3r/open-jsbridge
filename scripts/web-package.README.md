# open-jsbridge

面向 Open JSBridge 宿主的 Web SDK。包含 ESM 入口和 TypeScript 类型声明。

## 安装

```sh
npm install /path/to/open-jsbridge-0.1.0.tgz
```

## App WebView

使用默认单例。第一次调用会等待原生 transport 并自动握手。下面的调用要求宿主启用 `device.getInfo`。

```ts
import { bridge } from 'open-jsbridge'

const device = await bridge.call('device.getInfo')
console.log(device)
```

## 浏览器本地联调

从 `open-jsbridge/mock` 显式安装 Mock transport。应用代码仍使用同一个 SDK 单例。

```ts
import { bridge } from 'open-jsbridge'
import { installMockTransport } from 'open-jsbridge/mock'

const mock = installMockTransport({ events: ['acme.app.configChanged'] })
const stop = bridge.on<{ theme: string }>('acme.app.configChanged', console.log)
await stop.ready
mock?.emit('acme.app.configChanged', { theme: 'dark' })
stop()
```

[项目仓库和宿主接入方式](https://github.com/Josp3r/open-jsbridge)
