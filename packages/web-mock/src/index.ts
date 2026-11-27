import {
  createHostCore, HostError,
  type CallWebOptions, type HostCoreLimits, type HostHandler, type HostHandlerContext, type RegisterHandlerOptions,
} from '../../host-core/src/index.js';
import type { JsonObject, JsonValue } from '../../protocol/src/index.js';

export { HostError };
export type { CallWebOptions, HostHandler, HostHandlerContext, RegisterHandlerOptions };

const ECHO_METHOD = 'conformance.echo';
const DEVICE_INFO_METHOD = 'device.getInfo';
const NETWORK_STATUS_METHOD = 'network.getStatus';
const TOAST_METHOD = 'ui.toast.show';
const MEDIA_CHOOSE_METHOD = 'media.chooseMedia';
const MEDIA_RELEASE_METHOD = 'media.release';
const TRANSFER_UPLOAD_METHOD = 'transfer.upload';
const MEDIA_ID_PATTERN = /^[0-9a-f]{32}$/;
const FIELD_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const HEADER_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_MEDIA_RELEASE_IDS = 32;
const MAX_UPLOAD_MAP_ENTRIES = 16;
const MAX_UPLOAD_METADATA_BYTES = 16 * 1024;
const MAX_UPLOAD_RESPONSE_BYTES = 32 * 1024;
const ALLOWED_UPLOAD_REQUEST_KEYS = new Set(['url', 'method', 'fieldName', 'formData', 'headers', 'compress']);
const FORBIDDEN_UPLOAD_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'host', 'transfer-encoding', 'connection',
]);
const utf8 = new TextEncoder();
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

export interface MockUploadWireResult {
  status: number;
  body: string;
}

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
  releaseMedia?: (
    ids: readonly string[],
    ctx: HostHandlerContext,
  ) => void | Promise<void>;
  uploadMedia?: (
    params: JsonObject | undefined,
    ctx: HostHandlerContext,
  ) => MockUploadWireResult | Promise<MockUploadWireResult>;
  /** Exact preconfigured HTTPS endpoints permitted for transfer.upload@1. */
  allowedUploadUrls?: readonly string[];
  handlers?: Record<string, HostHandler>;
  supportsCancel?: boolean;
  supportsCallbacks?: boolean;
  supportsReverse?: boolean;
  /** Fixed delay (ms) or inclusive [minMs, maxMs] range applied before handler execution. */
  latency?: number | readonly [number, number];
  limits?: HostCoreLimits;
}

export interface MockAdapter {
  readonly name: string;
  readonly webMethods: ReadonlySet<string>;
  send(raw: string): Promise<string | null>;
  emit(name: string, payload: JsonValue): boolean;
  callWeb<T = JsonValue>(method: string, params?: JsonObject, options?: CallWebOptions): Promise<T>;
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

function validateMediaReleaseParams(params: JsonObject | undefined): string | undefined {
  if (!params || Object.keys(params).length !== 1) return 'Invalid media release params';
  const ids = params.ids;
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > MAX_MEDIA_RELEASE_IDS ||
    !ids.every((id) => typeof id === 'string' && MEDIA_ID_PATTERN.test(id))
  ) {
    return 'Invalid media release params';
  }
}

function isPlainRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidHttpsEndpoint(url: unknown): url is string {
  if (typeof url !== 'string' || url.length < 9 || /\s/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.length > 0 &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
}

function assertValidUploadRequest(
  params: JsonObject | undefined,
  allowedUrls: ReadonlySet<string> | undefined,
): void {
  if (!isPlainRecord(params) || Object.keys(params).length !== 2 || !('id' in params) || !('request' in params)) {
    throw new HostError(-32602, 'Invalid upload params');
  }
  if (typeof params.id !== 'string' || !MEDIA_ID_PATTERN.test(params.id)) {
    throw new HostError(-32602, 'Invalid media handle');
  }
  const req = params.request;
  if (!isPlainRecord(req)) {
    throw new HostError(-32602, 'Invalid upload request');
  }
  for (const key of Object.keys(req)) {
    if (!ALLOWED_UPLOAD_REQUEST_KEYS.has(key)) {
      throw new HostError(-32602, `Unknown upload request field "${key}"`);
    }
  }
  if (!isValidHttpsEndpoint(req.url)) {
    throw new HostError(-32602, 'Upload url must be an absolute HTTPS endpoint');
  }
  if (req.method !== undefined && req.method !== 'POST') {
    throw new HostError(-32602, 'Upload method must be POST');
  }

  let effectiveFieldName = 'file';
  if (req.fieldName !== undefined) {
    if (typeof req.fieldName !== 'string' || !FIELD_NAME_PATTERN.test(req.fieldName)) {
      throw new HostError(-32602, 'Invalid upload fieldName');
    }
    effectiveFieldName = req.fieldName;
  }

  let metadataBytes = 0;

  if (req.formData !== undefined) {
    if (!isPlainRecord(req.formData)) throw new HostError(-32602, 'Invalid formData');
    const entries = Object.entries(req.formData);
    if (entries.length > MAX_UPLOAD_MAP_ENTRIES) {
      throw new HostError(-32006, 'formData exceeds 16 entries');
    }
    for (const [key, value] of entries) {
      if (!FIELD_NAME_PATTERN.test(key) || typeof value !== 'string') {
        throw new HostError(-32602, 'Invalid formData entry');
      }
      if (key === effectiveFieldName) {
        throw new HostError(-32602, 'formData key collides with fieldName');
      }
      metadataBytes += utf8.encode(key).byteLength + utf8.encode(value).byteLength;
      if (metadataBytes > MAX_UPLOAD_METADATA_BYTES) {
        throw new HostError(-32006, 'Upload metadata exceeds budget');
      }
    }
  }

  const forbiddenHeadersFound: string[] = [];
  if (req.headers !== undefined) {
    if (!isPlainRecord(req.headers)) throw new HostError(-32602, 'Invalid headers');
    const entries = Object.entries(req.headers);
    if (entries.length > MAX_UPLOAD_MAP_ENTRIES) {
      throw new HostError(-32006, 'headers exceeds 16 entries');
    }
    const seenLower = new Set<string>();
    for (const [key, value] of entries) {
      if (!HEADER_NAME_PATTERN.test(key) || typeof value !== 'string' || HEADER_CONTROL_PATTERN.test(value)) {
        throw new HostError(-32602, 'Invalid header entry');
      }
      const lower = key.toLowerCase();
      if (seenLower.has(lower)) throw new HostError(-32602, 'Duplicate header name');
      seenLower.add(lower);
      metadataBytes += utf8.encode(key).byteLength + utf8.encode(value).byteLength;
      if (metadataBytes > MAX_UPLOAD_METADATA_BYTES) {
        throw new HostError(-32006, 'Upload metadata exceeds budget');
      }
      if (FORBIDDEN_UPLOAD_HEADERS.has(lower) || lower.startsWith('content-')) {
        forbiddenHeadersFound.push(lower);
      }
    }
  }

  if (req.compress !== undefined) {
    if (!isPlainRecord(req.compress)) throw new HostError(-32602, 'Invalid compress options');
    for (const [key, value] of Object.entries(req.compress)) {
      if (key === 'maxEdge') {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 4096) {
          throw new HostError(-32602, 'Invalid compress.maxEdge');
        }
      } else if (key === 'quality') {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 100) {
          throw new HostError(-32602, 'Invalid compress.quality');
        }
      } else {
        throw new HostError(-32602, `Unknown compress field "${key}"`);
      }
    }
  }

  if (forbiddenHeadersFound.length > 0) {
    throw new HostError(-32003, 'Forbidden upload header', { reason: 'forbidden_header' });
  }
  if (allowedUrls && !allowedUrls.has(req.url)) {
    throw new HostError(-32003, 'Upload endpoint not allowed', { reason: 'endpoint_not_allowed' });
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
    version: options?.hostVersion ?? '1.0.0',
    events: options?.events,
    deniedEvents: options?.deniedEvents,
    supportsCancel: options?.supportsCancel,
    supportsCallbacks: options?.supportsCallbacks,
    supportsReverse: options?.supportsReverse,
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

  const {
    deviceInfo, getNetworkStatus, showToast, chooseMedia, releaseMedia, uploadMedia, allowedUploadUrls, handlers,
  } = options ?? {};
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
  if (releaseMedia) {
    register(
      MEDIA_RELEASE_METHOD,
      async (params, ctx) => {
        const ids = [...new Set(params?.ids as string[])];
        await releaseMedia(ids, ctx);
        return null;
      },
      { validateParams: validateMediaReleaseParams },
    );
  }
  if (uploadMedia) {
    const allowedSet = allowedUploadUrls ? new Set(allowedUploadUrls.filter(isValidHttpsEndpoint)) : undefined;
    register(
      TRANSFER_UPLOAD_METHOD,
      async (params, ctx) => {
        assertValidUploadRequest(params, allowedSet);
        const res = await uploadMedia(params, ctx);
        if (
          !isPlainRecord(res) ||
          typeof res.status !== 'number' || !Number.isSafeInteger(res.status) ||
          res.status < 100 || res.status > 599 ||
          typeof res.body !== 'string'
        ) {
          throw new HostError(-32603, 'Invalid upload response', { reason: 'invalid_response' });
        }
        if (utf8.encode(res.body).byteLength > MAX_UPLOAD_RESPONSE_BYTES) {
          throw new HostError(-32006, 'Upload response body exceeds limit');
        }
        return { status: res.status, body: res.body };
      },
      { concurrency: 'serial' },
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
    get webMethods(): ReadonlySet<string> {
      return host.webMethods;
    },
    send: (raw) => host.receive(raw),
    emit: (name, payload) => host.emit(name, payload),
    callWeb: (method, params, callOptions) => host.callWeb(method, params, callOptions),
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
  readonly webMethods: ReadonlySet<string>;
  emit(name: string, payload: JsonValue): boolean;
  callWeb<T = JsonValue>(method: string, params?: JsonObject, options?: CallWebOptions): Promise<T>;
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
    get webMethods(): ReadonlySet<string> {
      return adapter.webMethods;
    },
    emit(name, payload) {
      if (typeof target.__OJSB_RECEIVE__ !== 'function') return false;
      return adapter.emit(name, payload);
    },
    callWeb(method, params, callOptions) {
      if (typeof target.__OJSB_RECEIVE__ !== 'function') {
        return Promise.reject(new HostError(-32000, 'Bridge unavailable'));
      }
      return adapter.callWeb(method, params, callOptions);
    },
    register: (method, handler, registerOptions) => adapter.register(method, handler, registerOptions),
    failNext: (method, failure) => adapter.failNext(method, failure),
    wasCancelled: (requestId) => adapter.wasCancelled(requestId),
  };
}
