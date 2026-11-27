# SDK 0.2.0 候选产物验收

Web、iOS 和 Android 使用同一个候选版本号 `0.2.0`，现阶段验收本地 npm tarball、SwiftPM 的确切版本解析和 Android Maven 产物。签名、远端标签及正式发布由维护者在单独的发布流程中处理。

## Web

运行 `npm run lint`、`npm test`、`npm run size:web` 和 `npm run pack:web`。在独立项目安装 `dist/open-jsbridge-web-0.2.0.tgz`，用 ESM 导入并检查 TypeScript 类型。[Web 安装方式](../examples/web-demo/README.md#从源码打包安装)

## iOS

仓库根目录的 `Package.swift` 提供 `NativeIOSHost` 产品。将待验收提交复制到临时 Git 仓库，在该副本创建 `0.2.0` 标签。从独立 App 按确切版本添加依赖，将示例路径替换为副本的实际路径。

```swift
.package(url: "file:///absolute/path/to/open-jsbridge", exact: "0.2.0")
```

添加 `NativeIOSHost` 产品，运行 SwiftPM 解析与 Release 构建，确认 `Package.resolved` 记录 `0.2.0` 及验收提交。[Release Consumer 验收](../examples/sdk-consumer/README.md#ios-release)

## Android

Android Release AAR 的候选 Maven 坐标为 `io.github.josp3r:open-jsbridge-android:0.2.0`。在仓库根目录生成本地包。环境要求见 [Android SDK Consumer](../examples/android-sdk-consumer/README.md)。

```sh
./examples/native-android/gradlew -p examples/native-android :host:bundleUnsignedCentralRelease
unzip -l examples/native-android/host/build/central/open-jsbridge-android-0.2.0-central-unsigned.zip
```

ZIP 按 Maven 路径包含 Release AAR、POM、Gradle module metadata、源码 JAR、接入文档 JAR 和校验和。独立 Consumer 通过本地 Maven 仓库安装同一版本并构建 Release。候选构建产物可供后续签名和 Central 上传流程使用。[Central 产物要求](https://central.sonatype.org/publish/requirements/)

Android 10–12（API 29–32）Photo Picker 兼容验收由 CI 中的 `Android 11 Photo Picker Compat`（API 30 模拟器）与 `Android Release WebView`（API 35 模拟器）执行 `AndroidPhotoPickerCompatTest` 替代物理真机（见 [docs/team-status.md](team-status.md) `D-014`），覆盖系统/回移 Photo Picker 解析、非 `ACTION_OPEN_DOCUMENT` 兜底、握手能力声明一致性与缩略图 EXIF 方向解码。
