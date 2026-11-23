import { ErrorCode, type JsonObject, type JsonValue } from '../../protocol/src/index.js';
import { BridgeError } from './errors.js';
import { isObject, type Session } from './session.js';

export type EventListener<T = unknown> = (payload: T) => void;

export interface EventSubscription {
  (): void;
  readonly ready: Promise<void>;
}

interface Registration {
  disposer: EventSubscription;
  acknowledged: boolean;
  resolve: () => void;
  reject: (error: BridgeError) => void;
}

interface Subscription {
  listeners: Map<EventListener, Registration>;
  phase: 'idle' | 'subscribing' | 'subscribed' | 'unsubscribing';
}

type Request = (
  method: 'bridge.subscribe' | 'bridge.unsubscribe',
  params: JsonObject,
  onReply: (result: JsonValue) => void,
) => Promise<unknown>;

const eventNamePattern = /^(?!rpc\.)[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;

function isEventName(name: unknown): name is string {
  return typeof name === 'string' && eventNamePattern.test(name);
}

export function hasSessionEvent(session: Session | undefined, name: string): boolean {
  return isEventName(name) && session?.events.has(name) === true;
}

function register(dispose: () => void): Registration {
  let resolve!: () => void;
  let reject!: (error: BridgeError) => void;
  const ready = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  void ready.catch(() => {}); // Callback-only callers can ignore readiness.
  const disposer = Object.defineProperty(dispose, 'ready', { value: ready }) as EventSubscription;
  return { disposer, acknowledged: false, resolve, reject };
}

function subscribeError(result: JsonValue, name: string): BridgeError | undefined {
  const context = { method: 'bridge.subscribe', data: { event: name } };
  if (isObject(result) && Array.isArray(result.subscribed) && Array.isArray(result.denied)) {
    const { subscribed, denied } = result;
    if (subscribed.length === 1 && subscribed[0] === name && denied.length === 0) return;
    if (denied.length === 1 && denied[0] === name && subscribed.length === 0) {
      return new BridgeError(ErrorCode.PermissionDenied, 'Event subscription denied', context);
    }
  }
  return new BridgeError(ErrorCode.InvalidRequest, 'Invalid event subscription acknowledgement', context);
}

export class EventSubscriptions {
  private readonly subscriptions = new Map<string, Subscription>();
  private session: Session | undefined;

  constructor(
    private readonly request: Request,
    private readonly connect: () => void,
  ) {}

  on<T>(name: string, listener: EventListener<T>): EventSubscription {
    if (!isEventName(name) || typeof listener !== 'function') {
      const invalid = register(() => {});
      invalid.reject(new BridgeError(ErrorCode.InvalidParams, 'Expected a qualified event name and a listener'));
      return invalid.disposer;
    }
    const callback = listener as EventListener;
    let subscription = this.subscriptions.get(name);
    if (!subscription) {
      subscription = { listeners: new Map(), phase: 'idle' };
      this.subscriptions.set(name, subscription);
    }
    const { listeners } = subscription;
    let registration = listeners.get(callback);
    if (!registration) {
      registration = register(() => {
        if (listeners.get(callback) === registration) this.off(name, callback);
      });
      listeners.set(callback, registration);
    }

    if (this.session) this.reconcile(name, subscription);
    else this.connect();
    return registration.disposer;
  }

  off<T>(name: string, listener?: EventListener<T>): void {
    const subscription = this.subscriptions.get(name);
    if (!subscription) return;
    const { listeners } = subscription;
    const remove = (callback: EventListener) => {
      const registration = listeners.get(callback);
      if (!registration) return;
      listeners.delete(callback);
      if (!registration.acknowledged) {
        registration.reject(new BridgeError(ErrorCode.Cancelled, 'Event subscription cancelled'));
      }
    };
    if (listener === undefined) {
      for (const callback of listeners.keys()) remove(callback);
    } else remove(listener as EventListener);
    this.reconcile(name, subscription);
  }

  start(session: Session): void {
    this.session = session;
    for (const [name, subscription] of this.subscriptions) this.reconcile(name, subscription);
  }

  reset(): void {
    this.session = undefined;
    for (const [name, subscription] of this.subscriptions) {
      subscription.phase = 'idle';
      if (subscription.listeners.size === 0) this.subscriptions.delete(name);
    }
  }

  rejectWaiting(error: BridgeError): void {
    for (const [name, subscription] of this.subscriptions) this.rejectListeners(name, subscription, error);
  }

  deliver(params: JsonObject | undefined): void {
    if (!params || !isEventName(params.name) || !Object.prototype.hasOwnProperty.call(params, 'payload')) return;
    const subscription = this.subscriptions.get(params.name);
    if (subscription?.phase !== 'subscribed') return;
    const { session } = this;
    const { listeners } = subscription;
    for (const [callback, registration] of [...listeners]) {
      if (this.session !== session || subscription.phase !== 'subscribed') break;
      if (listeners.get(callback) !== registration) continue;
      try { callback(params.payload); }
      catch (error) { queueMicrotask(() => { throw error; }); }
    }
  }

  private rejectListeners(name: string, subscription: Subscription, error: BridgeError): void {
    for (const [callback, registration] of subscription.listeners) {
      if (registration.acknowledged) continue;
      subscription.listeners.delete(callback);
      registration.reject(error);
    }
    if (subscription.listeners.size === 0 && subscription.phase === 'idle') this.subscriptions.delete(name);
  }

  private reconcile(name: string, subscription: Subscription): void {
    const { session } = this;
    const { listeners, phase } = subscription;
    // Serialize controls for the same event, including removal during a subscribe.
    if (phase === 'subscribing' || phase === 'unsubscribing') return;
    if (listeners.size === 0) {
      if (phase === 'subscribed' && session) this.unsubscribe(name, subscription, session);
      else this.subscriptions.delete(name);
      return;
    }
    if (!session) return;
    if (phase === 'subscribed') {
      for (const registration of listeners.values()) {
        registration.acknowledged = true;
        registration.resolve();
      }
      return;
    }
    if (!session.events.has(name)) {
      this.rejectListeners(name, subscription, new BridgeError(ErrorCode.MethodNotFound, 'Event not available', {
        method: 'bridge.subscribe', data: { event: name },
      }));
      return;
    }

    subscription.phase = 'subscribing';
    const fail = (error: BridgeError, cleanup: boolean) => {
      if (this.session !== session) return;
      if (!cleanup) subscription.phase = 'idle';
      this.rejectListeners(name, subscription, error);
      // An ambiguous outcome may have installed the remote subscription.
      if (cleanup) this.unsubscribe(name, subscription, session);
    };
    void this.request('bridge.subscribe', { events: [name] }, (result) => {
      if (this.session !== session) return;
      const error = subscribeError(result, name);
      if (error) { fail(error, error.code === ErrorCode.InvalidRequest); return; }
      subscription.phase = 'subscribed';
      this.reconcile(name, subscription);
    }).catch((error: BridgeError) => fail(error, error.code === ErrorCode.Timeout));
  }

  private unsubscribe(name: string, subscription: Subscription, session: Session): void {
    subscription.phase = 'unsubscribing';
    const finish = (error?: BridgeError) => {
      if (this.session !== session) return;
      subscription.phase = 'idle';
      if (error) {
        this.rejectListeners(name, subscription, error);
        return;
      }
      const { listeners } = subscription;
      // Retained listeners alone must not cause a failed resubscribe to loop.
      if (listeners.size === 0 || [...listeners.values()].some((registration) => !registration.acknowledged)) {
        this.reconcile(name, subscription);
      }
    };
    void this.request('bridge.unsubscribe', { events: [name] }, (result) => {
      const names = isObject(result) ? result.unsubscribed : undefined;
      if (Array.isArray(names) && names.length === 1 && names[0] === name) finish();
      else finish(new BridgeError(ErrorCode.InvalidRequest, 'Invalid event unsubscription acknowledgement', {
        method: 'bridge.unsubscribe', data: { event: name },
      }));
    }).catch(finish);
  }
}
