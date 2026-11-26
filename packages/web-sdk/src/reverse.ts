import {
  encodeEnvelope, ErrorCode,
  type Envelope, type JsonObject, type JsonValue, type RpcRequest,
} from '../../protocol/src/index.js';
import type { Bridge } from './bridge.js';
import { BridgeError } from './errors.js';
import { reverseHooks, reverseTransports } from './reverse-slot.js';
import type { Session } from './session.js';

export type WebHandler<P = JsonObject | undefined, R = JsonValue | void> = (
  params: P,
  ctx: { signal: AbortSignal },
) => R | Promise<R>;

export interface ReverseHandlers {
  handle<P = JsonObject | undefined, R = JsonValue | void>(method: string, fn: WebHandler<P, R>): () => void;
  methods(): string[];
}

const versionSuffix = /@([1-9][0-9]*)$/;
const qualifiedName = /^(?!rpc\.|bridge\.|ojsb\.)[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const utf8 = new TextEncoder();

function exceedsLimit(raw: string, maxBytes: number): boolean {
  return raw.length > maxBytes || utf8.encode(raw).byteLength > maxBytes;
}

/**
 * Attaches Host -> Web reverse-call handler support (protocol §9.2) to a Bridge instance.
 * Exported from `@open-jsbridge/web/reverse` so pages that do not need reverse calls pay zero bytes.
 */
export function createReverseHandlers(bridge: Bridge): ReverseHandlers {
  const transport = reverseTransports.get(bridge);
  if (!transport) throw new TypeError('Expected a Bridge instance created by createBridge()');
  if (reverseHooks.has(bridge)) {
    throw new Error('Reverse handlers are already attached to this Bridge instance');
  }

  const handlers = new Map<string, WebHandler>();
  const inboundCalls = new Map<string, AbortController>();
  const inboundIds = new Set<string>();

  function syncWebMethods(session = transport?.session()): void {
    if (!transport || !session?.features.includes('reverse')) return;
    const raw = encodeEnvelope({
      jsb: '1.0',
      meta: { sid: session.sid },
      rpc: {
        jsonrpc: '2.0',
        id: transport.nextId(),
        method: 'bridge.registerWebMethods',
        params: { methods: [...handlers.keys()] },
      },
    });
    if (!exceedsLimit(raw, session.maxMessageBytes)) transport.post(raw);
  }

  function reply(session: Session, rpc: Envelope['rpc']): void {
    if (!transport || transport.session() !== session) return;
    let raw: string;
    try {
      raw = encodeEnvelope({ jsb: '1.0', meta: { sid: session.sid }, rpc });
    } catch {
      if ('id' in rpc && typeof rpc.id === 'string') {
        reply(session, {
          jsonrpc: '2.0', id: rpc.id, error: { code: ErrorCode.InternalError, message: 'Internal error' },
        });
      }
      return;
    }
    if (exceedsLimit(raw, session.maxMessageBytes) && 'id' in rpc && typeof rpc.id === 'string' && !('error' in rpc)) {
      reply(session, {
        jsonrpc: '2.0', id: rpc.id, error: { code: ErrorCode.PayloadTooLarge, message: 'Payload too large' },
      });
      return;
    }
    transport.post(raw);
  }

  reverseHooks.set(bridge, {
    onReady(session) {
      if (handlers.size > 0) syncWebMethods(session);
    },
    onInvalidate() {
      for (const controller of inboundCalls.values()) controller.abort();
      inboundCalls.clear();
      inboundIds.clear();
    },
    onCancel(requestId) {
      inboundCalls.get(requestId)?.abort();
    },
    onRequest(rpc: RpcRequest, session: Session) {
      if (inboundIds.has(rpc.id)) return;
      inboundIds.add(rpc.id);
      const handler = handlers.get(rpc.method) ?? handlers.get(rpc.method.replace(versionSuffix, ''));
      if (!handler) {
        reply(session, {
          jsonrpc: '2.0', id: rpc.id, error: { code: ErrorCode.MethodNotFound, message: 'Method not found' },
        });
        return;
      }
      const controller = new AbortController();
      inboundCalls.set(rpc.id, controller);
      void Promise.resolve()
        .then(() => handler(rpc.params, { signal: controller.signal }))
        .then(
          (result) => {
            inboundCalls.delete(rpc.id);
            if (controller.signal.aborted) {
              reply(session, {
                jsonrpc: '2.0', id: rpc.id, error: { code: ErrorCode.Cancelled, message: 'Cancelled' },
              });
            } else {
              reply(session, {
                jsonrpc: '2.0', id: rpc.id, result: result === undefined ? null : result,
              });
            }
          },
          (error) => {
            inboundCalls.delete(rpc.id);
            const err = controller.signal.aborted
              ? { code: ErrorCode.Cancelled, message: 'Cancelled' }
              : error instanceof BridgeError
                ? { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
                : { code: ErrorCode.InternalError, message: 'Internal error' };
            reply(session, { jsonrpc: '2.0', id: rpc.id, error: err });
          },
        );
    },
  });

  return {
    handle<P = JsonObject | undefined, R = JsonValue | void>(method: string, fn: WebHandler<P, R>): () => void {
      if (typeof method !== 'string' || !qualifiedName.test(method)) {
        throw new TypeError(`Invalid web handler method "${String(method)}"`);
      }
      if (typeof fn !== 'function') {
        throw new TypeError('Expected a handler function');
      }
      const handler = fn as unknown as WebHandler;
      handlers.set(method, handler);
      syncWebMethods();
      return () => {
        if (handlers.get(method) !== handler) return;
        handlers.delete(method);
        syncWebMethods();
      };
    },
    methods() {
      return [...handlers.keys()];
    },
  };
}
