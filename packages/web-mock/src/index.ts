import {
  decodeEnvelope, encodeEnvelope, ErrorCode, WireDecodeError,
  type Envelope, type JsonObject, type JsonValue, type RpcRequest,
} from '../../protocol/src/index.js';

const echoMethod = 'conformance.echo';
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

/** A standalone Mock session exposed through the promise reply channel. */
export function createMockAdapter() {
  let sid: string | undefined;
  const seen = new Set<string>();

  function negotiate(request: RpcRequest): string {
    const protocols = readProtocols(request.params);
    if (!protocols) return failure(request.id, ErrorCode.InvalidParams, 'Invalid handshake params');
    if (!protocols.includes(1)) {
      return failure(request.id, ErrorCode.UnsupportedProtocol, 'Unsupported protocol', { supported: [1] });
    }
    sid ??= globalThis.crypto?.randomUUID?.() ?? `mock-${++nextSession}`;
    return success(request.id, {
      jsb: '1.0', sid, host: { platform: 'mock', name: 'mock', version: '0.1.0' },
      capabilities: { methods: { [echoMethod]: { versions: [1] } }, events: [], features: [] },
      limits,
    }, sid);
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
    if (!('method' in rpc) || !('id' in rpc) || seen.has(rpc.id)) return null;
    if (rpc.method === 'bridge.hello') {
      if (meta?.sid !== undefined && meta.sid !== sid) return null;
      seen.add(rpc.id);
      return negotiate(rpc);
    }
    if (!sid || meta?.sid !== sid) return null;
    seen.add(rpc.id);

    if (rpc.method === echoMethod || rpc.method === `${echoMethod}@1`) {
      const response = success(rpc.id, rpc.params ?? {}, sid);
      if (exceedsMessageLimit(response)) {
        return failure(rpc.id, ErrorCode.PayloadTooLarge, 'Payload too large', undefined, sid);
      }
      return response;
    }
    return failure(rpc.id, ErrorCode.MethodNotFound, 'Method not found', undefined, sid);
  }

  return {
    name: 'mock',
    send,
    listen(_onMessage: (raw: string) => void): () => void { return () => {}; },
  };
}

type FrameDirection = 'request' | 'response';

/** Installs a Mock Host Shim on the current browser window when its transport slot is free. */
export function installMockTransport(options?: {
  onFrame?: (direction: FrameDirection, raw: string | null) => void;
}): void {
  if (typeof window === 'undefined' || '__OJSB_TRANSPORT__' in window) return;

  const target = window;
  const adapter = createMockAdapter();
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

  Object.defineProperty(target, '__OJSB_TRANSPORT__', {
    value: transport,
    writable: false,
    configurable: false,
  });
  target.dispatchEvent(new CustomEvent('ojsb:transportready'));
}
