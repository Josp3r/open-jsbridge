# Open JSBridge TODO

> 本文件记录协议与里程碑级待办项；多 Agent 并行开发时的实时任务认领、Scope 锁与跨端交接统一走置顶 Issue [#41](https://github.com/Josp3r/open-jsbridge/issues/41)，持久化基线、候选池、待决议事项与共享决策维护在 [docs/team-status.md](docs/team-status.md)（协作规范与停止规则见 [AGENTS.md](AGENTS.md)）。

## 1.0 退出标准（Release 1.0 Exit Criteria）

达到以下全部条件后，停止 1.0 功能扩张并转入维护模式（只修 bug、做安全修复、跟进平台兼容；新能力须先在 `#21` 通过准入四问并获维护者批准）：

- [ ] **协议冻结**：完成下方 M0 信封与握手规范评审，`jsb 1.0` 从 Draft 改为冻结。
- [x] **能力三端对齐**：首批 7 项 v1 能力、`media.release@1`、`bridge.progress` 与 `transfer.upload@1` 在 Web（#58）、iOS（#65）、Android（#67）三端均已落地并通过回归测试。
- [x] **质量与 M0 收尾**：下方 M0、M1 全部 1.0 必选项勾选（iOS 权限链抛错 `-32603` 单测 #68 与 Android 缺少 `WebMessageListener` 回退关闭回归测试均已补齐）；iframe 明确推迟至 1.0 之后。
- [x] **Android 10–12 兼容替代验收**：补齐 Android 10–12（API 30–32）模拟器 / CI Photo Picker 验收用例（`AndroidPhotoPickerCompatTest` 在 CI `Android 11 Photo Picker Compat` API 30 与 `Android Release WebView` API 35 模拟器上双跑通过），不以物理真机阻塞发版（见 `D-014`）。
- [ ] **三端正式发版**：npm `@open-jsbridge/web`、iOS SwiftPM 标签、Android Maven Central 全部发布。
- [x] **Web SDK 体积门禁拍板**：当前体积非瓶颈，`npm run size:web` 改为非阻断观测输出（见 `D-011`）。

### 明确不进 1.0（推迟至 1.0 之后按真实需求与维护者审批决定）

- `media.preview@1` 与下一批标准能力（`ui.dialog.confirm`、`clipboard.*`、`permissions.getState`、`media.scan.qr` 等）
- 原生 `rules` ACL、原生 Host → Web 反向调用（握手时按能力声明，不做不影响兼容）
- 原生 iframe 文档绑定与能力声明
- `packages/flutter`、`packages/react-native`、`packages/devtools` 独立发版（继续作为仓内参考实现）

---

## M0 · JSON-RPC wire 格式

- [ ] 评审 [JSON-RPC 信封规范](docs/protocol.md#3-消息信封envelope)、`spec/protocol/envelope.schema.json`、`spec/protocol/errors.json` 和 `spec/methods/bridge/hello.json`。（待维护者指定评审人并在评审结论后勾选）
- [x] 校验 `conformance-tests/fixtures/wire.json` 中的正反例。运行时用例覆盖缺失请求 id、握手关联、`rpc.id: null` 不结算 pending、重复请求静默丢弃及通知无应答。

## M0 · PR #1 审查后续

下列条目跟踪从规范到一致性验证的交付。设计修订见对应文档，待实现并通过用例后勾选。

- [x] **iOS 权限链出错时拒绝请求。** 意外异常映射为 `-32603`，确认业务 handler 未被调用。[iOS 接收与权限校验](docs/native-ios.md#7-接收与权限校验链)（TypeScript `host-core` 由 #54 `SEC-ACL-ERROR-001` 覆盖；iOS `WireHostTests.testAuthorizationUnexpectedErrorRejectsWithInternalErrorWithoutInvokingHandler` 已覆盖，见 #68。）
- [x] **Android 回退通道默认关闭。** 首选 `addWebMessageListener`，缺失时保持 bridge 不可用。仅在宿主可独立保证受控内容隔离时评估显式启用回退，并验证主 frame 与来源的权限边界。[Android 通道选择](docs/native-android.md#1-通道选择)（`AndroidBridgeChannelTest` JVM 单测与 `AndroidChannelFallbackTest` 真实 WebView 仪器测试覆盖 `SEC-JSI-DEFAULT-001`：缺少 `WEB_MESSAGE_LISTENER` 或 `DOCUMENT_START_SCRIPT` 时 `install` 返回 `null`、不安装回退通道且页面不暴露 `__OJSB_TRANSPORT__`。）
- [x] **隔离文档切换后的迟到应答。** iOS 和 Android 的真实 WebView 测试验证延迟应答不会进入新文档。Android JVM 测试覆盖重新确认窗口内的请求和连续挑战。[一致性测试](docs/conformance.md#23-pr-1-审查回归用例)
- [x] **验证异步业务处理器的取消。** iOS 和 Android Release WebView 测试覆盖文档失效和 `bridge.cancel`，验证取消能释放原生并发槽。[一致性测试](docs/conformance.md#32-原生-release-webview-回归)
- [ ] **（推迟至 1.0 之后）验证 iframe 文档绑定。** iframe 能力在原生侧具备文档绑定且通过真实 WebView 验证后再声明。[协议生命周期](docs/protocol.md#12-生命周期)
- [x] **处理握手期间的超时和取消。** 加入握手延迟用例，确认已过期或取消的排队请求在握手成功后仍未发送，已发出的请求只向原会话发送取消。[Web SDK 握手队列](docs/web-sdk.md#23-pre-ready-队列)

验收场景见[一致性测试](docs/conformance.md#23-pr-1-审查回归用例)。

## M1 · 最小闭环

- [x] 跑通 TypeScript Web SDK 与 Mock 宿主的 echo，验证握手、调用、错误及超时行为。
- [x] 使用同一份 Web demo 验证 iOS WithReply 的握手、echo、导航会话切换，以及来源和 frame 隔离。[Swift 示例](examples/native-ios/README.md)
- [x] 使用同一份 Web demo 验证 Android WebMessageListener 的握手、echo、导航后的调用，以及来源和 frame 隔离。[Kotlin 示例](examples/native-android/README.md)
- [x] 复用同一组原始报文用例校验 Native 与 Mock，覆盖 `bridge.hello` 的版本后缀、普通方法的 `meta.timeout: 0` 和 JSON 解析边界。[原始报文一致性测试](docs/conformance.md#31-m1-原始入站报文)
