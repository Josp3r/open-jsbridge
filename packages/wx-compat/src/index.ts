import { ErrorCode, type JsonValue } from '../../protocol/src/index.js';
import {
  BridgeError,
  type Bridge,
  type CallOptions,
  type EventSubscription,
} from '../../web-sdk/src/index.js';
import type { DeviceInfo } from '../../web-sdk/src/device.js';
import type { NetworkStatus } from '../../web-sdk/src/events.js';
import { createMediaHelpers, type ChooseMediaParams } from '../../web-sdk/src/media.js';

export type WxNetworkType = NetworkStatus['type'];

export interface WxFailResult {
  readonly errMsg: string;
  readonly code: number;
  readonly data?: JsonValue;
}

export class WxCompatError extends Error implements WxFailResult {
  readonly errMsg: string;
  readonly code: number;
  readonly data?: JsonValue;
  readonly cause?: unknown;

  constructor(errMsg: string, code: number, data?: JsonValue, cause?: unknown) {
    super(errMsg);
    this.name = 'WxCompatError';
    this.errMsg = errMsg;
    this.code = code;
    this.data = data;
    this.cause = cause;
  }
}

export interface WxCallbackOptions<R> {
  success?: (res: R) => void;
  fail?: (err: WxFailResult) => void;
  complete?: (res: R | WxFailResult) => void;
  timeout?: number;
  signal?: AbortSignal;
  traceId?: string;
}

export interface WxOkResult {
  readonly errMsg: string;
}

export interface WxSystemInfoResult extends WxOkResult {
  readonly platform: DeviceInfo['os'];
  readonly system: string;
  readonly os: DeviceInfo['os'];
  readonly osVersion: string;
}

export interface WxNetworkTypeResult extends WxOkResult {
  readonly networkType: WxNetworkType;
  readonly isConnected: boolean;
}

export interface WxShowToastOptions extends WxCallbackOptions<WxOkResult> {
  title: string;
}

export interface WxChooseMediaFile {
  readonly id: string;
  readonly tempFilePath: string;
  readonly size: number;
  readonly fileType: 'image';
  readonly width: number;
  readonly height: number;
  readonly mime: string;
  readonly expiresAt: number;
}

export interface WxChooseMediaResult extends WxOkResult {
  readonly type: 'image';
  readonly tempFiles: readonly [WxChooseMediaFile];
}

export interface WxChooseMediaOptions extends WxCallbackOptions<WxChooseMediaResult> {
  count?: 1;
  mediaType?: ['image'];
  sourceType?: ['album'];
}

export interface WxNetworkStatusChangeResult {
  readonly isConnected: boolean;
  readonly networkType: WxNetworkType;
}

export type WxNetworkStatusListener = (res: WxNetworkStatusChangeResult) => void;
export type WxAppLifecycleListener = () => void;

export interface WxCompat {
  getSystemInfo(options?: WxCallbackOptions<WxSystemInfoResult>): Promise<WxSystemInfoResult>;
  getNetworkType(options?: WxCallbackOptions<WxNetworkTypeResult>): Promise<WxNetworkTypeResult>;
  showToast(options: WxShowToastOptions): Promise<WxOkResult>;
  chooseMedia(options?: WxChooseMediaOptions): Promise<WxChooseMediaResult>;
  onNetworkStatusChange(listener: WxNetworkStatusListener): EventSubscription;
  offNetworkStatusChange(listener?: WxNetworkStatusListener): void;
  onAppShow(listener: WxAppLifecycleListener): EventSubscription;
  offAppShow(listener?: WxAppLifecycleListener): void;
  onAppHide(listener: WxAppLifecycleListener): EventSubscription;
  offAppHide(listener?: WxAppLifecycleListener): void;
  canIUse(api: string): boolean;
  dispose(): void;
}

const API_METHOD_MAP: Readonly<Record<string, { kind: 'method'; name: string; version: number } | { kind: 'event'; name: string }>> = {
  getSystemInfo: { kind: 'method', name: 'device.getInfo', version: 1 },
  getNetworkType: { kind: 'method', name: 'network.getStatus', version: 1 },
  showToast: { kind: 'method', name: 'ui.toast.show', version: 1 },
  chooseMedia: { kind: 'method', name: 'media.chooseMedia', version: 1 },
  onNetworkStatusChange: { kind: 'event', name: 'network.statusChanged' },
  offNetworkStatusChange: { kind: 'event', name: 'network.statusChanged' },
  onAppShow: { kind: 'event', name: 'app.foregrounded' },
  offAppShow: { kind: 'event', name: 'app.foregrounded' },
  onAppHide: { kind: 'event', name: 'app.backgrounded' },
  offAppHide: { kind: 'event', name: 'app.backgrounded' },
};

function callOptionsFrom<R>(options?: WxCallbackOptions<R>): Omit<CallOptions, 'version'> | undefined {
  if (!options) return;
  const out: Omit<CallOptions, 'version'> = {};
  if (options.timeout !== undefined) out.timeout = options.timeout;
  if (options.signal !== undefined) out.signal = options.signal;
  if (options.traceId !== undefined) out.traceId = options.traceId;
  return out;
}

function toCompatError(api: string, error: unknown): WxCompatError {
  if (error instanceof WxCompatError) return error;
  if (error instanceof BridgeError) {
    return new WxCompatError(`${api}:fail ${error.message}`, error.code, error.data, error);
  }
  const message = error instanceof Error && error.message ? error.message : 'Internal error';
  return new WxCompatError(`${api}:fail ${message}`, ErrorCode.InternalError, undefined, error);
}

async function invokeWx<R extends WxOkResult>(
  api: string,
  options: WxCallbackOptions<R> | undefined,
  run: () => Promise<R>,
): Promise<R> {
  try {
    const res = await run();
    options?.success?.(res);
    options?.complete?.(res);
    return res;
  } catch (error) {
    const compatError = toCompatError(api, error);
    const failPayload: WxFailResult = {
      errMsg: compatError.errMsg,
      code: compatError.code,
      ...(compatError.data === undefined ? {} : { data: compatError.data }),
    };
    options?.fail?.(failPayload);
    options?.complete?.(failPayload);
    throw compatError;
  }
}

function isConnectedType(type: WxNetworkType): boolean {
  return type !== 'none' && type !== 'unknown';
}

function validateChooseMediaOptions(options?: WxChooseMediaOptions): ChooseMediaParams | undefined {
  if (!options) return;
  const params: ChooseMediaParams = {};
  if (options.count !== undefined) {
    if (options.count !== 1) {
      throw new WxCompatError('chooseMedia:fail count must be 1 in Open JSBridge v1', ErrorCode.InvalidParams);
    }
    params.count = 1;
  }
  if (options.mediaType !== undefined) {
    if (!Array.isArray(options.mediaType) || options.mediaType.length !== 1 || options.mediaType[0] !== 'image') {
      throw new WxCompatError('chooseMedia:fail mediaType must be ["image"] in Open JSBridge v1', ErrorCode.InvalidParams);
    }
    params.mediaType = ['image'];
  }
  if (options.sourceType !== undefined) {
    if (!Array.isArray(options.sourceType) || options.sourceType.length !== 1 || options.sourceType[0] !== 'album') {
      throw new WxCompatError('chooseMedia:fail sourceType must be ["album"] in Open JSBridge v1', ErrorCode.InvalidParams);
    }
    params.sourceType = ['album'];
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

/**
 * Creates a thin, async-only WeChat-style compatibility facade over an Open JSBridge `Bridge`.
 * Maps only capabilities that overlap with the Open JSBridge v1 standard profile (never `*Sync`).
 */
export function createWxCompat(bridge: Bridge): WxCompat {
  const { media } = createMediaHelpers(bridge);

  const networkSubs = new Map<WxNetworkStatusListener, EventSubscription>();
  const appShowSubs = new Map<WxAppLifecycleListener, EventSubscription>();
  const appHideSubs = new Map<WxAppLifecycleListener, EventSubscription>();

  function bindSubscription<L>(
    registry: Map<L, EventSubscription>,
    listener: L,
    subscribe: () => EventSubscription,
  ): EventSubscription {
    const existing = registry.get(listener);
    if (existing) return existing;
    const rawSub = subscribe();
    const wrapped = (() => {
      if (registry.get(listener) === wrapped) registry.delete(listener);
      rawSub();
    }) as EventSubscription;
    Object.defineProperty(wrapped, 'ready', { value: rawSub.ready, enumerable: true });
    registry.set(listener, wrapped);
    return wrapped;
  }

  function unbindSubscription<L>(registry: Map<L, EventSubscription>, listener?: L): void {
    if (listener !== undefined) {
      const sub = registry.get(listener);
      if (sub) sub();
      return;
    }
    for (const sub of [...registry.values()]) sub();
    registry.clear();
  }

  return {
    getSystemInfo(options) {
      return invokeWx('getSystemInfo', options, async () => {
        const info = await bridge.call<DeviceInfo>('device.getInfo@1', undefined, callOptionsFrom(options));
        const osLabel = info.os === 'ios' ? 'iOS' : 'Android';
        return {
          errMsg: 'getSystemInfo:ok',
          platform: info.os,
          system: `${osLabel} ${info.osVersion}`,
          os: info.os,
          osVersion: info.osVersion,
        };
      });
    },

    getNetworkType(options) {
      return invokeWx('getNetworkType', options, async () => {
        const status = await bridge.call<NetworkStatus>('network.getStatus@1', undefined, callOptionsFrom(options));
        return {
          errMsg: 'getNetworkType:ok',
          networkType: status.type,
          isConnected: isConnectedType(status.type),
        };
      });
    },

    showToast(options) {
      return invokeWx('showToast', options, async () => {
        const title = options?.title;
        if (typeof title !== 'string' || title.length === 0 || [...title].length > 120) {
          throw new WxCompatError('showToast:fail invalid title', ErrorCode.InvalidParams);
        }
        await bridge.call('ui.toast.show@1', { text: title }, callOptionsFrom(options));
        return { errMsg: 'showToast:ok' };
      });
    },

    chooseMedia(options) {
      return invokeWx('chooseMedia', options, async () => {
        const params = validateChooseMediaOptions(options);
        const result = await media.chooseMedia(params, callOptionsFrom(options));
        if (result.status === 'cancelled') {
          throw new WxCompatError('chooseMedia:fail cancel', ErrorCode.Cancelled);
        }
        const [file] = result.files;
        return {
          errMsg: 'chooseMedia:ok',
          type: 'image',
          tempFiles: [{
            id: file.id,
            tempFilePath: file.thumbUrl,
            size: file.size,
            fileType: 'image',
            width: file.width,
            height: file.height,
            mime: file.mime,
            expiresAt: file.expiresAt,
          }],
        };
      });
    },

    onNetworkStatusChange(listener) {
      return bindSubscription(networkSubs, listener, () =>
        bridge.on('network.statusChanged', (status) => {
          listener({
            isConnected: isConnectedType(status.type),
            networkType: status.type,
          });
        }));
    },

    offNetworkStatusChange(listener) {
      unbindSubscription(networkSubs, listener);
    },

    onAppShow(listener) {
      return bindSubscription(appShowSubs, listener, () =>
        bridge.on('app.foregrounded', () => listener()));
    },

    offAppShow(listener) {
      unbindSubscription(appShowSubs, listener);
    },

    onAppHide(listener) {
      return bindSubscription(appHideSubs, listener, () =>
        bridge.on('app.backgrounded', () => listener()));
    },

    offAppHide(listener) {
      unbindSubscription(appHideSubs, listener);
    },

    canIUse(api) {
      const mapping = API_METHOD_MAP[api];
      if (!mapping) return false;
      if (mapping.kind === 'method') return bridge.has(mapping.name, mapping.version);
      return bridge.hasEvent(mapping.name);
    },

    dispose() {
      unbindSubscription(networkSubs);
      unbindSubscription(appShowSubs);
      unbindSubscription(appHideSubs);
    },
  };
}
