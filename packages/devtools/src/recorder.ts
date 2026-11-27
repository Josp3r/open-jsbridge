import type { Envelope, JsonObject, JsonValue } from '../../protocol/src/index.js';
import type { Bridge, BridgeMetric, BridgePlugin, BridgeState, HostInfo } from '../../web-sdk/src/index.js';

export type DevtoolsDirection = 'send' | 'receive';
export type DevtoolsMessageKind = 'request' | 'response' | 'error' | 'notification';

export interface DevtoolsEntry {
  readonly seq: number;
  readonly timestamp: number;
  readonly isoTime: string;
  readonly direction: DevtoolsDirection;
  readonly kind: DevtoolsMessageKind;
  readonly id?: string | null;
  readonly method?: string;
  readonly sid?: string;
  readonly traceId?: string;
  readonly bytes: number;
  readonly code?: number;
  readonly roundTripMs?: number;
  readonly hostHandlerMs?: number;
  readonly envelope: Envelope;
}

export interface DevtoolsCapabilitiesSnapshot {
  readonly methods: Readonly<Record<string, readonly number[]>>;
  readonly events: readonly string[];
  readonly features: readonly string[];
}

export interface DevtoolsLimitsSnapshot {
  readonly maxMessageBytes?: number;
  readonly maxInflight?: number;
  readonly defaultTimeoutMs?: number;
}

export interface DevtoolsSessionSnapshot {
  readonly state: BridgeState | 'unknown';
  readonly sid?: string;
  readonly host?: HostInfo;
  readonly capabilities?: DevtoolsCapabilitiesSnapshot;
  readonly limits?: DevtoolsLimitsSnapshot;
  readonly totalMessages: number;
  readonly totalErrors: number;
  readonly inflightCount: number;
}

export interface DevtoolsHarEntry {
  readonly startedDateTime: string;
  readonly time: number;
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly httpVersion: string;
    readonly headers: readonly { readonly name: string; readonly value: string }[];
    readonly bodySize: number;
    readonly postData?: { readonly mimeType: string; readonly text: string };
  };
  readonly response: {
    readonly status: number;
    readonly statusText: string;
    readonly httpVersion: string;
    readonly headers: readonly { readonly name: string; readonly value: string }[];
    readonly bodySize: number;
    readonly content: { readonly size: number; readonly mimeType: string; readonly text: string };
  };
  readonly timings: {
    readonly send: number;
    readonly wait: number;
    readonly receive: number;
  };
  readonly _ojsb: {
    readonly seq: number;
    readonly direction: DevtoolsDirection;
    readonly kind: DevtoolsMessageKind;
    readonly id?: string | null;
    readonly method?: string;
    readonly sid?: string;
    readonly traceId?: string;
    readonly code?: number;
    readonly hostHandlerMs?: number;
  };
}

export interface DevtoolsHarLog {
  readonly log: {
    readonly version: '1.2';
    readonly creator: {
      readonly name: '@open-jsbridge/devtools';
      readonly version: '1.0.0';
    };
    readonly session: DevtoolsSessionSnapshot;
    readonly entries: readonly DevtoolsHarEntry[];
  };
}

export interface DevtoolsOptions {
  /** Maximum number of entries retained in the ring buffer. Defaults to 500. */
  maxEntries?: number;
  /** Optional envelope sanitizer applied only to devtools snapshots (wire frames remain untouched). */
  redact?: (envelope: Envelope) => Envelope;
  /** Optional clock override for deterministic timestamps in tests. */
  now?: () => number;
}

export interface DevtoolsController {
  readonly plugin: BridgePlugin;
  entries(): readonly DevtoolsEntry[];
  session(): DevtoolsSessionSnapshot;
  subscribe(listener: () => void): () => void;
  clear(): void;
  exportHar(): DevtoolsHarLog;
  exportHarJson(pretty?: boolean): string;
  detach(): void;
}

interface MutableEntry {
  seq: number;
  timestamp: number;
  isoTime: string;
  direction: DevtoolsDirection;
  kind: DevtoolsMessageKind;
  id?: string | null;
  method?: string;
  sid?: string;
  traceId?: string;
  bytes: number;
  code?: number;
  roundTripMs?: number;
  hostHandlerMs?: number;
  envelope: Envelope;
}

interface OutboundPending {
  method: string;
  entry: MutableEntry;
}

const utf8 = new TextEncoder();
const SENSITIVE_KEY_PATTERN = /^(authorization|cookie|set-cookie|x-api-key|access[-_]?token|refresh[-_]?token|id[-_]?token|secret|password)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function redactValue(value: JsonValue, key?: string): JsonValue {
  if (typeof value === 'string') {
    if (key === 'thumbnailBase64' && value.length > 64) {
      return `[redacted:${value.length} chars]`;
    }
    if (key !== undefined && SENSITIVE_KEY_PATTERN.test(key)) {
      return '[redacted]';
    }
    return value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  const copy: JsonObject = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    copy[entryKey] = redactValue(entryValue, entryKey);
  }
  return copy;
}

/**
 * Default observational redactor that masks sensitive credential fields and large base64 thumbnails
 * without mutating the wire envelope sent over the bridge.
 */
export function defaultRedactEnvelope(envelope: Envelope): Envelope {
  return redactValue(envelope as unknown as JsonValue) as unknown as Envelope;
}

function measureBytes(envelope: Envelope): number {
  try {
    return utf8.encode(JSON.stringify(envelope)).byteLength;
  } catch {
    return 0;
  }
}

function classifyEnvelope(envelope: Envelope): {
  kind: DevtoolsMessageKind;
  id?: string | null;
  method?: string;
  code?: number;
} {
  const { rpc } = envelope;
  if ('method' in rpc) {
    if ('id' in rpc) {
      return { kind: 'request', id: rpc.id, method: rpc.method };
    }
    return { kind: 'notification', method: rpc.method };
  }
  if ('error' in rpc) {
    return { kind: 'error', id: rpc.id, code: rpc.error.code };
  }
  return { kind: 'response', id: rpc.id };
}

function readHelloMetadata(result: JsonValue): {
  sid: string;
  host: HostInfo;
  capabilities: DevtoolsCapabilitiesSnapshot;
  limits?: DevtoolsLimitsSnapshot;
} | undefined {
  if (!isRecord(result) || result.jsb !== '1.0' || typeof result.sid !== 'string') return;
  if (
    !isRecord(result.host) ||
    typeof result.host.platform !== 'string' ||
    typeof result.host.name !== 'string' ||
    typeof result.host.version !== 'string'
  ) {
    return;
  }
  if (!isRecord(result.capabilities)) return;

  const host: HostInfo = {
    platform: result.host.platform,
    name: result.host.name,
    version: result.host.version,
    ...(typeof result.host.appId === 'string' ? { appId: result.host.appId } : {}),
    ...(typeof result.host.appVersion === 'string' ? { appVersion: result.host.appVersion } : {}),
  };
  const methods: Record<string, readonly number[]> = {};
  if (isRecord(result.capabilities.methods)) {
    for (const [name, spec] of Object.entries(result.capabilities.methods)) {
      if (isRecord(spec) && Array.isArray(spec.versions)) {
        const versions = spec.versions.filter((v): v is number => typeof v === 'number');
        methods[name] = versions;
      }
    }
  }
  const events = Array.isArray(result.capabilities.events)
    ? result.capabilities.events.filter((e): e is string => typeof e === 'string')
    : [];
  const features = Array.isArray(result.capabilities.features)
    ? result.capabilities.features.filter((f): f is string => typeof f === 'string')
    : [];
  const capabilities: DevtoolsCapabilitiesSnapshot = { methods, events, features };

  let limits: DevtoolsLimitsSnapshot | undefined;
  if (isRecord(result.limits)) {
    limits = {
      ...(typeof result.limits.maxMessageBytes === 'number' ? { maxMessageBytes: result.limits.maxMessageBytes } : {}),
      ...(typeof result.limits.maxInflight === 'number' ? { maxInflight: result.limits.maxInflight } : {}),
      ...(typeof result.limits.defaultTimeoutMs === 'number' ? { defaultTimeoutMs: result.limits.defaultTimeoutMs } : {}),
    };
  }
  return { sid: result.sid, host, capabilities, limits };
}

/**
 * Creates a headless Open JSBridge devtools controller backed by a `BridgePlugin`.
 * When `bridge` is provided, the plugin is immediately registered and can be removed via `detach()`.
 */
export function createDevtools(bridge?: Bridge, options: DevtoolsOptions = {}): DevtoolsController {
  const maxEntries = options.maxEntries !== undefined && Number.isInteger(options.maxEntries) && options.maxEntries >= 1
    ? options.maxEntries
    : 500;
  const redact = options.redact ?? defaultRedactEnvelope;
  const now = options.now ?? (() => Date.now());

  const buffer: MutableEntry[] = [];
  const listeners = new Set<() => void>();
  const outboundRequests = new Map<string, OutboundPending>();
  const responseById = new Map<string, MutableEntry>();

  let nextSeq = 0;
  let totalMessages = 0;
  let totalErrors = 0;
  let activeSid: string | undefined;
  let activeHost: HostInfo | undefined;
  let activeCapabilities: DevtoolsCapabilitiesSnapshot | undefined;
  let activeLimits: DevtoolsLimitsSnapshot | undefined;
  let detachPlugin: (() => void) | undefined;

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Isolate subscriber exceptions from bridge traffic.
      }
    }
  }

  function pushEntry(entry: MutableEntry): void {
    buffer.push(entry);
    totalMessages += 1;
    if (entry.kind === 'error') totalErrors += 1;
    while (buffer.length > maxEntries) {
      const removed = buffer.shift();
      if (removed?.id && responseById.get(removed.id) === removed) {
        responseById.delete(removed.id);
      }
    }
    notify();
  }

  function record(direction: DevtoolsDirection, envelope: Envelope): void {
    const timestamp = now();
    const bytes = measureBytes(envelope);
    const classified = classifyEnvelope(envelope);
    const sid = typeof envelope.meta?.sid === 'string' ? envelope.meta.sid : undefined;
    const traceId = typeof envelope.meta?.traceId === 'string' ? envelope.meta.traceId : undefined;
    if (sid) activeSid = sid;

    let safeEnvelope = envelope;
    try {
      safeEnvelope = redact(envelope);
    } catch {
      safeEnvelope = envelope;
    }

    let method = classified.method;

    if (direction === 'receive' && (classified.kind === 'response' || classified.kind === 'error') && typeof classified.id === 'string') {
      const pending = outboundRequests.get(classified.id);
      if (pending) {
        method = pending.method;
        outboundRequests.delete(classified.id);
      } else if ('result' in envelope.rpc) {
        const meta = readHelloMetadata(envelope.rpc.result);
        if (meta) {
          method = 'bridge.hello';
          activeSid = meta.sid;
          activeHost = meta.host;
          activeCapabilities = meta.capabilities;
          activeLimits = meta.limits;
        }
      }
    }

    const entry: MutableEntry = {
      seq: ++nextSeq,
      timestamp,
      isoTime: new Date(timestamp).toISOString(),
      direction,
      kind: classified.kind,
      ...(classified.id === undefined ? {} : { id: classified.id }),
      ...(method === undefined ? {} : { method }),
      ...(sid === undefined ? {} : { sid }),
      ...(traceId === undefined ? {} : { traceId }),
      bytes,
      ...(classified.code === undefined ? {} : { code: classified.code }),
      envelope: safeEnvelope,
    };

    if (direction === 'send' && classified.kind === 'request' && typeof classified.id === 'string' && method) {
      outboundRequests.set(classified.id, { method, entry });
    }
    if (direction === 'receive' && (classified.kind === 'response' || classified.kind === 'error') && typeof classified.id === 'string') {
      responseById.set(classified.id, entry);
    }

    pushEntry(entry);
  }

  function onMetric(metric: BridgeMetric): void {
    const pending = outboundRequests.get(metric.id);
    if (pending) {
      pending.entry.roundTripMs = metric.roundTripMs;
      if (metric.hostHandlerMs !== undefined) pending.entry.hostHandlerMs = metric.hostHandlerMs;
      if (metric.code !== undefined) pending.entry.code = metric.code;
      outboundRequests.delete(metric.id);
    }
    const response = responseById.get(metric.id);
    if (response) {
      response.roundTripMs = metric.roundTripMs;
      if (metric.hostHandlerMs !== undefined) response.hostHandlerMs = metric.hostHandlerMs;
      if (metric.code !== undefined) response.code = metric.code;
      if (!response.method) response.method = metric.method;
    } else if (metric.code !== undefined) {
      // Local settlement (e.g. timeout, cancel, payload too large) with no inbound response frame.
      totalErrors += 1;
    }
    notify();
  }

  const plugin: BridgePlugin = {
    name: 'open-jsbridge-devtools',
    onSend(envelope) {
      record('send', envelope);
    },
    onReceive(envelope) {
      record('receive', envelope);
    },
    onMetric,
  };

  if (bridge) {
    detachPlugin = bridge.use(plugin);
  }

  function session(): DevtoolsSessionSnapshot {
    return {
      state: bridge ? bridge.state : 'unknown',
      ...(activeSid === undefined ? {} : { sid: activeSid }),
      ...(bridge?.host ?? activeHost ? { host: bridge?.host ?? activeHost } : {}),
      ...(activeCapabilities === undefined ? {} : { capabilities: activeCapabilities }),
      ...(activeLimits === undefined ? {} : { limits: activeLimits }),
      totalMessages,
      totalErrors,
      inflightCount: outboundRequests.size,
    };
  }

  function exportHar(): DevtoolsHarLog {
    const currentSession = session();
    const hostSegment = currentSession.host?.name ?? 'host';
    const entries: DevtoolsHarEntry[] = buffer.map((entry) => {
      const serialized = JSON.stringify(entry.envelope);
      const isError = entry.kind === 'error' || entry.code !== undefined;
      const status = isError ? 500 : 200;
      const statusText = entry.code !== undefined ? `RPC ${entry.code}` : 'OK';
      const time = entry.roundTripMs ?? 0;
      const wait = entry.hostHandlerMs ?? time;
      const methodLabel = entry.method ?? 'unknown';
      const headers: { name: string; value: string }[] = [];
      if (entry.sid) headers.push({ name: 'x-ojsb-sid', value: entry.sid });
      if (entry.traceId) headers.push({ name: 'x-ojsb-trace-id', value: entry.traceId });
      headers.push({ name: 'x-ojsb-direction', value: entry.direction });

      return {
        startedDateTime: entry.isoTime,
        time,
        request: {
          method: entry.direction === 'send' ? 'POST' : 'EVENT',
          url: `ojsb://${hostSegment}/${methodLabel}`,
          httpVersion: 'jsb/1.0',
          headers,
          bodySize: entry.direction === 'send' ? entry.bytes : 0,
          ...(entry.direction === 'send'
            ? { postData: { mimeType: 'application/json', text: serialized } }
            : {}),
        },
        response: {
          status,
          statusText,
          httpVersion: 'jsb/1.0',
          headers,
          bodySize: entry.direction === 'receive' ? entry.bytes : 0,
          content: {
            size: entry.direction === 'receive' ? entry.bytes : 0,
            mimeType: 'application/json',
            text: entry.direction === 'receive' ? serialized : '',
          },
        },
        timings: {
          send: 0,
          wait,
          receive: Math.max(0, time - wait),
        },
        _ojsb: {
          seq: entry.seq,
          direction: entry.direction,
          kind: entry.kind,
          ...(entry.id === undefined ? {} : { id: entry.id }),
          ...(entry.method === undefined ? {} : { method: entry.method }),
          ...(entry.sid === undefined ? {} : { sid: entry.sid }),
          ...(entry.traceId === undefined ? {} : { traceId: entry.traceId }),
          ...(entry.code === undefined ? {} : { code: entry.code }),
          ...(entry.hostHandlerMs === undefined ? {} : { hostHandlerMs: entry.hostHandlerMs }),
        },
      };
    });

    return {
      log: {
        version: '1.2',
        creator: {
          name: '@open-jsbridge/devtools',
          version: '1.0.0',
        },
        session: currentSession,
        entries,
      },
    };
  }

  return {
    plugin,
    entries() {
      return [...buffer];
    },
    session,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear() {
      buffer.length = 0;
      responseById.clear();
      totalMessages = 0;
      totalErrors = 0;
      notify();
    },
    exportHar,
    exportHarJson(pretty = true) {
      return JSON.stringify(exportHar(), null, pretty ? 2 : 0);
    },
    detach() {
      detachPlugin?.();
      detachPlugin = undefined;
      outboundRequests.clear();
      responseById.clear();
      listeners.clear();
    },
  };
}
