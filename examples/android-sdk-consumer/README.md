# Android SDK Release Consumer

这是一个独立 Gradle 工程。App 只通过 Maven 坐标 `io.github.josp3r:open-jsbridge-android:0.1.0` 接入 Android SDK，不包含 `:host` 源码或 composite build。共享 H5 从 npm 打包产物安装 Web SDK 后构建；本工程只把产物按原样打进 APK，不重写页面或替换 transport。

## 构建与验收

在仓库根目录执行。需要 JDK 17、Android SDK Platform 35、Build Tools 34.0.0 和 Platform Tools（将 `adb` 加入 `PATH`），以及已启动、解锁且支持 document-start 和 WebMessageListener 的 Android Emulator。验证系统绘制的文字 Toast 建议使用 API 35。若有多个设备，请设置 `ANDROID_SERIAL`。

```bash
npm ci
npm run build:sdk-consumer

repo="$PWD/examples/native-android/build/sdk-maven"
page="$PWD/dist/sdk-consumer/ReleaseToast.html"

./examples/native-android/gradlew -p examples/native-android \
  :host:publishReleasePublicationToLocalSdkRepository -PojsbSdkRepository="$repo"

./examples/android-sdk-consumer/gradlew -p examples/android-sdk-consumer \
  :app:assembleRelease :app:assembleReleaseAndroidTest :app:connectedReleaseAndroidTest \
  -PojsbSdkRepository="$repo" -PojsbConsumerPage="$page"

./examples/android-sdk-consumer/gradlew -p examples/android-sdk-consumer \
  :app:dependencies --configuration releaseRuntimeClasspath -PojsbSdkRepository="$repo"
```

可省略属性以使用以上默认目录，或用 `-PojsbSdkRepository` 和 `-PojsbConsumerPage` 覆盖（跨工程建议使用绝对路径）。本地 Maven 目录只负责 `open-jsbridge-android`，其传递依赖仍从 Google Maven / Maven Central 获取。发布物为 Release AAR、POM 和 Gradle module metadata。`Gson` 是 SDK 的 API 依赖；AndroidX WebKit 与 Kotlin coroutines 是 SDK 的运行时依赖，无需另加到 App。

如需手动验收，安装 `app/build/outputs/apk/release/app-release.apk`，打开 **Open JSBridge SDK Consumer** 并点击页面按钮。App 将内嵌 H5 以 `https://sdk-consumer.example.test/` 为 base URL 加载，不请求该域名。App 用公开 `AndroidBridge.attach` 只启用 Device Info 和 Toast，并转发文档 commit、renderer termination 和 detach 生命周期。Release 用测试签名以便安装和运行 instrumentation；目标 APK 不可调试。

Release instrumentation 调用 `window.__sdkToastProbe()`，校验 JavaScript 返回值、页面状态与 Android 的原生 Toast 无障碍事件（包含预期文字），并另测不同 HTTPS 端口的文档无法使用 bridge。运行 `connectedReleaseAndroidTest` 后，报告位于 `app/build/reports/androidTests/connected/release/`，XML 位于 `app/build/outputs/androidTest-results/connected/release/`。原生 Toast 截图若可捕获，测试会将其记录到日志指明的目标 App 外部文件目录；可在卸载前用 `adb pull` 保存。
