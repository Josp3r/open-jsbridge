# Swift / WKWebView 示例

`NativeIOSDemo` 的 Debug 构建加载仓库的 Web Demo，Release 构建演示设备查询和 App 注册的业务方法。`IOSSDKConsumer` 使用 Swift Package 中的 `NativeIOSHost` 产品，在独立的 Release App 中运行 iOS 和 Android 共用的 H5，验证设备查询、原生 toast、相册选择和图片读取。Swift Package 使用 iOS 14 的 WithReply API，示例 App 和测试目标需要 iOS 15+。

## 安装 Swift Package

在 Xcode 的 **File → Add Package Dependencies…** 输入 `https://github.com/Josp3r/open-jsbridge.git`，选择包含仓库根 [Package.swift](../../Package.swift) 的版本或 revision，再将 `NativeIOSHost` 产品添加到 App target。Swift 源码使用 `import NativeIOSHost`。在本仓库运行示例时，Xcode 项目直接以本地 Package 引用同一份根 Manifest。

## 在模拟器运行

1. 在仓库根目录执行 `npm ci` 和 `npm run demo:web`，保持服务器运行。
2. 在 Xcode 打开 [NativeIOSDemo.xcodeproj](NativeIOSDemo.xcodeproj)，选中 `NativeIOSDemo` scheme 和一个 iPhone 模拟器，运行 Debug 构建。App 加载 `http://127.0.0.1:4173/?host=native`。模拟器的回环地址可以访问 Mac 上的 Web Demo 服务器。
3. 点击「发送 echo」确认连接状态显示 `ios-wk`，再试用「查询设备信息」「查询网络状态」和「订阅事件」。在订阅生效后切换设备网络，可以在页面上查看新的网络类型。模拟器能触发的状态变化取决于 Mac 的网络和模拟器可见的接口。`host=native` 模式禁用 Mock 回落。

## 启用设备和网络能力

Debug Demo 的 `makeWebView(allowing:)` 默认声明 `conformance.echo`。示例 App 在 Debug 构建中独立开启以下三个选项。

```swift
let webView = NativeIOSHost.makeWebView(
    allowing: url,
    options: .init(deviceInfo: true, networkStatus: true, networkChanges: true)
)
```

- `deviceInfo` 开启 `device.getInfo@1`，返回 iOS 系统版本。
- `networkStatus` 开启 `network.getStatus@1`，返回 `NWPathMonitor` 最近一次观测的标准网络类型。初次观测前返回 `unknown`。
- `networkChanges` 声明 `network.statusChanged`。订阅成功后，标准网络类型发生变化时发送与查询相同的 `{ type }` 结构。跨文档导航会清除订阅并停止本次会话的网络监测。

三个能力的参数、返回值和网络类型定义见 [设备和网络 Profiles](../../docs/native-profiles.md)。

## 接入 App 自己的 WKWebView

App 使用 Swift Package 的 `NativeIOSHost` 产品，把 bridge 装到自己创建的 `WKWebView` 上。先安装再导航。`allowing` 接受一个精确 HTTPS origin，也接受非空的 `[URL]` 来源列表。自定义端口参与精确匹配，每个来源都须通过验证。App 持有返回的 `Attachment`，继续用自己的 `WKNavigationDelegate` 决定导航策略。

```swift
let origin = URL(string: "https://app.example.com")!
let configuration = WKWebViewConfiguration()
let webView = WKWebView(frame: .zero, configuration: configuration)

var currentTheme = "system"
let getConfig = try NativeIOSHost.BusinessMethod("acme.app.getConfig") { params in
    guard params.isEmpty else { throw NativeIOSHost.BusinessMethodError.invalidParams }
    return ["theme": currentTheme]
}
attachment = try NativeIOSHost.attach(
    to: webView,
    allowing: origin,
    options: .init(deviceInfo: true),
    methods: [getConfig],
    events: ["acme.app.configChanged"]
)
webView.navigationDelegate = self
webView.load(URLRequest(url: origin))
```

在 App 的主 frame `didCommit` 回调调用 `attachment?.didCommitNavigation()`，在 `webViewWebContentProcessDidTerminate` 回调调用 `attachment?.webContentProcessDidTerminate()`。在销毁或替换 WebView 前调用 `attachment?.detach()`。每个正在接入的 WebView 使用自己的 `WKUserContentController`。附件拆卸时清理它自己的 handler 和注入脚本，App 的脚本保留原有顺序。

Web 可以从同一个 SDK 实例调用两个方法。业务方法注册时使用完整基础名称，支持按 v1 调用。业务 handler 在主 actor 上以异步函数执行，接收 JSON 对象参数，返回 JSON 值。耗时工作由 App 切换到适当的执行环境，并配合 Swift 任务取消。文档会话失效会取消旧任务，晚到结果不会进入新文档。

```ts
const device = await bridge.call('device.getInfo')
const config = await bridge.call('acme.app.getConfig')
```

示例的 Release 构建使用 App 内嵌的本地页面，以 App 指定的 HTTPS origin 验证 JSON-RPC 通道并显示两个结果。实际 App 的 HTTPS 页面可以用上面的 Web SDK 写法，业务方法使用自己的公司前缀。

示例的 `currentTheme` 由 App 持有。配置更新回调在主 actor 上修改状态，再发出已注册的事件。

```swift
currentTheme = "dark"
attachment?.emit("acme.app.configChanged", payload: NSNull())
```

`emit` 接收任意符合协议的 JSON 值，使用 `NSNull()` 表示 JSON `null`。页面通过 `bridge.on()` 订阅。 [订阅与状态同步](../../docs/native-host.md#app-自定义事件)

## 订阅 App 前后台事件

设置 `options: .init(appLifecycle: true)` 后，H5 可分别订阅 `app.foregrounded` 和 `app.backgrounded`。两项都返回 JSON `null`，分别来自 UIKit 的 `willEnterForegroundNotification` 和 `didEnterBackgroundNotification`。订阅确认后才发送后续转换。换页、退订和拆卸会结束对应的事件投递。

## 运行 Release SDK Consumer

在仓库根目录执行 `npm ci` 和 `npm run build:sdk-consumer`。该命令将通过 npm 安装 SDK 的共用 H5 生成到 `dist/sdk-consumer/ReleaseToast.html`，Xcode 将它打包为 App 资源。打开 [NativeIOSDemo.xcodeproj](NativeIOSDemo.xcodeproj)，选择 `IOSSDKConsumer` scheme，运行到 iPhone 模拟器后点击页面按钮。App 查询 iOS 版本并在 WebView 底部显示原生 toast。

在自有 App 中调用 `NativeIOSHost.attach` 时，使用 `options: .init(deviceInfo: true, toast: true)` 开启对应能力。`toast` 默认关闭。Web SDK 可以调用 `bridge.call('ui.toast.show', { text: '保存成功' })`。文本长度为 1–120 个 Unicode 码点，宿主接收展示请求后返回 `{}`。当前 WebView 须位于前台窗口。toast 支持 VoiceOver 公告，自动消失，并随文档会话失效清除。

向 options 加上 `media: true` 可开启 `media.chooseMedia@1` 的系统相册单张图片选择。`media` 默认关闭。iOS 使用 PHPicker，仅访问用户选中的图片。点击 H5 的 **Choose image** 打开系统选择器。选中后，页面解码 JPEG 缩略图并显示 **Preview ready**。取消时显示 **Selection cancelled**。

宿主在后台生成最长边 256 像素、原始 JPEG 不超过 32 KiB 的缩略图。返回值包含原图的 MIME、字节数和按显示方向计算的像素尺寸，以及缩略图 Base64。宿主为当前文档最多暂存 20 MiB 原图，超过单图上限或当前会话额度时返回 `-32006`。原图 ID 在五分钟后过期，跨文档导航、Web 内容进程退出或附件拆卸会提前使其失效。

启用媒体能力时，宿主也会通告 `media.release@1`。页面用完 `media.chooseMedia` 返回的文件 `file` 后，可提前归还原图占用的会话配额。页面已经取得的缩略图仍按 Web 对象 URL 的生命周期回收。

```ts
if (bridge.has('media.release', 1)) {
  await bridge.call('media.release@1', { ids: [file.id] })
}
```

一次可提交 1–32 个选图句柄。重复、已过期或本会话中不存在的 ID 会被跳过，成功返回 `null`。任一 ID 格式有误时，宿主返回 `-32602`，整批句柄保持原状。

同一 WebView 已有选择请求在进行时，新的选择请求返回 `-32010`。选择器无法打开、所选图片无法读取或解码时返回 `-32003`。用户关闭选择器时，结果为 `{ status: 'cancelled', files: [] }`。H5 通过 `AbortSignal` 中止本次 RPC 时，SDK 以 `-32002` 拒绝该调用。

## 宿主的关键代码

- [NativeIOSHost.swift](Sources/NativeIOSHost/NativeIOSHost.swift) 在主文档开始加载时注入冻结的 transport。Swift 使用 WebKit 给出的 `securityOrigin` 和 `isMainFrame` 校验调用者。Debug Demo 使用回环地址，App 接入入口使用精确的 HTTPS origin。
- WebKit 通道私下携带每份文档生成的标记。Swift 在当前主文档校验标记后才分派。跨文档提交、文档标记切换或 Web 内容进程退出会清除旧会话，向尚未完成的旧请求返回空回执并释放应答数据。应答只使用原消息的 `replyHandler`，晚到或重复的完成回调会被丢弃。
- [WireHost.swift](Sources/NativeIOSHost/WireHost.swift) 解析信封、建立会话、执行请求去重和限额、声明已启用的能力并维护订阅。从 App 注册表选择获准的业务方法。异步业务方法启用后，握手声明 `cancel`。
- [DeviceModule.swift](Sources/NativeIOSHost/DeviceModule.swift) 读取系统版本。[NetworkModule.swift](Sources/NativeIOSHost/NetworkModule.swift) 归一化系统网络路径并保存最近一次观测结果。推送脚本在交付前核对当前页面的 origin 和文档标记。页面隐藏时丢弃待交付消息，并轮换标记以便恢复时重新握手。
- 协议的来源、文档和会话规则适用于两种接入方式。[最小接入契约](../../docs/native-host.md)

## 测试

在 Xcode 以 iPhone 模拟器为目标运行 Debug 测试，保持 Web Demo 服务运行。WebKit 测试涵盖原生握手和 echo、系统提供的设备与网络快照、网络订阅确认、推送缓冲与退订、文档隐藏和切换时的隔离、并发限制及来源和 frame 校验。Release 接入测试使用 App 内嵌的 HTTPS 页面，可单独运行。

```sh
xcodebuild -project examples/native-ios/NativeIOSDemo.xcodeproj -scheme NativeIOSDemo \
  -configuration Release -destination 'platform=iOS Simulator,name=iPhone 17e' \
  -only-testing:NativeIOSDemoTests/ReleaseIOSTests CODE_SIGNING_ALLOWED=NO test
```

将设备名称换成本机已安装的模拟器。Release 测试可直接读取示例的内嵌页面，无需启动 Web Demo。

生成共用 H5 后，可以运行独立的 Release SDK Consumer 测试。测试从 WebView 执行 H5 调用，并检查原生 toast 的内容、位置、无障碍属性及自动消失。

```sh
xcodebuild -project examples/native-ios/NativeIOSDemo.xcodeproj -scheme IOSSDKConsumer \
  -configuration Release -destination 'platform=iOS Simulator,name=iPhone 17e' \
  CODE_SIGNING_ALLOWED=NO test
```

`IOSSDKConsumerMedia` scheme 通过 UI 测试取消一次选择，再从系统相册选择测试图片。H5 解码缩略图并显示预览。先生成共用 H5，再启动独立模拟器并把测试图片作为最新照片导入。

```sh
xcrun simctl addmedia <模拟器UDID> dist/sdk-consumer/MediaFixture.png
xcodebuild -project examples/native-ios/NativeIOSDemo.xcodeproj -scheme IOSSDKConsumerMedia \
  -configuration Release -destination 'platform=iOS Simulator,id=<模拟器UDID>' \
  -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO test
```

在 macOS 上可离线测试 Swift 协议处理。

```sh
swift test
```

WebKit 集成测试也可以在启动 Web Demo 服务后通过 macOS WebKit 运行。

```sh
OJSB_WEBKIT_E2E=1 swift test
```

命令行默认使用 Command Line Tools 时，可以在命令前加 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` 来选用 Xcode 工具链。
