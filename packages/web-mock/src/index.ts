import {
  createHostCore, HostError,
  type HostCoreLimits, type HostHandler, type HostHandlerContext, type RegisterHandlerOptions,
} from '../../host-core/src/index.js';
import type { JsonObject, JsonValue } from '../../protocol/src/index.js';

export { HostError };
export type { HostHandler, HostHandlerContext, RegisterHandlerOptions };

const ECHO_METHOD = 'conformance.echo';
const DEVICE_INFO_METHOD = 'device.getInfo';
const NETWORK_STATUS_METHOD = 'network.getStatus';
const TOAST_METHOD = 'ui.toast.show';
const MEDIA_CHOOSE_METHOD = 'media.chooseMedia';
const networkTypes = ['wifi', 'cellular', 'ethernet', 'other', 'none', 'unknown'] as const;

export interface MockMediaImageWire {
  type: 'image';
  id: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  expiresAt: number;
  thumbnailBase64: string;
}

export type MockChooseMediaWireResult =
  | { status: 'cancelled'; files: [] }
  | { status: 'selected'; files: [MockMediaImageWire] };

export interface MockFailureSpec {
  code: number;
  message: string;
  data?: JsonValue;
}

export interface MockAdapterOptions {
  platform?: string;
  hostName?: string;
  hostVersion?: string;
  events?: readonly string[];
  /** Advertised events whose subscription requests are denied by the Mock host. */
  deniedEvents?: readonly string[];
  deviceInfo?: { os: 'ios' | 'android'; osVersion: string };
  getNetworkStatus?: () => { type: typeof networkTypes[number] };
  showToast?: (text: string) => void | Promise<void>;
  chooseMedia?: (
    params: JsonObject | undefined,
    ctx: HostHandlerContext,
  ) => MockChooseMediaWireResult | Promise<MockChooseMediaWireResult>;
  handlers?: Record<string, HostHandler>;
  supportsCancel?: boolean;
  /** Fixed delay (ms) or inclusive [minMs, maxMs] range applied before handler execution. */
  latency?: number | readonly [number, number];
  limits?: HostCoreLimits;
}

export interface MockAdapter {
  readonly name: string;
  send(raw: string): Promise<string | null>;
  emit(name: string, payload: JsonValue): boolean;
  listen(onMessage: (raw: string) => void): () => void;
  register(method: string, handler: HostHandler, options?: RegisterHandlerOptions): () => void;
  failNext(method: string, failure: MockFailureSpec): void;
  wasCancelled(requestId: string): boolean;
}

function validateEmptyParams(params: JsonObject | undefined): string | undefined {
  return Object.keys(params ?? {}).length > 0 ? 'Expected empty params' : undefined;
}

function validateToastParams(params: JsonObject | undefined): string | undefined {
  const text = params?.text;
  if (
    typeof text !== 'string' ||
    text.length === 0 ||
    [...text].length > 120 ||
    Object.keys(params ?? {}).length !== 1
  ) {
    return 'Invalid toast params';
  }
}

function validateMediaChooseParams(params: JsonObject | undefined): string | undefined {
  if (!params) return;
  for (const [key, value] of Object.entries(params)) {
    if (key === 'count') {
      if (value !== 1) return 'Invalid media params';
    } else if (key === 'mediaType') {
      if (!Array.isArray(value) || value.length !== 1 || value[0] !== 'image') return 'Invalid media params';
    } else if (key === 'sourceType') {
      if (!Array.isArray(value) || value.length !== 1 || value[0] !== 'album') return 'Invalid media params';
    } else {
      return 'Invalid media params';
    }
  }
}

function resolveDelayMs(latency: MockAdapterOptions['latency']): number {
  if (typeof latency === 'number') return latency > 0 ? latency : 0;
  if (Array.isArray(latency)) {
    const [min, max] = latency;
    const low = Math.max(0, Math.min(min, max));
    const high = Math.max(low, Math.max(min, max));
    if (high <= 0) return 0;
    return Math.round(low + Math.random() * (high - low));
  }
  return 0;
}

function delayWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A standalone Mock session built on the reference HostCore state machine. */
export function createMockAdapter(options?: MockAdapterOptions): MockAdapter {
  const host = createHostCore({
    platform: options?.platform ?? 'mock',
    name: options?.hostName ?? 'mock',
    version: options?.hostVersion ?? '0.2.0',
    events: options?.events,
    deniedEvents: options?.deniedEvents,
    supportsCancel: options?.supportsCancel,
    limits: options?.limits,
  });

  const nextFailures = new Map<string, MockFailureSpec[]>();
  const latency = options?.latency;

  function wrapHandler(method: string, handler: HostHandler): HostHandler {
    return async (params, ctx) => {
      const waitMs = resolveDelayMs(latency);
      if (waitMs > 0) await delayWithSignal(waitMs, ctx.signal);
      if (ctx.signal.aborted) {
        throw new HostError(-32002, 'Cancelled');
      }
      const queued = nextFailures.get(method);
      const failure = queued?.shift();
      if (queued && queued.length === 0) nextFailures.delete(method);
      if (failure) {
        throw new HostError(failure.code, failure.message, failure.data);
      }
      return handler(params, ctx);
    };
  }

  function register(
    method: string,
    handler: HostHandler,
    registerOptions?: RegisterHandlerOptions,
  ): () => void {
    return host.register(method, wrapHandler(method, handler), registerOptions);
  }

  register(ECHO_METHOD, (params) => params ?? {});

  const { deviceInfo, getNetworkStatus, showToast, chooseMedia, handlers } = options ?? {};
  if (deviceInfo) {
    const { os, osVersion } = deviceInfo;
    if ((os === 'ios' || os === 'android') && typeof osVersion === 'string' && osVersion.length > 0) {
      register(DEVICE_INFO_METHOD, () => ({ os, osVersion }), { validateParams: validateEmptyParams });
    }
  }
  if (getNetworkStatus) {
    register(
      NETWORK_STATUS_METHOD,
      () => {
        const { type } = getNetworkStatus();
        return { type: networkTypes.includes(type) ? type : 'unknown' };
      },
      { validateParams: validateEmptyParams },
    );
  }
  if (showToast) {
    register(
      TOAST_METHOD,
      async (params) => {
        await showToast(params?.text as string);
        return {};
      },
      { validateParams: validateToastParams },
    );
  }
  if (chooseMedia) {
    register(
      MEDIA_CHOOSE_METHOD,
      async (params, ctx) => (await chooseMedia(params, ctx)) as unknown as JsonValue,
      { concurrency: 'serial', validateParams: validateMediaChooseParams },
    );
  }
  if (handlers) {
    for (const [method, handler] of Object.entries(handlers)) {
      register(method, handler);
    }
  }

  let currentReceiver: ((raw: string) => void) | undefined;

  return {
    name: host.name,
    send: (raw) => host.receive(raw),
    emit: (name, payload) => host.emit(name, payload),
    register,
    failNext(method, failure) {
      const queue = nextFailures.get(method) ?? [];
      queue.push(failure);
      nextFailures.set(method, queue);
    },
    wasCancelled: (requestId) => host.wasCancelled(requestId),
    listen(onMessage: (raw: string) => void): () => void {
      if (currentReceiver) host.reset();
      const receive = (raw: string) => onMessage(raw);
      currentReceiver = receive;
      host.setReceiver(receive);
      return () => {
        if (currentReceiver !== receive) return;
        currentReceiver = undefined;
        host.setReceiver(undefined);
        host.reset();
      };
    },
  };
}

type FrameDirection = 'request' | 'response' | 'event';

export interface MockTransportOptions extends MockAdapterOptions {
  onFrame?: (direction: FrameDirection, raw: string | null) => void;
}

export interface MockTransportHandle {
  emit(name: string, payload: JsonValue): boolean;
  register(method: string, handler: HostHandler, options?: RegisterHandlerOptions): () => void;
  failNext(method: string, failure: MockFailureSpec): void;
  wasCancelled(requestId: string): boolean;
}

/** Installs a Mock Host Shim on the current browser window when its transport slot is free. */
export function installMockTransport(options?: MockTransportOptions): MockTransportHandle | undefined {
  if (typeof window === 'undefined' || '__OJSB_TRANSPORT__' in window) return;

  const target = window;
  const adapter = createMockAdapter(options);
  const onFrame = options?.onFrame;
  const observe = (direction: FrameDirection, raw: string | null): void => {
    try {
      onFrame?.(direction, raw);
    } catch {
      // Observation must not interrupt transport traffic.
    }
  };
  const transport = Object.freeze({
    name: adapter.name,
    protocols: Object.freeze([1]),
    async postMessage(raw: string): Promise<string | null> {
      observe('request', raw);
      const reply = await adapter.send(raw);
      observe('response', reply);
      return reply;
    },
  });
  const forwardEvent = (raw: string): void => {
    const receive = target.__OJSB_RECEIVE__;
    if (typeof receive !== 'function') return;
    observe('event', raw);
    receive.call(target, raw);
  };

  Object.defineProperty(target, '__OJSB_TRANSPORT__', {
    value: transport,
    writable: false,
    configurable: false,
  });
  let unlisten = adapter.listen(forwardEvent);
  target.addEventListener('pagehide', () => {
    unlisten();
    unlisten = adapter.listen(forwardEvent);
  });
  target.dispatchEvent(new CustomEvent('ojsb:transportready'));
  return {
    emit(name, payload) {
      if (typeof target.__OJSB_RECEIVE__ !== 'function') return false;
      return adapter.emit(name, payload);
    },
    register: (method, handler, registerOptions) => adapter.register(method, handler, registerOptions),
    failNext: (method, failure) => adapter.failNext(method, failure),
    wasCancelled: (requestId) => adapter.wasCancelled(requestId),
  };
}
