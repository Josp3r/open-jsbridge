import { createMediaHelpers } from './media.js';
import { bridge } from './singleton.js';

export type { ChooseMediaParams, ChooseMediaResult, ImageResource } from './media.js';
export const { media } = /* @__PURE__ */ createMediaHelpers(bridge);
