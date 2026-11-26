# Web SDK 快速上手

## 在独立 Web 项目安装

### 已发布的 0.1.0

从 npm 安装稳定版，并从主入口导入 `bridge` 单例。

```sh
npm install @open-jsbridge/web@0.1.0
```

```ts
import { bridge } from '@open-jsbridge/web'

const device = await bridge.call<{ os: string; osVersion: string }>('device.getInfo')
```

## 从源码打包安装

在 Open JSBridge 仓库根目录构建 0.2.0 候选包。

```sh
npm ci
npm run pack:web
```

在自己的 Web 项目里安装生成的文件，将示例路径换成本机的实际路径。

```sh
npm install /path/to/open-jsbridge/dist/open-jsbridge-web-0.2.0.tgz
```

候选包仅支持 ESM，从 `/auto` 导入 `bridge` 单例。真实 App WebView 由宿主注入通道，首次调用会自动握手。

```ts
import { bridge } from '@open-jsbridge/web/auto'

const device = await bridge.call<{ os: string; osVersion: string }>('device.getInfo')
```

普通浏览器联调时，在开发入口安装 Mock，再通过同一单例调用 Mock 宿主的 echo。

```ts
import { bridge } from '@open-jsbridge/web/auto'
import { installMockTransport } from '@open-jsbridge/web/mock'

installMockTransport()
const result = await bridge.call<{ text: string }>('conformance.echo', { text: '你好' })
```

## 在浏览器体验

在仓库根目录运行以下命令。

```sh
npm ci
npm run demo:web
```

打开 [Web Demo](http://127.0.0.1:4173/)。页面在启动时安装 Mock 宿主的 `window.__OJSB_TRANSPORT__`，模拟 App 向 WebView 注入 Host Shim。

1. 输入一段文字并点击「发送 echo」。首次调用自动握手，面板顶部会显示 `bridge.hello → conformance.echo`，下方保留最后一对请求和响应。Mock 将参数原样返回，例如输入 `你好`，SDK 得到 `{"text":"你好"}`。
2. 如果想单独观察握手，可以在首次发送 echo 前点击「开始握手」。Mock 返回宿主信息和支持的能力，SDK 进入 `ready`，`bridge.has('conformance.echo')` 返回 `true`。
3. 连接后点击「试试报错」。SDK 根据握手时收到的能力列表，在本地以 `BridgeError` 拒绝调用，错误码为 `-32601`。这次调用没有发送请求，因此没有对应的响应。

页面展示最近的实际请求、响应和 SDK 操作结果。握手和 echo 的面板里，外层 `jsb` 与 `meta` 属于 Open JSBridge 信封，`rpc` 对象承载 JSON-RPC 2.0 消息。请求和响应可以用 `rpc.id` 对照。

## 在代码里调用

Demo 已完成 Mock 注入。在页面打开浏览器开发者工具，把以下代码粘贴到控制台运行。模块来自仓库的本地构建产物。

```js
const { BridgeError } = await import('/dist/packages/web-sdk/src/index.js');
const { bridge } = await import('/dist/packages/web-sdk/src/auto.js');

try {
  const result = await bridge.call('conformance.echo', { text: '你好' }, { timeout: 3000 });
  console.log(result); // { text: '你好' }
} catch (error) {
  if (!(error instanceof BridgeError)) throw error;
  console.error(error.code, error.message, error.data);
}
```

`call()` 返回宿主响应里的 `rpc.result`，`timeout` 以毫秒计。如果页面需要根据宿主能力决定是否展示功能，可以先用 `await bridge.ready()` 等待握手，再用 `bridge.has(method)` 查询。`ready()` 也会返回宿主信息。

## 在本地开发页模拟 App 注入

如果在自己的浏览器开发页使用这套构建产物，在页面启动时运行以下代码，并在安装完成后再发起业务调用。

```js
import { installMockTransport } from '/dist/packages/web-mock/src/index.js';

installMockTransport();
```

安装完成后，业务代码和上面的控制台示例一样，直接使用 SDK 导出的 `bridge` 单例。Mock 注入仅用于本地开发和测试。正式 App 中由原生宿主注入真实的 Host Shim。页面已有 Host Shim 时，安装函数会保留它。

## 接入真实 App

在 [iOS 示例](../native-ios/README.md) 和 [Android 示例](../native-android/README.md) 中打开同一页面。两个示例都使用 `/?host=native`，只等 WebView 注入的真实通道。发送 echo 后，页面显示宿主名称和返回值。JSON-RPC 消息面板在浏览器 Mock 模式下显示。

App 向 WebView 注入 `window.__OJSB_TRANSPORT__` 并声明支持的业务方法。Web 页面导入默认 `bridge` 单例后可以直接调用。SDK 在第一次 `call()` 时自动连接和握手，并在发送请求前检查能力。点击「查询设备信息」或「查询网络状态」可查看可选模块的返回值。[原生基础能力](../../docs/native-profiles.md)

```js
import { bridge } from '/dist/packages/web-sdk/src/auto.js';

const result = await bridge.call('conformance.echo', { text: '你好' });
```

[Native Host 最小接入要求](../../docs/native-host.md)

## 订阅宿主事件

在浏览器 Demo 的事件区订阅 `network.statusChanged`，然后点击「切换 Mock 网络」，可以看到业务收到的 payload 和原始 `bridge.event` 通知。退订后可以再切换一次，确认监听结果保持不变。查询网络状态仍会返回当前值。

```js
const off = bridge.on('network.statusChanged', ({ type }) => {
  console.log('当前网络', type);
});

try {
  await off.ready;
} catch (error) {
  off();
  throw error;
}

// 组件卸载时
off();
```

`off.ready` 可以观察握手失败、宿主未声明事件和订阅被拒绝。在原生示例里，握手后会显示宿主已声明的事件。订阅后切换设备网络即可观察事件。[Web SDK 事件用法](../../docs/web-sdk.md#24-事件多路复用)
