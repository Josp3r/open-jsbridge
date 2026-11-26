import {
  createHostCore, HostError,
  type CallWebOptions, type HostCoreLimits, type HostHandler, type HostHandlerContext, type RegisterHandlerOptions,
} from '../../host-core/src/index.js';
import type { JsonObject, JsonValue } from '../../protocol/src/index.js';
import { canonicalHttpsOrigin, createOriginAllowlist, type OriginAllowlist } from './origin.js';
import { encodeReceiveScript, OJSB_RN_SHIM } from './shim.js';

export { canonicalHttpsOrigin, createOriginAllowlist, encodeReceiveScript, HostError, OJSB_RN_SHIM };
export type { CallWebOptions, HostCoreLimits, HostHandler, HostHandlerContext, OriginAllowlist, RegisterHandlerOptions };

export interface ReactNativeWebViewTarget {
  injectJavaScript(script: string): void;
}

export interface ReactNativeMessageEvent {
  nativeEvent: {
    data: string;
    url?: string;
    isMainFrame?: boolean;
  };
}

export interface ReactNativeNavigationRequest {
  url: string;
  isTopFrame?: boolean;
}

export interface ReactNativeHostOptions {
  /** Exact HTTPS origins permitted to load and talk to the host. */
  allowedOrigins: readonly string[];
  /**
   * Explicit opt-in required by protocol S2 (trust: "degraded").
   * Scheme A via react-native-webview lacks verified native frame origin metadata,
   * so the host remains disabled unless the caller explicitly enables degraded mode
   * and enforces content/frame isolation.
   */
  allowDegradedTransport?: boolean;
  platform?: string;
  version?: string;
  appId?: string;
  appVersion?: string;
  events?: readonly string[];
  deniedEvents?: readonly string[];
  handlers?: Record<string, HostHandler>;
  supportsCancel?: boolean;
  supportsCallbacks?: boolean;
  supportsReverse?: boolean;
  limits?: HostCoreLimits;
  onBlockedNavigation?: (url: string) => void;
  onSessionInvalidated?: (reason: string) => void;
}

export interface BindWebViewPropsOptions {
  /** Initial URL passed to <WebView source={{ uri }}>. Must match allowedOrigins to enable the bridge. */
  sourceUri: string;
  onMessage?: (event: ReactNativeMessageEvent) => void;
  onShouldStartLoadWithRequest?: (request: ReactNativeNavigationRequest) => boolean;
  onContentProcessDidTerminate?: (event?: unknown) => void;
  onRenderProcessGone?: (event?: unknown) => void;
}

export interface ReactNativeWebViewBridgeProps {
  injectedJavaScriptBeforeContentLoaded?: string;
  injectedJavaScriptBeforeContentLoadedForMainFrameOnly?: boolean;
  onMessage?: (event: ReactNativeMessageEvent) => void;
  onShouldStartLoadWithRequest?: (request: ReactNativeNavigationRequest) => boolean;
  onContentProcessDidTerminate?: (event?: unknown) => void;
  onRenderProcessGone?: (event?: unknown) => void;
}

export interface ReactNativeHost {
  readonly trust: 'degraded';
  readonly isEnabled: boolean;
  readonly acl: OriginAllowlist;
  readonly sid: string | undefined;
  readonly documentId: number;
  readonly webMethods: ReadonlySet<string>;
  attach(target: ReactNativeWebViewTarget): () => void;
  allowSource(url: string): boolean;
  shouldStartLoad(url: string): boolean;
  onDocumentCommit(url: string): boolean;
  handleMessage(raw: string, context?: { url?: string; isMainFrame?: boolean }): Promise<boolean>;
  invalidate(reason?: string): void;
  register(method: string, handler: HostHandler, options?: RegisterHandlerOptions): () => void;
  unregister(method: string): boolean;
  emit(name: string, payload: JsonValue): boolean;
  callWeb<T = JsonValue>(method: string, params?: JsonObject, options?: CallWebOptions): Promise<T>;
  wasCancelled(requestId: string): boolean;
  bindWebViewProps(options: BindWebViewPropsOptions): ReactNativeWebViewBridgeProps;
}

/**
 * Creates a Scheme A React Native Host built on HostCore (docs/react-native.md).
 * Disabled by default unless `allowDegradedTransport: true` is explicitly configured (protocol S2).
 */
export function createReactNativeHost(options: ReactNativeHostOptions): ReactNativeHost {
  const acl = createOriginAllowlist(options.allowedOrigins);
  const degradedEnabled = options.allowDegradedTransport === true;

  const core = createHostCore({
    platform: options.platform ?? 'rn',
    name: 'rn',
    version: options.version ?? '0.2.0',
    appId: options.appId,
    appVersion: options.appVersion,
    events: options.events,
    deniedEvents: options.deniedEvents,
    supportsCancel: options.supportsCancel ?? true,
    supportsCallbacks: options.supportsCallbacks ?? true,
    supportsReverse: options.supportsReverse ?? true,
    limits: options.limits,
  });

  if (options.handlers) {
    for (const [method, handler] of Object.entries(options.handlers)) {
      core.register(method, handler);
    }
  }

  let target: ReactNativeWebViewTarget | undefined;
  let currentDocumentId = 0;
  let documentAuthorized = false;

  function deliverForDocument(raw: string, expectedDocumentId: number): boolean {
    if (!degradedEnabled || !documentAuthorized || !target || currentDocumentId !== expectedDocumentId) {
      return false;
    }
    target.injectJavaScript(encodeReceiveScript(raw));
    return true;
  }

  function invalidate(reason = 'invalidated'): void {
    currentDocumentId += 1;
    documentAuthorized = false;
    core.setReceiver(undefined);
    core.reset();
    options.onSessionInvalidated?.(reason);
  }

  function bindDocumentReceiver(docId: number): void {
    core.setReceiver((raw) => {
      deliverForDocument(raw, docId);
    });
  }

  function attach(nextTarget: ReactNativeWebViewTarget): () => void {
    if (target) invalidate('reattached');
    target = nextTarget;
    if (degradedEnabled && documentAuthorized) {
      bindDocumentReceiver(currentDocumentId);
    }
    return () => {
      if (target !== nextTarget) return;
      target = undefined;
      invalidate('detached');
    };
  }

  function allowSource(url: string): boolean {
    return degradedEnabled && acl.allowsUrl(url);
  }

  function shouldStartLoad(url: string): boolean {
    if (!acl.allowsUrl(url)) {
      options.onBlockedNavigation?.(url);
      return false;
    }
    return true;
  }

  function onDocumentCommit(url: string): boolean {
    invalidate('navigation');
    if (!degradedEnabled || !acl.allowsUrl(url)) {
      options.onBlockedNavigation?.(url);
      return false;
    }
    documentAuthorized = true;
    if (target) bindDocumentReceiver(currentDocumentId);
    return true;
  }

  async function handleMessage(
    raw: string,
    context?: { url?: string; isMainFrame?: boolean },
  ): Promise<boolean> {
    if (!degradedEnabled || !documentAuthorized || !target) return false;
    if (typeof raw !== 'string') return false;
    if (context?.isMainFrame === false) return false;

    const expectedDoc = currentDocumentId;
    const reply = await core.receive(raw);
    if (reply === null) return false;
    return deliverForDocument(reply, expectedDoc);
  }

  function bindWebViewProps(bindOptions: BindWebViewPropsOptions): ReactNativeWebViewBridgeProps {
    if (!allowSource(bindOptions.sourceUri)) {
      invalidate('source_not_allowed');
      return {
        onMessage: bindOptions.onMessage,
        onShouldStartLoadWithRequest: bindOptions.onShouldStartLoadWithRequest,
        onContentProcessDidTerminate: bindOptions.onContentProcessDidTerminate,
        onRenderProcessGone: bindOptions.onRenderProcessGone,
      };
    }

    onDocumentCommit(bindOptions.sourceUri);

    return {
      injectedJavaScriptBeforeContentLoaded: OJSB_RN_SHIM,
      injectedJavaScriptBeforeContentLoadedForMainFrameOnly: true,
      onMessage(event) {
        if (typeof event?.nativeEvent?.data === 'string') {
          void handleMessage(event.nativeEvent.data, {
            url: event.nativeEvent.url,
            isMainFrame: event.nativeEvent.isMainFrame,
          });
        }
        bindOptions.onMessage?.(event);
      },
      onShouldStartLoadWithRequest(request) {
        if (!shouldStartLoad(request.url)) return false;
        return bindOptions.onShouldStartLoadWithRequest
          ? bindOptions.onShouldStartLoadWithRequest(request)
          : true;
      },
      onContentProcessDidTerminate(event) {
        invalidate('process_gone');
        bindOptions.onContentProcessDidTerminate?.(event);
      },
      onRenderProcessGone(event) {
        invalidate('process_gone');
        bindOptions.onRenderProcessGone?.(event);
      },
    };
  }

  return {
    trust: 'degraded',
    get isEnabled() {
      return degradedEnabled;
    },
    acl,
    get sid() {
      return core.sid;
    },
    get documentId() {
      return currentDocumentId;
    },
    get webMethods(): ReadonlySet<string> {
      return core.webMethods;
    },
    attach,
    allowSource,
    shouldStartLoad,
    onDocumentCommit,
    handleMessage,
    invalidate,
    register: (method, handler, registerOptions) => core.register(method, handler, registerOptions),
    unregister: (method) => core.unregister(method),
    emit(name, payload) {
      if (!degradedEnabled || !documentAuthorized || !target) return false;
      return core.emit(name, payload);
    },
    callWeb(method, params, callOptions) {
      if (!degradedEnabled || !documentAuthorized || !target) {
        return Promise.reject(new HostError(-32000, 'Bridge unavailable'));
      }
      return core.callWeb(method, params, callOptions);
    },
    wasCancelled: (requestId) => core.wasCancelled(requestId),
    bindWebViewProps,
  };
}
