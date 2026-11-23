# 原生能力目录

**设计提案**

这个目录为原生 App 与 WebView 之间的能力命名提供入口。开发者先按能力归属查目录，再找对应的协议契约。目录尽量覆盖通用 App、系统集成和垂直场景，方便判断一个需求适合复用标准能力、提案补充标准能力，还是由宿主定义扩展。

## 目录、契约和运行时能力

- **目录**说明每个领域负责什么、常见需求放在哪里、平台差异在哪里。下文的候选命名空间用于讨论归属。新增命名空间进入标准时，再按协议流程登记。
- **契约**定义调用方可依赖的行为。已定义的方法和事件可以在 `spec/methods/` 找到 Schema 和版本信息，语义见对应文档。一致性用例验证消息、权限、生命周期和边界行为。标准能力由宿主按需实现。[Schema 与一致性测试](conformance.md#1-单一事实来源single-source-of-truth)
- **运行时能力**由宿主通过 `bridge.hello` 声明，按当前来源、frame 和宿主策略过滤。Web 用 `bridge.has(method, version)` 和 `bridge.hasEvent(event)` 检测。系统授权和用户选择仍由宿主在执行时处理。[能力协商](protocol.md#62-bridgehello)

目前已有契约和两端参考实现的是 [`device.getInfo@1`](../spec/methods/device/getInfo.json)、[`network.getStatus@1`](../spec/methods/network/getStatus.json) 和 [`network.changed`](../spec/methods/network/changed.json)。查询和事件分别声明，事件名称按现有订阅协议传输。[已实现的原生能力](native-profiles.md)

为同一能力选一个主归属。后台执行、数据敏感性、用户手势、外部服务和限定设备属于这项能力的适用条件。判断一个领域的标准化程度时，区分跨端共性、平台或服务专属、以及依赖企业部署或系统角色的能力。目录覆盖这三类场景，宿主按实际条件选择实现范围。

## 1. 宿主与运行环境

- **`app`** 负责宿主标识和应用生命周期。包括版本与构建信息、前后台状态、应用启动原因、收到的 Deep Link、窗口场景的建立与恢复，以及宿主提供的运行环境。已有握手字段优先用于识别宿主。页面自己的可见性继续使用 Web 生命周期。
- **`device`** 负责设备与操作系统信息。包括 OS 版本、粗粒度设备形态、系统架构、供电与电池、低电量模式、内存压力与温度状态。地区、语言、时区和用户系统偏好归 `system`。设备信息字段应有可跨平台解释的含义，并优先使用低识别度数据。
- **`system`** 负责系统环境与可交给系统处理的操作。包括语言、地区、时区、系统设置入口、外部浏览器，以及交给系统处理的拨号和消息撰写。宿主按策略选择可接受的链接和动作，回执说明系统是否接受该交接。系统角色限定的通信服务见第 9 节。容器导航归 `ui.navigation`，产品路由归应用扩展。[Android 常用 Intent](https://developer.android.com/guide/components/intents-common)

## 2. 容器、反馈与无障碍

- **`ui`** 负责用户看到和操作的原生容器。包括窗口与安全区、方向与全屏、画中画、主题、系统栏、键盘遮挡、导航栏与原生返回、对话框、操作菜单、轻提示、加载反馈、触感与无障碍状态。截屏通知、系统捕获状态和显示时遮蔽敏感内容也归本章。Web 页面内部的布局和交互优先由 DOM、CSS 与 Web API 处理。[Apple 屏幕共享期间的内容保护](https://developer.apple.com/documentation/swiftui/protecting-sensitive-content-when-screen-sharing)
- 需要跨端定义含义时，用子域表达，例如将容器导航放在 `ui.navigation`、短提示放在 `ui.toast`。方法应明确目标窗口、系统状态变化和回执代表的阶段。原生系统相同的意图可以保留各平台的视觉和触感差异。

## 3. 网络与传输

- **`network`** 负责宿主网络路径及其变化。包括当前连接类型、网络切换、计费或受限状态等可表达的系统信号。已定义的 `network.getStatus` 描述默认路径，业务服务的可达性由业务请求观察。[网络状态契约](native-profiles.md#network)
- **`transfer`** 作为候选领域，负责由原生系统管理的可取消上传与下载，包括进度、恢复、目标文件引用和后台交接。普通 HTTP 请求优先使用 Web 网络 API。会话内大消息载荷归 [协议大数据通道](protocol.md#10-二进制与大数据传输)。用户可见文件的选择、打开和导出归 `files`。

## 4. 存储、文件与系统分享

- **`storage`** 负责由宿主提供的结构化键值、应用作用域缓存和持久化。定义隔离时要说明来源、应用或账号作用域、配额、过期和退出登录后的清理。App 与扩展共享容器属于宿主部署配置。凭据由 `security` 负责，业务数据模型、同步规则和加密策略由应用定义。[Apple App Groups](https://developer.apple.com/documentation/xcode/configuring-app-groups)
- **`files`** 负责文档选择、文件引用、受控读取、打开预览、保存导出和打印。优先传递受作用域约束的引用。每个契约明确访问期限、读写权限、可用类型、大小和失效行为。图片、视频与音频内容采集归 `media`。
- **`clipboard`** 负责系统剪贴板及支持的数据类型。分别说明读取和写入的触发条件与用户授权。**`share`** 负责系统分享面板和应用收到的系统分享内容。回执应明确系统面板、内容交接和用户操作中哪一步有确认。应用内的分享文案、业务链接和分享奖励由业务扩展定义。

## 5. 媒体与内容采集

- **`media`** 负责照片、视频、音频及系统采集界面。包括相册选择、拍照、视频与录音、系统音频路由与会话状态、语音识别和朗读、扫码、播放与音视频投放。系统屏幕或音频捕获可作为平台能力研究，按捕获会话处理授权。捕获状态与界面保护归 `ui`。[Apple Speech](https://developer.apple.com/documentation/speech) · [Android SpeechRecognizer](https://developer.android.com/reference/android/speech/SpeechRecognizer) · [Android MediaProjection](https://developer.android.com/media/grow/media-projection)
- 内容选择应明确选择范围、单选或多选、返回类型、资源访问期限和用户取消。相册选择可作为标准能力，上传头像、裁剪规则、审核与更新个人资料由应用扩展处理。对可由 Web 原生实现的扫码、渲染和媒体播放，先验证宿主接入的必要性。[Apple PhotosUI](https://developer.apple.com/documentation/photosui) · [Android Photo Picker](https://developer.android.com/training/data-storage/shared/photopicker)

## 6. 通知、任务与应用外入口

- **`notifications`** 负责系统通知的显示、清除、点击与操作反馈。区分本地通知和远程推送，推送供应商、设备令牌与业务订阅由宿主控制。收到行为时明确 App 激活、冷启动和 WebView 尚未加载时的交付方式。
- **`background`** 负责原生任务调度及其状态。包括刷新、上传下载之外的定时或受约束工作，以及撤销与恢复。跨平台契约应描述请求已提交、实际执行、到期和系统推迟的不同状态。
- 小组件、快捷指令、快捷设置控件、系统搜索、实时活动、应用扩展和跨设备接力归 **`app.integrations`**。平台先处理外部入口，再视页面状态提供可读结果或事件。任务执行和交付以系统提供的生命周期为准。[Apple Background Tasks](https://developer.apple.com/documentation/backgroundtasks) · [Apple App Intents](https://developer.apple.com/documentation/appintents) · [Android WorkManager](https://developer.android.com/topic/libraries/architecture/workmanager) · [Android 小组件](https://developer.android.com/develop/ui/views/appwidgets/overview)

## 7. 位置、传感器与周边设备

- **`location`** 负责定位、精度、授权状态、位置变化和地理围栏。地图展示、地点检索、地理编码与路线规划可以作为位置相关的平台能力另行设计。契约需区分精确和大致位置、前台和后台授权。
- **`sensors`** 负责运动、方向、环境和传感器流。包括加速度、陀螺仪、磁力计、气压、光线与接近状态。契约应定义单位、坐标系、采样频率、时间基准和暂停时的行为。系统健康记录归 `health`。
- **`bluetooth`**、**`nfc`** 和 **`nearby`** 分别覆盖蓝牙连接、近场标签交互，以及通过局域连接或超宽带进行的邻近发现、配对和距离感知。按会话定义发现、连接、数据交换、断连和权限失效。卡模拟、USB、串行接口、专用扫码枪和外设配件可归设备集成扩展。[Apple Core Bluetooth](https://developer.apple.com/documentation/corebluetooth) · [Apple Nearby Interaction](https://developer.apple.com/documentation/nearbyinteraction) · [Android Companion Device Pairing](https://developer.android.com/develop/connectivity/bluetooth/companion-device-pairing) · [Android USB](https://developer.android.com/develop/connectivity/usb)

## 8. 权限、安全与用户数据

- **权限**是各能力契约的一部分。定义硬件与系统支持、宿主授权、系统授权和用户取消。若以后出现跨能力复用需求，可以用 **`permissions`** 提供准确定义的查询。触发系统授权应保留具体场景和最小必要范围。系统隐私声明作为宿主构建和发布配置。[Apple 受保护资源](https://developer.apple.com/documentation/bundleresources/protected-resources) · [Android 权限](https://developer.android.com/guide/topics/permissions/overview)
- **`security`** 负责用户在设备上的确认与持有者验证，以及平台凭据、密钥和安全存储的受控操作。包括系统生物识别、设备口令与 Passkey 协作。应用把本地验证结果接入自己的登录、支付、会话和风控策略。面向 Web 的契约优先返回结果或短期引用。应用完整性证明依赖平台与服务端验证，可按平台扩展登记。[Apple App Attest](https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity) · [Android Play Integrity](https://developer.android.com/google/play/integrity/overview)
- **`contacts`**、**`calendar`** 和 **`health`** 负责三类有各自权限边界的系统数据。分别考虑单项选择与批量访问、只读与写入、数据来源、撤回权限、时间范围、设备同步以及数据单位。[Apple HealthKit](https://developer.apple.com/documentation/healthkit) · [Android Health Connect](https://developer.android.com/health-and-fitness/health-connect)

## 9. 特定系统和行业集成

- **设备生态。** 车载、手表、家庭设备、外接显示和辅助设备按平台或设备扩展登记。设备资格、外设安装、原生组件和连接限制随平台说明。[Apple CarPlay](https://developer.apple.com/documentation/carplay)
- **受限系统角色。** 默认拨号、短信或其他系统角色，以及企业托管配置、工作资料、设备策略和专用设备模式，按角色或部署条件登记。[Android RoleManager](https://developer.android.com/reference/android/app/role/RoleManager) · [Android 托管配置](https://developer.android.com/work/managed-configurations)
- **商店与平台服务。** 商店购买及恢复、应用内更新和评价、系统钱包和票证，以及端侧模型等平台服务能力，按渠道和服务依赖描述。支付订单、商品与权益、医疗业务记录、租户和企业业务流程使用应用或厂商自己的命名空间。[Android Play Billing](https://developer.android.com/google/play/billing) · [Android 应用内更新](https://developer.android.com/guide/playcore/in-app-updates)

## 标准能力和业务扩展

协议控制沿用 `bridge.*`，一致性测试沿用 `conformance.*`，其他保留名称遵循现有命名规则。标准能力根按具体领域分配。应用与厂商扩展可以使用一段公司前缀，如 `acme.getProfile` 或 `acme.profile.updateAvatar`，也可以使用反域名前缀，如 `com.acme.profile.updateAvatar`。完整方法名至少两段。扩展可以自带 Schema、版本和权限规则，复用同一套调用、事件、错误和会话机制。[命名与版本规则](protocol.md#34-method-命名)

一个主题进入标准契约前，应回答以下问题。

1. **归属和通用性。** 至少能说明不同应用为何需要同一项原生能力，以及独立宿主怎样提供一致的可观察行为。平台差异可以通过明确的能力边界和可选声明表达。
2. **调用语义。** 明确请求参数、成功结果、事件、版本与失败情况。为数据字段写清单位和粒度，为持续观察写清初始状态、推送时机、退订和会话失效。方法可按协议选择版本，事件订阅使用登记名称。
3. **权限和副作用。** 说明宿主权限、系统权限、用户手势或确认、个人数据暴露、原生 UI 与外部副作用。默认授权范围、取消和清理应能验证。
4. **互操作证据。** 提供 Schema、最小示例、正反例与目标平台的行为核对。参考实现通过测试后再记录对应平台可用。运行时只信任当前会话的能力通告。

## 维护入口

新增需求先从目录定位责任域。已有契约时复用完整名称及其 Schema。候选主题先写清语义，成熟后再登记方法或事件。产品专属能力由所属团队在自己的前缀下添加。

当工具需要接受结构化目录时，`spec/profiles/` 可以索引命名空间和已有 Schema。方法名、类型、版本与废弃信息从 Schema 读取。文档保留章节职责、边界与候选主题，便于开发者和生成式工具从同一入口查找。

[Apple 技术文档](https://developer.apple.com/technologies/) · [Android API 索引](https://developer.android.com/reference/packages) · [Capacitor 插件目录](https://capacitorjs.com/docs/plugins) · [微信小程序官方类型定义](https://github.com/wechat-miniprogram/api-typings)
