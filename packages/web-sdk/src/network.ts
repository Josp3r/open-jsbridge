import type { CallOptions } from './bridge.js';
import type { EventListener, NetworkStatus } from './events.js';
import { bridge } from './singleton.js';

export type { NetworkStatus } from './events.js';

export const network = {
  getStatus(options?: Omit<CallOptions, 'version'>) {
    return bridge.call<NetworkStatus>('network.getStatus@1', undefined, options);
  },
  onStatusChanged(listener: EventListener<NetworkStatus>) {
    return bridge.on('network.statusChanged', listener);
  },
};
