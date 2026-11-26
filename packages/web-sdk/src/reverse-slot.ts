import type { RpcRequest } from '../../protocol/src/index.js';
import type { Session } from './session.js';

export interface ReverseTransport {
  session(): Session | undefined;
  post(raw: string): void;
  nextId(): string;
}

export interface ReverseHooks {
  onReady(session: Session): void;
  onInvalidate(): void;
  onRequest(rpc: RpcRequest, session: Session): void;
  onCancel(requestId: string): void;
}

export const reverseTransports = new WeakMap<object, ReverseTransport>();
export const reverseHooks = new WeakMap<object, ReverseHooks>();
