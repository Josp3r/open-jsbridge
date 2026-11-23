import type { JsonObject, JsonValue } from '../../protocol/src/index.js';

export interface HostInfo {
  readonly platform: string;
  readonly name: string;
  readonly version: string;
  readonly appId?: string;
  readonly appVersion?: string;
}

export interface Session {
  sid: string;
  host: HostInfo;
  methods: Map<string, ReadonlySet<number>>;
  events: ReadonlySet<string>;
  features: readonly string[];
  defaultTimeout: number;
  maxMessageBytes: number;
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isStringArray(value: JsonValue | undefined): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') &&
    new Set(value).size === value.length;
}

export function readSession(result: JsonValue, sid?: string): Session | undefined {
  if (!isObject(result) || result.jsb !== '1.0' || typeof result.sid !== 'string' || !result.sid ||
      (sid !== undefined && sid !== result.sid)) return;

  const { host, capabilities, limits } = result;
  if (!isObject(host) || typeof host.platform !== 'string' ||
      typeof host.name !== 'string' || typeof host.version !== 'string' ||
      (host.appId !== undefined && typeof host.appId !== 'string') ||
      (host.appVersion !== undefined && typeof host.appVersion !== 'string')) return;
  if (!isObject(capabilities) || !isObject(capabilities.methods) ||
      !isStringArray(capabilities.events) || !isStringArray(capabilities.features)) return;
  if (!isObject(limits) || !isPositiveInteger(limits.maxMessageBytes) ||
      !isPositiveInteger(limits.maxInflight) || !isPositiveInteger(limits.defaultTimeoutMs) ||
      limits.defaultTimeoutMs > 2_147_483_647) return;

  const methods = new Map<string, ReadonlySet<number>>();
  for (const [method, entry] of Object.entries(capabilities.methods)) {
    if (!isObject(entry) || !Array.isArray(entry.versions) || !entry.versions.length ||
        !entry.versions.every(isPositiveInteger)) return;
    const versions = new Set(entry.versions);
    if (versions.size !== entry.versions.length) return;
    methods.set(method, versions);
  }

  const hostInfo = { platform: host.platform, name: host.name, version: host.version };
  return {
    sid: result.sid,
    host: {
      ...hostInfo,
      ...(host.appId === undefined ? {} : { appId: host.appId }),
      ...(host.appVersion === undefined ? {} : { appVersion: host.appVersion }),
    },
    methods,
    events: new Set(capabilities.events),
    features: capabilities.features,
    defaultTimeout: limits.defaultTimeoutMs,
    maxMessageBytes: limits.maxMessageBytes,
  };
}
