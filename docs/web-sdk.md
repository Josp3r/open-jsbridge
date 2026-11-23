# Web SDK 设计（`@open-jsbridge/web`）

> 目标：**一份 SDK 跑在所有宿主**（iOS / Android / Flutter / React Native / 浏览器 / mock）。SDK 只依赖 [protocol.md §2 Host Shim 契约](protocol.md#2-host-shim-契约transport-层)，不感知具体平台。

## 1. 公共 API

当前 M1 实现提供 `createBridge`、默认 `bridge`、`ready`、`has` 和 `call`。本节也列出后续里程碑的事件、流式回调、反向调用和 codegen API。

```ts
import { bridge, BridgeError, ErrorCode } from '@open-jsbridge/web';

await bridge.ready();                                   // 握手完成（或降级判定完成）

if (bridge.has('device.getInfo')) {
  const info = await bridge.call('device.getInfo', { fields: ['os', 'model'] }, { timeout: 3000 });
  // info 的类型由 codegen 推导：DeviceGetInfoResult
}

const off = bridge.on('network.changed', (e) => console.log(e.type));
off();                                                   // 或 bridge.off('network.changed', handler)

// 取消
const ac = new AbortController();
bridge.call('media.chooseImage', { count: 3 }, { signal: ac.signal, timeout: 0 });
ac.abort();

// 流式回调
await bridge.call('file.download', { url }, { onCallback: (p) => setProgress(p.percent) });

// 反向调用：Host 调用 Web
bridge.handle('page.getShareInfo', async () => ({ title: document.title, url: location.href }));

try { await bridge.call('acme.pay.create', { orderId }); }
catch (e) {
  if (e instanceof BridgeError && e.code === ErrorCode.PermissionDenied) { /* ... */ }
}
```

### 1.1 类型签名

```ts
// 由 codegen 从 spec/methods/**/*.json 生成（见 conformance.md §4）
export interface MethodMap {
  'device.getInfo': { params: DeviceGetInfoParams; result: DeviceGetInfoResult };
  'ui.toast.show':  { params: UiToastShowParams;  result: void };
  // ...
}
export interface EventMap {
  'network.changed': NetworkChangedEvent;
  'app.didEnterBackground': Record<string, never>;
}

export interface CallOptions<C = unknown> {
  timeout?: number;                 // ms；M1 接受正整数
  signal?: AbortSignal;
  traceId?: string;
  version?: number;                 // 显式 method 版本，等价于 'x.y@2'
  onCallback?: (chunk: C, seq: number) => void;
}

export interface Bridge {
  readonly state: 'idle' | 'connecting' | 'ready' | 'unavailable';
  readonly host?: HostInfo;
  ready(): Promise<HostInfo>;
  has(method: string, version?: number): boolean;

  call<M extends keyof MethodMap>(method: M, params?: MethodMap[M]['params'], opts?: CallOptions): Promise<MethodMap[M]['result']>;
  call<T = unknown>(method: string, params?: Record<string, unknown>, opts?: CallOptions): Promise<T>; // 未声明的扩展 method

  on<E extends keyof EventMap>(event: E, fn: (p: EventMap[E]) => void): () => void;
  on(event: string, fn: (p: unknown) => void): () => void;
  off(event: string, fn?: (p: any) => void): void;
  emit(event: string, params?: Record<string, unknown>): void;      // Web → Host event

  handle(method: string, fn: (params: any, ctx: { signal: AbortSignal }) => unknown | Promise<unknown>): () => void;

  use(plugin: BridgePlugin): void;  // 中间件：日志、埋点、mock 覆盖
}

export function createBridge(options?: BridgeOptions): Bridge;  // 多实例/测试用
export const bridge: Bridge;                                     // 默认单例
```

设计说明：

- **为什么是 `call(method, params)` 而不是 `bridge.device.getInfo()` 代理对象**：字符串 method 便于 tree-shaking、日志与 codegen 对齐；强类型通过 `MethodMap` 获得。codegen MAY 额外生成 `api.device.getInfo()` 的薄封装（可选子路径导出 `@open-jsbridge/web/typed`）。
- `params` 必须是 object（协议约束），SDK 在开发模式下对非 object 直接抛错。
- `BridgeError extends Error`，带 `code / data / method / traceId`，可 `instanceof` 判断。

## 2. 内部架构

```mermaid
flowchart TB
  API[Public API<br/>call / on / handle / has] --> MW[Plugin pipeline]
  MW --> CORE[Core<br/>pending map · id gen · timers · cancel · seq]
  CORE --> Q[Pre-ready Queue]
  CORE --> HS[Handshake & Capabilities]
  CORE --> CODEC[Envelope Codec + 校验]
  CODEC --> AD{Adapter}
  AD --> A1[InjectedShimAdapter<br/>window.__OJSB_TRANSPORT__]
  AD --> A2[BrowserFallbackAdapter]
  AD --> A3["MockAdapter（@open-jsbridge/mock）"]
  AD --> A4[PostMessageAdapter（可选：受控 iframe 宿主/测试）]
```

### 2.1 Adapter 抽象

```ts
export interface Adapter {
  readonly name?: string;
  readonly protocols?: readonly number[];
  detect?(): boolean;
  /** 发送；若返回 Promise<string>，Core 将其视为该 request 的 response */
  send(raw: string): void | Promise<string | null>;
  /** 注册接收回调，返回注销函数 */
  listen(onMessage: (raw: string) => void): () => void;
}
```

- **平台差异全部下沉到 Host shim**：iOS 的 `webkit.messageHandlers.x.postMessage` 返回 Promise、Android `addWebMessageListener` 对象的 `postMessage + onmessage`、Flutter/RN 的通道，都由各自 shim 适配成同一个 `OJSBTransport`。因此新增宿主（如 Flutter、RN、鸿蒙 ArkWeb）**不需要改 SDK**。
- 自动选择顺序为显式 `options.adapter`、已注入的 shim、等待 `ojsb:transportready`。等待超时后 bridge 进入 unavailable，浏览器 polyfill 留待后续。
- SDK 独立跟踪当前 window 的接收器所有权。卸载时只移除该实例持有的接收器，以兼容返回缓冲转发函数的 shim getter。页面内多个 SDK 实例应各自使用显式 Adapter。

### 2.2 Core：pending、id、超时与会话

Web SDK 和 Mock 共用 [TypeScript codec](../packages/protocol/src/index.ts)。应用仍通过 `bridge.call(method, params, options)` 发起调用。发送时把 JSON-RPC 2.0 request 放进 `rpc`，由外层 `meta` 携带会话与剩余超时。

```json
{
  "jsb": "1.0",
  "meta": { "sid": "s-01", "timeout": 4800 },
  "rpc": { "jsonrpc": "2.0", "id": "w-42", "method": "conformance.echo", "params": { "text": "你好" } }
}
```

- 把请求登记到 pending 时启动基于单调时钟的超时计时，并安装 `AbortSignal` 监听。响应、发送失败、超时或取消都会移除 pending、定时器和监听。同一请求只结算一次。
- Adapter 的 Promise 回复与 push 共用接收路径。先校验信封和 RPC 结构，随后验证会话。只有当前会话中已发送、仍有效并匹配 `rpc.id` 的响应才能结算调用。`rpc.id: null` 仅用于协议诊断。
- `bridge.hello` 直接发送。握手的响应按本次尝试的 id 与 deadline 匹配。成功时校验 `rpc.result.sid`、协商版本、能力和限制，响应外层若提供 `meta.sid` 则须与结果一致。旧握手响应无法建立会话。
- 对已发出的请求，取消使用无 RPC id 的 `bridge.cancel` notification，`rpc.params.requestId` 是原请求 id。SDK 仅向原活动会话发送取消。
- M2 通知分发器将显式处理 `bridge.event` 与 `bridge.progress`。进度通过 `rpc.params.requestId` 和 `seq` 关联，最终结果仍由一次普通 response 结束。
- M1 按协商的 `maxMessageBytes` 检查完整信封的 UTF-8 字节数。发送端在超限时以 `-32006` 本地结算，接收端在解析前丢弃超限帧。按 `maxInflight` 排队和 schema 授权的无超时长任务留待后续。

### 2.3 Pre-ready 队列

```mermaid
sequenceDiagram
  participant B as 业务
  participant S as SDK
  participant H as Host
  B->>S: call A（state=connecting）
  S->>S: queue.push(A)（计时已开始）
  B->>S: call B
  S->>S: queue.push(B)
  S->>H: bridge.hello
  S->>S: A 的 deadline 到达 → 移出队列
  S-->>B: A reject -32001
  H-->>S: 有效 hello 响应 { sid, capabilities }
  loop 冲刷
    S->>S: 核对 pending 与剩余时间，检查 capabilities
    alt method 不可用
      S-->>B: reject -32601（不发送）
    else
      S->>H: B（当前 sid 与剩余 timeout）
    end
  end
```

- 队列上限默认 100，溢出 reject `-32005`。
- deadline 从业务调用时开始。冲刷时按入队顺序从队列移除各项，再调用 `sendRequest` 跳过已结算的项，检查剩余时间和能力。若 deadline 已到，即使定时器回调尚未运行，也立即 reject `-32001`。发出时 `meta.ts` 写入发送时刻，`meta.timeout` 写入剩余时间。定时器仍按原 deadline 运行。
- 入队后发生 abort 或超时，SDK 分别以 `-32002` / `-32001` 在本地结算并移除该项，尚未发出的调用不发送 wire `cancel`。已发出的调用只向原会话发送 `cancel`，会话失效后直接完成本地清理。
- 降级判定为 `unavailable` 时，队列中所有调用 reject `-32000`。

### 2.4 事件多路复用

```ts
class Events {
  private listeners = new Map<string, Set<Function>>();
  on(name: string, fn: Function) {
    let set = this.listeners.get(name);
    if (!set) { set = new Set(); this.listeners.set(name, set); this.core.request('bridge.subscribe', { events: [name] }).catch(this.warn); }
    set.add(fn);
    return () => this.off(name, fn);
  }
  off(name: string, fn?: Function) {
    const set = this.listeners.get(name); if (!set) return;
    fn ? set.delete(fn) : set.clear();
    if (set.size === 0) { this.listeners.delete(name); this.core.request('bridge.unsubscribe', { events: [name] }).catch(() => {}); }
  }
  dispatch(name: string, payload: unknown) {
    this.listeners.get(name)?.forEach((fn) => { try { fn(payload); } catch (e) { queueMicrotask(() => { throw e; }); } });
  }
}
```

- 监听者异常不影响其他监听者，并重新抛到全局（`window.onerror` 可见）。
- 重新握手（bfcache 恢复、Host 重建会话）后，SDK 自动把当前 `listeners` 的 key 重新 `bridge.subscribe`。

### 2.5 生命周期处理

```ts
addEventListener('pagehide', () => core.invalidateSession());
addEventListener('pageshow', (e) => { if (e.persisted) core.rehandshake(); });
```

- `invalidateSession()` 先清除活动会话、能力和握手尝试，再用 `-32002` 结算出站 pending 和队列，并取消旧会话中的 Web handler。旧 handler 完成后不向新会话发送响应。
- `rehandshake()` 先使任何旧会话与握手失效，再发起新的 `bridge.hello`。仅在验证新尝试的响应后恢复业务消息分派，并重新订阅当前监听的事件。

## 3. 降级与 polyfill

```ts
import { createBridge, BrowserFallbackAdapter } from '@open-jsbridge/web';

const bridge = createBridge({
  fallback: new BrowserFallbackAdapter({
    polyfills: {
      'ui.toast.show': ({ text }) => { alert(text); },
      'device.getInfo': () => ({ os: 'web', model: navigator.userAgent }),
    },
  }),
});
```

在普通浏览器中，`has()` 只对 polyfill 返回 true；这让同一份业务代码在 H5 外投场景可运行。

## 4. 类型生成

- 输入：`spec/methods/**/*.json`（JSON Schema 2020-12 + `x-ojsb-*` 扩展）。
- 工具：`packages/codegen`，内部可基于 `json-schema-to-typescript` 一类库生成 params/result 类型，再自行生成 `MethodMap` / `EventMap` 聚合接口。
- 产物：`packages/web-sdk/src/generated/methods.d.ts`（标准 profile），业务方可在自己仓库对自定义 schema 运行 `ojsb-codegen --target ts` 并通过 **declaration merging** 扩展：

```ts
declare module '@open-jsbridge/web' {
  interface MethodMap {
    'acme.pay.create': { params: { orderId: string }; result: { status: 'paid' | 'cancelled' } };
  }
}
```

- CI：codegen 结果入库，CI 运行 codegen 后 `git diff --exit-code`，防止 schema 与类型不一致。

## 5. 构建产物与体积

| 产物 | 路径 | 用途 |
|------|------|------|
| ESM | `dist/index.mjs` | 现代打包器，`sideEffects: false`（默认单例放在独立入口 `@open-jsbridge/web/auto`） |
| CJS | `dist/index.cjs` | SSR / 测试环境（SSR 下 `detect()` 返回 false，不访问 window） |
| UMD/IIFE | `dist/ojsb.umd.min.js` | `<script>` 直接引入，全局 `OpenJSBridge` |
| 类型 | `dist/index.d.ts` | 含 `MethodMap` 等可扩展接口 |

- 构建：tsup 或 Rollup + esbuild，target `es2017`（覆盖 iOS 11+ WKWebView 与 Android System WebView 主流版本；更老环境由业务自行转译）。
- 体积预算（min+gzip，CI 用 size-limit 卡口）：core ≤ 4 KB；含事件/反向调用/回调 ≤ 6 KB；devtools 单独包不计入。
- 零运行时依赖；不使用 `Proxy`（低版本兼容与可调试性）。

`package.json` 关键字段：

```json
{
  "name": "@open-jsbridge/web",
  "type": "module",
  "exports": {
    ".":       { "types": "./dist/index.d.ts", "import": "./dist/index.mjs", "require": "./dist/index.cjs" },
    "./auto":  { "types": "./dist/auto.d.ts",  "import": "./dist/auto.mjs" },
    "./typed": { "types": "./dist/typed.d.ts", "import": "./dist/typed.mjs" }
  },
  "sideEffects": ["./dist/auto.mjs"],
  "unpkg": "./dist/ojsb.umd.min.js"
}
```

## 6. Mock 与调试工具

### 6.1 `@open-jsbridge/mock`

在浏览器里模拟一个完整 Host（**实现了同一个 shim 契约**），SDK 无需特殊分支：

```ts
import { installMockHost } from '@open-jsbridge/mock';

const host = installMockHost({
  platform: 'ios',
  latency: [20, 80],                                  // 随机延迟，暴露竞态
  acl: { origins: [location.origin], allow: ['*'] },
});
host.register('device.getInfo', () => ({ os: 'ios', model: 'iPhone' }));
host.register('media.chooseImage', async (_p, ctx) => { ctx.callback({ selected: 1 }); return { images: [] }; });
host.emit('network.changed', { type: 'wifi' });
host.failNext('acme.pay.create', { code: -32007, message: 'User denied' });
```

- mock host 内部复用 conformance 套件里的"参考 Host 状态机"（TS 实现），保证 mock 行为与协议一致。
- 支持通过 URL 参数 `?ojsb_mock=1` 在开发环境自动安装。

### 6.2 Devtools

- `@open-jsbridge/devtools`：页面浮层，展示消息流（方向、method、耗时、错误码）、能力清单、会话状态；可导出 HAR-like JSON。
- SDK 的 `use(plugin)` 中间件接口：

```ts
export interface BridgePlugin {
  name: string;
  onSend?(env: Envelope): Envelope | void;
  onReceive?(env: Envelope): Envelope | void;
  onMetric?(m: { method: string; id: string; roundTripMs: number; hostHandlerMs?: number; code?: number }): void;
}
```

## 7. 单元测试

- 当前使用 Node test runner。仓库根目录执行 `npm ci`、`npm test`，编译 TypeScript 后运行 JSON 信封样例和 SDK ↔ Mock 用例。浏览器与真实 WebView 用例在对应宿主接入时加入。
- 覆盖点（与 conformance 用例 id 对应）：
  - id 唯一性、并发 1000 次调用无串号
  - 超时触发 → reject -32001 → 发送 cancel；迟到 response 被丢弃
  - AbortSignal 取消（调用前已 abort / 调用中 abort）
  - pre-ready 队列：顺序、溢出、握手失败全部 reject，等待握手时超时或 abort 不发送 request/cancel，剩余 timeout 随发出时写入
  - 能力过滤：未广告 method 不发送
  - reply 通道（send 返回 Promise）与异步通道行为一致（同一组用例参数化跑两遍）
  - 事件引用计数订阅/退订、重新握手后重新订阅
  - 握手前的会话消息、活动会话中缺少 SID 或 SID 不匹配的消息、迟到的 hello 都被丢弃
  - pagehide / bfcache 恢复
- 使用 fake timers 测试超时；用 mock host 的 `latency` 做随机化"模糊测试"。
- 覆盖率门槛：core 行覆盖 ≥ 95%。
