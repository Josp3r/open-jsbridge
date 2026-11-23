# Android WebView 宿主示例

这个 Kotlin 示例在 Android Emulator 中加载同一个 [Web Demo](../web-demo/README.md)。页面里的 Web SDK 通过 AndroidX WebKit 完成 `bridge.hello` 和 `conformance.echo`，首次发送 echo 时会自动握手。

## 运行

准备 JDK 17、Android SDK Platform 35、Build Tools 34.0.0 和 Platform Tools。命令行运行时，将 `JAVA_HOME` 指向 JDK、`ANDROID_HOME` 指向 SDK，并把 `platform-tools` 加入 `PATH`。启动一台 API 24 或更高的 Android Emulator。设备上的 WebView 必须支持 `WEB_MESSAGE_LISTENER` 和 `DOCUMENT_START_SCRIPT`。 [AndroidX WebKit](https://developer.android.com/reference/androidx/webkit/WebViewCompat)

在仓库根目录启动页面服务，并保持该命令运行。

```sh
npm ci
npm run demo:web
```

在另一个终端中安装并启动 debug App。也可以用 Android Studio 打开本目录，选中 Emulator 后运行 `app`。

```sh
cd examples/native-android
./gradlew :app:installDebug
adb shell am start -n dev.openjsbridge.example/.MainActivity
```

Windows 使用 `gradlew.bat`。Android Emulator 的 `10.0.2.2` 指向开发机的 loopback。App 打开 `http://10.0.2.2:4173/?host=native`，该模式等待 WebView 注入。点击「发送 echo」，连接状态应显示「已连接 android-wml」，SDK 返回 `{"text":"你好"}`。点击「试试报错」可观察 SDK 对未声明方法返回的 `-32601`。如果 App 提示 WebView 功能不足，请更新 Emulator 中的 WebView 并重试。

## 宿主接入

1. 先创建 WebView，启用 JavaScript，再调用 `AndroidBridge.attach(webView, allowedOrigin)`。在 `loadUrl` 前完成注册，检查返回值是否为 `null`。宿主侧需要一个精确的 origin，例如 `https://web.example.com`，含非默认端口时写明端口。
2. 从应用自己的 `WebViewClient` 转发 `onPageCommitVisible` 和 `onRenderProcessGone`，并在 WebView 销毁前调用 `detach()`。Activity 中可查看完整接入方式。 [MainActivity.kt](app/src/main/java/dev/openjsbridge/example/MainActivity.kt)
3. 文档启动时安装 `window.__OJSB_TRANSPORT__`。主 frame 提交后，宿主用一次随机挑战确认当前文档，再通过 AndroidX WebKit 的 `sourceOrigin`、`isMainFrame` 和 `JavaScriptReplyProxy` 绑定会话。所有 RPC 回复由对应文档的 proxy 交付。 [AndroidBridge.kt](app/src/main/java/dev/openjsbridge/example/AndroidBridge.kt) · [DocumentTransport.kt](app/src/main/java/dev/openjsbridge/example/DocumentTransport.kt)

示例限定单个 origin、主 frame、64 KiB UTF-8 信封和一个同步 host handler。去重集合跟随文档和会话，各可记录 4096 个请求 id。达到容量后，新请求返回 `-32008` 并在登记前结束，刷新页面可恢复。握手声明的事件和可选特性列表为空。Android 的 cleartext 配置仅在 debug 构建为模拟器主机名 `10.0.2.2` 放行，Bridge 将端口进一步限定为 `4173`。`conformance.echo` 仅在 debug 构建启用。

## 验证

在本目录运行宿主单元测试。运行设备测试时，保留 Web Demo 服务并连接一台支持上述功能的 Emulator。

```sh
./gradlew :app:testDebugUnitTest :app:assembleDebug
./gradlew :app:connectedDebugAndroidTest
```

在仓库根目录也可以单独验证注入脚本。

```sh
node --test examples/native-android/test/shim.test.mjs
```
