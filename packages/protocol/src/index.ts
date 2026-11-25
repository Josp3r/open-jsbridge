export type JsonValue = null | boolean | number | string | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

interface RpcMethod {
  jsonrpc: '2.0';
  method: string;
  params?: JsonObject;
}

export interface RpcRequest extends RpcMethod {
  id: string;
}

export interface RpcNotification extends RpcMethod {}

export interface RpcSuccess {
  jsonrpc: '2.0';
  id: string;
  result: JsonValue;
}

export interface RpcFailure {
  jsonrpc: '2.0';
  id: string | null;
  error: {
    code: number;
    message: string;
    data?: JsonValue;
  };
}

export interface Envelope {
  jsb: '1.0';
  meta?: {
    sid?: string;
    timeout?: number;
    ts?: number;
    traceId?: string;
    [field: string]: JsonValue | undefined;
  };
  rpc: RpcRequest | RpcNotification | RpcSuccess | RpcFailure;
  [field: string]: unknown;
}

export const ErrorCode = Object.freeze({
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  Unavailable: -32000,
  Timeout: -32001,
  Cancelled: -32002,
  PermissionDenied: -32003,
  UnsupportedProtocol: -32004,
  NotReady: -32005,
  PayloadTooLarge: -32006,
  UserDenied: -32007,
  RateLimited: -32008,
  SessionExpired: -32009,
  Busy: -32010,
} as const);

type DecodeErrorCode = typeof ErrorCode.ParseError | typeof ErrorCode.InvalidRequest;

export class WireDecodeError extends Error {
  constructor(readonly code: DecodeErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'WireDecodeError';
  }
}

const methodPattern = /^(?!rpc\.)[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+(@[1-9][0-9]*)?$/;
const notificationOnlyMethodPattern = /^bridge\.(cancel|event|progress)(@[1-9][0-9]*)?$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isId(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 256 && /^.{1,128}$/su.test(value);
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isMeta(value: unknown): boolean {
  return isObject(value) &&
    (!hasOwn(value, 'sid') || (typeof value.sid === 'string' && value.sid.length > 0)) &&
    (!hasOwn(value, 'timeout') || isNonNegativeInteger(value.timeout)) &&
    (!hasOwn(value, 'ts') || isNonNegativeInteger(value.ts)) &&
    (!hasOwn(value, 'traceId') || typeof value.traceId === 'string');
}

function isError(value: unknown): boolean {
  return isObject(value) && Number.isSafeInteger(value.code) && typeof value.message === 'string' &&
    hasOnlyKeys(value, ['code', 'message', 'data']);
}

function isRpcMessage(value: unknown): boolean {
  if (!isObject(value) || value.jsonrpc !== '2.0') return false;
  if (hasOwn(value, 'method')) {
    return typeof value.method === 'string' && methodPattern.test(value.method) &&
      (!hasOwn(value, 'params') || isObject(value.params)) &&
      (!hasOwn(value, 'id') || (!notificationOnlyMethodPattern.test(value.method) && isId(value.id))) &&
      hasOnlyKeys(value, ['jsonrpc', 'method', 'params', 'id']);
  }
  if (hasOwn(value, 'error')) {
    return (isId(value.id) || value.id === null) && isError(value.error) &&
      hasOnlyKeys(value, ['jsonrpc', 'id', 'error']);
  }
  return isId(value.id) && hasOwn(value, 'result') &&
    hasOnlyKeys(value, ['jsonrpc', 'id', 'result']);
}

function isEnvelope(value: unknown): value is Envelope {
  return isObject(value) && value.jsb === '1.0' && isRpcMessage(value.rpc) &&
    (!hasOwn(value, 'meta') || isMeta(value.meta));
}

function checkJsonNumber(value: unknown): void {
  if (typeof value === 'number' &&
    (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new WireDecodeError(ErrorCode.InvalidRequest, 'Number is outside the supported JSON range');
  }
}

function decodeJsonProperty(key: string, value: unknown): unknown {
  checkJsonNumber(value);
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
  return value;
}

export function decodeEnvelope(raw: string): Envelope {
  let value: unknown;
  try {
    value = JSON.parse(raw, decodeJsonProperty);
  } catch (cause) {
    if (cause instanceof WireDecodeError) throw cause;
    throw new WireDecodeError(ErrorCode.ParseError, 'Parse error', cause);
  }
  if (!isEnvelope(value)) {
    throw new WireDecodeError(ErrorCode.InvalidRequest, 'Invalid request');
  }
  return value;
}

function jsonProperty(object: object, key: string, ancestors: Set<object>): JsonValue {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor?.enumerable || !hasOwn(descriptor, 'value')) {
    throw new WireDecodeError(ErrorCode.InvalidRequest, 'Expected an enumerable JSON data property');
  }
  return copyJson(descriptor.value, ancestors);
}

function copyJson(value: unknown, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    checkJsonNumber(value);
    return value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new WireDecodeError(ErrorCode.InvalidRequest, 'Expected an acyclic JSON value');
  }

  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      if (keys.length !== value.length + 1 || 'toJSON' in value) {
        throw new WireDecodeError(ErrorCode.InvalidRequest, 'Expected a dense JSON array');
      }
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        result.push(jsonProperty(value, String(index), ancestors));
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
      throw new WireDecodeError(ErrorCode.InvalidRequest, 'Expected a plain JSON object');
    }
    const result: JsonObject = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string') {
        throw new WireDecodeError(ErrorCode.InvalidRequest, 'Expected a string JSON property name');
      }
      result[key] = jsonProperty(value, key, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function snapshotJson(value: unknown): JsonValue {
  try {
    return copyJson(value, new Set());
  } catch (cause) {
    if (cause instanceof WireDecodeError) throw cause;
    throw new WireDecodeError(ErrorCode.InvalidRequest, 'Message is not serializable', cause);
  }
}

export function encodeEnvelope(envelope: Envelope): string {
  const snapshot = snapshotJson(envelope);
  if (!isEnvelope(snapshot)) {
    throw new WireDecodeError(ErrorCode.InvalidRequest, 'Invalid request');
  }
  return JSON.stringify(snapshot);
}
