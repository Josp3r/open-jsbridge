import 'dart:async';

import 'protocol.dart';
import 'transport.dart';

/// Cooperative cancellation token passed to Dart handlers via [BridgeContext].
class CancelToken {
  final Completer<String?> _completer = Completer<String?>();
  final List<void Function(String? reason)> _listeners =
      <void Function(String? reason)>[];
  bool _cancelled = false;
  String? _reason;

  bool get isCancelled => _cancelled;
  String? get reason => _reason;
  Future<String?> get onCancel => _completer.future;

  void addListener(void Function(String? reason) listener) {
    if (_cancelled) {
      listener(_reason);
      return;
    }
    _listeners.add(listener);
  }

  void removeListener(void Function(String? reason) listener) {
    _listeners.remove(listener);
  }

  /// Triggers cancellation once and notifies all listeners.
  void cancel([String? reason]) {
    if (_cancelled) return;
    _cancelled = true;
    _reason = reason;
    if (!_completer.isCompleted) {
      _completer.complete(reason);
    }
    final snapshot = List<void Function(String? reason)>.of(_listeners);
    _listeners.clear();
    for (final listener in snapshot) {
      try {
        listener(reason);
      } catch (_) {
        // Isolate listener errors during cancellation cleanup.
      }
    }
  }
}

/// Execution context supplied to every registered Dart handler (docs/flutter.md §4).
class BridgeContext {
  final String sid;
  final String id;
  final String method;
  final int version;
  final String? traceId;

  /// Verified caller origin; `null` in degraded sessions.
  final Uri? origin;

  /// Verified main-frame flag; `null` in degraded sessions.
  final bool? isMainFrame;

  final Trust trust;
  final CancelToken cancel;

  /// Emits an ordered `bridge.progress` notification for this request.
  /// Returns `true` iff the progress frame was accepted for delivery.
  final bool Function([Object? chunk]) callback;

  const BridgeContext({
    required this.sid,
    required this.id,
    required this.method,
    required this.version,
    required this.trust,
    required this.cancel,
    required this.callback,
    this.traceId,
    this.origin,
    this.isMainFrame,
  });
}

/// Concurrency mode for a registered method (`x-ojsb-concurrency`).
enum ConcurrencyMode { parallel, serial }

typedef RawBridgeHandler = FutureOr<Object?> Function(
  Map<String, Object?>? params,
  BridgeContext ctx,
);

typedef ParamsValidator = String? Function(Map<String, Object?>? params);

/// Typed handler interface matching `docs/flutter.md` §4.
abstract class BridgeHandler<P, R> {
  String get method;
  List<int> get versions => const <int>[1];
  ConcurrencyMode get concurrency => ConcurrencyMode.parallel;

  /// Whether this method may be advertised and called in a `Trust.degraded` session (protocol S2).
  bool get allowDegraded => false;

  P decode(Map<String, Object?> json);
  Object? encode(R result);
  Future<R> handle(P params, BridgeContext ctx);
}

/// Internal normalized registration entry inside [HandlerRegistry].
class RegisteredMethod {
  final String method;
  final List<int> versions;
  final ConcurrencyMode concurrency;
  final bool allowDegraded;
  final ParamsValidator? validateParams;
  final RawBridgeHandler invoke;

  const RegisteredMethod({
    required this.method,
    required this.versions,
    required this.concurrency,
    required this.allowDegraded,
    required this.invoke,
    this.validateParams,
  });
}

List<int> _normalizeVersions(Iterable<int>? versions) {
  if (versions == null) return const <int>[1];
  final unique = <int>{};
  for (final v in versions) {
    if (isPositiveSafeInteger(v)) unique.add(v);
  }
  if (unique.isEmpty) return const <int>[1];
  final sorted = unique.toList()..sort();
  return List<int>.unmodifiable(sorted);
}

/// Registry of Dart handlers exposed to Web callers.
class HandlerRegistry {
  final Map<String, RegisteredMethod> _methods = <String, RegisteredMethod>{};

  /// Registers a typed [BridgeHandler].
  void register<P, R>(BridgeHandler<P, R> handler) {
    if (!qualifiedNamePattern.hasMatch(handler.method)) {
      throw ArgumentError.value(
        handler.method,
        'handler.method',
        'Invalid qualified method name',
      );
    }
    _methods[handler.method] = RegisteredMethod(
      method: handler.method,
      versions: _normalizeVersions(handler.versions),
      concurrency: handler.concurrency,
      allowDegraded: handler.allowDegraded,
      invoke: (params, ctx) async {
        final decoded = handler.decode(params ?? const <String, Object?>{});
        final result = await handler.handle(decoded, ctx);
        return handler.encode(result);
      },
    );
  }

  /// Registers a lightweight closure handler.
  void on(
    String method,
    RawBridgeHandler handler, {
    List<int> versions = const <int>[1],
    ConcurrencyMode concurrency = ConcurrencyMode.parallel,
    bool allowDegraded = false,
    ParamsValidator? validateParams,
  }) {
    if (!qualifiedNamePattern.hasMatch(method)) {
      throw ArgumentError.value(method, 'method', 'Invalid qualified method name');
    }
    _methods[method] = RegisteredMethod(
      method: method,
      versions: _normalizeVersions(versions),
      concurrency: concurrency,
      allowDegraded: allowDegraded,
      validateParams: validateParams,
      invoke: handler,
    );
  }

  /// Removes [method] from the registry. Returns true if it was registered.
  bool unregister(String method) => _methods.remove(method) != null;

  bool contains(String method) => _methods.containsKey(method);

  RegisteredMethod? lookup(String method) => _methods[method];

  Iterable<RegisteredMethod> get entries => _methods.values;
}
