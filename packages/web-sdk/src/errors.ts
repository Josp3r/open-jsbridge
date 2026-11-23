import type { JsonValue } from '../../protocol/src/index.js';

interface ErrorContext {
  data?: JsonValue | undefined;
  method?: string | undefined;
  traceId?: string | undefined;
}

export class BridgeError extends Error {
  readonly data: JsonValue | undefined;
  readonly method: string | undefined;
  readonly traceId: string | undefined;

  constructor(readonly code: number, message: string, context: ErrorContext = {}) {
    super(message);
    this.name = 'BridgeError';
    this.data = context.data;
    this.method = context.method;
    this.traceId = context.traceId;
  }
}
