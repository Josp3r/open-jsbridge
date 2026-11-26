import {
  decodeEnvelope, encodeEnvelope, ErrorCode, WireDecodeError,
  type Envelope, type JsonObject, type JsonValue, type RpcRequest,
} from '../../protocol/src/index.js';

const helloMethod = 'bridge.hello';
const echoMethod = 'conformance.echo';
const toastMethod = 'ui.toast.show';
const subscribeMethod = 'bridge.subscribe';
const unsubscribeMethod = 'bridge.unsubscribe';
const eventNamePattern = /^(?!rpc\.)[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;
const networkTypes = ['wifi', 'cellular', 'ethernet', 'other', 'none', 'unknown'] as const;
const limits = { maxMessageBytes: 1_048_576, maxInflight: 64, defaultTimeoutMs: 15_000 };
const utf8 = new TextEncoder();
let nextSession = 0;

function exceedsMessageLimit(raw: string): boolean {
  return raw.length > limits.maxMessageBytes || utf8.encode(raw).byteLength > limits.maxMessageBytes;
}

function failure(id: string | null, code: number, message: string, data?: JsonValue, sid?: string): string {
  return encodeEnvelope({
    jsb: '1.0', ...(sid === undefined ? {} : { meta: { sid } }),
    rpc: { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } },
  });
}

function success(id: string, result: JsonValue, sid: string): string {
  return encodeEnvelope({ jsb: '1.0', meta: { sid }, rpc: { jsonrpc: '2.0', id, result } });
}

function readProtocols(params?: JsonObject): number[] | undefined {
  const protocols = params?.protocols;
  if (!Array.isArray(protocols) || !protocols.length ||
      !protocols.every((major): major is number => typeof major === 'number' && Number.isSafeInteger(major) && major > 0) ||
      new Set(protocols).size !== protocols.length) return;

  const { sdk, wants } = params ?? {};
  if (sdk !== undefined && (sdk === null || typeof sdk !== 'object' || Array.isArray(sdk) ||
      typeof sdk.name !== 'string' || typeof sdk.version !== 'string')) return;
  if (wants !== undefined && (!Array.isArray(wants) || !wants.every((want) => typeof want === 'string') ||
      new Set(wants).size !== wants.length)) return;
  return protocols;
}

function isEventName(name: unknown): name is string {
  return typeof name === 'string' && eventNamePattern.test(name);
}

function readEventNames(params?: JsonObject): string[] | undefined {
  const events = params?.events;
  if (Array.isArray(events) && events.length && events.every(isEventName) &&
      new Set(events).size === events.length) return events;
}

function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return true;
  }
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
  }

  ancestors.add(value);
  for (const entry of Array.isArray(value) ? value : Object.values(value)) {
    if (!isJsonValue(entry, ancestors)) return false;
  }
  ancestors.delete(value);
  return true;
}

export interface MockAdapterOptions {
  events?: readonly string[];
  /** Advertised events whose subscription requests are denied by the Mock host. */
  deniedEvents?: readonly string[];
  deviceInfo?: { os: 'ios' | 'android'; osVersion: string };
  getNetworkStatus?: () => { type: typeof networkTypes[number] };
  showToast?: (text: string) => void | Promise<void>;
}

/** A standalone Mock session with Promise responses and out-of-band event delivery. */
export function createMockAdapter(options?: MockAdapterOptions) {
  let sid: string | undefined;
  let receiver: ((raw: string) => void) | undefined;
  const helloIds = new Set<string>();
  const requestIds = new Set<string>();
  const methods = new Map<string, (params?: JsonObject) => JsonValue | Promise<JsonValue>>([
    [echoMethod, (params) => params ?? {}],
  ]);
  const { deviceInfo, getNetworkStatus, showToast } = options ?? {};
  if (deviceInfo) {
    const { os, osVersion } = deviceInfo;
    if ((os === 'ios' || os === 'android') && typeof osVersion === 'string' && osVersion.length > 0) {
      methods.set('device.getInfo', () => ({ os, osVersion }));
    }
  }
  if (getNetworkStatus) {
    methods.set('network.getStatus', () => {
      const { type } = getNetworkStatus();
      return { type: networkTypes.includes(type) ? type : 'unknown' };
    });
  }
  if (showToast) {
    methods.set(toastMethod, async (params) => {
      await showToast(params?.text as string);
      return {};
    });
  }
  const allowedEvents = new Set(options?.events?.filter(isEventName));
  const deniedEvents = new Set(options?.deniedEvents?.filter(isEventName));
  const eventNames = [...new Set([...allowedEvents, ...deniedEvents])];
  const subscriptions = new Set<string>();

  function resetSession(): void {
    sid = undefined;
    helloIds.clear();
    requestIds.clear();
    subscriptions.clear();
  }

  function negotiate(request: RpcRequest): string {
    const protocols = readProtocols(request.params);
    if (!protocols) return failure(request.id, ErrorCode.InvalidParams, 'Invalid handshake params');
    if (!protocols.includes(1)) {
      return failure(request.id, ErrorCode.UnsupportedProtocol, 'Unsupported protocol', { supported: [1] });
    }
    sid ??= globalThis.crypto?.randomUUID?.() ?? `mock-${++nextSession}`;
    return success(request.id, {
      jsb: '1.0', sid, host: { platform: 'mock', name: 'mock', version: '0.2.0' },
      capabilities: {
        methods: Object.fromEntries([...methods.keys()].map((method) => [method, { versions: [1] }])),
        events: eventNames,
        features: [],
      },
      limits,
    }, sid);
  }

  function controlSubscription(method: string, request: RpcRequest, session: string): string {
    const events = readEventNames(request.params);
    if (!events) return failure(request.id, ErrorCode.InvalidParams, 'Invalid event subscription params', undefined, session);

    if (method === unsubscribeMethod) {
      const response = success(request.id, { unsubscribed: events }, session);
      if (exceedsMessageLimit(response)) {
        return failure(request.id, ErrorCode.PayloadTooLarge, 'Payload too large', undefined, session);
      }
      for (const event of events) subscriptions.delete(event);
      return response;
    }

    const subscribed: string[] = [];
    const denied: string[] = [];
    for (const event of events) {
      if (allowedEvents.has(event) && !deniedEvents.has(event)) subscribed.push(event);
      else denied.push(event);
    }
    const response = success(request.id, { subscribed, denied }, session);
    if (exceedsMessageLimit(response)) {
      return failure(request.id, ErrorCode.PayloadTooLarge, 'Payload too large', undefined, session);
    }
    for (const event of subscribed) subscriptions.add(event);
    return response;
  }

  async function send(raw: string): Promise<string | null> {
    if (exceedsMessageLimit(raw)) return null;

    let envelope: Envelope;
    try {
      envelope = decodeEnvelope(raw);
    } catch (error) {
      // This adapter has one route. It can attach a session only after negotiating on that route.
      if (sid && error instanceof WireDecodeError && error.code === ErrorCode.ParseError) {
        return failure(null, error.code, error.message, undefined, sid);
      }
      return null;
    }

    const { rpc, meta } = envelope;
    if (!('method' in rpc) || !('id' in rpc)) return null;
    const method = rpc.method.endsWith('@1') ? rpc.method.slice(0, -2) : rpc.method;
    if (method === helloMethod) {
      if ((meta?.sid !== undefined && meta.sid !== sid) || helloIds.has(rpc.id)) return null;
      helloIds.add(rpc.id);
      if (meta?.timeout === 0) {
        return failure(rpc.id, ErrorCode.InvalidParams, 'Invalid request timeout', undefined, sid);
      }
      return negotiate(rpc);
    }
    if (!sid || meta?.sid !== sid || requestIds.has(rpc.id)) return null;
    requestIds.add(rpc.id);

    const control = method === subscribeMethod || method === unsubscribeMethod;
    const handle = methods.get(method);
    if (!control && !handle) return failure(rpc.id, ErrorCode.MethodNotFound, 'Method not found', undefined, sid);
    if (meta.timeout === 0) return failure(rpc.id, ErrorCode.InvalidParams, 'Invalid request timeout', undefined, sid);
    if (control) return controlSubscription(method, rpc, sid);
    if (method === toastMethod) {
      const text = rpc.params?.text;
      if (typeof text !== 'string' || text.length === 0 || [...text].length > 120 ||
          Object.keys(rpc.params ?? {}).length !== 1) {
        return failure(rpc.id, ErrorCode.InvalidParams, 'Invalid toast params', undefined, sid);
      }
    } else if (method !== echoMethod && Object.keys(rpc.params ?? {}).length > 0) {
      return failure(rpc.id, ErrorCode.InvalidParams, 'Expected empty params', undefined, sid);
    }
    const replySid = sid;
    try {
      const result = handle!(rpc.params);
      const value = result instanceof Promise ? await result : result;
      if (sid !== replySid) return null;
      const response = success(rpc.id, value, replySid);
      if (exceedsMessageLimit(response)) {
        return failure(rpc.id, ErrorCode.PayloadTooLarge, 'Payload too large', undefined, sid);
      }
      return response;
    } catch {
      return sid === replySid ? failure(rpc.id, ErrorCode.InternalError, 'Internal error', undefined, replySid) : null;
    }
  }

  function emit(name: string, payload: JsonValue): boolean {
    const receive = receiver;
    if (!sid || !receive || !subscriptions.has(name)) return false;

    let raw: string;
    try {
      if (!isJsonValue(payload, new Set())) return false;
      raw = encodeEnvelope({
        jsb: '1.0', meta: { sid },
        rpc: { jsonrpc: '2.0', method: 'bridge.event', params: { name, payload } },
      });
    } catch {
      return false;
    }
    if (exceedsMessageLimit(raw) || receiver !== receive || !subscriptions.has(name)) return false;
    receive(raw);
    return true;
  }

  return {
    name: 'mock',
    send,
    emit,
    listen(onMessage: (raw: string) => void): () => void {
      if (receiver) resetSession();
      const receive = (raw: string) => onMessage(raw);
      receiver = receive;
      return () => {
        if (receiver !== receive) return;
        receiver = undefined;
        resetSession();
      };
    },
  };
}

type FrameDirection = 'request' | 'response' | 'event';

export interface MockTransportOptions extends MockAdapterOptions {
  onFrame?: (direction: FrameDirection, raw: string | null) => void;
}

/** Installs a Mock Host Shim on the current browser window when its transport slot is free. */
export function installMockTransport(options?: MockTransportOptions): { emit(name: string, payload: JsonValue): boolean } | undefined {
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
  };
}
