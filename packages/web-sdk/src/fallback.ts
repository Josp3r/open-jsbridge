import {
  decodeEnvelope, encodeEnvelope, ErrorCode,
  type JsonObject, type JsonValue,
} from '../../protocol/src/index.js';
import { BridgeError } from './errors.js';
import type { Adapter } from './transport.js';

export type PolyfillHandler = (
  params: JsonObject | undefined,
) => JsonValue | void | Promise<JsonValue | void>;

export interface BrowserFallbackOptions {
  polyfills?: Record<string, PolyfillHandler>;
}

const versionSuffix = /@([1-9][0-9]*)$/;
let nextFallbackSession = 0;

/**
 * Browser fallback adapter for running outside native WebViews (docs/web-sdk.md §3).
 * Advertises only the registered polyfills so `bridge.has()` stays accurate.
 */
export class BrowserFallbackAdapter implements Adapter {
  readonly name = 'browser-fallback';
  readonly protocols = [1] as const;
  private readonly polyfills = new Map<string, PolyfillHandler>();
  private sid: string | undefined;

  constructor(options: BrowserFallbackOptions = {}) {
    if (options.polyfills) {
      for (const [method, handler] of Object.entries(options.polyfills)) {
        if (typeof handler === 'function') {
          this.polyfills.set(method.replace(versionSuffix, ''), handler);
        }
      }
    }
  }

  async send(raw: string): Promise<string | null> {
    let envelope;
    try { envelope = decodeEnvelope(raw); } catch { return null; }
    const { rpc, meta } = envelope;
    if (!('method' in rpc) || !('id' in rpc)) return null;
    const base = rpc.method.replace(versionSuffix, '');
    if (base === 'bridge.hello') {
      const sid = (this.sid ??= `fallback-${++nextFallbackSession}`);
      const methods: JsonObject = {};
      for (const method of this.polyfills.keys()) methods[method] = { versions: [1] };
      return encodeEnvelope({
        jsb: '1.0', meta: { sid },
        rpc: {
          jsonrpc: '2.0', id: rpc.id,
          result: {
            jsb: '1.0', sid,
            host: { platform: 'browser', name: this.name, version: '1.0.0' },
            capabilities: { methods, events: [], features: [] },
            limits: { maxMessageBytes: 1_048_576, maxInflight: 64, defaultTimeoutMs: 15_000 },
          },
        },
      });
    }
    const sid = this.sid;
    if (!sid || meta?.sid !== sid) return null;
    const handler = this.polyfills.get(base);
    if (!handler) {
      return encodeEnvelope({
        jsb: '1.0', meta: { sid },
        rpc: { jsonrpc: '2.0', id: rpc.id, error: { code: ErrorCode.MethodNotFound, message: 'Method not found' } },
      });
    }
    try {
      const result = await handler(rpc.params);
      if (this.sid !== sid) return null;
      return encodeEnvelope({
        jsb: '1.0', meta: { sid },
        rpc: { jsonrpc: '2.0', id: rpc.id, result: result === undefined ? null : result },
      });
    } catch (error) {
      if (this.sid !== sid) return null;
      const err = error instanceof BridgeError
        ? { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
        : { code: ErrorCode.InternalError, message: 'Internal error' };
      return encodeEnvelope({ jsb: '1.0', meta: { sid }, rpc: { jsonrpc: '2.0', id: rpc.id, error: err } });
    }
  }

  listen(_onMessage: (raw: string) => void): () => void {
    return () => { this.sid = undefined; };
  }
}
