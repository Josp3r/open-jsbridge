import type { EventListener } from './events.js';
import { bridge } from './singleton.js';

export const app = {
  onForegrounded(listener: EventListener<null>) {
    return bridge.on('app.foregrounded', listener);
  },
  onBackgrounded(listener: EventListener<null>) {
    return bridge.on('app.backgrounded', listener);
  },
};
