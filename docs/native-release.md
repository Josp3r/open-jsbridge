# SDK 1.0.0 发版与产物验收

Web、iOS 和 Android 使用统一正式版本号 `1.0.0`（对应冻结后的协议 `jsb: 1.0`）。签名、远端标签及正式发布由维护者在发版窗口执行；发版完成后按 [TODO.md](../TODO.md) 与 [AGENTS.md](../AGENTS.md) §2.5 转入维护模式。

## 1. Web（npm `@open-jsbridge/web`）

在仓库根目录执行校验与打包：

```sh
npm ci
npm run lint
npm run codegen:check
npm test
npm run size:web
npm run pack:web
```

确认生成 `dist/open-jsbridge-web-1.0.0.tgz` 后，可在独立项目安装并检查 ESM 导入与 TypeScript 类型（[Web 安装方式](../examples/web-demo/README.md#从源码打包安装)）。维护者发布正式版：

```sh
npm publish ./dist/open-jsbridge-web-1.0.0.tgz --access public
```

## 2. iOS（SwiftPM `NativeIOSHost`）

仓库根目录的 `Package.swift` 提供 `NativeIOSHost` 产品。本地预验收时可将待发布提交复制到临时 Git 仓库并创建 `1.0.0` 标签，从独立 App 按确切版本依赖并运行 Release 构建（[Release Consumer 验收](../examples/sdk-consumer/README.md#ios-release)）：

```swift
.package(url: "https://github.com/Josp3r/open-jsbridge", exact: "1.0.0")
```

维护者打正式标签并推送：

```sh
git tag -a 1.0.0 -m "Release 1.0.0"
git push origin 1.0.0
```

## 3. Android（Maven Central `io.github.josp3r:open-jsbridge-android:1.0.0`）

### 方式 A：通过 GitHub Actions 一键构建、签名并上传（推荐）

仓库提供手动触发工作流 [`.github/workflows/release-android.yml`](../.github/workflows/release-android.yml)，无需本地安装 JDK 17 或 Android SDK。在仓库 `Settings → Secrets and variables → Actions` 配置以下 4 个 Secret：

- `MAVEN_CENTRAL_USERNAME` / `MAVEN_CENTRAL_PASSWORD`：Sonatype Central Portal 生成的 User Token 用户名与密码
- `SIGNING_KEY`：ASCII-armored GPG 私钥（`gpg --armor --export-secret-keys <KEY_ID>`，对应公钥须先上传至 `keys.openpgp.org` 或 `keyserver.ubuntu.com`）
- `SIGNING_PASSWORD`：GPG 私钥口令（无口令可留空）

配置完成后在 GitHub Actions 选择 **Release Android to Maven Central → Run workflow**（支持先勾选 `dry_run: true` 验证签名包，再以 `publishing_type: AUTOMATIC` 或 `USER_MANAGED` 正式发布）。

### 方式 B：本地构建未签名包

在仓库根目录生成 Maven Central 未签名产物包（环境要求见 [Android SDK Consumer](../examples/android-sdk-consumer/README.md)）：

```sh
./examples/native-android/gradlew -p examples/native-android :host:bundleUnsignedCentralRelease
unzip -l examples/native-android/host/build/central/open-jsbridge-android-1.0.0-central-unsigned.zip
```

ZIP 按 Maven 路径包含 Release AAR、POM、Gradle module metadata、源码 JAR、接入文档 JAR 和校验和。维护者对其中的发布文件补齐 GPG `.asc` 签名后，打包上传至 [Sonatype Central Portal](https://central.sonatype.org/publish/requirements/)。

Android 10–12（API 29–32）Photo Picker 兼容验收由 CI 中的 `Android 11 Photo Picker Compat`（API 30 模拟器）与 `Android Release WebView`（API 35 模拟器）执行 `AndroidPhotoPickerCompatTest` 替代物理真机（见 [docs/team-status.md](team-status.md) `D-014`），覆盖系统/回移 Photo Picker 解析、非 `ACTION_OPEN_DOCUMENT` 兜底、握手能力声明一致性与缩略图 EXIF 方向解码。
