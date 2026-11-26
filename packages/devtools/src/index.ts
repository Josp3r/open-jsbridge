import type { Bridge } from '../../web-sdk/src/index.js';
import {
  mountDevtoolsOverlay,
  type DevtoolsOverlayHandle,
  type DevtoolsOverlayOptions,
  type DevtoolsOverlayPosition,
} from './overlay.js';
import {
  createDevtools,
  defaultRedactEnvelope,
  type DevtoolsCapabilitiesSnapshot,
  type DevtoolsController,
  type DevtoolsDirection,
  type DevtoolsEntry,
  type DevtoolsHarEntry,
  type DevtoolsHarLog,
  type DevtoolsLimitsSnapshot,
  type DevtoolsMessageKind,
  type DevtoolsOptions,
  type DevtoolsSessionSnapshot,
} from './recorder.js';

export { createDevtools, defaultRedactEnvelope, mountDevtoolsOverlay };
export type {
  DevtoolsCapabilitiesSnapshot,
  DevtoolsController,
  DevtoolsDirection,
  DevtoolsEntry,
  DevtoolsHarEntry,
  DevtoolsHarLog,
  DevtoolsLimitsSnapshot,
  DevtoolsMessageKind,
  DevtoolsOptions,
  DevtoolsOverlayHandle,
  DevtoolsOverlayOptions,
  DevtoolsOverlayPosition,
  DevtoolsSessionSnapshot,
};

export interface AttachDevtoolsOptions extends DevtoolsOptions {
  /**
   * Mount the floating DOM overlay immediately. Defaults to `false`.
   * Set to `true` or pass `DevtoolsOverlayOptions` in browser environments.
   */
  mount?: boolean | DevtoolsOverlayOptions;
}

export interface AttachedDevtools {
  readonly controller: DevtoolsController;
  readonly overlay?: DevtoolsOverlayHandle;
  destroy(): void;
}

/**
 * Convenience helper that registers the devtools plugin on a Bridge instance
 * and optionally mounts the Shadow DOM floating overlay.
 */
export function attachDevtools(bridge: Bridge, options: AttachDevtoolsOptions = {}): AttachedDevtools {
  const { mount, ...recorderOptions } = options;
  const controller = createDevtools(bridge, recorderOptions);
  let overlay: DevtoolsOverlayHandle | undefined;
  if (mount) {
    overlay = mountDevtoolsOverlay(controller, typeof mount === 'object' ? mount : {});
  }
  return {
    controller,
    ...(overlay === undefined ? {} : { overlay }),
    destroy() {
      overlay?.unmount();
      controller.detach();
    },
  };
}
