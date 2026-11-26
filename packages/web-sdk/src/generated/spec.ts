// GENERATED FROM spec/ — DO NOT EDIT.
// Run `npm run codegen:ts` after modifying files under spec/.

/** 由 128 位密码学安全随机值编码的当前文档会话内不透明引用。 */
export type MediaId = string;

export interface NetworkStatus {
  type: "wifi" | "cellular" | "ethernet" | "other" | "none" | "unknown";
}

/** 宿主 App 进程进入后台。 */
export type AppBackgroundedPayload = null;

/** 宿主 App 进程进入前台。 */
export type AppForegroundedPayload = null;

/** 为当前 document 建立或恢复活动会话，并返回能力和限制。 */
export interface BridgeHelloParams {
  protocols: number[];
  sdk?: {
    name: string;
    version: string;
  };
  wants?: string[];
}

export interface BridgeHelloResult {
  jsb: "1.0";
  sid: string;
  host: {
    platform: string;
    name: string;
    version: string;
    appId?: string;
    appVersion?: string;
  };
  capabilities: {
    methods: Record<string, {
      versions: number[];
    }>;
    events: string[];
    features: string[];
  };
  limits: {
    maxMessageBytes: number;
    maxInflight: number;
    defaultTimeoutMs: number;
  };
}

/** 在当前会话订阅事件，返回已订阅和被拒绝的事件。 */
export interface BridgeSubscribeParams {
  events: string[];
}

export interface BridgeSubscribeResult {
  subscribed: string[];
  denied: string[];
}

/** 确保指定事件在当前会话中处于退订状态。 */
export interface BridgeUnsubscribeParams {
  events: string[];
}

export interface BridgeUnsubscribeResult {
  unsubscribed: string[];
}

/** 原样返回对象参数。省略参数时返回空对象。 */
export type ConformanceEchoParams = Record<string, unknown>;

export type ConformanceEchoResult = Record<string, unknown>;

/** 获取宿主设备的操作系统和版本。 */
export type DeviceGetInfoParams = Record<string, never>;

export interface DeviceGetInfoResult {
  os: "ios" | "android";
  osVersion: string;
}

/** 从系统相册选择一张图片，返回绑定当前会话的原生句柄、原图元数据及有界 JPEG 缩略图。 */
export interface MediaChooseMediaParams {
  mediaType?: ["image"];
  sourceType?: ["album"];
  count?: 1;
}

export type MediaChooseMediaResult = {
  status: "cancelled";
  files: [];
} | {
  status: "selected";
  files: [{
    type: "image";
    mime: string;
    size: number;
    expiresAt: number;
    id: MediaId;
    width: number;
    height: number;
    thumbnailBase64: string;
  }];
};

/** 获取宿主 App 当前默认网络路径的类型。 */
export type NetworkGetStatusParams = Record<string, never>;

export type NetworkGetStatusResult = NetworkStatus;

/** 宿主 App 默认网络路径类型发生变化。 */
export type NetworkStatusChangedPayload = NetworkStatus;

/** 请求宿主显示一条短文本提示。成功表示宿主接受展示请求。 */
export interface UiToastShowParams {
  text: string;
}

export type UiToastShowResult = Record<string, never>;

export interface MethodMap {
  "bridge.hello": { params: BridgeHelloParams; result: BridgeHelloResult };
  "bridge.subscribe": { params: BridgeSubscribeParams; result: BridgeSubscribeResult };
  "bridge.unsubscribe": { params: BridgeUnsubscribeParams; result: BridgeUnsubscribeResult };
  "conformance.echo": { params: ConformanceEchoParams; result: ConformanceEchoResult };
  "device.getInfo": { params: DeviceGetInfoParams; result: DeviceGetInfoResult };
  "media.chooseMedia": { params: MediaChooseMediaParams; result: MediaChooseMediaResult };
  "network.getStatus": { params: NetworkGetStatusParams; result: NetworkGetStatusResult };
  "ui.toast.show": { params: UiToastShowParams; result: UiToastShowResult };
}

export interface EventMap {
  "app.backgrounded": AppBackgroundedPayload;
  "app.foregrounded": AppForegroundedPayload;
  "network.statusChanged": NetworkStatusChangedPayload;
}

export interface ErrorCodeMap {
  readonly ParseError: -32700;
  readonly InvalidRequest: -32600;
  readonly MethodNotFound: -32601;
  readonly InvalidParams: -32602;
  readonly InternalError: -32603;
  readonly Unavailable: -32000;
  readonly Timeout: -32001;
  readonly Cancelled: -32002;
  readonly PermissionDenied: -32003;
  readonly UnsupportedProtocol: -32004;
  readonly NotReady: -32005;
  readonly PayloadTooLarge: -32006;
  readonly UserDenied: -32007;
  readonly RateLimited: -32008;
  readonly SessionExpired: -32009;
  readonly Busy: -32010;
}
