import {
  decodeEnvelope, encodeEnvelope, ErrorCode, WireDecodeError,
  type Envelope, type JsonObject, type JsonValue, type RpcRequest,
} from '../../protocol/src/index.js';

const HELLO_METHOD = 'bridge.hello';
const SUBSCRIBE_METHOD = 'bridge.subscribe';
const UNSUBSCRIBE_METHOD = 'bridge.unsubscribe';
const CANCEL_METHOD = 'bridge.cancel';
const NAME_PATTERN = /^(?!rpc\.)[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;
const VERSION_SUFFIX = /@([1-9][0-9]*)$/;
const DEFAULT_LIMITS = Object.freeze({
  maxMessageBytes: 1_048_576,
  maxInflight: 64,
  defaultTimeoutMs: 15_000,
});
const utf8 = new TextEncoder();
let nextSession = 0;

export class HostError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: JsonValue,
  ) {
    super(message);
    this.name = 'HostError';
  }
}

export interface HostHandlerContext {
  readonly sid: string;
  readonly id: string;
  readonly method: string;
  readonly version: number;
  readonly traceId?: string;
  readonly signal: AbortSignal;
}

export type HostHandler = (
  params: JsonObject | undefined,
  ctx: HostHandlerContext,
) => JsonValue | Promise<JsonValue>;

export interface RegisterHandlerOptions {
  versions?: readonly number[];
  concurrency?: 'parallel' | 'serial';
  validateParams?: (params: JsonObject | undefined) => string | undefined;
}

export interface HostCoreLimits {
  maxMessageBytes?: number;
  maxInflight?: number;
  defaultTimeoutMs?: number;
}

export interface HostCoreOptions {
  platform?: string;
  name?: string;
  version?: string;
  appId?: string;
  appVersion?: string;
  events?: readonly string[];
  deniedEvents?: readonly string[];
  supportsCancel?: boolean;
  limits?: HostCoreLimits;
}

export interface HostCore {
  readonly sid: string | undefined;
  readonly name: string;
  receive(raw: string): Promise<string | null>;
  emit(name: string, payload: JsonValue): boolean;
  register(method: string, handler: HostHandler, options?: RegisterHandlerOptions): () => void;
  unregister(method: string): boolean;
  setReceiver(onMessage: ((raw: string) => void) | undefined): void;
  reset(): void;
  wasCancelled(requestId: string): boolean;
}

interface RegisteredMethod {
  handler: HostHandler;
  versions: readonly number[];
  concurrency: 'parallel' | 'serial';
  validateParams?: (params: JsonObject | undefined) => string | undefined;
  activeCount: number;
}

interface InflightCall {
  controller: AbortController;
  sid: string;
  cancelled: boolean;
}

function isQualifiedName(name: unknown): name is string {
  return typeof name === 'string' && NAME_PATTERN.test(name);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function normalizeVersions(versions?: readonly number[]): number[] {
  if (!versions || versions.length === 0) return [1];
  const unique = [...new Set(versions.filter(isPositiveSafeInteger))].sort((a, b) => a - b);
  return unique.length > 0 ? unique : [1];
}

function parseMethod(wireMethod: string): { name: string; explicitVersion?: number } {
  const match = VERSION_SUFFIX.exec(wireMethod);
  if (!match) return { name: wireMethod };
  return { name: wireMethod.slice(0, match.index), explicitVersion: Number(match[1]) };
}

function readProtocols(params?: JsonObject): number[] | undefined {
  const protocols = params?.protocols;
  if (
    !Array.isArray(protocols) ||
    !protocols.length ||
    !protocols.every((major): major is number => isPositiveSafeInteger(major)) ||
    new Set(protocols).size !== protocols.length
  ) {
    return;
  }
  const { sdk, wants } = params ?? {};
  if (
    sdk !== undefined &&
    (sdk === null ||
      typeof sdk !== 'object' ||
      Array.isArray(sdk) ||
      typeof sdk.name !== 'string' ||
      typeof sdk.version !== 'string')
  ) {
    return;
  }
  if (
    wants !== undefined &&
    (!Array.isArray(wants) ||
      !wants.every((want) => typeof want === 'string') ||
      new Set(wants).size !== wants.length)
  ) {
    return;
  }
  return protocols;
}

function readEventNames(params?: JsonObject): string[] | undefined {
  const events = params?.events;
  if (
    Array.isArray(events) &&
    events.length > 0 &&
    events.every(isQualifiedName) &&
    new Set(events).size === events.length
  ) {
    return events;
  }
}

function isPlainJsonValue(value: unknown, ancestors: Set<object>): boolean {
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
    if (!isPlainJsonValue(entry, ancestors)) return false;
  }
  ancestors.delete(value);
  return true;
}

/** Transport-agnostic reference Host state machine for jsb 1.0. */
export function createHostCore(options: HostCoreOptions = {}): HostCore {
  const hostInfo: JsonObject = {
    platform: options.platform ?? 'mock',
    name: options.name ?? 'mock',
    version: options.version ?? '0.2.0',
    ...(options.appId === undefined ? {} : { appId: options.appId }),
    ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
  };
  const limits = {
    maxMessageBytes: isPositiveSafeInteger(options.limits?.maxMessageBytes)
      ? options.limits.maxMessageBytes
      : DEFAULT_LIMITS.maxMessageBytes,
    maxInflight: isPositiveSafeInteger(options.limits?.maxInflight)
      ? options.limits.maxInflight
      : DEFAULT_LIMITS.maxInflight,
    defaultTimeoutMs: isPositiveSafeInteger(options.limits?.defaultTimeoutMs)
      ? options.limits.defaultTimeoutMs
      : DEFAULT_LIMITS.defaultTimeoutMs,
  };
  const supportsCancel = options.supportsCancel === true;
  const allowedEvents = new Set(options.events?.filter(isQualifiedName));
  const deniedEvents = new Set(options.deniedEvents?.filter(isQualifiedName));
  const advertisedEvents = [...new Set([...allowedEvents, ...deniedEvents])];

  const registry = new Map<string, RegisteredMethod>();
  const helloIds = new Set<string>();
  const requestIds = new Set<string>();
  const subscriptions = new Set<string>();
  const inflight = new Map<string, InflightCall>();
  const cancelledIds = new Set<string>();

  let activeSid: string | undefined;
  let receiver: ((raw: string) => void) | undefined;

  function exceedsMessageLimit(raw: string): boolean {
    return raw.length > limits.maxMessageBytes || utf8.encode(raw).byteLength > limits.maxMessageBytes;
  }

  function failure(
    id: string | null,
    code: number,
    message: string,
    data?: JsonValue,
    sid?: string,
    traceId?: string,
  ): string {
    const meta: JsonObject = {};
    if (sid !== undefined) meta.sid = sid;
    if (traceId !== undefined) meta.traceId = traceId;
    return encodeEnvelope({
      jsb: '1.0',
      ...(Object.keys(meta).length === 0 ? {} : { meta }),
      rpc: { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } },
    });
  }

  function success(id: string, result: JsonValue, sid: string, traceId?: string): string {
    const meta: JsonObject = { sid };
    if (traceId !== undefined) meta.traceId = traceId;
    return encodeEnvelope({ jsb: '1.0', meta, rpc: { jsonrpc: '2.0', id, result } });
  }

  function reset(): void {
    activeSid = undefined;
    helloIds.clear();
    requestIds.clear();
    subscriptions.clear();
    cancelledIds.clear();
    for (const call of inflight.values()) {
      call.cancelled = true;
      call.controller.abort();
    }
    inflight.clear();
    for (const entry of registry.values()) {
      entry.activeCount = 0;
    }
  }

  function register(
    method: string,
    handler: HostHandler,
    registerOptions: RegisterHandlerOptions = {},
  ): () => void {
    if (!isQualifiedName(method)) {
      throw new Error(`Invalid method name "${method}"`);
    }
    const entry: RegisteredMethod = {
      handler,
      versions: normalizeVersions(registerOptions.versions),
      concurrency: registerOptions.concurrency ?? 'parallel',
      validateParams: registerOptions.validateParams,
      activeCount: 0,
    };
    registry.set(method, entry);
    return () => {
      if (registry.get(method) === entry) registry.delete(method);
    };
  }

  function unregister(method: string): boolean {
    return registry.delete(method);
  }

  function negotiate(request: RpcRequest, traceId?: string): string {
    const protocols = readProtocols(request.params);
    if (!protocols) return failure(request.id, ErrorCode.InvalidParams, 'Invalid handshake params', undefined, undefined, traceId);
    if (!protocols.includes(1)) {
      return failure(request.id, ErrorCode.UnsupportedProtocol, 'Unsupported protocol', { supported: [1] }, undefined, traceId);
    }
    activeSid ??= globalThis.crypto?.randomUUID?.() ?? `host-${++nextSession}`;
    const advertisedMethods: JsonObject = {};
    for (const [name, entry] of registry) {
      advertisedMethods[name] = { versions: [...entry.versions] };
    }
    return success(
      request.id,
      {
        jsb: '1.0',
        sid: activeSid,
        host: hostInfo,
        capabilities: {
          methods: advertisedMethods,
          events: advertisedEvents,
          features: supportsCancel ? ['cancel'] : [],
        },
        limits,
      },
      activeSid,
      traceId,
    );
  }

  function controlSubscription(
    method: string,
    request: RpcRequest,
    session: string,
    traceId?: string,
  ): string {
    const events = readEventNames(request.params);
    if (!events) {
      return failure(request.id, ErrorCode.InvalidParams, 'Invalid event subscription params', undefined, session, traceId);
    }

    if (method === UNSUBSCRIBE_METHOD) {
      const response = success(request.id, { unsubscribed: events }, session, traceId);
      if (exceedsMessageLimit(response)) {
        return failure(request.id, ErrorCode.PayloadTooLarge, 'Payload too large', undefined, session, traceId);
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
    const response = success(request.id, { subscribed, denied }, session, traceId);
    if (exceedsMessageLimit(response)) {
      return failure(request.id, ErrorCode.PayloadTooLarge, 'Payload too large', undefined, session, traceId);
    }
    for (const event of subscribed) subscriptions.add(event);
    return response;
  }

  function handleCancelNotification(envelope: Envelope): void {
    if (!supportsCancel || !activeSid || envelope.meta?.sid !== activeSid) return;
    const { rpc } = envelope;
    if (!('method' in rpc) || 'id' in rpc) return;
    const { name, explicitVersion } = parseMethod(rpc.method);
    if (name !== CANCEL_METHOD || (explicitVersion !== undefined && explicitVersion !== 1)) return;
    const params = rpc.params;
    const requestId = params?.requestId;
    const reason = params?.reason;
    if (
      typeof requestId !== 'string' ||
      requestId.length === 0 ||
      (reason !== undefined && typeof reason !== 'string')
    ) {
      return;
    }
    const call = inflight.get(requestId);
    if (!call || call.sid !== activeSid) return;
    call.cancelled = true;
    cancelledIds.add(requestId);
    call.controller.abort(reason);
  }

  async function receive(raw: string): Promise<string | null> {
    if (exceedsMessageLimit(raw)) return null;

    let envelope: Envelope;
    try {
      envelope = decodeEnvelope(raw);
    } catch (error) {
      if (activeSid && error instanceof WireDecodeError && error.code === ErrorCode.ParseError) {
        return failure(null, error.code, error.message, undefined, activeSid);
      }
      return null;
    }

    const { rpc, meta } = envelope;
    if (!('method' in rpc)) return null;
    if (!('id' in rpc)) {
      handleCancelNotification(envelope);
      return null;
    }

    const traceId = typeof meta?.traceId === 'string' ? meta.traceId : undefined;
    const { name, explicitVersion } = parseMethod(rpc.method);
    const isHello = name === HELLO_METHOD && (explicitVersion === undefined || explicitVersion === 1);

    if (isHello) {
      if ((meta?.sid !== undefined && meta.sid !== activeSid) || helloIds.has(rpc.id)) return null;
      helloIds.add(rpc.id);
      if (meta?.timeout === 0) {
        return failure(rpc.id, ErrorCode.InvalidParams, 'Invalid request timeout', undefined, activeSid, traceId);
      }
      return negotiate(rpc, traceId);
    }

    if (!activeSid || meta?.sid !== activeSid || requestIds.has(rpc.id)) return null;
    requestIds.add(rpc.id);

    const replySid = activeSid;
    const isControl =
      (name === SUBSCRIBE_METHOD || name === UNSUBSCRIBE_METHOD) &&
      (explicitVersion === undefined || explicitVersion === 1);

    if (isControl) {
      if (meta.timeout === 0) {
        return failure(rpc.id, ErrorCode.InvalidParams, 'Invalid request timeout', undefined, replySid, traceId);
      }
      return controlSubscription(name, rpc, replySid, traceId);
    }

    const entry = registry.get(name);
    if (!entry) {
      return failure(rpc.id, ErrorCode.MethodNotFound, 'Method not found', undefined, replySid, traceId);
    }
    const resolvedVersion = explicitVersion ?? entry.versions[0]!;
    if (!entry.versions.includes(resolvedVersion)) {
      return failure(
        rpc.id,
        ErrorCode.MethodNotFound,
        'Method version not supported',
        { reason: 'version_unsupported', method: name },
        replySid,
        traceId,
      );
    }
    if (meta.timeout === 0) {
      return failure(rpc.id, ErrorCode.InvalidParams, 'Invalid request timeout', undefined, replySid, traceId);
    }

    const paramError = entry.validateParams?.(rpc.params);
    if (paramError !== undefined) {
      return failure(rpc.id, ErrorCode.InvalidParams, paramError, undefined, replySid, traceId);
    }
    if (entry.concurrency === 'serial' && entry.activeCount > 0) {
      return failure(rpc.id, ErrorCode.Busy, 'Busy', undefined, replySid, traceId);
    }
    if (inflight.size >= limits.maxInflight) {
      return failure(rpc.id, ErrorCode.RateLimited, 'Rate limited', undefined, replySid, traceId);
    }

    const controller = new AbortController();
    const call: InflightCall = { controller, sid: replySid, cancelled: false };
    inflight.set(rpc.id, call);
    entry.activeCount += 1;

    try {
      const ctx: HostHandlerContext = {
        sid: replySid,
        id: rpc.id,
        method: name,
        version: resolvedVersion,
        ...(traceId === undefined ? {} : { traceId }),
        signal: controller.signal,
      };
      const maybePromise = entry.handler(rpc.params, ctx);
      const value = maybePromise instanceof Promise ? await maybePromise : maybePromise;
      if (activeSid !== replySid) return null;
      if (call.cancelled) {
        return failure(rpc.id, ErrorCode.Cancelled, 'Cancelled', undefined, replySid, traceId);
      }
      const response = success(rpc.id, value, replySid, traceId);
      if (exceedsMessageLimit(response)) {
        return failure(rpc.id, ErrorCode.PayloadTooLarge, 'Payload too large', undefined, replySid, traceId);
      }
      return response;
    } catch (error) {
      if (activeSid !== replySid) return null;
      if (call.cancelled) {
        return failure(rpc.id, ErrorCode.Cancelled, 'Cancelled', undefined, replySid, traceId);
      }
      if (error instanceof HostError) {
        return failure(rpc.id, error.code, error.message, error.data, replySid, traceId);
      }
      return failure(rpc.id, ErrorCode.InternalError, 'Internal error', undefined, replySid, traceId);
    } finally {
      if (inflight.get(rpc.id) === call) inflight.delete(rpc.id);
      if (entry.activeCount > 0) entry.activeCount -= 1;
    }
  }

  function emit(name: string, payload: JsonValue): boolean {
    const receiveMessage = receiver;
    if (!activeSid || !receiveMessage || !subscriptions.has(name)) return false;

    let raw: string;
    try {
      if (!isPlainJsonValue(payload, new Set())) return false;
      raw = encodeEnvelope({
        jsb: '1.0',
        meta: { sid: activeSid },
        rpc: { jsonrpc: '2.0', method: 'bridge.event', params: { name, payload } },
      });
    } catch {
      return false;
    }
    if (exceedsMessageLimit(raw) || receiver !== receiveMessage || !subscriptions.has(name)) return false;
    receiveMessage(raw);
    return true;
  }

  return {
    get sid() {
      return activeSid;
    },
    name: String(hostInfo.name),
    receive,
    emit,
    register,
    unregister,
    setReceiver(onMessage) {
      receiver = onMessage;
    },
    reset,
    wasCancelled(requestId) {
      return cancelledIds.has(requestId);
    },
  };
}
