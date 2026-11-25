import {
  decodeEnvelope, encodeEnvelope, ErrorCode,
  type Envelope, type JsonObject, type JsonValue, type RpcRequest,
} from '../../protocol/src/index.js';
import { BridgeError } from './errors.js';
import { EventSubscriptions, hasSessionEvent, type EventControl, type EventListener, type EventSubscription, type StandardEvents } from './events.js';
import { isObject, readSession, type HostInfo, type Session } from './session.js';
import { findBrowserAdapter, type Adapter } from './transport.js';

export { BridgeError, ErrorCode };
export type { EventListener, EventSubscription, StandardEvents };
export type { Adapter, HostInfo };

export type BridgeState = 'idle' | 'connecting' | 'ready' | 'unavailable';

export interface BridgeOptions {
  adapter?: Adapter;
  handshakeTimeout?: number;
  queueLimit?: number;
}

export interface CallOptions {
  timeout?: number;
  signal?: AbortSignal;
  traceId?: string;
  version?: number;
}

export interface Bridge {
  readonly state: BridgeState;
  readonly host: HostInfo | undefined;
  ready(): Promise<HostInfo>;
  reconnect(): Promise<HostInfo>;
  has(method: string, version?: number): boolean;
  call<T = unknown>(method: string, params?: JsonObject, options?: CallOptions): Promise<T>;
  hasEvent(name: string): boolean;
  on<E extends keyof StandardEvents>(name: E, listener: EventListener<StandardEvents[E]>): EventSubscription;
  on<T = unknown>(name: string, listener: EventListener<T>): EventSubscription;
  off<E extends keyof StandardEvents>(name: E, listener?: EventListener<StandardEvents[E]>): void;
  off<T = unknown>(name: string, listener?: EventListener<T>): void;
}

interface PendingCall {
  request: RpcRequest;
  eventControl: boolean;
  traceId: string | undefined;
  deadline: number | undefined;
  onDispatch: (() => void) | undefined;
  session?: Session;
  stopTimer?: () => void;
  stopListening?: () => void;
  resolve: (result: JsonValue) => void;
  reject: (error: BridgeError) => void;
}

interface HelloAttempt {
  id: string;
  deadline: number;
  resolve: (session: Session) => void;
  reject: (error: BridgeError) => void;
}

const versionSuffix = /@([1-9][0-9]*)$/;
const timerLimit = 2_147_483_647;
let bridgeCount = 0;

function exceedsMessageLimit(raw: string, maxMessageBytes: number): boolean {
  return raw.length > maxMessageBytes || new TextEncoder().encode(raw).byteLength > maxMessageBytes;
}

function atDeadline(deadline: number, expire: () => void): () => void {
  const check = () => {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) expire();
    else timer = setTimeout(check, Math.min(remaining, timerLimit));
  };
  let timer = setTimeout(check, Math.max(0, Math.min(Math.ceil(deadline - performance.now()), timerLimit)));
  return () => clearTimeout(timer);
}

class WebBridge implements Bridge {
  private currentState: BridgeState = 'idle';
  private connection: Promise<HostInfo> | undefined;
  private lifetime: AbortController | undefined;
  private lifecycleBound = false;
  private suspended = false;
  private adapter: Adapter | undefined;
  private unlisten: (() => void) | undefined;
  private session: Session | undefined;
  private hello: HelloAttempt | undefined;
  private readonly pending = new Map<string, PendingCall>();
  private readonly cancelReceipts = new Set<() => void>();
  private draining = false;
  private readonly events = new EventSubscriptions(
    (method, params, control) => this.request(method, params, {}, control),
    () => this.connectForEvents(),
  );
  private readonly idPrefix = `w-${++bridgeCount}-${Math.random().toString(36).slice(2, 8)}`;
  private nextId = 0;

  constructor(
    private readonly options: BridgeOptions,
    private readonly handshakeTimeout: number,
    private readonly queueLimit: number,
  ) {}

  get state(): BridgeState { return this.currentState; }
  get host(): HostInfo | undefined { return this.session?.host; }

  ready(): Promise<HostInfo> {
    if (this.suspended) return Promise.reject(new BridgeError(ErrorCode.Unavailable, 'Bridge unavailable'));
    if (!this.connection) {
      this.bindBrowserLifecycle();
      const lifetime = new AbortController();
      this.lifetime = lifetime;
      this.connection = this.connect(lifetime.signal);
    }
    return this.connection;
  }

  reconnect(): Promise<HostInfo> {
    if (!this.suspended && this.currentState === 'unavailable') {
      this.lifetime?.abort();
      this.connection = undefined;
    }
    return this.ready();
  }

  has(method: string, version?: number): boolean {
    if (typeof method !== 'string') return false;
    const base = method.replace(versionSuffix, '');
    const advertised = this.session?.methods.get(base);
    const suffix = versionSuffix.exec(method);
    if (!advertised || (suffix && version !== undefined && Number(suffix[1]) !== version)) return false;
    const requested = version ?? (suffix ? Number(suffix[1]) : undefined);
    return requested === undefined || advertised.has(requested);
  }

  hasEvent(name: string): boolean { return hasSessionEvent(this.session, name); }

  on<T = unknown>(name: string, listener: EventListener<T>): EventSubscription {
    return this.events.on(name, listener);
  }

  off<T = unknown>(name: string, listener?: EventListener<T>): void { this.events.off(name, listener); }

  call<T = unknown>(method: string, params?: JsonObject, options: CallOptions = {}): Promise<T> {
    return this.request(method, params, options);
  }

  private request<T>(
    method: string,
    params: JsonObject | undefined,
    options: CallOptions,
    control?: EventControl,
  ): Promise<T> {
    const { signal, traceId, version } = options;
    if (typeof method !== 'string') {
      return Promise.reject(new BridgeError(ErrorCode.InvalidParams, 'Expected a string method', { traceId }));
    }
    const context = { method, traceId };
    if (signal?.aborted) return Promise.reject(new BridgeError(ErrorCode.Cancelled, 'Call cancelled', context));
    if (this.state === 'unavailable') {
      return Promise.reject(new BridgeError(ErrorCode.Unavailable, 'Bridge unavailable', context));
    }
    if (params !== undefined && !isObject(params)) {
      return Promise.reject(new BridgeError(ErrorCode.InvalidParams, 'Expected object params', context));
    }
    const suffix = versionSuffix.exec(method);
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1 ||
        (suffix && Number(suffix[1]) !== version))) {
      return Promise.reject(new BridgeError(ErrorCode.InvalidParams, 'Invalid method version', context));
    }
    const timeout = options.timeout ?? this.session?.defaultTimeout ?? 15_000;
    if (!Number.isSafeInteger(timeout) || timeout <= 0) {
      return Promise.reject(new BridgeError(ErrorCode.InvalidParams, 'Expected a positive timeout', context));
    }
    const wireMethod = version === undefined || suffix ? method : `${method}@${version}`;
    const eventControl = control !== undefined;
    const waitForSlot = control?.waitForSlot === true;
    const session = this.session;
    if (session) {
      const error = this.unsupportedMethod(wireMethod, eventControl, traceId);
      if (error) return Promise.reject(error);
    }
    // Event maintenance must eventually run even when the waiting queue is full.
    const capacity = (session?.maxInflight ?? 0) - this.cancelReceipts.size;
    if (!waitForSlot && this.pending.size - capacity >= this.queueLimit) {
      return Promise.reject(new BridgeError(ErrorCode.NotReady, 'Pending call queue is full', context));
    }

    const id = this.createId();
    const request: RpcRequest = {
      jsonrpc: '2.0', id, method: wireMethod, ...(params === undefined ? {} : { params }),
    };
    const deadline = waitForSlot ? undefined : performance.now() + timeout;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingCall = {
        request, traceId, deadline, eventControl, onDispatch: control?.onDispatch, reject,
        resolve: (value) => {
          control?.onReply(value);
          resolve(value as T);
        },
      };
      this.pending.set(id, pending);
      if (deadline !== undefined) this.startTimeout(pending, deadline);
      if (signal) {
        const abort = () => this.fail(id, ErrorCode.Cancelled, 'Call cancelled', true);
        signal.addEventListener('abort', abort, { once: true });
        pending.stopListening = () => signal.removeEventListener('abort', abort);
      }
      if (this.session) this.drain();
      else void this.ready().catch(() => {});
    });
  }

  private connectForEvents(): void {
    if (this.suspended) return;
    if (this.state === 'unavailable') {
      this.events.rejectWaiting(new BridgeError(ErrorCode.Unavailable, 'Bridge unavailable'));
    } else void this.ready().catch(() => {});
  }

  private createId(): string { return `${this.idPrefix}-${++this.nextId}`; }

  private bindBrowserLifecycle(): void {
    if (this.lifecycleBound || typeof window === 'undefined') return;
    this.lifecycleBound = true;
    window.addEventListener('pagehide', () => this.invalidate());
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return;
      this.invalidate();
      this.suspended = false;
      void this.ready().catch(() => {});
    });
  }

  private invalidate(): void {
    this.suspended = true;
    this.currentState = 'unavailable';
    this.session = undefined;
    this.connection = undefined;
    this.events.reset();
    this.lifetime?.abort();
    this.lifetime = undefined;
    const hello = this.hello;
    this.hello = undefined;
    hello?.reject(new BridgeError(ErrorCode.Cancelled, 'Handshake cancelled'));
    for (const id of this.pending.keys()) this.fail(id, ErrorCode.Cancelled, 'Page hidden');
    this.detach();
  }

  private detach(): void {
    for (const release of this.cancelReceipts) release();
    const unlisten = this.unlisten;
    this.unlisten = undefined;
    this.adapter = undefined;
    try { unlisten?.(); } catch { /* Pending calls have already been retired. */ }
  }

  private async connect(signal: AbortSignal): Promise<HostInfo> {
    this.currentState = 'connecting';
    const requireActive = () => {
      if (signal.aborted) throw new BridgeError(ErrorCode.Cancelled, 'Handshake cancelled');
    };
    try {
      const adapter = await (this.options.adapter ?? findBrowserAdapter(this.handshakeTimeout, signal));
      requireActive();
      if (!adapter || adapter.detect?.() === false) throw new BridgeError(ErrorCode.Unavailable, 'No transport');
      if (adapter.protocols && !adapter.protocols.includes(1)) {
        throw new BridgeError(ErrorCode.UnsupportedProtocol, 'Unsupported protocol', {
          data: { supported: [...adapter.protocols] },
        });
      }
      const unlisten = adapter.listen((raw) => {
        if (!signal.aborted) this.receive(raw);
      });
      if (signal.aborted) unlisten();
      requireActive();
      this.adapter = adapter;
      this.unlisten = unlisten;
      let session: Session;
      try {
        session = await this.handshake();
      } catch (error) {
        requireActive();
        if (!(error instanceof BridgeError) || error.code !== ErrorCode.Timeout) throw error;
        session = await this.handshake();
      }
      requireActive();
      this.session = session;
      this.currentState = 'ready';
      for (const call of this.pending.values()) {
        const { request: { id, method }, deadline, eventControl, traceId } = call;
        const error = deadline !== undefined && performance.now() >= deadline
          ? new BridgeError(ErrorCode.Timeout, 'Call timed out', { method, traceId })
          : this.unsupportedMethod(method, eventControl, traceId);
        if (error) this.take(id)?.reject(error);
      }
      this.drain();
      requireActive();
      this.events.start(session);
      requireActive();
      return session.host;
    } catch (error) {
      if (signal.aborted) throw new BridgeError(ErrorCode.Cancelled, 'Handshake cancelled');
      this.currentState = 'unavailable';
      this.session = undefined;
      for (const id of this.pending.keys()) this.fail(id, ErrorCode.Unavailable, 'Bridge unavailable');
      this.detach();
      const failure = error instanceof BridgeError ? error : new BridgeError(ErrorCode.Unavailable, 'Transport unavailable');
      this.events.rejectWaiting(failure);
      throw failure;
    }
  }

  private async handshake(): Promise<Session> {
    const id = this.createId();
    const deadline = performance.now() + this.handshakeTimeout;
    const request = encodeEnvelope({
      jsb: '1.0',
      rpc: { jsonrpc: '2.0', id, method: 'bridge.hello', params: {
        protocols: [1], sdk: { name: 'open-jsbridge', version: '0.1.0' }, wants: ['cancel', 'events', 'blob'],
      } },
    });
    const stopTimer = atDeadline(deadline, () => {
      if (this.hello?.id === id) this.hello.reject(new BridgeError(ErrorCode.Timeout, 'Handshake timed out'));
    });
    try {
      return await new Promise<Session>((resolve, reject) => {
        this.hello = { id, deadline, resolve, reject };
        this.post(request, id, () => reject(new BridgeError(ErrorCode.Unavailable, 'Handshake failed to send')));
      });
    } finally {
      if (this.hello?.id === id) this.hello = undefined;
      stopTimer();
    }
  }

  private drain(): void {
    const session = this.session;
    if (!session || this.draining || session.inflight >= session.maxInflight) return;
    // Adapters can synchronously deliver a response while send() is on the stack.
    this.draining = true;
    try {
      for (const call of this.pending.values()) {
        if (this.session !== session || session.inflight >= session.maxInflight) break;
        if (!call.session) this.dispatch(call, session);
      }
    } finally {
      this.draining = false;
    }
  }

  private unsupportedMethod(method: string, eventControl: boolean, traceId: string | undefined): BridgeError | undefined {
    if (eventControl && (method === 'bridge.subscribe' || method === 'bridge.unsubscribe')) return;
    if (this.has(method)) return;
    const reason = this.has(method.replace(versionSuffix, '')) ? 'version_unsupported' : 'method_not_found';
    return new BridgeError(ErrorCode.MethodNotFound, 'Method not available', { method, traceId, data: { reason } });
  }

  private dispatch(pending: PendingCall, session: Session): void {
    const { request, traceId } = pending;
    const now = performance.now();
    const deadline = pending.deadline ?? now + session.defaultTimeout;
    const timeout = Math.ceil(deadline - now);
    if (timeout <= 0) return this.fail(request.id, ErrorCode.Timeout, 'Call timed out');

    let raw: string;
    try {
      raw = encodeEnvelope({
        jsb: '1.0', rpc: request,
        meta: { sid: session.sid, ts: Date.now(), timeout, ...(traceId === undefined ? {} : { traceId }) },
      });
    } catch {
      this.fail(request.id, ErrorCode.InvalidParams, 'Call could not be encoded');
      return;
    }
    if (!this.pending.has(request.id)) return;
    if (exceedsMessageLimit(raw, session.maxMessageBytes)) {
      this.fail(request.id, ErrorCode.PayloadTooLarge, 'Call exceeds the negotiated byte limit');
      return;
    }
    if (performance.now() >= deadline) {
      this.fail(request.id, ErrorCode.Timeout, 'Call timed out');
      return;
    }
    if (pending.deadline === undefined) this.startTimeout(pending, deadline);
    pending.session = session;
    session.inflight++;
    pending.onDispatch?.();
    this.post(raw, request.id, () => this.fail(request.id, ErrorCode.Unavailable, 'Call failed to send'));
  }

  private startTimeout(pending: PendingCall, deadline: number): void {
    pending.deadline = deadline;
    pending.stopTimer = atDeadline(deadline, () => this.fail(pending.request.id, ErrorCode.Timeout, 'Call timed out', true));
  }

  private post(raw: string, id?: string, onFailure: () => void = () => {}): void | Promise<string | null> {
    const signal = this.lifetime?.signal;
    try {
      const response = this.adapter?.send(raw);
      if (response) void response.then((reply) => {
        if (!signal?.aborted && reply !== null && id !== undefined) this.receive(reply, id);
      }, onFailure);
      return response;
    } catch {
      onFailure();
    }
  }

  private postCancel(id: string, session: Session): void {
    const raw = encodeEnvelope({
      jsb: '1.0', meta: { sid: session.sid },
      rpc: { jsonrpc: '2.0', method: 'bridge.cancel', params: { requestId: id } },
    });
    let stopTimer: (() => void) | undefined;
    const release = () => {
      if (!this.cancelReceipts.delete(release)) return;
      stopTimer?.();
      session.inflight--;
      this.drain();
    };

    // Hold the slot while a WithReply transport has a cancel receipt outstanding.
    const deadline = performance.now() + session.defaultTimeout;
    this.cancelReceipts.add(release);
    session.inflight++;
    const receipt = this.post(raw);
    if (!receipt) {
      release();
      return;
    }
    if (this.cancelReceipts.has(release)) stopTimer = atDeadline(deadline, release);
    void receipt.then(release, release);
  }

  private receive(raw: string, replyId?: string): void {
    const activeSession = this.session;
    if (typeof raw !== 'string' || (activeSession && exceedsMessageLimit(raw, activeSession.maxMessageBytes))) return;
    let envelope: Envelope;
    try { envelope = decodeEnvelope(raw); } catch { return; }
    const { rpc, meta } = envelope;
    if ('method' in rpc) {
      if (replyId === undefined && rpc.method === 'bridge.event' && !('id' in rpc) &&
          activeSession && activeSession.sid === meta?.sid) this.events.deliver(rpc.params);
      return;
    }
    if (typeof rpc.id !== 'string' || (replyId !== undefined && replyId !== rpc.id)) return;
    const attempt = this.hello;
    if (attempt?.id === rpc.id) {
      if (performance.now() >= attempt.deadline) return;
      this.hello = undefined;
      if ('error' in rpc) {
        attempt.reject(new BridgeError(rpc.error.code, rpc.error.message, { data: rpc.error.data }));
      } else {
        const session = readSession(rpc.result, meta?.sid);
        if (session) attempt.resolve(session);
        else attempt.reject(new BridgeError(ErrorCode.InvalidRequest, 'Invalid handshake result'));
      }
      return;
    }

    if (!activeSession || activeSession.sid !== meta?.sid) return;
    const call = this.pending.get(rpc.id);
    if (call?.session !== activeSession) return;
    if (call.deadline !== undefined && performance.now() >= call.deadline) {
      this.fail(rpc.id, ErrorCode.Timeout, 'Call timed out', true);
      return;
    }
    this.take(rpc.id);
    if ('error' in rpc) {
      call.reject(new BridgeError(rpc.error.code, rpc.error.message, {
        data: rpc.error.data, method: call.request.method, traceId: call.traceId,
      }));
    } else call.resolve(rpc.result);
    this.drain();
  }

  private take(id: string): PendingCall | undefined {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    if (call.session) call.session.inflight--;
    call.stopTimer?.();
    call.stopListening?.();
    return call;
  }

  private fail(id: string, code: number, message: string, cancel = false): void {
    const call = this.take(id);
    if (!call) return;
    call.reject(new BridgeError(code, message, { method: call.request.method, traceId: call.traceId }));
    const session = call.session;
    if (cancel && session === this.session && session?.features.includes('cancel')) {
      this.postCancel(id, session);
    }
    this.drain();
  }
}

export function createBridge(options: BridgeOptions = {}): Bridge {
  const { handshakeTimeout = 3000, queueLimit = 100 } = options;
  if (!Number.isInteger(handshakeTimeout) || handshakeTimeout <= 0 || handshakeTimeout > timerLimit) {
    throw new RangeError('handshakeTimeout must be a positive timer interval');
  }
  if (!Number.isSafeInteger(queueLimit) || queueLimit < 0) throw new RangeError('Invalid queueLimit');
  return new WebBridge(options, handshakeTimeout, queueLimit);
}
