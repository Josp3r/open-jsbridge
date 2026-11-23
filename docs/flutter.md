# Flutter 宿主实现（`open_jsbridge_flutter`）

> Flutter 在这里是 **WebView 宿主端**：Flutter App 内嵌 WebView 加载 H5，H5 使用**同一份** `@open-jsbridge/web`，**Web SDK 不做任何修改**。Flutter 侧只需实现 [protocol.md](protocol.md) 的 Host 职责并注入满足 [Host Shim 契约](protocol.md#2-host-shim-契约transport-层) 的 shim。
>
> 方案 A 在 M2.5 实现。`webview_flutter`、`flutter_inappwebview` 的 API 以接入版本的官方文档为准，文中标注「需核实」的能力须在接入时通过 conformance 用例验证。

## 1. 两个 WebView 插件的取舍

| 维度 | `webview_flutter`（官方 flutter.dev 维护） | `flutter_inappwebview`（社区） |
|------|------------------------------------------|-------------------------------|
| Web→Dart 通道 | `controller.addJavaScriptChannel(name, onMessageReceived:)`；页面侧 `Name.postMessage(string)`；只传字符串，无返回值 | `controller.addJavaScriptHandler(handlerName:, callback:)`；页面侧 `window.flutter_inappwebview.callHandler(name, ...args)` 返回 Promise（callback 返回值即 resolve 值） |
| Dart→Web | `controller.runJavaScript(js)` | `controller.evaluateJavascript(source:)` 等 |
| document-start 注入 | 跨平台 API 中**没有**通用的 document-start user script（平台专属扩展是否提供需核实），通常只能在 `NavigationDelegate.onPageStarted` 里 `runJavaScript`，**不保证**早于页面脚本 | `UserScript(source:, injectionTime: UserScriptInjectionTime.AT_DOCUMENT_START, ...)`，可通过 `initialUserScripts` 在创建时注入 |
| 调用方 origin / frame | `JavaScriptMessage` 只提供消息字符串。`currentUrl()` 仅用于导航检查或诊断 | handler 回调字段的来源需按平台核实。Android `callHandler` 的 origin / frame 由注入的 JavaScript 提供。Android `addWebMessageListener` 封装可提供原生调用方信息，接入时需核实可用性 |
| 维护与体积 | 官方维护、API 稳定、体积小、能力少 | 能力全面（UserScript、WebMessage、拦截等），依赖面更大 |
| 结论 | 符合 §5 的隔离与显式启用条件时可用，`trust = degraded` | 优先适配。`trust = full` 要求经核实的原生调用方信息，其余通道按 §5 判断是否可降级启用 |

```mermaid
flowchart LR
  subgraph Flutter["Flutter（Dart isolate）"]
    W[OJSBWebView widget] --> T{Transport}
    T --> T1[InAppWebViewTransport<br/>UserScript + addJavaScriptHandler]
    T --> T2[WebviewFlutterTransport<br/>JavaScriptChannel + runJavaScript<br/>trust=degraded]
    T1 & T2 --> CORE[Dart BridgeCore<br/>会话 · 超时 · 取消 · ACL]
    CORE --> REG[Dart HandlerRegistry]
    REG -. 可选 .-> FWD[NativeHandlerForwarder<br/>Pigeon → iOS/Android 原生 handler]
  end
  H5["H5 + @open-jsbridge/web（不变）"] <--> T
```

## 2. 架构方案：纯 Dart 核心 vs 复用原生实现

### 方案 A：纯 Dart 实现协议核心（**推荐默认**）

- Dart 实现 BridgeCore（JSON-RPC 信封、握手、sid、ACL、超时、取消、事件订阅、进度通知），通过 `Transport` 抽象适配两个插件。
- Handler 用 Dart 写；需要原生能力时由业务用常规 Flutter 插件实现。
- 优点：
  - 不依赖、也不需要拿到插件内部的原生 WebView 实例；随插件升级成本低。
  - 与 Flutter 业务代码同语言，handler 可直接访问 Dart 状态（路由、登录态）。
  - 协议核心逻辑小（核心状态机千行量级），一致性由 conformance 套件兜底，而不是靠"共享代码"。
- 缺点：协议逻辑多维护一份（Dart）；消息经过 原生插件 → platform channel → Dart，比纯原生多一跳（对 bridge 典型调用频率影响可忽略，大数据走 blob URL）。

### 方案 B：复用 iOS/Android 原生 OJSB，经 MethodChannel / Pigeon 桥接到 Dart

- 原生 OJSB（native-ios.md / native-android.md）直接挂在 WebView 上，Dart 通过 **Pigeon** 生成的类型安全接口注册/实现 handler：
  - `@HostApi`（Dart→Native）：`register(method, versions)`、`emit(event, json)`、`setAcl(json)`。
  - `@FlutterApi`（Native→Dart）：`invoke(method, paramsJson, ctx) → resultJson`，`cancel(id)`。
- 难点：原生 OJSB 必须拿到并配置**原生 WebView 实例**（注入 shim、加 message handler、设置 `WKURLSchemeHandler` —— 后者必须在 WebView 创建前配置）。第三方 WebView 插件的原生实例由插件自己创建和持有，是否能以公开、稳定的方式拿到并在创建前配置，**需逐个插件核实**；稳妥做法是自己提供一个 PlatformView 插件（`open_jsbridge_webview`）来创建原生 WebView。
- 优点：协议行为与原生端**完全同一份代码**；已有大量原生 handler 的 App（add-to-app 场景）可以零改动复用。
- 缺点：要自己维护一个 WebView PlatformView（放弃插件生态里的 cookie、下载、文件选择等现成能力，或自己补齐）；Dart handler 每次调用多一次 Pigeon 往返；两端原生实现的发布节奏绑定 Flutter 插件。

### 推荐

**优先采用方案 A**（Dart 核心 + `flutter_inappwebview` transport），按 §5 判定是否启用通道。另可接入**原生 handler 转发器**：

- 协议与 transport 在 Dart；但当某个 method 在 Dart registry 中不存在、而 App 的原生层已有 OJSB handler（复用 iOS/Android 的 `HandlerRegistry`）时，Dart 通过 Pigeon 把 `(method, params, ctx)` 转给原生 registry 执行。
- 这样复用的是**原生 handler（业务能力）**而不是原生 transport，避免了"必须拿到插件内部 WebView"的问题。
- 方案 A 无法满足所需的原生调用方校验、frame 定向投递或专属通道能力时，考虑方案 B。

## 3. Shim（以 `flutter_inappwebview` 为例）

```js
(function () {
  if (window.__OJSB_TRANSPORT__) return;
  var buf = [], recv;
  function deliver(m) { recv ? recv(m) : (buf.length < 256 && buf.push(m)); }
  var t = Object.freeze({
    name: 'flutter', protocols: Object.freeze([1]),
    // callHandler 返回 Promise，使用前须验证回复通道满足 §5 的 document 绑定要求
    postMessage: function (s) { return window.flutter_inappwebview.callHandler('ojsb', s); }
  });
  Object.defineProperty(window, '__OJSB_TRANSPORT__', { value: t, writable: false, configurable: false });
  Object.defineProperty(window, '__OJSB_RECEIVE__', { configurable: false,
    get: function () { return deliver; },
    set: function (fn) { recv = fn; var q = buf; buf = []; q.forEach(function (m) { fn(m); }); } });
  window.dispatchEvent(new CustomEvent('ojsb:transportready'));
})();
```

`window.flutter_inappwebview.callHandler` 可能在 shim 执行时尚未就绪，插件提供了"平台就绪"事件（事件名需按版本核实）。shim 在 `postMessage` 内部 MUST 等待该就绪信号再调用，或在就绪前缓存。启用 Promise 回复时，成功值是 JSON-RPC 响应信封字符串或传输回执 `null`。`webview_flutter` 版 shim 把 `postMessage` 换成 `OjsbChannel.postMessage(s)` 且返回 `undefined`。响应由 Dart 通过 `runJavaScript` 调 `__OJSB_RECEIVE__` 定向投递。

## 4. Dart API 与 handler 注册示例

```dart
// 由 codegen 从 spec/methods 生成（json_serializable 或 freezed 风格）
class DeviceGetInfoParams { final List<String>? fields; /* fromJson/toJson */ }
class DeviceGetInfoResult { final String os, osVersion, model; /* fromJson/toJson */ }

abstract class BridgeHandler<P, R> {
  String get method;
  List<int> get versions => const [1];
  P decode(Map<String, dynamic> json);
  Object? encode(R result);
  Future<R> handle(P params, BridgeContext ctx);
}

class BridgeContext {
  final String sid, id, traceId;
  final Uri? origin;              // transport 能提供可信 origin 时非空
  final bool? isMainFrame;       // 仅在有经验证的原生 frame 信息时赋值
  final Trust trust;              // Trust.full | Trust.degraded
  final CancelToken cancel;       // 收到匹配的 bridge.cancel 或会话失效时触发
  final Future<void> Function(Object? chunk) callback; // 发送 bridge.progress 通知
  BridgeContext(this.sid, this.id, this.traceId, this.origin, this.isMainFrame, this.trust, this.cancel, this.callback);
}

class BridgeException implements Exception {
  final int code; final String message; final Map<String, Object?>? data;
  const BridgeException(this.code, this.message, [this.data]);
  static const userDenied = BridgeException(-32007, 'User denied');
}

class DeviceGetInfo extends BridgeHandler<DeviceGetInfoParams, DeviceGetInfoResult> {
  @override String get method => 'device.getInfo';
  @override DeviceGetInfoParams decode(Map<String, dynamic> j) => DeviceGetInfoParams.fromJson(j);
  @override Object? encode(DeviceGetInfoResult r) => r.toJson();
  @override
  Future<DeviceGetInfoResult> handle(DeviceGetInfoParams p, BridgeContext ctx) async =>
      DeviceGetInfoResult(os: Platform.operatingSystem, osVersion: Platform.operatingSystemVersion, model: 'unknown');
}
```

使用：

```dart
final registry = HandlerRegistry()
  ..register(DeviceGetInfo())
  ..on('ui.toast.show', (Map<String, dynamic> p, ctx) async {   // 轻量注册
      ScaffoldMessenger.of(navigatorKey.currentContext!).showSnackBar(SnackBar(content: Text(p['text'] as String)));
      return null;
    });

final bridge = OJSBridge(
  registry: registry,
  acl: Acl.fromJson(await rootBundle.loadString('assets/ojsb-acl.json')),   // 与 iOS/Android 同一 ACL 格式
  nativeForwarder: NativeHandlerForwarder.pigeon(),                          // 可选：转发到原生 registry
);

// Widget：通过 §5 的启用检查后才注入 UserScript 并注册 OJSB 通道
OJSBWebView(bridge: bridge, initialUrl: Uri.parse('https://m.acme.com/home'));

// Native(Dart) → Web
bridge.emit('network.changed', {'type': 'wifi'});
final share = await bridge.callWeb('page.getShareInfo', timeout: const Duration(seconds: 3));
```

Transport 抽象（便于替换插件，也便于单测）：

```dart
abstract class HostTransport {
  /// Web→Host：收到原始字符串。Promise 回复通道将 JSON-RPC 响应字符串或传输回执 null 送回原 document
  void listen(Future<String?> Function(String raw, CallerInfo caller) onMessage);
  /// Host→Web：目标 frame/document 仍有效时才投递。仅支持主 frame 的通道只绑定主文档会话
  Future<void> deliver(String raw, DocumentRef target);
  /// 导航与进程事件，用于会话失效
  Stream<LifecycleEvent> get lifecycle;
}
```

使用脚本投递时，`deliver` 须先在目标 document 内确认其身份，并对字符串做二次编码（`jsonEncode(raw)` 得到 JS 字符串字面量，再替换 U+2028/U+2029），遵循 protocol §11.5、§12.1。直接回复通道也须绑定同一 document。无法保证时关闭对应下行能力。

## 5. 安全与生命周期

- **入站处理**。BridgeCore 按 protocol §3 解码单条 `{jsb, meta?, rpc}` JSON-RPC 2.0 信封并拒绝批量数组。仅 `bridge.hello` 请求及其关联响应可省略 `meta.sid`，握手仍须通过调用者授权。入站会话消息校验 sid 和 WebView、frame、document 绑定。规则拒绝或异常时停止分发。请求在分发前去重，握手按 document，其他请求按 sid 和发起方向。重复项静默丢弃。
- **通知与响应**。显式允许的内置控制通知包括 `bridge.event`（`name`、`payload`）、`bridge.cancel`（`requestId`、可选 `reason`）和 `bridge.progress`（`requestId`、`seq`、可选 `chunk`）。通知省略 `rpc.id`，无 JSON-RPC 响应。Promise 通道使用 `null` 完成传输回执。请求响应以字符串 `rpc.id` 关联原调用。`rpc.id: null` 仅用于诊断错误，须经满足会话校验且绑定到原 document 的通道发送。
- **调用方身份**：只有经核实的原生 WebView 调用方信息可用于 origin 与 frame 校验（protocol S1）。`webview_flutter` 的消息回调和 Android `callHandler` 均按 `degraded` 处理。降级时将未知的调用方 origin 与 frame 留空，主 frame URL 仅用于导航检查或诊断。
- **降级启用**：接入方 MUST 显式启用降级并独立执行内容与 frame 隔离，确保从初始加载到后续导航都只有受信的主文档可使用通道。仅开放 ACL 中标注 `allowDegraded: true` 的 method（protocol S2）。条件不成立时，MUST 禁用 OJSB 通道和 shim，并使已有会话失效。导航拦截与 main-frame-only UserScript 可作为辅助措施。
- **iframe**：仅当插件暴露可验证的原生调用方 frame/document 绑定、原生失效信号和对同一 frame/document 的定向投递时，才可宣告 iframe 能力，并按 frame 执行 ACL。降级通道只支持主文档（protocol F5）。
- **会话失效**：以原生生命周期信号跟踪 document。新 document 提交时使旧 sid 失效，取消进行中的 Dart handler（`CancelToken`）并丢弃旧响应。进程终止或 Widget dispose 时清理该 WebView 的所有会话。同一 document 内的 SPA 路由保留会话（protocol §12）。
- **Dart isolate**：BridgeCore 在 UI isolate 运行；重 CPU 的 handler 自行用 `Isolate.run` 等方式下放。

## 6. 测试

| 层 | 工具 | 内容 |
|----|------|------|
| Dart 单测 | `flutter test` + `FakeTransport` | Core 状态机、ACL、超时取消、二次编码；直接复用 `conformance-tests/cases` 中与 transport 无关的用例（消息级断言） |
| 集成测试 | `integration_test` 在真机/模拟器运行 | 加载 conformance runner 页面，transport 参数化（inappwebview / webview_flutter）各跑一遍，产出 JUnit |
| Pigeon 转发 | 原生端单测 + 集成测试 | 转发到原生 handler 的错误码、取消、超时一致 |
