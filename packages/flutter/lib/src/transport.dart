import 'dart:async';

import 'origin.dart';
import 'shim.dart';

/// Trust level of the underlying WebView message channel (protocol S1/S2).
enum Trust {
  /// Platform provides verified native caller origin and frame metadata.
  full,

  /// Platform lacks verified native caller origin/frame metadata; disabled by default (S2).
  degraded,
}

/// Opaque identity of a committed document inside a WebView instance.
class DocumentRef {
  final int id;
  final Uri? url;

  const DocumentRef({required this.id, this.url});

  @override
  bool operator ==(Object other) => other is DocumentRef && other.id == id;

  @override
  int get hashCode => id.hashCode;

  @override
  String toString() => 'DocumentRef(id: $id, url: $url)';
}

/// Caller metadata attached to an inbound Web → Host message.
class CallerInfo {
  /// Verified caller origin (non-null only when `trust == Trust.full`).
  final Uri? origin;

  /// Verified main-frame flag (non-null only when `trust == Trust.full`).
  final bool? isMainFrame;

  final Trust trust;
  final DocumentRef document;

  const CallerInfo({
    required this.trust,
    required this.document,
    this.origin,
    this.isMainFrame,
  });
}

/// Lifecycle transition emitted by a [HostTransport] to drive session invalidation (protocol §12).
enum LifecycleEventKind {
  documentCommit,
  processTerminated,
  disposed,
}

class LifecycleEvent {
  final LifecycleEventKind kind;
  final DocumentRef? document;
  final String? reason;

  const LifecycleEvent(this.kind, {this.document, this.reason});
}

typedef InboundMessageHandler = Future<String?> Function(
  String raw,
  CallerInfo caller,
);

/// Transport abstraction decoupling [OJSBridge] from specific Flutter WebView plugins.
abstract class HostTransport {
  String get name;
  Trust get trust;

  /// Registers the inbound message handler invoked for Web → Host traffic.
  void listen(InboundMessageHandler onMessage);

  /// Delivers a Host → Web envelope string iff [target] is still the active document.
  Future<void> deliver(String raw, DocumentRef target);

  /// Stream of document navigation, process termination, and disposal signals.
  Stream<LifecycleEvent> get lifecycle;

  /// Releases resources and invalidates any bound document.
  void dispose();
}

/// Transport adapter for `flutter_inappwebview` (`UserScript` + `addJavaScriptHandler`).
///
/// Defaults to [Trust.degraded] unless the integrator supplies verified native
/// caller origin/frame metadata and explicitly constructs with `trust: Trust.full`.
class InAppWebViewTransport implements HostTransport {
  final Future<void> Function(String script) _evaluateJavascript;
  final StreamController<LifecycleEvent> _lifecycle =
      StreamController<LifecycleEvent>.broadcast(sync: true);

  @override
  final Trust trust;

  InboundMessageHandler? _onMessage;
  DocumentRef? _currentDocument;
  int _nextDocumentId = 0;
  bool _disposed = false;

  InAppWebViewTransport({
    required Future<void> Function(String script) evaluateJavascript,
    this.trust = Trust.degraded,
  }) : _evaluateJavascript = evaluateJavascript;

  @override
  String get name => 'flutter_inappwebview';

  /// JS shim to inject via `UserScript(injectionTime: AT_DOCUMENT_START, forMainFrameOnly: true)`.
  String get shim => ojsbInAppWebViewShim;

  DocumentRef? get currentDocument => _currentDocument;

  @override
  Stream<LifecycleEvent> get lifecycle => _lifecycle.stream;

  @override
  void listen(InboundMessageHandler onMessage) {
    _onMessage = onMessage;
  }

  /// Checks whether a top-level navigation to [url] should be permitted by [allowlist].
  bool shouldAllowNavigation(Uri url, OriginAllowlist allowlist) =>
      allowlist.allowsUri(url);

  /// Signals that a new main-frame document has committed at [url].
  DocumentRef onDocumentCommit(Uri url) {
    if (_disposed) {
      throw StateError('InAppWebViewTransport has been disposed');
    }
    final doc = DocumentRef(id: ++_nextDocumentId, url: url);
    _currentDocument = doc;
    _lifecycle.add(
      LifecycleEvent(
        LifecycleEventKind.documentCommit,
        document: doc,
        reason: 'navigation',
      ),
    );
    return doc;
  }

  /// Signals that the WebView content/render process terminated (protocol L5).
  void onProcessTerminated() {
    if (_disposed) return;
    _currentDocument = null;
    _lifecycle.add(
      const LifecycleEvent(
        LifecycleEventKind.processTerminated,
        reason: 'process_terminated',
      ),
    );
  }

  /// Bridges `controller.addJavaScriptHandler(handlerName: 'ojsb', callback: ...)` into the host.
  ///
  /// Returns the JSON-RPC response envelope string (or `null` for notifications / dropped frames).
  /// Drops any reply if the document changed while the handler was running (protocol L2).
  Future<String?> handleCallHandler(
    String raw, {
    Uri? origin,
    bool? isMainFrame,
  }) async {
    final handler = _onMessage;
    final doc = _currentDocument;
    if (_disposed || handler == null || doc == null) return null;

    // In degraded mode, unknown origin/frame metadata MUST remain null (docs/flutter.md §5).
    final caller = CallerInfo(
      trust: trust,
      document: doc,
      origin: trust == Trust.full ? origin : null,
      isMainFrame: trust == Trust.full ? isMainFrame : null,
    );
    final reply = await handler(raw, caller);
    if (_disposed || _currentDocument != doc) return null;
    return reply;
  }

  @override
  Future<void> deliver(String raw, DocumentRef target) async {
    if (_disposed || _currentDocument != target) return;
    await _evaluateJavascript(encodeReceiveScript(raw));
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _currentDocument = null;
    _onMessage = null;
    _lifecycle.add(
      const LifecycleEvent(LifecycleEventKind.disposed, reason: 'disposed'),
    );
    unawaited(_lifecycle.close());
  }
}

/// Transport adapter for official `webview_flutter` (`JavaScriptChannel` + `runJavaScript`).
///
/// Always operates at [Trust.degraded] because `JavaScriptMessage` only provides
/// the message string without native caller origin or frame metadata (docs/flutter.md §1, §5).
class WebviewFlutterTransport implements HostTransport {
  final Future<void> Function(String script) _runJavaScript;
  final String channelName;
  final StreamController<LifecycleEvent> _lifecycle =
      StreamController<LifecycleEvent>.broadcast(sync: true);

  InboundMessageHandler? _onMessage;
  DocumentRef? _currentDocument;
  int _nextDocumentId = 0;
  bool _disposed = false;

  WebviewFlutterTransport({
    required Future<void> Function(String script) runJavaScript,
    this.channelName = 'OjsbChannel',
  }) : _runJavaScript = runJavaScript {
    // Validate channel name eagerly.
    buildWebviewFlutterShim(channelName: channelName);
  }

  @override
  String get name => 'webview_flutter';

  @override
  Trust get trust => Trust.degraded;

  /// JS shim tailored to [channelName].
  String get shim => buildWebviewFlutterShim(channelName: channelName);

  DocumentRef? get currentDocument => _currentDocument;

  @override
  Stream<LifecycleEvent> get lifecycle => _lifecycle.stream;

  @override
  void listen(InboundMessageHandler onMessage) {
    _onMessage = onMessage;
  }

  /// Checks whether a top-level navigation to [url] should be permitted by [allowlist].
  bool shouldAllowNavigation(Uri url, OriginAllowlist allowlist) =>
      allowlist.allowsUri(url);

  /// Signals that a new main-frame document has committed at [url].
  DocumentRef onDocumentCommit(Uri url) {
    if (_disposed) {
      throw StateError('WebviewFlutterTransport has been disposed');
    }
    final doc = DocumentRef(id: ++_nextDocumentId, url: url);
    _currentDocument = doc;
    _lifecycle.add(
      LifecycleEvent(
        LifecycleEventKind.documentCommit,
        document: doc,
        reason: 'navigation',
      ),
    );
    return doc;
  }

  /// Signals that the WebView render process terminated (protocol L5).
  void onProcessTerminated() {
    if (_disposed) return;
    _currentDocument = null;
    _lifecycle.add(
      const LifecycleEvent(
        LifecycleEventKind.processTerminated,
        reason: 'process_terminated',
      ),
    );
  }

  /// Bridges `controller.addJavaScriptChannel(channelName, onMessageReceived: ...)` into the host.
  ///
  /// Replies are pushed back to the same bound document via double-encoded `runJavaScript`.
  Future<void> handleJavaScriptMessage(String raw) async {
    final handler = _onMessage;
    final doc = _currentDocument;
    if (_disposed || handler == null || doc == null) return;

    final caller = CallerInfo(trust: Trust.degraded, document: doc);
    final reply = await handler(raw, caller);
    if (reply != null) {
      await deliver(reply, doc);
    }
  }

  @override
  Future<void> deliver(String raw, DocumentRef target) async {
    if (_disposed || _currentDocument != target) return;
    await _runJavaScript(encodeReceiveScript(raw));
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _currentDocument = null;
    _onMessage = null;
    _lifecycle.add(
      const LifecycleEvent(LifecycleEventKind.disposed, reason: 'disposed'),
    );
    unawaited(_lifecycle.close());
  }
}
