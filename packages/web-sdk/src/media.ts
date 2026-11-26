import { ErrorCode } from '../../protocol/src/index.js';
import { BridgeError } from './errors.js';
import type { Bridge, CallOptions } from './bridge.js';
import { isObject } from './session.js';

const chooseMethod = 'media.chooseMedia@1';
const releaseMethod = 'media.release@1';
const maxImageBytes = 20 * 1024 * 1024;
const maxThumbnailBytes = 32 * 1024;
const maxReleaseIds = 32;
const previewLifetime = 300_000;
const mediaId = /^[0-9a-f]{32}$/;
const imageMime = /^image\/[a-z0-9!#$&^_.+-]+$/i;
const jpegBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?(?![\s\S])/;

const previews = new WeakMap<Bridge, Map<string, ReturnType<typeof setTimeout>>>();

export interface ImageResource {
  type: 'image';
  id: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  expiresAt: number;
  thumbUrl: string;
}

export type ChooseMediaParams = {
  mediaType?: ['image'];
  sourceType?: ['album'];
  count?: 1;
};

export type ChooseMediaResult =
  | { status: 'cancelled'; files: [] }
  | { status: 'selected'; files: [ImageResource] };

export type ReleaseMediaParams = {
  ids: readonly string[];
};

export type ReleaseMediaResult = null;

export function revokeMediaPreviews(client: Bridge): void {
  const active = previews.get(client);
  if (!active) return;
  previews.delete(client);
  for (const [url, timer] of active) {
    clearTimeout(timer);
    URL.revokeObjectURL(url);
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function invalidSelection(): BridgeError {
  return new BridgeError(ErrorCode.InternalError, 'Invalid media selection', { method: chooseMethod });
}

function thumbnailBlob(encoded: unknown): Blob {
  if (typeof encoded !== 'string' || encoded.length > 4 * Math.ceil(maxThumbnailBytes / 3) ||
      !jpegBase64.test(encoded)) throw invalidSelection();
  const binary = atob(encoded);
  if (binary.length < 4 || binary.length > maxThumbnailBytes ||
      binary.charCodeAt(0) !== 255 || binary.charCodeAt(1) !== 216 ||
      binary.charCodeAt(binary.length - 2) !== 255 || binary.charCodeAt(binary.length - 1) !== 217) {
    throw invalidSelection();
  }
  return new Blob([Uint8Array.from(binary, (byte) => byte.charCodeAt(0))], { type: 'image/jpeg' });
}

export function createMediaHelpers(client: Bridge) {
  return {
    media: {
      async chooseMedia(params?: ChooseMediaParams, options?: Omit<CallOptions, 'version'>): Promise<ChooseMediaResult> {
        const active = previews.get(client) ?? new Map<string, ReturnType<typeof setTimeout>>();
        previews.set(client, active);
        const result = await client.call(chooseMethod, params, { ...options, timeout: options?.timeout ?? 120_000 });
        if (previews.get(client) !== active) {
          throw new BridgeError(ErrorCode.Cancelled, 'Media selection retired', { method: chooseMethod });
        }
        if (!isObject(result) || !Array.isArray(result.files)) throw invalidSelection();
        if (result.status === 'cancelled' && result.files.length === 0) return { status: 'cancelled', files: [] };
        const [file] = result.files;
        if (result.status !== 'selected' || result.files.length !== 1 || !isObject(file)) throw invalidSelection();
        const { type, id, mime, size, width, height, expiresAt, thumbnailBase64 } = file;
        if (type !== 'image' || typeof id !== 'string' || !mediaId.test(id) ||
            typeof mime !== 'string' || mime.length > 128 || !imageMime.test(mime) ||
            !isPositiveInteger(size) || size > maxImageBytes ||
            !isPositiveInteger(width) || !isPositiveInteger(height) ||
            width > 2147483647 || height > 2147483647 || !isPositiveInteger(expiresAt)) throw invalidSelection();

        const ttl = Math.min(expiresAt - Date.now(), previewLifetime);
        if (ttl <= 0) throw new BridgeError(ErrorCode.PermissionDenied, 'Media selection expired', { method: chooseMethod });
        const thumbUrl = URL.createObjectURL(thumbnailBlob(thumbnailBase64));
        active.set(thumbUrl, setTimeout(() => {
          active.delete(thumbUrl);
          URL.revokeObjectURL(thumbUrl);
        }, ttl));
        return { status: 'selected', files: [{ type, id, mime, size, width, height, expiresAt, thumbUrl }] };
      },

      async release(params: ReleaseMediaParams, options?: Omit<CallOptions, 'version'>): Promise<ReleaseMediaResult> {
        if (
          !isObject(params) ||
          Object.keys(params).length !== 1 ||
          !Array.isArray(params.ids) ||
          params.ids.length < 1 ||
          params.ids.length > maxReleaseIds ||
          !params.ids.every((id): id is string => typeof id === 'string' && mediaId.test(id))
        ) {
          throw new BridgeError(ErrorCode.InvalidParams, 'Invalid media release params', { method: releaseMethod });
        }
        const result = await client.call(releaseMethod, { ids: [...params.ids] }, options);
        if (result !== null) {
          throw new BridgeError(ErrorCode.InternalError, 'Invalid media release result', { method: releaseMethod });
        }
        return null;
      },
    },
  };
}
