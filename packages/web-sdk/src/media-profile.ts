import { createMediaHelpers } from './media.js';
import { bridge } from './singleton.js';

export type { BlobResource, ChooseMediaParams, ChooseMediaResult, ImageResource } from './media.js';
export const { media, blob } = /* @__PURE__ */ createMediaHelpers(bridge);
