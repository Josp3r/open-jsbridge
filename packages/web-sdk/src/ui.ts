import type { CallOptions } from './bridge.js';
import { bridge } from './singleton.js';

export const ui = {
  toast: {
    show(
      params: { text: string },
      options?: Omit<CallOptions, 'version'>,
    ): Promise<Record<string, never>> {
      return bridge.call('ui.toast.show@1', params, options);
    },
  },
};
