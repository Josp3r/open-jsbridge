# Open JSBridge

> 一套**协议优先（spec-first）**、三端行为一致、默认安全的 Hybrid 通信标准：
> `spec/`（协议 + method schema） → `packages/web-sdk`（Web SDK） → `ios/`（WKWebView 注入层） / `android/`（WebView 注入层） / `flutter/`、`react-native/`（跨端框架宿主）。

## 1. 项目定位

Open JSBridge（下文简称 **OJSB**）解决的是 **Web 页面与宿主 Native（iOS / Android）之间的双向 RPC + 事件通信**。它不是一个"某家 App 的 bridge"，而是：

1. **一份协议规范**（[docs/protocol.md](docs/protocol.md)）：消息信封、错误码、握手、超时取消、事件、大数据、安全、生命周期、可观测性、版本演进。任何人都可以按规范独立实现一端。
2. **参考实现路线**：
   - Web：TypeScript SDK（[docs/web-sdk.md](docs/web-sdk.md)）
   - iOS：基于 `WKWebView` 的注入实现（[docs/native-ios.md](docs/native-ios.md)）
   - Android：基于 `androidx.webkit` 的注入实现（[docs/native-android.md](docs/native-android.md)）
   - Flutter 宿主：基于 `flutter_inappwebview` / `webview_flutter`，Dart 实现协议核心（[docs/flutter.md](docs/flutter.md)）
   - React Native 宿主：基于 `react-native-webview`，TS 实现协议核心，可选 TurboModule 复用原生层（[docs/react-native.md](docs/react-native.md)）

   所有宿主都注入满足同一 **Host Shim 契约**（protocol §2）的 shim，因此 **Web SDK 只有一份，新增宿主无需修改 SDK**。
3. **一致性测试套件 + 单一事实来源的 method schema**（[docs/conformance.md](docs/conformance.md)）：JSON Schema 描述每个 method，代码生成三端类型与桩代码，同一套用例跑三端。

### 非目标（Non-goals）

- **不提供同步调用**。所有调用都是异步的（Promise）。同步 bridge 依赖 `prompt()` 劫持或阻塞 JS 线程，会卡死渲染、行为不可移植。
- **不规定业务 API**。规范只定义 `bridge.*` 等少量保留命名空间；`device.*`、`ui.*` 等标准库作为可选 "profile" 单独版本化。
- **不兼容 UIWebView / Android 4.x 以下**。协议本身与传输无关，但参考实现只面向现代 WebView。

## 2. 设计原则

| # | 原则 | 落地方式 |
|---|------|---------|
| P1 | **Spec-first** | 先改 `spec/`，再生成代码；实现与规范冲突时以规范为准，并补 conformance 用例 |
| P2 | **Transport-agnostic** | 每条 UTF-8 JSON 消息用 OJSB 信封承载一个 JSON-RPC 2.0 对象。iOS、Android、Flutter 和 React Native 的平台通道由宿主 shim 适配 |
| P3 | **Secure by default** | 默认拒绝；使用可信 origin、frame 与 method 级 ACL；缺少可信来源的通道默认停用 |
| P4 | **Async-only, 可取消, 有超时** | SDK 管理调用的 deadline，并用 `bridge.cancel` 通知取消已发送的请求 |
| P5 | **能力协商而非版本猜测** | 握手返回 capabilities，Web 用 `bridge.has(method)` 做特性检测 |
| P6 | **可观测** | 使用 `meta.traceId` 关联调用，三端统一日志字段与耗时埋点 |
| P7 | **小而稳** | Web SDK core 目标 ≤ 4 KB（min+gzip），零运行时依赖 |
| P8 | **三端行为一致** | 一致性测试是合入门槛，不是"有空再补" |

## 3. 与业内方案的取舍

以下只做概念层面比较，不涉及具体版本细节：

| 方案 | 特点 | OJSB 的取舍 |
|------|------|------------|
| **WebViewJavascriptBridge** | 经典的 iOS/OS X 方案，早期依赖 URL scheme 拦截做通知，handler 注册模型简洁 | 沿用"handler 注册"的简洁心智；放弃 URL scheme 拦截，改用 `WKScriptMessageHandler(WithReply)`，拿到可信的 frame/origin 信息 |
| **DSBridge** | 跨 iOS/Android，支持同步调用和命名空间 | 沿用命名空间（`ns.method`）；**明确不做同步调用**；补上正式的错误码、能力协商和安全模型 |
| **Cordova / Capacitor 插件体系** | 插件化成熟、生态大，但运行时和工程结构较重，偏"整个 App 是 Web" | 借鉴插件注册与权限声明；OJSB 只做"bridge 层"，可嵌入任意现有 App 的任意 WebView |
| **JSON-RPC 2.0** | 请求、通知、响应与标准错误码 | 在 `{ "jsb": "1.0", "meta": { … }, "rpc": { "jsonrpc": "2.0", … } }` 中承载单条 RPC 消息。握手和会话信息由 OJSB 管理，事件、取消和进度使用显式通知 |

## 4. 仓库结构（monorepo）

```
open-jsbridge/
├── spec/                          # 单一事实来源
│   ├── protocol/
│   │   ├── envelope.schema.json   # 消息信封 JSON Schema
│   │   └── errors.json            # 错误码注册表
│   ├── methods/                   # 每个 method 一个 schema
│   │   ├── bridge/                # 保留命名空间（握手、能力、事件订阅）
│   │   │   └── hello.json         # 握手参数和成功结果
│   │   ├── device/getInfo.json
│   │   └── conformance/           # 一致性测试专用 method（echo/delay/emit...）
│   └── profiles/                  # 可选标准库 profile（device/ui/storage...）
├── packages/
│   ├── web-sdk/                   # open-jsbridge（核心 SDK）
│   ├── web-mock/                  # open-jsbridge/mock（浏览器/单测 mock 宿主）
│   ├── host-core/                 # host-core：TS 参考 Host 状态机（mock 与 RN 共用）
│   ├── devtools/                  # 调试面板 / 日志 overlay
│   └── codegen/                   # schema → TS / Swift / Kotlin / Dart
├── ios/
│   ├── Sources/OpenJSBridge/      # Swift Package
│   ├── Tests/OpenJSBridgeTests/
│   └── OpenJSBridge.podspec       # 可选
├── android/
│   ├── openjsbridge/              # AAR module
│   └── openjsbridge-test/         # instrumentation 测试
├── flutter/                       # open_jsbridge_flutter（pub 包）
│   ├── lib/src/core/              # Dart BridgeCore
│   ├── lib/src/transports/        # inappwebview / webview_flutter 适配
│   ├── lib/src/native_forwarder/  # 可选：Pigeon 转发到原生 handler
│   └── integration_test/
├── react-native/                  # open-jsbridge-react-native
│   ├── src/                       # OJSBWebView 组件 + createHostBridge（基于 host-core）
│   └── native/                    # 可选方案 B：TurboModule / Fabric 组件（M3+）
├── conformance-tests/
│   ├── cases/                     # 与平台无关的用例（JSON/YAML）
│   ├── fixtures/wire.json         # 消息形状正反例
│   ├── hosts/                     # 各宿主能力声明（ios-wk / android-wml / flutter / rn ...）
│   ├── runner-web/                # 跑在 WebView 内的测试页 + 执行器
│   └── reports/                   # 输出格式定义（JUnit XML / JSON）
├── examples/
│   ├── native-ios/                # Swift + WKWebView 示例
│   ├── native-android/            # Kotlin + AndroidX WebKit 示例
│   ├── flutter-demo/
│   ├── rn-demo/
│   └── web-demo/
├── docs/                          # 本设计文档
└── .github/workflows/             # CI：lint、codegen diff 检查、三端 conformance
```

### 本地构建与验证

```sh
npm ci
npm test
```

`npm test` 先编译 TypeScript，再运行 wire 正反例与 Web SDK / Mock 一致性用例。单独运行 `npm run build` 可将 TypeScript 编译产物输出到 `dist/`。

使用 `npm run demo:web` 可以在浏览器里体验 Mock 通道注入、自动握手、调用和错误处理。[Web SDK 快速上手](examples/web-demo/README.md)

同一个 demo 也可在原生 WebView 中运行。Native 开发者可从 [最小接入要求](docs/native-host.md) 开始，并在 [Swift / iOS 示例](examples/native-ios/README.md) 或 [Kotlin / Android 示例](examples/native-android/README.md) 验证自动握手和 echo。

在 Node.js 脚本中，可以显式创建带 Mock Adapter 的实例。首次调用会自动握手。

```sh
node --input-type=module <<'JS'
import { createBridge } from './dist/packages/web-sdk/src/index.js';
import { createMockAdapter } from './dist/packages/web-mock/src/index.js';

const bridge = createBridge({ adapter: createMockAdapter() });
console.log(await bridge.call('conformance.echo', { text: '你好' }));
JS
```

### 安装 Web SDK

```sh
npm install open-jsbridge
```

在 App WebView 中从 `open-jsbridge` 导入 `bridge` 单例。浏览器联调时，从同一个包的 `open-jsbridge/mock` 入口安装 Mock 通道。 [独立项目接入](examples/web-demo/README.md#在独立-web-项目安装)

验证仓库里的改动时，可运行 `npm run pack:web` 并安装生成的本地 tarball。 [本地打包与安装](examples/web-demo/README.md#从源码打包安装)

## 5. 版本策略

存在**三条相互独立的版本线**，不要混用：

| 版本线 | 格式 | 含义 | 规则 |
|--------|------|------|------|
| **协议版本** `jsb` | `MAJOR.MINOR`，如 `1.0` | 信封与核心语义 | MINOR 只做向后兼容的新增；MAJOR 才允许破坏性变更，握手协商 |
| **Method 版本** | 整数，如 `device.getInfo@2` | 单个 method 的 params/result 形状 | 新增可选字段不升版本；删除/改语义必须升版本，旧版本至少保留一个 MAJOR 周期 |
| **包版本** | SemVer | npm / SPM / Maven / pub 产物 | 三端包独立发版；每个包在元数据中声明支持的协议版本范围 |

## 6. 路线图

| 里程碑 | 目标 | 交付物 | 退出标准 |
|--------|------|-------|---------|
| **M0 规范冻结（Draft）** | 冻结可校验的 JSON-RPC wire 格式 | `docs/protocol.md`、`spec/protocol/envelope.schema.json`、`spec/protocol/errors.json`、`spec/methods/bridge/hello.json`、`conformance-tests/fixtures/wire.json` | 规范评审通过，wire 正反例通过 Schema 校验 |
| **M1 最小闭环** | 先跑通 TypeScript Web SDK 与 Mock 宿主的 echo，再分别接入 iOS 和 Android 主 frame | Web SDK core、Mock 宿主、echo demo。单独交付 iOS WithReply 与 Android WebMessageListener 接入 | TypeScript 闭环通过握手、调用、错误、超时核心用例。各原生接入独立通过其核心用例 |
| **M2 完整协议** | 事件、取消、流式回调、安全 ACL、生命周期 | blob 大数据通道、devtools。多 frame 和旧通道按平台隔离能力评估 | 参考三端通过所有适用的 conformance 用例。声明 iframe 或旧通道能力前，须验证跨 origin、frame 导航和迟到消息隔离 |
| **M2.5 跨端框架宿主** | Flutter / RN 方案 A | 共享 TS 宿主核心、`open-jsbridge-react-native`（react-native-webview）、`open_jsbridge_flutter`（flutter_inappwebview 优先，webview_flutter degraded） | 两者在 conformance 矩阵中按各自 trust 等级全绿；Web SDK 零改动 |
| **M3 生态与 1.0** | 可被外部采用 | codegen（TS/Swift/Kotlin/Dart）、`device/ui/storage` profile、Flutter Pigeon 原生 handler 转发、RN 方案 B（TurboModule/Fabric）预研、文档站、性能基准、1.0 发布 | 至少一个真实 App 接入；协议 `1.0` 正式冻结；兼容性承诺生效 |

## 7. 文档索引

- [协议规范 docs/protocol.md](docs/protocol.md)（核心）
- [Native Host 最小接入 docs/native-host.md](docs/native-host.md)
- [原生基础能力 docs/native-profiles.md](docs/native-profiles.md)
- [原生能力目录提案 docs/native-capability-catalog.md](docs/native-capability-catalog.md)
- [iOS 实现层 docs/native-ios.md](docs/native-ios.md)
- [Android 实现层 docs/native-android.md](docs/native-android.md)
- [Flutter 宿主 docs/flutter.md](docs/flutter.md)
- [React Native 宿主 docs/react-native.md](docs/react-native.md)
- [Web SDK docs/web-sdk.md](docs/web-sdk.md)
- [一致性测试与 Schema 单一事实来源 docs/conformance.md](docs/conformance.md)
- [开发待办 TODO.md](TODO.md)
