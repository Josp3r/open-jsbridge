# Swift / WKWebView 示例

示例在 iOS 模拟器中加载仓库的 Web Demo。Swift 接收 `bridge.hello` 和 `conformance.echo` v1，直接用 WebKit 的 Promise 应答通道返回 JSON-RPC 信封。Swift Package 使用 iOS 14 的 WithReply API，示例 App 和测试目标需要 iOS 15+。

## 在模拟器运行

1. 在仓库根目录执行 `npm ci` 和 `npm run demo:web`，保持服务器运行。
2. 在 Xcode 打开 [NativeIOSDemo.xcodeproj](NativeIOSDemo.xcodeproj)，选中 `NativeIOSDemo` scheme 和一个 iPhone 模拟器，运行 Debug 构建。App 加载 `http://127.0.0.1:4173/?host=native`。模拟器的回环地址可以访问 Mac 上的 Web Demo 服务器。
3. 点击「发送 echo」。连接状态显示 `ios-wk`，结果显示所输入的文本。测试原生宿主时，`host=native` 模式会禁用 Mock 回落。

## 宿主的关键代码

- [NativeIOSHost.swift](Sources/NativeIOSHost/NativeIOSHost.swift) 创建专用 WebView，在主文档开始加载时注入冻结的 transport。Swift 使用 WebKit 给出的 `securityOrigin` 和 `isMainFrame` 校验调用者。示例 App 精确允许 `http://127.0.0.1:4173`，并在 Debug 配置中为回环地址声明 ATS 例外。
- WebKit 通道私下携带每份文档生成的标记。Swift 在当前主文档校验标记后才分派。跨文档提交或 Web 内容进程退出清除旧会话。应答只使用原消息的 `replyHandler`，因此它会结算发起文档的 Promise。
- [WireHost.swift](Sources/NativeIOSHost/WireHost.swift) 独立实现信封解析、握手、请求去重、UTF-8 消息大小和并发限制，以及对象 echo。联调方法只在 Debug 宿主通道启用。握手中的可选特性列表为空。示例沿用 Foundation 的 JSON 解析行为。它接受带尾逗号的对象，并把 `1e999` 之类不可表示的数字归为解析错误。
- 将适配器移植到已有 App 时，把脚本安装和导航失效钩子接到自己的 WebView 生命周期，并为实际页面使用精确的 HTTPS origin。[最小接入契约](../../docs/native-host.md)

## 测试

在 Xcode 以 iPhone 模拟器为目标运行 `Product → Test`，Web Demo 服务需保持运行。测试覆盖共享 Web Demo 的原生握手和 echo、文档开始注入和并发限制、History API 导航和跨文档导航、子 frame 及非白名单 origin 的原始通道调用。

在 macOS 上可离线测试 Swift 协议处理。

```sh
swift test --package-path examples/native-ios
```

WebKit 集成测试也可以在启动 Web Demo 服务后通过 macOS WebKit 运行。

```sh
OJSB_WEBKIT_E2E=1 swift test --package-path examples/native-ios
```

命令行默认使用 Command Line Tools 时，可以在命令前加 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` 来选用 Xcode 工具链。
