# 原生 SDK 独立接入验收

两个最小 App 都创建自己的 WebView，安装宿主 SDK，启用设备信息和 Toast。它们加载同一份 H5。页面先查询 `device.getInfo`，再用 Web SDK 的 `ui.toast.show()` 调用原生 Toast。

## 生成共享页面

在仓库根目录运行。

```bash
npm ci
npm run build:sdk-consumer
```

构建脚本先生成 Web SDK 的 npm tarball，再在临时项目离线安装它，输出可直接内嵌的 `dist/sdk-consumer/ReleaseToast.html`。

## iOS Release

`IOSSDKConsumer` 是一个独立 App target，使用仓库根目录的 Swift Package 的 `NativeIOSHost` 产品。在 Xcode 选中其 scheme 后可直接在模拟器运行，也可以从终端执行。

```bash
xcodebuild -project examples/native-ios/NativeIOSDemo.xcodeproj \
  -scheme IOSSDKConsumer -configuration Release \
  -destination 'platform=iOS Simulator,id=<simulator-uuid>' \
  -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO test
```

测试运行真实的 `WKWebView`，用共享页面触发 Toast，并查询应用内的 UIKit 视图来验证展示和消失。App 集成可参考 [iOS 宿主说明](../native-ios/README.md)。

## Android Release

独立 Gradle 工程通过 Maven 坐标安装 Release AAR。仪器测试校验网页调用结果及 Android 系统 Toast 的实际展示。[Android 构建和验收](../android-sdk-consumer/README.md)
