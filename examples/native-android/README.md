# Kotlin / Android WebView 示例

Debug App 加载仓库的 [Web Demo](../web-demo/README.md)，用于验证握手、echo 和网络事件。Release App 自己创建并管理 `WebView`，用内嵌页面调用 `device.getInfo` 和 App 注册的 `acme.app.getConfig`。

## 接入 App 自己的 WebView

将本目录的 `host` 纳入 App 的 Gradle 工程，并在 App 模块添加 `implementation(project(":host"))`。在主线程创建 WebView、启用 JavaScript，并在首次导航前通过 `allowedOrigins` 传入需要接入的精确 HTTPS origin。使用非默认端口时，在 origin 中写明端口。切换到另一允许来源的文档后，页面重新握手和订阅。

```kotlin
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import android.webkit.WebViewClient
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import dev.openjsbridge.host.AndroidBridge
import dev.openjsbridge.host.BusinessMethod
import dev.openjsbridge.host.InvalidBusinessParamsException

val origin = "https://app.example.com"
val browser = WebView(this)
browser.settings.javaScriptEnabled = true

var currentTheme = "system"
val getConfig = BusinessMethod("acme.app.getConfig") { params ->
    if (params.size() != 0) throw InvalidBusinessParamsException()
    JsonObject().apply { addProperty("theme", currentTheme) }
}
val attachment = AndroidBridge.attach(
    webView = browser,
    allowedOrigins = listOf(origin, "https://support.example.com"),
    options = AndroidBridge.Options(deviceInfo = true, appLifecycle = true),
    methods = listOf(getConfig),
    events = listOf("acme.app.configChanged"),
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
import { bridge } from '@open-jsbridge/web/auto'

const device = await bridge.call('device.getInfo')
const config = await bridge.call('acme.app.getConfig')
```

`deviceInfo`、`networkStatus` 和 `networkChanges` 分别开启设备查询、默认网络查询和 `network.statusChanged`。使用网络能力的 App 在 manifest 声明 `ACCESS_NETWORK_STATE`。观察器在订阅时注册，会话退订或销毁时释放。 [设备和网络 Profiles](../../docs/native-profiles.md)

`appLifecycle` 开启 `app.foregrounded` 和 `app.backgrounded`，负载为 JSON `null`。订阅后，进程前后台切换时发送事件。 [AndroidX ProcessLifecycleOwner](https://developer.android.com/reference/androidx/lifecycle/ProcessLifecycleOwner)

示例的 `currentTheme` 由 App 持有。配置更新回调在主线程修改状态，再发出已注册的事件。

```kotlin
currentTheme = "dark"
attachment?.emit("acme.app.configChanged", JsonNull.INSTANCE)
```

`emit` 接收符合协议的 `JsonElement`，使用 `JsonNull.INSTANCE` 表示 JSON `null`。页面通过 `bridge.on()` 订阅。 [订阅与状态同步](../../docs/native-host.md#app-自定义事件)

### 业务方法的进度通知

仅为方法 Schema 已声明 `x-ojsb-callbacks` 的业务方法使用 `BusinessMethod.streaming`。例如，下面的方法生成一个标识符，并可在开始时通知页面。将 `generate` 加入上例的 `methods = listOf(getConfig, generate)` 即可注册。

```kotlin
val generate = BusinessMethod.streaming("acme.app.generate") { params, progress ->
    if (params.size() != 0) throw InvalidBusinessParamsException()
    progress.send(JsonObject().apply { addProperty("stage", "started") })
    JsonObject().apply { addProperty("id", java.util.UUID.randomUUID().toString()) }
}
```

页面在握手的 `wants` 中请求 `callbacks`，宿主在 `capabilities.features` 中确认后才可发送 `bridge.progress`。挂起函数 `progress.send(chunk: JsonElement?): Boolean` 返回本次通知是否已送入原文档的通道。`progress.send(null)` 省略 `chunk` 字段，`progress.send(JsonNull.INSTANCE)` 则发送显式 JSON `null`。进度通知可能丢弃，页面通过原请求的最终响应取得结果。[协议 §8 流式回调](../../docs/protocol.md#8-流式回调callback)

## 单图 Photo Picker（可选）

在 App 的 Activity 进入 `STARTED` 前注册 Activity Result launcher。用 `AndroidMediaPicker.createIntent(context)` 获取 AndroidX `PickVisualMedia` 选择的系统单图 Intent。可用范围包含系统内置选择器、扩展更新和已安装的 OEM 或 Google Play 服务回移实现，覆盖符合条件的 API 24–32 设备。App 可在启动时用 `isAvailable(context)` 探测，并在每次打开时重新调用 `createIntent(context)`。Activity Result 回调可用 `PickVisualMedia().parseResult(resultCode, data)` 解析 URI，再交给 `picker.onResult`。挂载时显式传 `AndroidBridge.Options(media = true)` 和 `mediaPicker = picker`。 [Android Photo Picker](https://developer.android.com/training/data-storage/shared/photo-picker) · [独立 Release App 接入](../android-sdk-consumer/README.md)

SDK 通过系统选择器读取用户选中的图片，无需相册或存储权限。设备缺少受信的选择器时 `createIntent` 返回 `null`，握手省略媒体能力。App 可选择在自己的 `<application>` 中声明官方 `ModuleDependencies` 服务，邀请 Google Play 服务为符合条件的旧设备安装回移组件。独立 Consumer 的 manifest 展示了此配置，安装由 App 显式启用。Release 验收可在 API 35 系统选择器和有已安装回移组件的旧设备上分别执行。 [安装配置](../android-sdk-consumer/app/src/main/AndroidManifest.xml)

页面收到当前文档的媒体 `id` 和 `thumbUrl`，用缩略图 URL 显示选择结果。原图暂存在宿主私有目录，每个会话最多 20 MiB，5 分钟内有效。换页、宿主销毁或到期时自动清理。关闭系统选择器返回 `cancelled`。SDK 取消请求后忽略迟到的系统结果，系统界面由用户关闭。[会话媒体协议](../../docs/protocol.md#101-原生句柄和缩略图)

仅需展示缩略图时，页面可以提前归还原图占用的会话配额。`media.release@1` 与选图共用 `Options(media = true)`、`mediaPicker` 和系统选择器可用性检查。页面在握手后分别检查两项能力，便可兼容只支持选图的宿主。

```ts
import { bridge, media } from '@open-jsbridge/web/auto'

export async function chooseThumbnail(preview: HTMLImageElement): Promise<void> {
  await bridge.ready()
  if (!bridge.has('media.chooseMedia', 1)) return

  const selection = await media.chooseMedia()
  if (selection.status === 'cancelled') return

  const { id, thumbUrl } = selection.files[0]
  preview.src = thumbUrl
  if (bridge.has('media.release', 1)) {
    await media.release({ ids: [id] })
  }
}
```

一次可提交 1–32 个句柄。成功返回 `null`，回收的配额可立即用于下一次选图，已显示的 `thumbUrl` 仍按原有效期和页面生命周期撤销。重复提交同一句柄只回收一次，已过期或当前会话查无记录的句柄会被跳过。若任一句柄格式错误，整批返回 `-32602`，原有句柄均保留。[主动释放契约](../../spec/methods/media/release.json)

## 前台上传选中的图片

在 App 的 manifest 中声明 `android.permission.INTERNET`，启用上节的 Photo Picker，并在挂载时传入 `uploadPolicy`。每个 `TransferUploadEndpoint` 将一个页面来源绑定到一个完整的 HTTPS URL，路径和显式端口都参与匹配。下面只允许 `https://app.example.com` 把所选图片提交到头像端点，原生端在请求获准后提供该端点的凭据。

```kotlin
import android.webkit.WebView
import dev.openjsbridge.host.AndroidBridge
import dev.openjsbridge.host.AndroidMediaPicker
import dev.openjsbridge.host.TransferUploadEndpoint
import dev.openjsbridge.host.TransferUploadPolicy

fun attachAvatarUpload(view: WebView, picker: AndroidMediaPicker, accessToken: () -> String): AndroidBridge? {
    val origin = "https://app.example.com"
    val endpoint = TransferUploadEndpoint(
        origin = origin,
        url = "https://uploads.example.com/v1/avatar",
        credentials = { mapOf("Authorization" to "Bearer ${accessToken()}") },
    )
    return AndroidBridge.attach(
        webView = view, allowedOrigins = listOf(origin), options = AndroidBridge.Options(media = true),
        mediaPicker = picker, uploadPolicy = TransferUploadPolicy(listOf(endpoint)),
    )
}
```

页面握手后分别检查选图和上传能力。上传使用当前会话的句柄，宿主将图片转成 JPEG 并以 `multipart/form-data` 发送一次 POST。可在调用选项中传 `timeout`、`signal` 和 `onProgress`。进度按完整请求体的字节报告。收到最终响应后，页面根据实际 HTTP 状态和正文判断业务结果，空正文表示为空字符串。

```ts
import { bridge, media } from '@open-jsbridge/web/auto'
import { transfer } from '@open-jsbridge/web/transfer'

export async function uploadAvatar(signal: AbortSignal) {
  await bridge.ready()
  if (!bridge.has('media.chooseMedia', 1) || !bridge.has('transfer.upload', 1)) return
  const choice = await media.chooseMedia()
  if (choice.status === 'cancelled') return
  return transfer.upload({
    id: choice.files[0].id,
    request: { url: 'https://uploads.example.com/v1/avatar' },
  }, { timeout: 60_000, signal })
}
```

端点可以返回未压缩的正文，或只含一个完整成员的 gzip 正文。解压后最多 32 KiB，非空正文须为端点允许的 UTF-8 文本或 JSON。收到重定向时，宿主以 `redirect_denied` 结束调用。

切到后台会取消进行中的上传。句柄到期或页面主动释放句柄时，上传以 `-32003` 结束。上传成功后，页面仍可按上节示例调用 `media.release` 提前归还配额。[上传契约](../../spec/methods/transfer/upload.json) · [前台上传 RFC](../../spec/rfcs/transfer-upload.md)

## 在模拟器验证

准备 JDK 17、Android SDK Platform 35、Build Tools 34.0.0 和 Platform Tools。命令行使用 `JAVA_HOME` 和 `ANDROID_HOME`，并将 `platform-tools` 加入 `PATH`。启动一台 API 24+ 且支持上述 WebView 功能的 Android Emulator。Windows 使用 `gradlew.bat`。

Release 示例为 App 内嵌页面设置 HTTPS base URL。可直接查看设备系统版本和业务配置，无需启动 Web Demo 服务。点击 App 的 **Toggle theme** 按钮，原生会发出 `acme.app.configChanged`，页面收到后更新显示的主题。以下属性仅用于模拟器测试，启用 Release 测试变体和本地测试签名。

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
