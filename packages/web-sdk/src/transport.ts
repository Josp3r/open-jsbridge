export interface Adapter {
  readonly name?: string;
  readonly protocols?: readonly number[];
  detect?(): boolean;
  send(raw: string): void | Promise<string | null>;
  listen(onMessage: (raw: string) => void): () => void;
}

interface OJSBTransport {
  readonly name: string;
  readonly protocols: readonly number[];
  postMessage(raw: string): void | Promise<string | null>;
}

declare global {
  interface Window {
    __OJSB_TRANSPORT__?: Readonly<OJSBTransport>;
    __OJSB_RECEIVE__?: (raw: string) => void;
  }
}

const receivers = new WeakMap<Window, (raw: string) => void>();

export function findBrowserAdapter(timeout: number, signal: AbortSignal): Promise<Adapter | undefined> {
  if (typeof window === 'undefined' || signal.aborted) return Promise.resolve(undefined);
  const target = window;

  const detect = (): Adapter | undefined => {
    const transport = target.__OJSB_TRANSPORT__;
    if (typeof transport?.postMessage !== 'function') return;
    return {
      name: transport.name,
      protocols: transport.protocols,
      send: (raw) => transport.postMessage(raw),
      listen(onMessage) {
        if (receivers.has(target)) throw new Error('The injected shim already has a receiver');
        receivers.set(target, onMessage);
        try {
          target.__OJSB_RECEIVE__ = onMessage;
        } catch (error) {
          receivers.delete(target);
          throw error;
        }
        return () => {
          // Native shims expose a forwarding getter, so ownership is tracked independently.
          if (receivers.get(target) !== onMessage) return;
          receivers.delete(target);
          target.__OJSB_RECEIVE__ = undefined;
        };
      },
    };
  };

  const existing = detect();
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const finish = (adapter?: Adapter) => {
      clearTimeout(timer);
      target.removeEventListener('ojsb:transportready', onReady);
      signal.removeEventListener('abort', onAbort);
      resolve(adapter);
    };
    const onAbort = () => finish();
    const onReady = () => {
      const adapter = detect();
      if (adapter) finish(adapter);
    };
    const timer = setTimeout(finish, timeout);
    target.addEventListener('ojsb:transportready', onReady);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
