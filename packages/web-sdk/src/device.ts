import type { CallOptions } from './bridge.js';
import { bridge } from './singleton.js';

export interface DeviceInfo {
  os: 'ios' | 'android';
  osVersion: string;
}

export const device = {
  getInfo(options?: Omit<CallOptions, 'version'>) {
    return bridge.call<DeviceInfo>('device.getInfo@1', undefined, options);
  },
};
