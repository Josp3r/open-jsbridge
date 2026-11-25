import { ErrorCode } from '../../protocol/src/index.js';
import { BridgeError } from './errors.js';
import type { Bridge, CallOptions } from './index.js';
import { isObject } from './session.js';

const chooseMethod = 'media.chooseMedia@1';
const readMethod = 'bridge.blob.read@1';
const releaseMethod = 'bridge.blob.release@1';
const chunkSize = 64 * 1024;
const maxBlobSize = 20 * 1024 * 1024;
const blobRefPattern = /^[0-9a-f]{32}$/;
const mimePattern = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}(?![\s\S])/;

export interface BlobResource {
  blobRef: string;
  mime: string;
  size: number;
  expiresAt: number;
}

export interface ImageResource extends BlobResource {
  type: 'image';
}

export type ChooseMediaParams = {
  mediaType?: ['image'];
  sourceType?: ['album'];
  count?: 1;
};

export type ChooseMediaResult =
  | { status: 'cancelled'; files: [] }
  | { status: 'selected'; files: [ImageResource] };

type MediaCallOptions = Omit<CallOptions, 'version'>;

function decodeChunk(chunk: unknown, size: number, expectedDone: boolean): Uint8Array | undefined {
  if (!isObject(chunk) || typeof chunk.dataBase64 !== 'string' || chunk.done !== expectedDone ||
      chunk.dataBase64.length !== 4 * Math.ceil(size / 3) || !base64Pattern.test(chunk.dataBase64)) {
    return;
  }
  let binary: string;
  try {
    binary = atob(chunk.dataBase64);
  } catch {
    return;
  }
  if (binary.length !== size) return;
  return Uint8Array.from(binary, (byte) => byte.charCodeAt(0));
}

export function createMediaHelpers(client: Bridge) {
  return {
    media: {
      chooseMedia(params?: ChooseMediaParams, options?: MediaCallOptions): Promise<ChooseMediaResult> {
        return client.call(chooseMethod, params, { ...options, timeout: options?.timeout ?? 120_000 });
      },
    },
    blob: {
      async read(resource: BlobResource, options?: MediaCallOptions): Promise<Blob> {
        if (!resource || typeof resource.blobRef !== 'string' || !blobRefPattern.test(resource.blobRef) ||
            !Number.isSafeInteger(resource.size) || resource.size < 1 || resource.size > maxBlobSize ||
            typeof resource.mime !== 'string' || resource.mime.length > 128 || !mimePattern.test(resource.mime) ||
            !Number.isSafeInteger(resource.expiresAt) || resource.expiresAt < 1) {
          throw new BridgeError(ErrorCode.InvalidParams, 'Invalid blob resource', { method: readMethod });
        }

        const { blobRef, size, mime } = resource;
        const bytes = new Uint8Array(size);
        for (let offset = 0; offset < size; offset += chunkSize) {
          const length = Math.min(chunkSize, size - offset);
          const chunk = await client.call(readMethod, { blobRef, index: offset / chunkSize }, options);
          const decoded = decodeChunk(chunk, length, offset + length === size);
          if (!decoded) throw new BridgeError(ErrorCode.InternalError, 'Invalid blob chunk', { method: readMethod });
          bytes.set(decoded, offset);
        }
        return new Blob([bytes], { type: mime });
      },
      release(blobRef: string, options?: MediaCallOptions): Promise<Record<string, never>> {
        return client.call(releaseMethod, { blobRef }, options);
      },
    },
  };
}
