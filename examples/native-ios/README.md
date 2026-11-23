# Swift / WKWebView 示例

示例在 iOS 模拟器中加载仓库的 Web Demo。Swift 通过 WebKit 的 Promise 通道应答 JSON-RPC 请求，并向已订阅的文档推送网络状态变化。Swift Package 使用 iOS 14 的 WithReply API，示例 App 和测试目标需要 iOS 15+。

## 在模拟器运行

1. 在仓库根目录执行 `npm ci` 和 `npm run demo:web`，保持服务器运行。
2. 在 Xcode 打开 [NativeIOSDemo.xcodeproj](NativeIOSDemo.xcodeproj)，选中 `NativeIOSDemo` scheme 和一个 iPhone 模拟器，运行 Debug 构建。App 加载 `http://127.0.0.1:4173/?host=native`。模拟器的回环地址可以访问 Mac 上的 Web Demo 服务器。
3. 点击「发送 echo」确认连接状态显示 `ios-wk`，再试用「查询设备信息」「查询网络状态」和「订阅事件」。在订阅生效后切换设备网络，可以在页面上查看新的网络类型。模拟器能触发的状态变化取决于 Mac 的网络和模拟器可见的接口。`host=native` 模式禁用 Mock 回落。

## 启用设备和网络能力

默认的 `makeWebView(allowing:)` 只声明 `conformance.echo`。示例 App 在 Debug 构建中独立开启以下三个选项。

```swift
let webView = NativeIOSHost.makeWebView(
    allowing: url,
    options: .init(deviceInfo: true, networkStatus: true, networkChanges: true)
)
```

- `deviceInfo` 开启 `device.getInfo@1`，返回 iOS 系统版本。
- `networkStatus` 开启 `network.getStatus@1`，返回 `NWPathMonitor` 最近一次观测的标准网络类型。初次观测前返回 `unknown`。
- `networkChanges` 声明 `network.changed`。订阅成功后，标准网络类型发生变化时发送与查询相同的 `{ type }` 结构。跨文档导航会清除订阅并停止本次会话的网络监测。

三个能力的参数、返回值和网络类型定义见 [设备和网络 Profiles](../../docs/native-profiles.md)。

## 宿主的关键代码

- [NativeIOSHost.swift](Sources/NativeIOSHost/NativeIOSHost.swift) 创建专用 WebView，在主文档开始加载时注入冻结的 transport。Swift 使用 WebKit 给出的 `securityOrigin` 和 `isMainFrame` 校验调用者。示例 App 精确允许 `http://127.0.0.1:4173`，并在 Debug 配置中为回环地址声明 ATS 例外。
- WebKit 通道私下携带每份文档生成的标记。Swift 在当前主文档校验标记后才分派。跨文档提交、文档标记切换或 Web 内容进程退出会清除旧会话，向尚未完成的旧请求返回空回执并释放应答数据。应答只使用原消息的 `replyHandler`，晚到或重复的完成回调会被丢弃。
- [WireHost.swift](Sources/NativeIOSHost/WireHost.swift) 解析信封、建立会话、执行请求去重和限额、声明已启用的能力并维护订阅。宿主通道仅在 Debug 构建注入，握手的可选特性列表为空。
- [DeviceModule.swift](Sources/NativeIOSHost/DeviceModule.swift) 读取系统版本。[NetworkModule.swift](Sources/NativeIOSHost/NetworkModule.swift) 归一化系统网络路径并保存最近一次观测结果。推送脚本在交付前核对当前页面的 origin 和文档标记。页面隐藏时丢弃待交付消息，并轮换标记以便恢复时重新握手。
- 将适配器移植到已有 App 时，把脚本安装和导航失效钩子接到自己的 WebView 生命周期，并为实际页面使用精确的 HTTPS origin。[最小接入契约](../../docs/native-host.md)

## 测试

在 Xcode 以 iPhone 模拟器为目标运行 `Product → Test`，Web Demo 服务需保持运行。WebKit 测试涵盖原生握手和 echo、系统提供的设备与网络快照、网络订阅确认、推送缓冲与退订、文档隐藏和切换时的隔离、并发限制及非白名单页面和子 frame 的隔离。

在 macOS 上可离线测试 Swift 协议处理。

```sh
swift test --package-path examples/native-ios
```

WebKit 集成测试也可以在启动 Web Demo 服务后通过 macOS WebKit 运行。

```sh
OJSB_WEBKIT_E2E=1 swift test --package-path examples/native-ios
```

命令行默认使用 Command Line Tools 时，可以在命令前加 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` 来选用 Xcode 工具链。
