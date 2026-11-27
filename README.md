# Open JSBridge

> 一套**协议优先（spec-first）**、三端行为一致、默认安全的 Hybrid 通信标准。
> 协议基线 `jsb: 1.0` 已正式冻结；Web SDK（`@open-jsbridge/web`）、iOS SwiftPM（`NativeIOSHost`）与 Android Maven（`io.github.josp3r:open-jsbridge-android`）均已对齐 **`1.0.0`**。

[在线社区首页与交互式 Playground](https://josp3r.github.io/open-jsbridge/) · [协议规范（Frozen, `jsb: 1.0`）](docs/protocol.md) · [CHANGELOG](CHANGELOG.md#100) · [发版与产物验收](docs/native-release.md)

---

## 1. 项目定位

Open JSBridge（简称 **OJSB**）解决 **Web 页面与宿主 Native（iOS / Android / Flutter / React Native）之间的双向异步 RPC + 流式进度 + 事件推送通信**。它不是某家 App 的私有 bridge，而是：

1. **一份冻结的协议规范**（[docs/protocol.md](docs/protocol.md)）：定义消息信封、错误码、握手协商、超时取消、流式进度回调、事件订阅、媒体与上传、安全边界、生命周期与版本演进。任何团队都可以按规范独立实现任一端。
2. **多端参考实现**：
   - **Web SDK**（`@open-jsbridge/web@1.0.0`）：零运行时依赖、ESM-only、带完整 TypeScript 声明（[docs/web-sdk.md](docs/web-sdk.md)）
   - **iOS 参考宿主**（SwiftPM `NativeIOSHost`）：基于 `WKScriptMessageHandlerWithReply` + 主文档 token 强校验（[docs/native-ios.md](docs/native-ios.md)）
   - **Android 参考宿主**（Maven `io.github.josp3r:open-jsbridge-android`）：基于 `WebMessageListener` + `DOCUMENT_START_SCRIPT`，无回退通道（[docs/native-android.md](docs/native-android.md)）
   - **仓内跨端参考实现**（随仓维护，不随 1.0 单独发版）：`packages/host-core`、`packages/flutter`（纯 Dart 方案 A，已接入 CI）、`packages/react-native`（方案 A）、`packages/devtools`、`packages/codegen`

   所有宿主注入满足同一 **Host Shim 契约**（protocol §2）的 `window.__OJSB_TRANSPORT__`，**Web SDK 只有一份，新增宿主无需修改 Web 业务代码**。
3. **Spec-first 与一致性测试套件**（[docs/conformance.md](docs/conformance.md)）：以 `spec/` 下 JSON Schema 作为单一事实来源，`packages/codegen` 支持 TS / Swift / Kotlin / Dart 代码生成与 CI 漂移检查；7 项 CI 矩阵覆盖 Web/Mock、Flutter Dart、SwiftPM、iOS Release 模拟器、Android JVM、Android 11（API 30）Photo Picker 与 Android 15（API 35）Release 模拟器。

### 非目标（Non-goals）

- **绝不提供同步调用**：所有跨端调用均返回异步 `Promise`，不使用 `prompt()` 劫持或阻塞 JS 线程的方案。
- **不将通用 Web 能力塞进桥**：`request`、WebSocket、Canvas 不进桥；支付、登录、广告等强厂商能力走业务/厂商命名空间（如 `acme.pay.create`）。
- **不兼容 UIWebView / Android 4.x**：参考实现面向现代安全 WebView 通道，默认拒绝缺少可信 origin / frame 元数据的通道。

---

## 2. 1.0 交付能力矩阵

| 分类 | 能力 | Web SDK | iOS | Android | 契约 |
|---|---|---|---|---|---|
| 协议核心 | 握手协商 / 取消 / 重复去重 / 导航隔离 | ✅ | ✅ | ✅ | [envelope.schema.json](spec/protocol/envelope.schema.json) |
| 流式回调 | `bridge.progress`（`seq` + `idleTimeout`） | ✅ | ✅ | ✅ | [protocol.md §8](docs/protocol.md#8-流式回调callback) |
| 标准方法 | `device.getInfo@1` | ✅ `/device` | ✅ | ✅ | [device/getInfo.json](spec/methods/device/getInfo.json) |
| 标准方法 | `network.getStatus@1` | ✅ `/network` | ✅ | ✅ | [network/getStatus.json](spec/methods/network/getStatus.json) |
| 标准方法 | `ui.toast.show@1` | ✅ `/ui` | ✅ | ✅ | [native-profiles.md](docs/native-profiles.md) |
| 标准方法 | `media.chooseMedia@1` | ✅ `/media` | ✅ | ✅ | [media/chooseMedia.json](spec/methods/media/chooseMedia.json) |
| 标准方法 | `media.release@1` | ✅ `/media` | ✅ | ✅ | [media/release.json](spec/methods/media/release.json) |
| 标准方法 | `transfer.upload@1` | ✅ `/transfer` | ✅ | ✅ | [transfer/upload.json](spec/methods/transfer/upload.json) |
| 标准事件 | `network.statusChanged` | ✅ `/network` | ✅ | ✅ | [network/statusChanged.json](spec/methods/network/statusChanged.json) |
| 标准事件 | `app.foregrounded` / `app.backgrounded` | ✅ `/app` | ✅ | ✅ | [app/foregrounded.json](spec/methods/app/foregrounded.json) |
| 扩展能力 | 自定义业务方法（含流式进度）与业务事件 | ✅ | ✅ | ✅ | [native-host.md](docs/native-host.md) |

> `media.preview@1`、下一批标准能力、原生 `rules` ACL、原生 Host→Web 反向调用与原生 iframe 文档绑定明确推迟至 1.0 之后（握手时按能力声明，不影响兼容，详见 [TODO.md](TODO.md) 与 `D-013`）。

---

## 3. 设计原则

| # | 原则 | 落地方式 |
|---|---|---|
| P1 | **Spec-first** | 先改 `spec/`，再运行 `npm run codegen:ts`；CI 通过 `npm run codegen:check` 拦截漂移 |
| P2 | **Transport-agnostic** | 每条 UTF-8 JSON 消息承载单个 JSON-RPC 2.0 对象，平台通道差异由 Host Shim 隔离 |
| P3 | **Secure by default** | 精确 HTTPS origin 白名单 + main frame / document / `sid` 强绑定；缺少可信来源默认停用 |
| P4 | **Async-only, 可取消, 有超时** | 每次调用具备 deadline，支持 `AbortSignal` 与 `bridge.cancel` 释放原生并发槽 |
| P5 | **能力协商而非版本猜测** | 握手返回 `capabilities`，页面使用 `bridge.has()` / `bridge.hasEvent()` 做特性检测 |
| P6 | **可观测** | `meta.traceId` 透传、插件管线 `use`/`onMetric`、仓内 `devtools` 浮层与 HAR 导出 |
| P7 | **轻量零依赖** | `@open-jsbridge/web` 零运行时依赖、ESM-only、按需子路径导入，CI 持续观测主入口体积 |
| P8 | **三端行为一致** | 共享 `wire.json` / `host-inbound-raw.json` 原始报文用例 + 双端真实 WebView 模拟器回归 |

---

## 4. 快速开始

### 安装 Web SDK（`1.0.0`）

```sh
npm install @open-jsbridge/web
```

主入口 `@open-jsbridge/web` 仅导出 `createBridge`、错误类型与核心类型，不自动初始化单例；默认单例位于 `@open-jsbridge/web/auto`，标准能力按需从 `/device`、`/network`、`/app`、`/ui`、`/media`、`/transfer`、`/reverse`、`/fallback`、`/mock` 导入。

```ts
import { bridge } from '@open-jsbridge/web/auto';
import { device } from '@open-jsbridge/web/device';
import { ui } from '@open-jsbridge/web/ui';

await bridge.ready();
if (bridge.has('device.getInfo')) {
  const info = await device.getInfo();
  await ui.toast.show({ text: `${info.os} ${info.osVersion}` });
}
```

### 浏览器本地联调（Mock + Devtools）

```ts
import { bridge } from '@open-jsbridge/web/auto';
import { installMockTransport } from '@open-jsbridge/web/mock';

const mock = installMockTransport({
  deviceInfo: { os: 'ios', osVersion: '18.4' },
  events: ['network.statusChanged'],
});

const stop = bridge.on('network.statusChanged', console.log);
await stop.ready;
mock?.emit('network.statusChanged', { type: 'wifi' });
```

### 原生宿主接入

- **iOS（SwiftPM）**：依赖 `https://github.com/Josp3r/open-jsbridge`（`exact: "1.0.0"`）并导入 `NativeIOSHost`，详见 [docs/native-ios.md](docs/native-ios.md) 与 [examples/native-ios/README.md](examples/native-ios/README.md)。
- **Android（Gradle / Maven Central）**：添加 `io.github.josp3r:open-jsbridge-android:1.0.0`，详见 [docs/native-android.md](docs/native-android.md) 与 [examples/native-android/README.md](examples/native-android/README.md)。

---

## 5. 仓库结构与本地开发

```text
open-jsbridge/
├── Package.swift                  # SwiftPM 的 NativeIOSHost 产品
├── spec/                          # 协议信封 Schema、错误码、标准方法/事件 Schema 与 RFC
├── packages/
│   ├── protocol/                  # TypeScript 信封编解码
│   ├── web-sdk/                   # @open-jsbridge/web
│   ├── web-mock/                  # @open-jsbridge/web/mock
│   ├── host-core/                 # 参考 Host 状态机（含 §11.3 rules ACL 与反向调用）
│   ├── devtools/                  # 调用记录器、HAR 导出与 Shadow DOM 浮层
│   ├── codegen/                   # Spec Lint 与 TS / Swift / Kotlin / Dart 代码生成
│   ├── flutter/                   # 纯 Dart 方案 A 宿主与 shim（66 项单测）
│   └── react-native/              # React Native 方案 A 宿主与 shim
├── site/                          # 社区首页与在线交互式 Playground 源码（GitHub Pages）
├── examples/
│   ├── web-demo/                  # 本地浏览器与原生 WebView 联调页
│   ├── native-ios/                # Swift 宿主、单测、模拟器测试与 iOS Consumer
│   ├── native-android/            # Kotlin 宿主、JVM 单测与 Release 模拟器测试
│   ├── android-sdk-consumer/      # 通过 Maven 坐标接入 AAR 的独立 Android App
│   └── sdk-consumer/              # 双端独立 App 共用的 H5 验收资源
├── conformance-tests/             # 跨端一致性测试与共享 wire/raw 用例
├── scripts/                       # 打包、体积观测、代码生成与静态站点构建脚本
└── docs/                          # 冻结协议规范、平台接入指南与团队治理文档
```

常用本地命令：

```sh
npm ci
npm run lint
npm run codegen:check
npm test               # 编译 TS 并运行 236+ 项协议、SDK、Mock、Codegen 与站点验收测试
npm run pack:web       # 生成 dist/open-jsbridge-web-1.0.0.tgz
npm run build:site     # 构建 dist/site/（社区首页 + 在线 Playground）
npm run demo:web       # 启动本地联调页（支持 ?devtools=1）
```

---

## 6. 版本策略

存在**三条相互独立的版本线**：

| 版本线 | 格式 | 含义 | 规则 |
|---|---|---|---|
| **协议版本** `jsb` | `MAJOR.MINOR`（当前 `1.0` Frozen） | 信封与核心语义 | MINOR 向后兼容；MAJOR 破坏性变更须握手协商 |
| **Method 版本** | 正整数（如 `device.getInfo@1`） | 单个 method 的 params/result 形状 | 新增可选字段不升版本；删除/改语义升版本 |
| **包版本** | SemVer（当前 `1.0.0`） | npm / SwiftPM / Maven 产物 | 遵循语义化版本，1.0 达标后进入维护模式 |

---

## 7. 文档索引

- [协议规范（Frozen, `jsb: 1.0`）](docs/protocol.md)
- [Web SDK 指南](docs/web-sdk.md) · [从 0.1.x 升级](docs/migrate-0.2.0.md)
- [Native Host 最小接入要求](docs/native-host.md) · [原生基础能力](docs/native-profiles.md) · [能力准入目录](docs/native-capability-catalog.md)
- [iOS 实现指南](docs/native-ios.md) · [Android 实现指南](docs/native-android.md)
- [Flutter 宿主指南](docs/flutter.md) · [React Native 宿主指南](docs/react-native.md)
- [一致性测试与 Schema 规范](docs/conformance.md) · [1.0.0 发版与产物验收](docs/native-release.md)
- [开发待办与 1.0 退出标准](TODO.md) · [多 Agent 协作规范](AGENTS.md) · [团队基线与共享决策](docs/team-status.md)
