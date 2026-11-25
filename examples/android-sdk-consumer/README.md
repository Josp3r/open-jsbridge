# Android SDK Release Consumer

这是一个独立 Gradle 工程。App 只通过 Maven 坐标 `io.github.josp3r:open-jsbridge-android:0.1.0` 接入 Android SDK，不包含 `:host` 源码或 composite build。共享 H5 从 npm 打包产物安装 Web SDK 后构建；本工程只把产物按原样打进 APK，不重写页面或替换 transport。

## 构建与验收

在仓库根目录执行。需要 JDK 17、Android SDK Platform 35、Build Tools 34.0.0 和 Platform Tools（将 `adb` 加入 `PATH`），以及已启动、解锁且支持 document-start 和 WebMessageListener 的 Android Emulator。完整验收建议使用全新的 API 35 Google APIs AVD，验证系统绘制的文字 Toast 和系统 Photo Picker。若有多个设备，请设置 `ANDROID_SERIAL`。

```bash
npm ci
npm run build:sdk-consumer

repo="$PWD/examples/native-android/build/sdk-maven"
page="$PWD/dist/sdk-consumer/ReleaseToast.html"
media_fixture="$PWD/dist/sdk-consumer/MediaFixture.png"

./examples/native-android/gradlew -p examples/native-android \
  :host:publishReleasePublicationToLocalSdkRepository -PojsbSdkRepository="$repo"

./examples/android-sdk-consumer/gradlew -p examples/android-sdk-consumer \
  :app:assembleRelease :app:assembleReleaseAndroidTest :app:connectedReleaseAndroidTest \
  -PojsbSdkRepository="$repo" -PojsbConsumerPage="$page" -PojsbConsumerMediaFixture="$media_fixture"

./examples/android-sdk-consumer/gradlew -p examples/android-sdk-consumer \
  :app:dependencies --configuration releaseRuntimeClasspath -PojsbSdkRepository="$repo"
```

可省略属性以使用以上默认位置（跨工程覆盖时建议使用绝对路径）。共享 PNG 仅打入测试 APK；若只构建 App 或运行旧 Toast 测试，没有提供 PNG 也可构建。需要只运行 Toast 测试时，可给 `connectedReleaseAndroidTest` 添加 `-Pandroid.testInstrumentationRunnerArguments.class=dev.openjsbridge.sdkconsumer.ReleaseSdkConsumerTest`。本地 Maven 目录只负责 `open-jsbridge-android`，其传递依赖仍从 Google Maven / Maven Central 获取。发布物为 Release AAR、POM 和 Gradle module metadata。`Gson` 是 SDK 的 API 依赖；AndroidX WebKit 与 Kotlin coroutines 是 SDK 的运行时依赖，无需另加到 App。

如需手动验收，安装 [Release APK](<app/build/outputs/apk/release/app-release.apk>)，打开 **Open JSBridge SDK Consumer** 并点击页面按钮。App 将内嵌 H5 以 `https://sdk-consumer.example.test/` 为 base URL 加载，不请求该域名。App 用公开 `AndroidBridge.attach` 启用 Device Info 和 Toast；仅在设备支持系统 Photo Picker 时额外启用 Media。App 在启动前注册 Activity Result launcher，向 SDK 转发选图结果、文档 commit、renderer termination 和 detach 生命周期，不申请照片库读权限。Release 用测试签名以便安装和运行 instrumentation；目标 APK 不可调试。

Release instrumentation 调用 `window.__sdkToastProbe()`，校验 JavaScript 返回值、页面状态与 Android 的原生 Toast 无障碍事件（包含预期文字），并另测不同 HTTPS 端口的文档无法使用 bridge。运行 `connectedReleaseAndroidTest` 后，可查看 [Release 测试报告](<app/build/reports/androidTests/connected/release/>) 和 [Release 测试结果 XML](<app/build/outputs/androidTest-results/connected/release/>)。原生 Toast 截图若可捕获，测试会将其记录到日志指明的目标 App 外部文件目录；可在卸载前用 `adb pull` 保存。

[Photo Picker 测试](<app/src/androidTest/java/dev/openjsbridge/sdkconsumer/ReleaseSystemPhotoPickerTest.kt>)在 API 33+ 上将一张唯一命名的共享 PNG 写入 MediaStore，用系统无障碍动作点击实际系统 Picker 的测试图片或按返回键关闭，不伪造 Activity Result，也不修改已有照片。测试核对 MIME、大小、逐字节读取、显式释放后的拒绝、同源文档替换后的失效、不同 HTTPS 端口不可用，以及关闭后不返回 blob。写入过测试 PNG 的用例在 `finally` 中只删除自己创建的 MediaStore 行。
