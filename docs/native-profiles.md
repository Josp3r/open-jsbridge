# 原生基础能力

参考宿主提供 `device`、`network`、Toast 和相册选择能力。App 为指定 WebView 和受信来源启用需要的能力。第三方宿主可按同一份 Schema 实现，Web 使用相同的方法名。

其他系统能力的归属与候选范围见 [原生能力目录提案](native-capability-catalog.md)。

基础能力当前提供 v1。裸方法名和 `@1` 指向同一个契约。未声明的方法或版本使用 `-32601`，参数违反契约时使用 `-32602`。

## Device

[`device.getInfo` v1](../spec/methods/device/getInfo.json) 省略参数或传入 `{}`。结果包含操作系统 `os`（`ios` 或 `android`）和系统给出的非空版本字符串 `osVersion`。版本字符串用于展示和诊断。Web 用握手能力判断功能是否可用。

## Network

[`network.getStatus` v1](../spec/methods/network/getStatus.json) 省略参数或传入 `{}`。它的结果和 [`network.statusChanged` 事件](../spec/methods/network/statusChanged.json) 使用同一个 [`{ type }` Schema](../spec/schemas/network-status.json)。

- `wifi`、`cellular`、`ethernet` 表示系统为宿主 App 选择的网络类型。
- `other` 表示已知存在默认路径，但类型属于其他类别或无法归为单一已列类型。
- `none` 表示系统确认当前没有可用的默认路径。`unknown` 表示宿主尚未获取足够的信息。

这个结果描述系统网络路径。业务请求的实际响应反映目标服务是否可达。查询和事件独立声明，宿主按可用能力公布 `capabilities.methods` 和 `capabilities.events`。事件只在标准化后的类型变化时发送。订阅确认代表宿主已完成订阅，可以另外调用查询获取初始状态。页面重新可见时也可重新查询。

## App 生命周期

宿主按需启用 [`app.foregrounded`](../spec/methods/app/foregrounded.json) 和 [`app.backgrounded`](../spec/methods/app/backgrounded.json)。两个事件的 v1 payload 均为 `null`，描述宿主进程已经发生的变化。订阅完成后接收后续变化，通过 `bridge.ready()` 等待握手。iOS 使用 UIApplication 的 `willEnterForeground` 和 `didEnterBackground`，Android 使用 ProcessLifecycleOwner 的 `onStart` 和 `onStop`。 [Apple 生命周期](https://developer.apple.com/documentation/uikit/uiapplication/willenterforegroundnotification) · [Android 进程生命周期](https://developer.android.com/reference/androidx/lifecycle/ProcessLifecycleOwner)

```ts
import { app } from '@open-jsbridge/web/app'

const off = app.onForegrounded(() => refresh())
await off.ready
```

## Toast

[`ui.toast.show` v1](../spec/methods/ui/toast/show.json) 接收 `{ text }`，文本长度为 1 至 120 个 Unicode 码点。宿主接受展示请求后返回 `{}`。Toast 的显示时长与样式由宿主决定。无法接受展示请求时返回 `-32603`。

App 挂载宿主时显式设置 `toast = true`，页面即可在握手后通过 `bridge.has('ui.toast.show', 1)` 检测。浏览器联调时，用 `installMockTransport({ showToast: (text) => console.log(text) })` 模拟宿主接收。

## Media

[`media.chooseMedia` v1](../spec/methods/media/chooseMedia.json) 打开系统照片选择器，允许从相册选择一张图片。宿主显式启用该模块，同一 WebView 同时只处理一次选择。可以省略参数，也可以传入 `{ mediaType: ['image'], sourceType: ['album'], count: 1 }`。iOS 14+ 使用 PHPicker。Android 使用 AndroidX `PickVisualMedia`，API 24–32 需要设备提供系统 Photo Picker 或已安装的回移版本。设备缺少可用选择器时，握手不声明 `media.chooseMedia`。两端都只获得选中图片的访问权，无需申请相册或存储权限。[Android Photo Picker](https://developer.android.com/training/data-storage/shared/photopicker)

用户关闭选择器时返回 `{ status: 'cancelled', files: [] }`。成功时线上响应为 `{ status: 'selected', files: [{ type: 'image', id, mime, size, width, height, expiresAt, thumbnailBase64 }] }`。`id` 是宿主保管的媒体句柄，`width` 和 `height` 表示原图按正确方向显示时的像素尺寸。`thumbnailBase64` 是 JPEG 缩略图的 Base64，长边至多 256 px，解码后的 JPEG 至多 32 KiB。Web SDK 将这个字段转换成 `blob:` URL，以 `thumbUrl` 提供给业务代码。页面使用 CSP 时，在 `img-src` 中允许 `blob:` 即可预览。[会话媒体协议](protocol.md#101-原生句柄和缩略图)

原图由宿主保存在当前文档会话中，最长保留 5 分钟，会话暂存总量上限为 20 MiB。Web SDK 默认等待 120 秒，支持 `AbortSignal`，并在有效期结束或文档会话失效时自动撤销缩略图 URL。该能力可从源码构建使用，已发布的 `@open-jsbridge/web@0.1.0` 尚未包含它。

- `-32010` 表示已有选择请求在进行或先前打开的选择器仍在等待系统回调。
- `-32003` 表示无法展示选择器，或系统无法读取或解码已选图片。
- `-32002` 表示调用方中止 RPC。单张图片或会话暂存量超出上限时返回 `-32006`。
- v1 通过系统选择器授权单张图片，无单独的权限弹窗，因此不会返回 `-32007`。未来有显式权限拒绝路径的能力才使用该码。

```ts
import { bridge } from '@open-jsbridge/web/auto'
import { media } from '@open-jsbridge/web/media'

export async function chooseImage(preview: HTMLImageElement): Promise<void> {
  await bridge.ready()
  if (!bridge.has('media.chooseMedia', 1)) return

  const result = await media.chooseMedia()
  if (result.status === 'cancelled') return
  preview.src = result.files[0].thumbUrl
}
```

原生全屏预览、原图上传与进度是候选能力。缩略图适合在选择结果页展示。

## Web 接入

```ts
import { bridge, ui } from '@open-jsbridge/web/auto'

await bridge.ready()

if (bridge.has('device.getInfo', 1)) {
  console.log(await bridge.call('device.getInfo'))
}

if (bridge.has('ui.toast.show', 1)) {
  await ui.toast.show({ text: '已保存' })
}

if (bridge.hasEvent('network.statusChanged')) {
  const off = bridge.on<{ type: string }>('network.statusChanged', ({ type }) => {
    console.log('网络变化', type)
  })
  try {
    await off.ready
  } catch (error) {
    off()
    throw error
  }
  // 在组件卸载时调用 off()
}

if (bridge.has('network.getStatus', 1)) {
  console.log(await bridge.call('network.getStatus'))
}
```

## 宿主接入与演示

参考宿主为配置的受信主文档提供能力。订阅须匹配活动会话和宿主声明的事件。退订后停止推送，并释放只为该订阅启动的原生监听。宿主可在会话有效期间保留查询所用的网络状态缓存和监听。文档会话失效时清理其订阅和监听。Android 读取网络状态需要在 Manifest 中声明 `ACCESS_NETWORK_STATE`。

两端示例注册实际原生实现并加载同一个页面。点击「查询设备信息」或「查询网络状态」会触发自动握手。宿主声明网络事件后，页面会显示订阅控件。可以切换设备网络观察事件，也可以在浏览器 Mock 中用按钮模拟切换。

[iOS 示例](../examples/native-ios/README.md) · [Android 示例](../examples/native-android/README.md) · [共享 Web Demo](../examples/web-demo/README.md)
