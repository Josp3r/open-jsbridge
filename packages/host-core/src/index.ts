import {
  decodeEnvelope, encodeEnvelope, ErrorCode, WireDecodeError,
  type Envelope, type JsonObject, type JsonValue, type RpcRequest,
} from '../../protocol/src/index.js';
import {
  createAclPolicy,
  type AclConfig, type AclDecision, type AclDenyReason, type AclFrameScope,
  type AclPolicy, type AclPolicyOptions, type AclRateLimit, type AclRule, type CallerContext,
} from './acl.js';

export { createAclPolicy };
export type {
  AclConfig, AclDecision, AclDenyReason, AclFrameScope,
  AclPolicy, AclPolicyOptions, AclRateLimit, AclRule, CallerContext,
};

const HELLO_METHOD = 'bridge.hello';
const SUBSCRIBE_METHOD = 'bridge.subscribe';
const UNSUBSCRIBE_METHOD = 'bridge.unsubscribe';
const REGISTER_WEB_METHODS = 'bridge.registerWebMethods';
const CANCEL_METHOD = 'bridge.cancel';
const NAME_PATTERN = /^(?!rpc\.)[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;
const WEB_METHOD_PATTERN = /^(?!rpc\.|bridge\.|ojsb\.)[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;
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
  callback(chunk?: JsonValue): boolean;
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

export interface CallWebOptions {
  timeout?: number;
  signal?: AbortSignal;
  traceId?: string;
}

export interface AuthorizeRequest {
  readonly kind: 'hello' | 'method' | 'subscribe';
  readonly method: string;
  readonly version?: number;
  readonly sid?: string;
  readonly caller: CallerContext;
}

export type HostAuthorizeHook = (request: AuthorizeRequest) => boolean | AclDecision | void;

export interface HostCoreOptions {
  platform?: string;
  name?: string;
  version?: string;
  appId?: string;
  appVersion?: string;
  events?: readonly string[];
  deniedEvents?: readonly string[];
  supportsCancel?: boolean;
  supportsCallbacks?: boolean;
  supportsReverse?: boolean;
  supportsIframe?: boolean;
  limits?: HostCoreLimits;
  /** Optional protocol §11.3 rules JSON ACL config or compiled policy. */
  acl?: AclConfig | AclPolicy;
  /** Default caller origin/frame metadata applied when receive() is called without an explicit caller. */
  caller?: CallerContext;
  /** Optional authorization hook evaluated in the security chain; unexpected throws map to -32603 (SEC-ACL-ERROR-001). */
  authorize?: HostAuthorizeHook;
  /** Optional clock (ms) forwarded to ACL rate limiting. */
  now?: () => number;
}

export interface HostCore {
  readonly sid: string | undefined;
  readonly name: string;
  readonly webMethods: ReadonlySet<string>;
  receive(raw: string, caller?: CallerContext): Promise<string | null>;
  emit(name: string, payload: JsonValue): boolean;
  callWeb<T = JsonValue>(method: string, params?: JsonObject, options?: CallWebOptions): Promise<T>;
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

interface ReversePendingCall {
  sid: string;
  timer?: ReturnType<typeof setTimeout>;
  stopSignal?: () => void;
  resolve: (value: JsonValue) => void;
  reject: (error: HostError) => void;
}

function isQualifiedName(name: unknown): name is string {
  return typeof name === 'string' && NAME_PATTERN.test(name);
}

function isWebMethodName(name: unknown): name is string {
  return typeof name === 'string' && WEB_METHOD_PATTERN.test(name);
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

function readWebMethods(params?: JsonObject): string[] | undefined {
  const methods = params?.methods;
  if (
    Array.isArray(methods) &&
    methods.every(isWebMethodName) &&
    new Set(methods).size === methods.length
  ) {
    return methods;
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
    version: options.version ?? '1.0.0',
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
  const aclPolicy = options.acl === undefined
    ? undefined
    : ('evaluate' in options.acl
      ? options.acl
      : createAclPolicy(options.acl, { supportsIframe: options.supportsIframe, now: options.now }));
  const supportsCancel = options.supportsCancel === true;
  const supportsCallbacks = options.supportsCallbacks === true;
  const supportsReverse = options.supportsReverse === true;
  const supportsIframe = aclPolicy ? aclPolicy.supportsIframe : options.supportsIframe === true;
  const defaultCaller = options.caller;
  const authorizeHook = options.authorize;
  const allowedEvents = new Set(options.events?.filter(isQualifiedName));
  const deniedEvents = new Set(options.deniedEvents?.filter(isQualifiedName));
  const advertisedEvents = [...new Set([...allowedEvents, ...deniedEvents])];

  const registry = new Map<string, RegisteredMethod>();
  const helloIds = new Set<string>();
  const requestIds = new Set<string>();
  const subscriptions = new Set<string>();
  const inflight = new Map<string, InflightCall>();
  const cancelledIds = new Set<string>();
  const registeredWebMethods = new Set<string>();
  const reversePending = new Map<string, ReversePendingCall>();

  let activeSid: string | undefined;
  let receiver: ((raw: string) => void) | undefined;
  let reverseCounter = 0;

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

  function settleReverse(id: string): ReversePendingCall | undefined {
    const call = reversePending.get(id);
    if (!call) return;
    reversePending.delete(id);
    if (call.timer !== undefined) clearTimeout(call.timer);
    call.stopSignal?.();
    return call;
  }

  function postReverseCancel(id: string, sid: string, reason?: string): void {
    const receiveMessage = receiver;
    if (activeSid !== sid || !receiveMessage) return;
    const raw = encodeEnvelope({
      jsb: '1.0',
      meta: { sid },
      rpc: {
        jsonrpc: '2.0',
        method: CANCEL_METHOD,
        params: { requestId: id, ...(reason === undefined ? {} : { reason }) },
      },
    });
    if (!exceedsMessageLimit(raw) && activeSid === sid && receiver === receiveMessage) {
      receiveMessage(raw);
    }
  }

  function reset(): void {
    activeSid = undefined;
    helloIds.clear();
    requestIds.clear();
    subscriptions.clear();
    cancelledIds.clear();
    registeredWebMethods.clear();
    for (const call of inflight.values()) {
      call.cancelled = true;
      call.controller.abort();
    }
    inflight.clear();
    const pendingReverse = [...reversePending.values()];
    reversePending.clear();
    for (const call of pendingReverse) {
      if (call.timer !== undefined) clearTimeout(call.timer);
      call.stopSignal?.();
      call.reject(new HostError(ErrorCode.Cancelled, 'Session invalidated'));
    }
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

  function checkAuthorization(
    request: AuthorizeRequest,
    rpcId: string,
    replySid: string | undefined,
    traceId: string | undefined,
  ): string | undefined {
    if (!aclPolicy && !authorizeHook) return;
    try {
      if (aclPolicy) {
        const decision = request.kind === 'method'
          ? aclPolicy.evaluate(request.caller, request.method)
          : aclPolicy.canHandshake(request.caller);
        if (!decision.allowed) {
          return failure(
            rpcId,
            decision.code,
            decision.message,
            { reason: decision.reason, method: request.method },
            replySid,
            traceId,
          );
        }
      }
      if (authorizeHook) {
        const verdict = authorizeHook(request);
        if (verdict === false) {
          return failure(
            rpcId,
            ErrorCode.PermissionDenied,
            'Permission denied',
            { reason: 'acl_denied', method: request.method },
            replySid,
            traceId,
          );
        }
        if (verdict && typeof verdict === 'object' && verdict.allowed === false) {
          return failure(
            rpcId,
            verdict.code,
            verdict.message,
            { reason: verdict.reason, method: request.method },
            replySid,
            traceId,
          );
        }
      }
    } catch {
      // Protocol §11.3 / SEC-ACL-ERROR-001: unexpected policy exceptions MUST abort dispatch
      // and return -32603 without leaking internal exception details.
      return failure(rpcId, ErrorCode.InternalError, 'Internal error', undefined, replySid, traceId);
    }
  }

  function negotiate(request: RpcRequest, caller: CallerContext, traceId?: string): string {
    const protocols = readProtocols(request.params);
    if (!protocols) return failure(request.id, ErrorCode.InvalidParams, 'Invalid handshake params', undefined, undefined, traceId);
    if (!protocols.includes(1)) {
      return failure(request.id, ErrorCode.UnsupportedProtocol, 'Unsupported protocol', { supported: [1] }, undefined, traceId);
    }
    activeSid ??= globalThis.crypto?.randomUUID?.() ?? `host-${++nextSession}`;
    const advertisedMethods: JsonObject = {};
    for (const [name, entry] of registry) {
      if (aclPolicy) {
        let allowed = false;
        try {
          allowed = aclPolicy.evaluate(caller, name, { consumeRateLimit: false }).allowed;
        } catch {
          allowed = false;
        }
        if (!allowed) continue;
      }
      advertisedMethods[name] = { versions: [...entry.versions] };
    }
    const features: string[] = [];
    if (supportsCancel) features.push('cancel');
    if (supportsCallbacks) features.push('callbacks');
    if (supportsReverse) features.push('reverse');
    if (supportsIframe) features.push('iframe');
    return success(
      request.id,
      {
        jsb: '1.0',
        sid: activeSid,
        host: hostInfo,
        capabilities: {
          methods: advertisedMethods,
          events: advertisedEvents,
          features,
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

  async function receive(raw: string, caller?: CallerContext): Promise<string | null> {
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
    if (!('method' in rpc)) {
      if (activeSid && meta?.sid === activeSid && typeof rpc.id === 'string') {
        const call = reversePending.get(rpc.id);
        if (call && call.sid === activeSid) {
          settleReverse(rpc.id);
          if ('error' in rpc) {
            call.reject(new HostError(rpc.error.code, rpc.error.message, rpc.error.data));
          } else {
            call.resolve(rpc.result);
          }
        }
      }
      return null;
    }
    if (!('id' in rpc)) {
      handleCancelNotification(envelope);
      return null;
    }

    const effectiveCaller: CallerContext = caller ?? defaultCaller ?? {};
    const traceId = typeof meta?.traceId === 'string' ? meta.traceId : undefined;
    const { name, explicitVersion } = parseMethod(rpc.method);
    const isHello = name === HELLO_METHOD && (explicitVersion === undefined || explicitVersion === 1);

    if (isHello) {
      if ((meta?.sid !== undefined && meta.sid !== activeSid) || helloIds.has(rpc.id)) return null;
      helloIds.add(rpc.id);
      if (meta?.timeout === 0) {
        return failure(rpc.id, ErrorCode.InvalidParams, 'Invalid request timeout', undefined, activeSid, traceId);
      }
      const authError = checkAuthorization(
        { kind: 'hello', method: HELLO_METHOD, caller: effectiveCaller },
        rpc.id,
        activeSid,
        traceId,
      );
      if (authError !== undefined) return authError;
      return negotiate(rpc, effectiveCaller, traceId);
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
      if (name === SUBSCRIBE_METHOD) {
        const authError = checkAuthorization(
          { kind: 'subscribe', method: name, sid: replySid, caller: effectiveCaller },
          rpc.id,
          replySid,
          traceId,
        );
        if (authError !== undefined) return authError;
      }
      return controlSubscription(name, rpc, replySid, traceId);
    }

    const isRegisterWebMethods =
      name === REGISTER_WEB_METHODS &&
      (explicitVersion === undefined || explicitVersion === 1);

    if (isRegisterWebMethods) {
      if (!supportsReverse) {
        return failure(rpc.id, ErrorCode.MethodNotFound, 'Method not found', undefined, replySid, traceId);
      }
      if (meta.timeout === 0) {
        return failure(rpc.id, ErrorCode.InvalidParams, 'Invalid request timeout', undefined, replySid, traceId);
      }
      const methods = readWebMethods(rpc.params);
      if (!methods) {
        return failure(rpc.id, ErrorCode.InvalidParams, 'Invalid web methods params', undefined, replySid, traceId);
      }
      const response = success(rpc.id, { registered: methods }, replySid, traceId);
      if (exceedsMessageLimit(response)) {
        return failure(rpc.id, ErrorCode.PayloadTooLarge, 'Payload too large', undefined, replySid, traceId);
      }
      registeredWebMethods.clear();
      for (const method of methods) registeredWebMethods.add(method);
      return response;
    }

    const authError = checkAuthorization(
      { kind: 'method', method: name, version: explicitVersion, sid: replySid, caller: effectiveCaller },
      rpc.id,
      replySid,
      traceId,
    );
    if (authError !== undefined) return authError;

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

    let nextSeq = 0;
    const emitProgress = (chunk?: JsonValue): boolean => {
      const receiveMessage = receiver;
      if (
        !supportsCallbacks ||
        activeSid !== replySid ||
        call.cancelled ||
        inflight.get(rpc.id) !== call ||
        !receiveMessage
      ) {
        return false;
      }
      if (chunk !== undefined && !isPlainJsonValue(chunk, new Set())) return false;
      let progressRaw: string;
      try {
        progressRaw = encodeEnvelope({
          jsb: '1.0',
          meta: { sid: replySid },
          rpc: {
            jsonrpc: '2.0',
            method: 'bridge.progress',
            params: {
              requestId: rpc.id,
              seq: nextSeq,
              ...(chunk === undefined ? {} : { chunk }),
            },
          },
        });
      } catch {
        return false;
      }
      if (
        exceedsMessageLimit(progressRaw) ||
        receiver !== receiveMessage ||
        activeSid !== replySid ||
        call.cancelled ||
        inflight.get(rpc.id) !== call
      ) {
        return false;
      }
      nextSeq += 1;
      receiveMessage(progressRaw);
      return true;
    };

    try {
      const ctx: HostHandlerContext = {
        sid: replySid,
        id: rpc.id,
        method: name,
        version: resolvedVersion,
        ...(traceId === undefined ? {} : { traceId }),
        signal: controller.signal,
        callback: emitProgress,
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

  function callWeb<T = JsonValue>(
    method: string,
    params?: JsonObject,
    callOptions?: CallWebOptions,
  ): Promise<T> {
    if (!supportsReverse) {
      return Promise.reject(new HostError(ErrorCode.MethodNotFound, 'Reverse calls not enabled'));
    }
    const callSid = activeSid;
    const receiveMessage = receiver;
    if (!callSid || !receiveMessage) {
      return Promise.reject(new HostError(ErrorCode.Unavailable, 'Bridge unavailable'));
    }
    if (typeof method !== 'string' || !isWebMethodName(parseMethod(method).name)) {
      return Promise.reject(new HostError(ErrorCode.InvalidParams, 'Invalid web method name'));
    }
    if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
      return Promise.reject(new HostError(ErrorCode.InvalidParams, 'Params must be a JSON object'));
    }
    const timeout = callOptions?.timeout ?? limits.defaultTimeoutMs;
    if (!isPositiveSafeInteger(timeout)) {
      return Promise.reject(new HostError(ErrorCode.InvalidParams, 'Invalid call timeout'));
    }
    const traceId = callOptions?.traceId;
    if (traceId !== undefined && typeof traceId !== 'string') {
      return Promise.reject(new HostError(ErrorCode.InvalidParams, 'Invalid traceId'));
    }
    const signal = callOptions?.signal;
    if (signal?.aborted) {
      return Promise.reject(new HostError(ErrorCode.Cancelled, 'Reverse call cancelled'));
    }

    const id = `n-${++reverseCounter}`;
    const meta: JsonObject = {
      sid: callSid,
      ts: Date.now(),
      timeout,
      ...(traceId === undefined ? {} : { traceId }),
    };
    let raw: string;
    try {
      raw = encodeEnvelope({
        jsb: '1.0',
        meta,
        rpc: {
          jsonrpc: '2.0',
          id,
          method,
          ...(params === undefined ? {} : { params }),
        },
      });
    } catch {
      return Promise.reject(new HostError(ErrorCode.InvalidParams, 'Call could not be encoded'));
    }
    if (exceedsMessageLimit(raw)) {
      return Promise.reject(new HostError(ErrorCode.PayloadTooLarge, 'Payload too large'));
    }

    return new Promise<T>((resolve, reject) => {
      const entry: ReversePendingCall = {
        sid: callSid,
        resolve: (value) => resolve(value as T),
        reject,
      };
      entry.timer = setTimeout(() => {
        if (!settleReverse(id)) return;
        postReverseCancel(id, callSid, 'timeout');
        reject(new HostError(ErrorCode.Timeout, 'Reverse call timed out'));
      }, Math.min(timeout, 2_147_483_647));
      if (signal) {
        const onAbort = () => {
          if (!settleReverse(id)) return;
          postReverseCancel(id, callSid, 'abort');
          reject(new HostError(ErrorCode.Cancelled, 'Reverse call cancelled'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.stopSignal = () => signal.removeEventListener('abort', onAbort);
      }
      reversePending.set(id, entry);
      try {
        receiveMessage(raw);
      } catch {
        if (settleReverse(id)) {
          reject(new HostError(ErrorCode.Unavailable, 'Failed to deliver reverse call'));
        }
      }
    });
  }

  return {
    get sid() {
      return activeSid;
    },
    name: String(hostInfo.name),
    get webMethods(): ReadonlySet<string> {
      return registeredWebMethods;
    },
    receive,
    emit,
    callWeb,
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
