import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'errors.dart';
import 'handler.dart';
import 'origin.dart';
import 'protocol.dart';
import 'transport.dart';

const String _helloMethod = 'bridge.hello';
const String _subscribeMethod = 'bridge.subscribe';
const String _unsubscribeMethod = 'bridge.unsubscribe';
const String _cancelMethod = 'bridge.cancel';
const String _progressMethod = 'bridge.progress';
const String _eventMethod = 'bridge.event';
const String _registerWebMethodsMethod = 'bridge.registerWebMethods';

/// Negotiated message and concurrency limits advertised in `bridge.hello`.
class BridgeLimits {
  final int maxMessageBytes;
  final int maxInflight;
  final int defaultTimeoutMs;

  const BridgeLimits({
    this.maxMessageBytes = 1048576,
    this.maxInflight = 64,
    this.defaultTimeoutMs = 15000,
  })  : assert(maxMessageBytes >= 1),
        assert(maxInflight >= 1),
        assert(defaultTimeoutMs >= 1 && defaultTimeoutMs <= 2147483647);

  Map<String, Object?> toJson() => <String, Object?>{
        'maxMessageBytes': maxMessageBytes,
        'maxInflight': maxInflight,
        'defaultTimeoutMs': defaultTimeoutMs,
      };
}

class _InflightCall {
  final CancelToken token;
  final String sid;

  _InflightCall(this.token, this.sid);
}

class _PendingReverseCall {
  final String sid;
  final Completer<Object?> completer;
  final Timer timer;

  _PendingReverseCall({
    required this.sid,
    required this.completer,
    required this.timer,
  });
}

/// Alias matching `docs/flutter.md` architecture terminology.
typedef BridgeCore = OJSBridge;

/// Transport-agnostic Scheme A Flutter/Dart Host state machine for `jsb: "1.0"`.
///
/// Enforces exact HTTPS origins (S1/S3/S4), keeps `Trust.degraded` channels
/// disabled unless explicitly opted in via [allowDegradedTransport] (S2),
/// isolates sessions per document (L1/L2/L5), and supports events, cancel,
/// streaming progress callbacks, and reverse Host → Web calls.
class OJSBridge {
  final HandlerRegistry registry;
  final OriginAllowlist? allowedOrigins;

  /// Explicit opt-in required by protocol S2 to enable `Trust.degraded` transports.
  final bool allowDegradedTransport;

  final String platform;
  final String hostName;
  final String hostVersion;
  final String? appId;
  final String? appVersion;
  final bool supportsCancel;
  final bool supportsCallbacks;
  final bool supportsReverse;
  final BridgeLimits limits;
  final void Function(String reason)? onSessionInvalidated;

  final Set<String> _allowedEvents;
  final Set<String> _deniedEvents;
  final List<String> _advertisedEvents;

  final Set<String> _helloIds = <String>{};
  final Set<String> _requestIds = <String>{};
  final Set<String> _subscriptions = <String>{};
  final Set<String> _webMethods = <String>{};
  final Set<String> _cancelledIds = <String>{};
  final Map<String, _InflightCall> _inflight = <String, _InflightCall>{};
  final Map<String, int> _activeCounts = <String, int>{};
  final Map<String, _PendingReverseCall> _pendingReverse =
      <String, _PendingReverseCall>{};

  final Random _random = Random.secure();
  int _nextOutboundId = 0;

  String? _activeSid;
  Trust _activeTrust = Trust.full;
  DocumentRef? _activeDocument;
  HostTransport? _transport;
  StreamSubscription<LifecycleEvent>? _lifecycleSub;
  Future<void> Function(String raw)? _rawDeliver;

  OJSBridge({
    HandlerRegistry? registry,
    this.allowedOrigins,
    this.allowDegradedTransport = false,
    this.platform = 'flutter',
    this.hostName = 'flutter',
    this.hostVersion = '0.2.0',
    this.appId,
    this.appVersion,
    Iterable<String> events = const <String>[],
    Iterable<String> deniedEvents = const <String>[],
    this.supportsCancel = true,
    this.supportsCallbacks = true,
    this.supportsReverse = true,
    this.limits = const BridgeLimits(),
    this.onSessionInvalidated,
  })  : registry = registry ?? HandlerRegistry(),
        _allowedEvents = events.where(qualifiedNamePattern.hasMatch).toSet(),
        _deniedEvents =
            deniedEvents.where(qualifiedNamePattern.hasMatch).toSet(),
        _advertisedEvents = <String>{
          ...events.where(qualifiedNamePattern.hasMatch),
          ...deniedEvents.where(qualifiedNamePattern.hasMatch),
        }.toList(growable: false);

  /// Current active session id, or `null` before handshake / after invalidation.
  String? get sid => _activeSid;

  /// Current bound document reference when attached to a [HostTransport].
  DocumentRef? get currentDocument => _activeDocument;

  /// Set of Web methods registered via `bridge.registerWebMethods` in the active session.
  Set<String> get webMethods => Set<String>.unmodifiable(_webMethods);

  /// Returns true if a request with [requestId] was cancelled in the current session.
  bool wasCancelled(String requestId) => _cancelledIds.contains(requestId);

  /// Returns true iff [transport] is permitted under protocol S2 policy.
  bool isTransportEnabled(HostTransport transport) =>
      transport.trust == Trust.full || allowDegradedTransport;

  /// Returns true iff [url] is permitted as a top-level document source for [transport].
  bool allowSource(Uri url, HostTransport transport) {
    if (!isTransportEnabled(transport)) return false;
    final acl = allowedOrigins;
    return acl == null || acl.allowsUri(url);
  }

  /// Returns the JS shim for [transport] only if enabled by policy (protocol S2).
  ///
  /// Returns `null` when degraded mode is not explicitly enabled or [initialUrl]
  /// is not permitted by [allowedOrigins].
  String? shimFor(HostTransport transport, {Uri? initialUrl}) {
    if (!isTransportEnabled(transport)) return null;
    if (initialUrl != null && !allowSource(initialUrl, transport)) return null;
    if (transport is InAppWebViewTransport) return transport.shim;
    if (transport is WebviewFlutterTransport) return transport.shim;
    return null;
  }

  /// Attaches a [HostTransport] and binds its inbound messages and lifecycle signals.
  void attachTransport(HostTransport transport) {
    detachTransport();
    _transport = transport;
    transport.listen((raw, caller) => receiveRaw(raw, caller: caller));
    _lifecycleSub = transport.lifecycle.listen((event) {
      switch (event.kind) {
        case LifecycleEventKind.documentCommit:
          if (event.document == null || event.document != _activeDocument) {
            invalidate(event.reason ?? 'navigation');
            _activeDocument = event.document;
          }
        case LifecycleEventKind.processTerminated:
          invalidate(event.reason ?? 'process_terminated');
          _activeDocument = null;
        case LifecycleEventKind.disposed:
          invalidate(event.reason ?? 'disposed');
          _activeDocument = null;
      }
    });
  }

  /// Detaches the current [HostTransport] and invalidates the active session.
  void detachTransport() {
    unawaited(_lifecycleSub?.cancel());
    _lifecycleSub = null;
    _transport = null;
    _activeDocument = null;
    invalidate('detached');
  }

  /// Sets a direct Host → Web delivery callback for transport-less / unit test usage.
  void setRawDeliver(Future<void> Function(String raw)? deliver) {
    _rawDeliver = deliver;
  }

  /// Invalidates the current session, aborts inflight handlers, cancels reverse calls,
  /// and clears all session-scoped state (protocol L1/L2/L5).
  void invalidate([String reason = 'invalidated']) {
    final hadSession = _activeSid != null ||
        _inflight.isNotEmpty ||
        _pendingReverse.isNotEmpty;
    _activeSid = null;
    _helloIds.clear();
    _requestIds.clear();
    _subscriptions.clear();
    _webMethods.clear();
    _cancelledIds.clear();
    _activeCounts.clear();

    final inflightSnapshot = _inflight.values.toList(growable: false);
    _inflight.clear();
    for (final call in inflightSnapshot) {
      call.token.cancel(reason);
    }

    final reverseSnapshot = _pendingReverse.values.toList(growable: false);
    _pendingReverse.clear();
    for (final pending in reverseSnapshot) {
      pending.timer.cancel();
      if (!pending.completer.isCompleted) {
        pending.completer.completeError(
          const BridgeException(ErrorCode.cancelled, 'Session invalidated'),
        );
      }
    }

    if (hadSession) {
      onSessionInvalidated?.call(reason);
    }
  }

  /// Alias for [invalidate] matching reference host state machine naming.
  void reset() => invalidate('reset');

  bool _exceedsMessageLimit(String raw) =>
      raw.length > limits.maxMessageBytes ||
      utf8.encode(raw).length > limits.maxMessageBytes;

  String _generateSid() {
    final buffer = StringBuffer();
    for (var i = 0; i < 16; i++) {
      buffer.write(_random.nextInt(256).toRadixString(16).padLeft(2, '0'));
    }
    return buffer.toString();
  }

  String _failure(
    String? id,
    int code,
    String message, {
    Object? data,
    bool hasData = false,
    String? sid,
    String? traceId,
  }) {
    final meta = (sid != null || traceId != null)
        ? EnvelopeMeta(sid: sid, traceId: traceId)
        : null;
    return encodeEnvelope(
      Envelope(
        meta: meta,
        rpc: RpcFailure(
          id: id,
          error: RpcErrorObject(
            code: code,
            message: message,
            data: data,
            hasData: hasData || data != null,
          ),
        ),
      ),
    );
  }

  String _success(
    String id,
    Object? result, {
    required String sid,
    String? traceId,
    Map<String, Object?>? timing,
  }) {
    return encodeEnvelope(
      Envelope(
        meta: EnvelopeMeta(
          sid: sid,
          traceId: traceId,
          extra: timing == null
              ? const <String, Object?>{}
              : <String, Object?>{'timing': timing},
        ),
        rpc: RpcSuccess(id: id, result: result),
      ),
    );
  }

  Future<bool> _pushToWeb(String raw, String expectedSid, DocumentRef? doc) async {
    if (_activeSid != expectedSid) return false;
    if (_exceedsMessageLimit(raw)) return false;
    final transport = _transport;
    if (transport != null) {
      if (doc == null || _activeDocument != doc) return false;
      await transport.deliver(raw, doc);
      return true;
    }
    final deliver = _rawDeliver;
    if (deliver == null) return false;
    await deliver(raw);
    return true;
  }

  /// Checks S1/S2/S3/S4 authorization for the inbound [caller].
  bool _authorizeCaller(CallerInfo? caller) {
    if (caller == null) {
      // Raw test mode without caller metadata is allowed only when no origin allowlist is configured.
      return allowedOrigins == null;
    }
    if (caller.trust == Trust.degraded) {
      if (!allowDegradedTransport) return false;
      final acl = allowedOrigins;
      if (acl != null && !acl.allowsUri(caller.document.url)) return false;
      return true;
    }
    // Trust.full requires verified main-frame and exact HTTPS origin (F1/S1/S3/S4).
    if (caller.isMainFrame != true) return false;
    final acl = allowedOrigins;
    if (acl != null && !acl.allowsUri(caller.origin)) return false;
    return true;
  }

  List<int>? _readProtocols(Map<String, Object?>? params) {
    if (params == null) return null;
    final rawProtocols = params['protocols'];
    if (rawProtocols is! List || rawProtocols.isEmpty) return null;
    final protocols = <int>[];
    final seen = <int>{};
    for (final entry in rawProtocols) {
      if (!isPositiveSafeInteger(entry)) return null;
      final major = (entry! as num).toInt();
      if (!seen.add(major)) return null;
      protocols.add(major);
    }

    if (params.containsKey('sdk')) {
      final sdk = params['sdk'];
      if (sdk is! Map<String, Object?> ||
          sdk['name'] is! String ||
          sdk['version'] is! String) {
        return null;
      }
    }
    if (params.containsKey('wants')) {
      final wants = params['wants'];
      if (wants is! List) return null;
      final seenWants = <String>{};
      for (final item in wants) {
        if (item is! String || !seenWants.add(item)) return null;
      }
    }
    return protocols;
  }

  List<String>? _readQualifiedNameList(
    Map<String, Object?>? params,
    String key, {
    bool allowEmpty = false,
  }) {
    if (params == null) return null;
    final raw = params[key];
    if (raw is! List) return null;
    if (!allowEmpty && raw.isEmpty) return null;
    final result = <String>[];
    final seen = <String>{};
    for (final entry in raw) {
      if (entry is! String ||
          !qualifiedNamePattern.hasMatch(entry) ||
          !seen.add(entry)) {
        return null;
      }
      result.add(entry);
    }
    return result;
  }

  String _negotiate(
    RpcRequest request,
    Trust sessionTrust,
    DocumentRef? document,
    String? traceId,
  ) {
    final protocols = _readProtocols(request.params);
    if (protocols == null) {
      return _failure(
        request.id,
        ErrorCode.invalidParams,
        'Invalid handshake params',
        traceId: traceId,
      );
    }
    if (!protocols.contains(1)) {
      return _failure(
        request.id,
        ErrorCode.unsupportedProtocol,
        'Unsupported protocol',
        data: <String, Object?>{'supported': <int>[1]},
        traceId: traceId,
      );
    }

    _activeSid ??= _generateSid();
    _activeTrust = sessionTrust;
    if (document != null) _activeDocument = document;

    final advertisedMethods = <String, Object?>{};
    for (final entry in registry.entries) {
      if (sessionTrust == Trust.degraded && !entry.allowDegraded) continue;
      advertisedMethods[entry.method] = <String, Object?>{
        'versions': entry.versions,
      };
    }

    final features = <String>[
      if (supportsCancel) 'cancel',
      if (supportsCallbacks) 'callbacks',
      if (supportsReverse) 'reverse',
    ];

    final hostInfo = <String, Object?>{
      'platform': platform,
      'name': hostName,
      'version': hostVersion,
      if (appId != null) 'appId': appId,
      if (appVersion != null) 'appVersion': appVersion,
    };

    return _success(
      request.id,
      <String, Object?>{
        'jsb': '1.0',
        'sid': _activeSid!,
        'host': hostInfo,
        'capabilities': <String, Object?>{
          'methods': advertisedMethods,
          'events': _advertisedEvents,
          'features': features,
        },
        'limits': limits.toJson(),
      },
      sid: _activeSid!,
      traceId: traceId,
    );
  }

  String _controlSubscription(
    String method,
    RpcRequest request,
    String sessionSid,
    String? traceId,
  ) {
    final events = _readQualifiedNameList(request.params, 'events');
    if (events == null) {
      return _failure(
        request.id,
        ErrorCode.invalidParams,
        'Invalid event subscription params',
        sid: sessionSid,
        traceId: traceId,
      );
    }

    if (method == _unsubscribeMethod) {
      final response = _success(
        request.id,
        <String, Object?>{'unsubscribed': events},
        sid: sessionSid,
        traceId: traceId,
      );
      if (_exceedsMessageLimit(response)) {
        return _failure(
          request.id,
          ErrorCode.payloadTooLarge,
          'Payload too large',
          sid: sessionSid,
          traceId: traceId,
        );
      }
      _subscriptions.removeAll(events);
      return response;
    }

    final subscribed = <String>[];
    final denied = <String>[];
    for (final event in events) {
      if (_allowedEvents.contains(event) && !_deniedEvents.contains(event)) {
        subscribed.add(event);
      } else {
        denied.add(event);
      }
    }
    final response = _success(
      request.id,
      <String, Object?>{'subscribed': subscribed, 'denied': denied},
      sid: sessionSid,
      traceId: traceId,
    );
    if (_exceedsMessageLimit(response)) {
      return _failure(
        request.id,
        ErrorCode.payloadTooLarge,
        'Payload too large',
        sid: sessionSid,
        traceId: traceId,
      );
    }
    _subscriptions.addAll(subscribed);
    return response;
  }

  String _controlRegisterWebMethods(
    RpcRequest request,
    String sessionSid,
    String? traceId,
  ) {
    final methods = _readQualifiedNameList(
      request.params,
      'methods',
      allowEmpty: true,
    );
    if (methods == null) {
      return _failure(
        request.id,
        ErrorCode.invalidParams,
        'Invalid web methods registration params',
        sid: sessionSid,
        traceId: traceId,
      );
    }
    _webMethods
      ..clear()
      ..addAll(methods);
    return _success(
      request.id,
      <String, Object?>{'registered': methods},
      sid: sessionSid,
      traceId: traceId,
    );
  }

  void _handleCancelNotification(Envelope envelope, RpcNotification rpc) {
    if (!supportsCancel || _activeSid == null || envelope.meta?.sid != _activeSid) {
      return;
    }
    final parsed = parseWireMethod(rpc.method);
    if (parsed.name != _cancelMethod ||
        (parsed.explicitVersion != null && parsed.explicitVersion != 1)) {
      return;
    }
    final params = rpc.params;
    if (params == null) return;
    final requestId = params['requestId'];
    final reason = params['reason'];
    if (requestId is! String ||
        requestId.isEmpty ||
        (reason != null && reason is! String)) {
      return;
    }
    final call = _inflight[requestId];
    if (call == null || call.sid != _activeSid) return;
    _cancelledIds.add(requestId);
    call.token.cancel(reason as String?);
  }

  void _handleInboundResponse(Envelope envelope, RpcMessage rpc) {
    if (_activeSid == null || envelope.meta?.sid != _activeSid) return;
    if (rpc is RpcSuccess) {
      final pending = _pendingReverse.remove(rpc.id);
      if (pending == null || pending.sid != _activeSid) return;
      pending.timer.cancel();
      if (!pending.completer.isCompleted) {
        pending.completer.complete(rpc.result);
      }
      return;
    }
    if (rpc is RpcFailure && rpc.id != null) {
      final pending = _pendingReverse.remove(rpc.id);
      if (pending == null || pending.sid != _activeSid) return;
      pending.timer.cancel();
      if (!pending.completer.isCompleted) {
        pending.completer.completeError(
          BridgeException(
            rpc.error.code,
            rpc.error.message,
            rpc.error.data,
          ),
        );
      }
    }
  }

  /// Processes a raw inbound Web → Host wire string and returns an optional response envelope.
  Future<String?> receiveRaw(String raw, {CallerInfo? caller}) async {
    if (!_authorizeCaller(caller)) return null;
    if (caller != null &&
        _activeDocument != null &&
        caller.document != _activeDocument) {
      return null;
    }
    if (_exceedsMessageLimit(raw)) return null;

    final recvMs = DateTime.now().millisecondsSinceEpoch;
    final Envelope envelope;
    try {
      envelope = decodeEnvelope(raw);
    } on WireDecodeException catch (error) {
      if (_activeSid != null && error.code == ErrorCode.parseError) {
        return _failure(null, error.code, error.message, sid: _activeSid);
      }
      return null;
    }

    final rpc = envelope.rpc;
    final meta = envelope.meta;

    if (rpc is RpcSuccess || rpc is RpcFailure) {
      _handleInboundResponse(envelope, rpc);
      return null;
    }

    if (rpc is RpcNotification) {
      _handleCancelNotification(envelope, rpc);
      return null;
    }

    final request = rpc as RpcRequest;
    final traceId = meta?.traceId;
    final parsed = parseWireMethod(request.method);
    final isHello = parsed.name == _helloMethod &&
        (parsed.explicitVersion == null || parsed.explicitVersion == 1);

    if (isHello) {
      if ((meta?.sid != null && meta!.sid != _activeSid) ||
          _helloIds.contains(request.id)) {
        return null;
      }
      _helloIds.add(request.id);
      if (meta?.timeout == 0) {
        return _failure(
          request.id,
          ErrorCode.invalidParams,
          'Invalid request timeout',
          sid: _activeSid,
          traceId: traceId,
        );
      }
      return _negotiate(
        request,
        caller?.trust ?? Trust.full,
        caller?.document,
        traceId,
      );
    }

    if (_activeSid == null ||
        meta?.sid != _activeSid ||
        _requestIds.contains(request.id)) {
      return null;
    }
    _requestIds.add(request.id);

    final replySid = _activeSid!;
    final replyDoc = caller?.document ?? _activeDocument;
    final isSubscribe = (parsed.name == _subscribeMethod ||
            parsed.name == _unsubscribeMethod) &&
        (parsed.explicitVersion == null || parsed.explicitVersion == 1);
    if (isSubscribe) {
      if (meta?.timeout == 0) {
        return _failure(
          request.id,
          ErrorCode.invalidParams,
          'Invalid request timeout',
          sid: replySid,
          traceId: traceId,
        );
      }
      return _controlSubscription(parsed.name, request, replySid, traceId);
    }

    final isRegisterWeb = parsed.name == _registerWebMethodsMethod &&
        (parsed.explicitVersion == null || parsed.explicitVersion == 1);
    if (isRegisterWeb && supportsReverse) {
      if (meta?.timeout == 0) {
        return _failure(
          request.id,
          ErrorCode.invalidParams,
          'Invalid request timeout',
          sid: replySid,
          traceId: traceId,
        );
      }
      return _controlRegisterWebMethods(request, replySid, traceId);
    }

    final entry = registry.lookup(parsed.name);
    if (entry == null) {
      return _failure(
        request.id,
        ErrorCode.methodNotFound,
        'Method not found',
        sid: replySid,
        traceId: traceId,
      );
    }
    if (_activeTrust == Trust.degraded && !entry.allowDegraded) {
      return _failure(
        request.id,
        ErrorCode.permissionDenied,
        'Method not allowed in degraded trust session',
        data: <String, Object?>{
          'reason': 'degraded_not_allowed',
          'method': parsed.name,
        },
        sid: replySid,
        traceId: traceId,
      );
    }
    final resolvedVersion = parsed.explicitVersion ?? entry.versions.first;
    if (!entry.versions.contains(resolvedVersion)) {
      return _failure(
        request.id,
        ErrorCode.methodNotFound,
        'Method version not supported',
        data: <String, Object?>{
          'reason': 'version_unsupported',
          'method': parsed.name,
        },
        sid: replySid,
        traceId: traceId,
      );
    }
    if (meta?.timeout == 0) {
      return _failure(
        request.id,
        ErrorCode.invalidParams,
        'Invalid request timeout',
        sid: replySid,
        traceId: traceId,
      );
    }

    final paramError = entry.validateParams?.call(request.params);
    if (paramError != null) {
      return _failure(
        request.id,
        ErrorCode.invalidParams,
        paramError,
        sid: replySid,
        traceId: traceId,
      );
    }

    final activeForMethod = _activeCounts[parsed.name] ?? 0;
    if (entry.concurrency == ConcurrencyMode.serial && activeForMethod > 0) {
      return _failure(
        request.id,
        ErrorCode.busy,
        'Busy',
        sid: replySid,
        traceId: traceId,
      );
    }
    if (_inflight.length >= limits.maxInflight) {
      return _failure(
        request.id,
        ErrorCode.rateLimited,
        'Rate limited',
        sid: replySid,
        traceId: traceId,
      );
    }

    final token = CancelToken();
    final call = _InflightCall(token, replySid);
    _inflight[request.id] = call;
    _activeCounts[parsed.name] = activeForMethod + 1;

    var nextSeq = 0;
    bool emitProgress([Object? chunk]) {
      if (!supportsCallbacks ||
          _activeSid != replySid ||
          token.isCancelled ||
          _inflight[request.id] != call) {
        return false;
      }
      if (_transport == null && _rawDeliver == null) return false;
      final String progressRaw;
      try {
        final params = <String, Object?>{
          'requestId': request.id,
          'seq': nextSeq,
          if (chunk != null) 'chunk': sanitizeJsonValue(chunk),
        };
        progressRaw = encodeEnvelope(
          Envelope(
            meta: EnvelopeMeta(sid: replySid),
            rpc: RpcNotification(method: _progressMethod, params: params),
          ),
        );
      } catch (_) {
        return false;
      }
      if (_exceedsMessageLimit(progressRaw) ||
          _activeSid != replySid ||
          token.isCancelled ||
          _inflight[request.id] != call) {
        return false;
      }
      nextSeq += 1;
      unawaited(_pushToWeb(progressRaw, replySid, replyDoc));
      return true;
    }

    final startMs = DateTime.now().millisecondsSinceEpoch;
    try {
      final ctx = BridgeContext(
        sid: replySid,
        id: request.id,
        method: parsed.name,
        version: resolvedVersion,
        traceId: traceId,
        origin: _activeTrust == Trust.full ? caller?.origin : null,
        isMainFrame: _activeTrust == Trust.full ? caller?.isMainFrame : null,
        trust: _activeTrust,
        cancel: token,
        callback: emitProgress,
      );
      final value = await entry.invoke(request.params, ctx);
      final endMs = DateTime.now().millisecondsSinceEpoch;

      if (_activeSid != replySid) return null;
      if (token.isCancelled) {
        return _failure(
          request.id,
          ErrorCode.cancelled,
          'Cancelled',
          sid: replySid,
          traceId: traceId,
        );
      }
      final response = _success(
        request.id,
        value,
        sid: replySid,
        traceId: traceId,
        timing: <String, Object?>{
          'recv': recvMs,
          'start': startMs,
          'end': endMs,
        },
      );
      if (_exceedsMessageLimit(response)) {
        return _failure(
          request.id,
          ErrorCode.payloadTooLarge,
          'Payload too large',
          sid: replySid,
          traceId: traceId,
        );
      }
      return response;
    } on BridgeException catch (error) {
      if (_activeSid != replySid) return null;
      if (token.isCancelled) {
        return _failure(
          request.id,
          ErrorCode.cancelled,
          'Cancelled',
          sid: replySid,
          traceId: traceId,
        );
      }
      return _failure(
        request.id,
        error.code,
        error.message,
        data: error.data,
        sid: replySid,
        traceId: traceId,
      );
    } catch (_) {
      if (_activeSid != replySid) return null;
      if (token.isCancelled) {
        return _failure(
          request.id,
          ErrorCode.cancelled,
          'Cancelled',
          sid: replySid,
          traceId: traceId,
        );
      }
      return _failure(
        request.id,
        ErrorCode.internalError,
        'Internal error',
        sid: replySid,
        traceId: traceId,
      );
    } finally {
      if (_inflight[request.id] == call) {
        _inflight.remove(request.id);
      }
      final current = _activeCounts[parsed.name] ?? 0;
      if (current <= 1) {
        _activeCounts.remove(parsed.name);
      } else {
        _activeCounts[parsed.name] = current - 1;
      }
    }
  }

  /// Pushes a `bridge.event` notification to the active subscribed document (protocol E1).
  Future<bool> emit(String name, Object? payload) async {
    final currentSid = _activeSid;
    final currentDoc = _activeDocument;
    if (currentSid == null || !_subscriptions.contains(name)) return false;

    final String raw;
    try {
      raw = encodeEnvelope(
        Envelope(
          meta: EnvelopeMeta(sid: currentSid),
          rpc: RpcNotification(
            method: _eventMethod,
            params: <String, Object?>{
              'name': name,
              'payload': sanitizeJsonValue(payload),
            },
          ),
        ),
      );
    } catch (_) {
      return false;
    }
    return _pushToWeb(raw, currentSid, currentDoc);
  }

  /// Invokes a Web-registered handler via Host → Web JSON-RPC request (protocol §9.2).
  Future<Object?> callWeb(
    String method, {
    Map<String, Object?>? params,
    Duration? timeout,
    String? traceId,
  }) async {
    if (!qualifiedNamePattern.hasMatch(method)) {
      throw const BridgeException(
        ErrorCode.invalidParams,
        'Invalid method name',
      );
    }
    final currentSid = _activeSid;
    final currentDoc = _activeDocument;
    if (currentSid == null || (_transport == null && _rawDeliver == null)) {
      throw const BridgeException(
        ErrorCode.unavailable,
        'No active session',
      );
    }

    final timeoutMs = timeout?.inMilliseconds ?? limits.defaultTimeoutMs;
    if (timeoutMs <= 0) {
      throw const BridgeException(
        ErrorCode.invalidParams,
        'Expected a positive timeout',
      );
    }

    final id = 'n-${++_nextOutboundId}';
    final String raw;
    try {
      raw = encodeEnvelope(
        Envelope(
          meta: EnvelopeMeta(
            sid: currentSid,
            timeout: timeoutMs,
            ts: DateTime.now().millisecondsSinceEpoch,
            traceId: traceId,
          ),
          rpc: RpcRequest(
            id: id,
            method: method,
            params: params == null
                ? null
                : sanitizeJsonValue(params) as Map<String, Object?>,
          ),
        ),
      );
    } catch (_) {
      throw const BridgeException(
        ErrorCode.invalidParams,
        'Expected JSON params',
      );
    }

    if (_exceedsMessageLimit(raw)) {
      throw const BridgeException(
        ErrorCode.payloadTooLarge,
        'Call exceeds negotiated byte limit',
      );
    }

    final completer = Completer<Object?>();
    final timer = Timer(Duration(milliseconds: timeoutMs), () {
      final pending = _pendingReverse.remove(id);
      if (pending == null) return;
      if (_activeSid == currentSid && supportsCancel) {
        final cancelRaw = encodeEnvelope(
          Envelope(
            meta: EnvelopeMeta(sid: currentSid),
            rpc: RpcNotification(
              method: _cancelMethod,
              params: <String, Object?>{'requestId': id, 'reason': 'timeout'},
            ),
          ),
        );
        unawaited(_pushToWeb(cancelRaw, currentSid, currentDoc));
      }
      if (!pending.completer.isCompleted) {
        pending.completer.completeError(
          const BridgeException(ErrorCode.timeout, 'Reverse call timed out'),
        );
      }
    });

    _pendingReverse[id] = _PendingReverseCall(
      sid: currentSid,
      completer: completer,
      timer: timer,
    );

    final delivered = await _pushToWeb(raw, currentSid, currentDoc);
    if (!delivered) {
      final pending = _pendingReverse.remove(id);
      pending?.timer.cancel();
      if (!completer.isCompleted) {
        completer.completeError(
          const BridgeException(
            ErrorCode.unavailable,
            'Failed to deliver reverse call',
          ),
        );
      }
    }

    return completer.future;
  }
}
