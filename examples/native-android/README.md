# Kotlin / Android WebView 示例

Debug App 加载仓库的 [Web Demo](../web-demo/README.md)，用于验证握手、echo 和网络事件。Release App 自己创建并管理 `WebView`，用内嵌页面调用 `device.getInfo` 和 App 注册的 `acme.app.getConfig`。

## 接入 App 自己的 WebView

将本目录的 `host` 纳入 App 的 Gradle 工程，并在 App 模块添加 `implementation(project(":host"))`。在主线程创建 WebView、启用 JavaScript，并在首次导航前传入一个精确的 HTTPS origin。使用非默认端口时，在 origin 中写明端口。

```kotlin
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import android.webkit.WebViewClient
import com.google.gson.JsonObject
import dev.openjsbridge.host.AndroidBridge
import dev.openjsbridge.host.BusinessMethod
import dev.openjsbridge.host.InvalidBusinessParamsException

val origin = "https://app.example.com"
val browser = WebView(this)
browser.settings.javaScriptEnabled = true

val getConfig = BusinessMethod("acme.app.getConfig") { params ->
    if (params.size() != 0) throw InvalidBusinessParamsException()
    JsonObject().apply { addProperty("theme", "system") }
}
val attachment = AndroidBridge.attach(
    webView = browser,
    allowedOrigin = origin,
    options = AndroidBridge.Options(deviceInfo = true),
    methods = listOf(getConfig),
)

if (attachment != null) {
    browser.webViewClient = object : WebViewClient() {
        override fun onPageCommitVisible(view: WebView, url: String) {
            attachment.onPageCommitVisible(url)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            attachment.onRenderProcessGone()
            (view.parent as? android.view.ViewGroup)?.removeView(view)
            view.destroy()
            return true
        }
    }
    setContentView(browser)
    browser.loadUrl("$origin/")
}
```

App 将上面的回调加到已有的 `WebViewClient`，由 App 继续管理导航。保留附件，并在销毁或替换 WebView 前调用 `attachment.detach()`。如果附件返回 `null`，可由 App 显示提示或提供普通网页体验。需要的 WebView 功能为 `WEB_MESSAGE_LISTENER` 和 `DOCUMENT_START_SCRIPT`。 [AndroidBridge.kt](host/src/main/java/dev/openjsbridge/host/AndroidBridge.kt) · [示例 Activity](app/src/main/java/dev/openjsbridge/example/MainActivity.kt)

业务方法注册时使用 App 自己的完整基础名称，握手声明 v1。handler 是在主线程协程中调用的 `suspend` 函数，接收 JSON 对象并返回 JSON 值。阻塞工作由 App 切换到适当的调度器。文档会话失效会取消旧任务，回执通过原文档确认的通道返回。 [Release App 的配置读取](app/src/release/java/dev/openjsbridge/example/ExampleBridge.kt)

页面可直接调用 Web SDK。

```ts
import { bridge } from '@open-jsbridge/web'

const device = await bridge.call('device.getInfo')
const config = await bridge.call('acme.app.getConfig')
```

`deviceInfo`、`networkStatus` 和 `networkChanges` 分别开启设备查询、默认网络查询和网络变化事件。使用网络能力的 App 在 manifest 声明 `ACCESS_NETWORK_STATE`。观察器在订阅时注册，会话退订或销毁时释放。 [设备和网络 Profiles](../../docs/native-profiles.md)

## 在模拟器验证

准备 JDK 17、Android SDK Platform 35、Build Tools 34.0.0 和 Platform Tools。命令行使用 `JAVA_HOME` 和 `ANDROID_HOME`，并将 `platform-tools` 加入 `PATH`。启动一台 API 24+ 且支持上述 WebView 功能的 Android Emulator。Windows 使用 `gradlew.bat`。

Release 示例为 App 内嵌页面设置 HTTPS base URL。可直接查看设备系统版本和业务配置，无需启动 Web Demo 服务。以下属性仅用于模拟器测试，启用 Release 测试变体和本地测试签名。

```sh
cd examples/native-android
./gradlew -PojsbTestBuildType=release :app:installRelease
adb shell am start -n dev.openjsbridge.example/.MainActivity
./gradlew -PojsbTestBuildType=release :app:connectedReleaseAndroidTest
```

Debug 示例从开发机加载 `http://10.0.2.2:4173/?host=native`。先在仓库根目录运行 `npm ci` 和 `npm run demo:web`，保持服务运行。Android Emulator 将 `10.0.2.2` 转到开发机的 loopback，Debug 构建针对这个地址放行本地 HTTP 和 `conformance.echo`。

```sh
cd examples/native-android
./gradlew :app:installDebug
adb shell am start -n dev.openjsbridge.example/.MainActivity
./gradlew :host:testDebugUnitTest :app:connectedDebugAndroidTest
```

在仓库根目录可单独测试注入脚本。

```sh
node --test examples/native-android/test/shim.test.mjs
```
