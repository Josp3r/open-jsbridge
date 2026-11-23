# Native Host 最小接入

本文定义 Open JSBridge M1 主 frame 示例的接入范围。已有 WebView 的宿主可按本页实现适配器，并用同一份页面验证。 [Web demo](../examples/web-demo/README.md) · [Swift / WKWebView](../examples/native-ios/README.md) · [Kotlin / Android WebView](../examples/native-android/README.md)

## 接入约定

1. 在导航前安装 Host Shim。在获准的主文档上尽早注入 `window.__OJSB_TRANSPORT__` 并通告 `protocols: [1]`。`postMessage` 接收 UTF-8 JSON 信封字符串，响应使用与请求绑定的通道。平台 handler 名称与平台内部附带的路由元数据由适配器选择。 [Host Shim](protocol.md#2-host-shim-契约transport-层)
2. 每次接收消息时，从平台读取真实 origin 和 frame。宿主只允许配置中的 HTTPS origin 与主 frame 调用，并按 origin 暴露已注册的方法。本地 Demo 单独允许固定端口的 HTTP 开发来源。第三方集成应保留 App 自己的导航和权限决策。
3. 在可验证的当前文档中处理 `bridge.hello`。M1 固定 `jsb: "1.0"`。同一文档内重复握手返回同一 `sid`。新的文档取得新的 `sid`，其会话与 WebView、主 frame 和文档绑定。 [握手 Schema](../spec/methods/bridge/hello.json)
4. 握手后只分派带当前 `meta.sid` 的请求。沿请求原来的通道返回应答，并带上原请求 id 和当前 `meta.sid`。在解析前检查 UTF-8 消息大小，丢弃重复请求。通知无需 RPC 应答。无法同时确认会话与应答路由时直接丢弃，WithReply 之类要求回执的通道返回传输回执 `null`。 [JSON-RPC 应答](protocol.md#5-request--response-时序)
5. 同文档 History API 导航保留会话。跨文档提交、渲染进程退出或销毁 WebView 时清理旧会话，并丢弃旧文档尚未交付的应答。尽早到达的握手必须等到宿主确认消息与当前文档绑定后才执行。

联调构建注册 `conformance.echo` v1，原样返回对象参数，省略参数时返回 `{}`。原生示例只提供请求应答。握手 `events` 和 `features` 均为空。客户端仍执行本地超时与取消。如需远端取消、事件、反向调用或 iframe，宿主实现对应契约后再声明能力。 [echo Schema](../spec/methods/conformance/echo.json)

## 验收

- 打开 `/?host=native` 后直接发送 echo，确认首次调用得到原样结果，连接状态显示真实平台。用未注入通道的浏览器打开该 URL，调用应报告通道不可用。
- 用原始传输验证未知方法返回关联错误、重复请求不执行、缺失或过期 `sid` 不进入业务处理。
- 验证非信任 origin 与子 frame 直接发出的消息无法通过 Native 校验。用 History API 更新路由时保留会话，刷新同一 URL 时重建会话。
- 增加异步 handler 时，发起调用后在其完成前导航。在新文档的传输层观察消息，确认没有收到旧应答。

测试入口与平台限制见各示例的 README。[完整一致性测试设计](conformance.md)
