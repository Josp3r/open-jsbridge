import { ErrorCode, type JsonObject } from '../../protocol/src/index.js';
import type { Bridge, CallOptions } from './bridge.js';
import { BridgeError } from './errors.js';
import { isObject } from './session.js';

const uploadMethod = 'transfer.upload@1';
const mediaIdPattern = /^[0-9a-f]{32}$/;
const fieldNamePattern = /^[A-Za-z0-9_-]{1,64}$/;
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const headerValueControlPattern = /[\u0000-\u001f\u007f]/;
const maxMapEntries = 16;
const maxMetadataBytes = 16 * 1024;
const maxResponseBodyBytes = 32 * 1024;
const allowedRequestKeys = new Set(['url', 'method', 'fieldName', 'formData', 'headers', 'compress']);
const utf8 = new TextEncoder();

export interface UploadCompressOptions {
  maxEdge?: number;
  quality?: number;
}

export interface UploadRequest {
  url: string;
  method?: 'POST';
  fieldName?: string;
  formData?: Record<string, string>;
  headers?: Record<string, string>;
  compress?: UploadCompressOptions;
}

export interface UploadParams {
  id: string;
  request: UploadRequest;
}

export interface UploadProgress {
  sent: number;
  total: number;
}

export interface UploadResult {
  status: number;
  body: string;
}

export interface UploadCallOptions extends Omit<CallOptions<UploadProgress>, 'version' | 'onCallback'> {
  onProgress?: (progress: UploadProgress, seq: number) => void;
}

function invalidParams(message = 'Invalid upload params'): BridgeError {
  return new BridgeError(ErrorCode.InvalidParams, message, { method: uploadMethod });
}

function payloadTooLarge(message = 'Upload metadata exceeds budget'): BridgeError {
  return new BridgeError(ErrorCode.PayloadTooLarge, message, { method: uploadMethod });
}

function isSafeIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function isValidHttpsEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 9 || /\s/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.length > 0 &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
}

function validateAndNormalizeUploadParams(params: UploadParams): JsonObject {
  if (!isObject(params)) throw invalidParams();
  const topKeys = Object.keys(params);
  if (topKeys.length !== 2 || !('id' in params) || !('request' in params)) throw invalidParams();
  if (typeof params.id !== 'string' || !mediaIdPattern.test(params.id)) throw invalidParams('Invalid media handle');

  const req = params.request;
  if (!isObject(req)) throw invalidParams('Invalid upload request');
  for (const key of Object.keys(req)) {
    if (!allowedRequestKeys.has(key)) throw invalidParams(`Unknown upload request field "${key}"`);
  }
  if (!isValidHttpsEndpoint(req.url)) throw invalidParams('Upload url must be an absolute HTTPS endpoint');

  const normalizedRequest: JsonObject = { url: req.url };
  if (req.method !== undefined) {
    if (req.method !== 'POST') throw invalidParams('Upload method must be POST');
    normalizedRequest.method = 'POST';
  }

  let effectiveFieldName = 'file';
  if (req.fieldName !== undefined) {
    if (typeof req.fieldName !== 'string' || !fieldNamePattern.test(req.fieldName)) {
      throw invalidParams('Invalid upload fieldName');
    }
    effectiveFieldName = req.fieldName;
    normalizedRequest.fieldName = req.fieldName;
  }

  let metadataBytes = 0;

  if (req.formData !== undefined) {
    if (!isObject(req.formData)) throw invalidParams('Invalid formData');
    const entries = Object.entries(req.formData);
    if (entries.length > maxMapEntries) throw payloadTooLarge('formData exceeds 16 entries');
    const formCopy: JsonObject = {};
    for (const [key, value] of entries) {
      if (!fieldNamePattern.test(key) || typeof value !== 'string') {
        throw invalidParams('Invalid formData entry');
      }
      if (key === effectiveFieldName) {
        throw invalidParams('formData key collides with fieldName');
      }
      metadataBytes += utf8.encode(key).byteLength + utf8.encode(value).byteLength;
      if (metadataBytes > maxMetadataBytes) throw payloadTooLarge();
      formCopy[key] = value;
    }
    normalizedRequest.formData = formCopy;
  }

  if (req.headers !== undefined) {
    if (!isObject(req.headers)) throw invalidParams('Invalid headers');
    const entries = Object.entries(req.headers);
    if (entries.length > maxMapEntries) throw payloadTooLarge('headers exceeds 16 entries');
    const seenLower = new Set<string>();
    const headersCopy: JsonObject = {};
    for (const [key, value] of entries) {
      if (!headerNamePattern.test(key) || typeof value !== 'string' || headerValueControlPattern.test(value)) {
        throw invalidParams('Invalid header entry');
      }
      const lower = key.toLowerCase();
      if (seenLower.has(lower)) throw invalidParams('Duplicate header name');
      seenLower.add(lower);
      metadataBytes += utf8.encode(key).byteLength + utf8.encode(value).byteLength;
      if (metadataBytes > maxMetadataBytes) throw payloadTooLarge();
      headersCopy[key] = value;
    }
    normalizedRequest.headers = headersCopy;
  }

  if (req.compress !== undefined) {
    if (!isObject(req.compress)) throw invalidParams('Invalid compress options');
    const compressCopy: JsonObject = {};
    for (const [key, value] of Object.entries(req.compress)) {
      if (key === 'maxEdge') {
        if (!isSafeIntInRange(value, 1, 4096)) throw invalidParams('Invalid compress.maxEdge');
        compressCopy.maxEdge = value;
      } else if (key === 'quality') {
        if (!isSafeIntInRange(value, 1, 100)) throw invalidParams('Invalid compress.quality');
        compressCopy.quality = value;
      } else {
        throw invalidParams(`Unknown compress field "${key}"`);
      }
    }
    normalizedRequest.compress = compressCopy;
  }

  return { id: params.id, request: normalizedRequest };
}

export function createTransferHelpers(client: Bridge) {
  return {
    transfer: {
      async upload(params: UploadParams, options?: UploadCallOptions): Promise<UploadResult> {
        if (options?.timeout === 0) throw invalidParams('Upload timeout must be positive');
        const wireParams = validateAndNormalizeUploadParams(params);
        const onProgress = options?.onProgress;
        let expectedTotal: number | undefined;
        let lastSent = 0;

        const callOptions: Omit<CallOptions<UploadProgress>, 'version'> = {
          ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
          ...(options?.traceId === undefined ? {} : { traceId: options.traceId }),
          ...(options?.idleTimeout === undefined ? {} : { idleTimeout: options.idleTimeout }),
          ...(onProgress === undefined ? {} : {
            onCallback(chunk, seq) {
              if (!isObject(chunk)) return;
              const { sent, total } = chunk;
              if (
                typeof total !== 'number' || !Number.isSafeInteger(total) || total < 1 ||
                typeof sent !== 'number' || !Number.isSafeInteger(sent) || sent < 0 || sent > total
              ) {
                return;
              }
              if (expectedTotal !== undefined && total !== expectedTotal) return;
              if (sent < lastSent) return;
              expectedTotal = total;
              lastSent = sent;
              onProgress({ sent, total }, seq);
            },
          }),
        };

        const result = await client.call<unknown, UploadProgress>(uploadMethod, wireParams, callOptions);
        if (
          !isObject(result) ||
          !isSafeIntInRange(result.status, 100, 599) ||
          typeof result.body !== 'string' ||
          utf8.encode(result.body).byteLength > maxResponseBodyBytes
        ) {
          throw new BridgeError(ErrorCode.InternalError, 'Invalid upload response', {
            method: uploadMethod,
            data: { reason: 'invalid_response' },
          });
        }
        return { status: result.status, body: result.body };
      },
    },
  };
}
