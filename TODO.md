# Open JSBridge TODO

## M0 · JSON-RPC wire 格式

- [ ] 评审 [JSON-RPC 信封规范](docs/protocol.md#3-消息信封envelope)、`spec/protocol/envelope.schema.json`、`spec/protocol/errors.json` 和 `spec/methods/bridge/hello.json`。
- [x] 校验 `conformance-tests/fixtures/wire.json` 中的正反例。运行时用例覆盖缺失请求 id、握手关联、`rpc.id: null` 不结算 pending、重复请求静默丢弃及通知无应答。

## M0 · PR #1 审查后续

下列条目跟踪从规范到一致性验证的交付。设计修订见对应文档，待实现并通过用例后勾选。

- [ ] **iOS 权限链出错时拒绝请求。** 意外异常映射为 `-32603`，确认业务 handler 未被调用。[iOS 接收与权限校验](docs/native-ios.md#7-接收与权限校验链)
- [ ] **Android 回退通道默认关闭。** 首选 `addWebMessageListener`，缺失时保持 bridge 不可用。仅在宿主可独立保证受控内容隔离时评估显式启用回退，并验证主 frame 与来源的权限边界。[Android 通道选择](docs/native-android.md#1-通道选择)
- [ ] **绑定会话与文档。** 补齐异步 handler 导航后迟到应答的隔离用例。覆盖 Android 快速连续提交时处于文档重新确认窗口的请求。iframe 能力在原生侧具备文档绑定且通过真实 WebView 验证后再声明。[协议生命周期](docs/protocol.md#12-生命周期)
- [x] **处理握手期间的超时和取消。** 加入握手延迟用例，确认已过期或取消的排队请求在握手成功后仍未发送，已发出的请求只向原会话发送取消。[Web SDK 握手队列](docs/web-sdk.md#23-pre-ready-队列)

验收场景见[一致性测试](docs/conformance.md#23-pr-1-审查回归用例)。

## M1 · 最小闭环

- [x] 跑通 TypeScript Web SDK 与 Mock 宿主的 echo，验证握手、调用、错误及超时行为。
- [x] 使用同一份 Web demo 验证 iOS WithReply 的握手、echo、导航会话切换，以及来源和 frame 隔离。[Swift 示例](examples/native-ios/README.md)
- [x] 使用同一份 Web demo 验证 Android WebMessageListener 的握手、echo、导航后的调用，以及来源和 frame 隔离。[Kotlin 示例](examples/native-android/README.md)
- [ ] 复用同一组原始报文用例校验 Native 与 Mock，覆盖 `bridge.hello` 的版本后缀、普通方法的 `meta.timeout: 0` 和 JSON 解析边界。
