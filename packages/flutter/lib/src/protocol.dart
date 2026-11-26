import 'dart:convert';

import 'errors.dart';

/// Maximum safe IEEE-754 integer (2^53 - 1) shared across JS, iOS, Android, and Dart.
const int maxSafeJsonInteger = 9007199254740991;
const int minSafeJsonInteger = -9007199254740991;

final RegExp qualifiedNamePattern =
    RegExp(r'^(?!rpc\.)[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$');

final RegExp wireMethodPattern = RegExp(
  r'^(?!rpc\.)[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+(@[1-9][0-9]*)?$',
);

final RegExp notificationOnlyMethodPattern =
    RegExp(r'^bridge\.(cancel|event|progress)(@[1-9][0-9]*)?$');

final RegExp versionSuffixPattern = RegExp(r'@([1-9][0-9]*)$');

/// Returns true if [value] is an exact JSON integer within IEEE-754 safe bounds.
bool isSafeJsonInteger(Object? value) {
  if (value is int) {
    return value >= minSafeJsonInteger && value <= maxSafeJsonInteger;
  }
  if (value is double) {
    return value.isFinite &&
        value == value.truncateToDouble() &&
        value >= minSafeJsonInteger &&
        value <= maxSafeJsonInteger;
  }
  return false;
}

/// Returns true if [value] is a positive safe JSON integer (>= 1).
bool isPositiveSafeInteger(Object? value) {
  if (!isSafeJsonInteger(value)) return false;
  return (value! as num) >= 1;
}

/// Returns true if [value] is a non-negative safe JSON integer (>= 0).
bool isNonNegativeSafeInteger(Object? value) {
  if (!isSafeJsonInteger(value)) return false;
  return (value! as num) >= 0;
}

/// Returns true if [value] is a valid JSON-RPC string id (1..128 Unicode code points, <= 256 UTF-16 code units).
bool isValidRpcId(Object? value) {
  if (value is! String) return false;
  if (value.isEmpty || value.length > 256) return false;
  final codePoints = value.runes.length;
  return codePoints >= 1 && codePoints <= 128;
}

/// Splits a wire method string like `device.getInfo@2` into base name and optional explicit version.
({String name, int? explicitVersion}) parseWireMethod(String wireMethod) {
  final match = versionSuffixPattern.firstMatch(wireMethod);
  if (match == null) return (name: wireMethod, explicitVersion: null);
  return (
    name: wireMethod.substring(0, match.start),
    explicitVersion: int.parse(match.group(1)!),
  );
}

void _checkJsonNumber(num value) {
  if (value is int) {
    if (value < minSafeJsonInteger || value > maxSafeJsonInteger) {
      throw const WireDecodeException(
        ErrorCode.invalidRequest,
        'Number is outside the supported JSON range',
      );
    }
    return;
  }
  final d = value as double;
  if (!d.isFinite ||
      (d == d.truncateToDouble() &&
          (d < minSafeJsonInteger || d > maxSafeJsonInteger))) {
    throw const WireDecodeException(
      ErrorCode.invalidRequest,
      'Number is outside the supported JSON range',
    );
  }
}

/// Recursively validates JSON values, enforces portable number bounds, and strips only `__proto__` keys.
Object? sanitizeJsonValue(Object? value, {Set<Object>? ancestors}) {
  if (value == null || value is bool || value is String) return value;
  if (value is num) {
    _checkJsonNumber(value);
    return value;
  }
  final seen = ancestors ?? Set<Object>.identity();
  if (value is List) {
    if (!seen.add(value)) {
      throw const WireDecodeException(
        ErrorCode.invalidRequest,
        'Expected an acyclic JSON value',
      );
    }
    try {
      return List<Object?>.generate(
        value.length,
        (index) => sanitizeJsonValue(value[index], ancestors: seen),
        growable: false,
      );
    } finally {
      seen.remove(value);
    }
  }
  if (value is Map) {
    if (!seen.add(value)) {
      throw const WireDecodeException(
        ErrorCode.invalidRequest,
        'Expected an acyclic JSON value',
      );
    }
    try {
      final result = <String, Object?>{};
      for (final entry in value.entries) {
        final key = entry.key;
        if (key is! String) {
          throw const WireDecodeException(
            ErrorCode.invalidRequest,
            'Expected a string JSON property name',
          );
        }
        // Filter only `__proto__`; preserve `constructor` and `prototype` (protocol D-003).
        if (key == '__proto__') continue;
        result[key] = sanitizeJsonValue(entry.value, ancestors: seen);
      }
      return result;
    } finally {
      seen.remove(value);
    }
  }
  throw const WireDecodeException(
    ErrorCode.invalidRequest,
    'Expected a plain JSON value',
  );
}

/// Optional envelope metadata block.
class EnvelopeMeta {
  final String? sid;
  final int? timeout;
  final int? ts;
  final String? traceId;
  final Map<String, Object?> extra;

  const EnvelopeMeta({
    this.sid,
    this.timeout,
    this.ts,
    this.traceId,
    this.extra = const <String, Object?>{},
  });

  Map<String, Object?> toJson() {
    final map = <String, Object?>{...extra};
    if (sid != null) map['sid'] = sid;
    if (timeout != null) map['timeout'] = timeout;
    if (ts != null) map['ts'] = ts;
    if (traceId != null) map['traceId'] = traceId;
    return map;
  }
}

/// Base type for inner JSON-RPC 2.0 messages.
sealed class RpcMessage {
  const RpcMessage();
  Map<String, Object?> toJson();
}

/// JSON-RPC 2.0 request (carries a string `id`).
class RpcRequest extends RpcMessage {
  final String id;
  final String method;
  final Map<String, Object?>? params;

  const RpcRequest({required this.id, required this.method, this.params});

  @override
  Map<String, Object?> toJson() => <String, Object?>{
        'jsonrpc': '2.0',
        'id': id,
        'method': method,
        if (params != null) 'params': params,
      };
}

/// JSON-RPC 2.0 notification (omits `id`).
class RpcNotification extends RpcMessage {
  final String method;
  final Map<String, Object?>? params;

  const RpcNotification({required this.method, this.params});

  @override
  Map<String, Object?> toJson() => <String, Object?>{
        'jsonrpc': '2.0',
        'method': method,
        if (params != null) 'params': params,
      };
}

/// JSON-RPC 2.0 success response.
class RpcSuccess extends RpcMessage {
  final String id;
  final Object? result;

  const RpcSuccess({required this.id, required this.result});

  @override
  Map<String, Object?> toJson() => <String, Object?>{
        'jsonrpc': '2.0',
        'id': id,
        'result': result,
      };
}

/// JSON-RPC 2.0 error object.
class RpcErrorObject {
  final int code;
  final String message;
  final Object? data;
  final bool hasData;

  const RpcErrorObject({
    required this.code,
    required this.message,
    this.data,
    this.hasData = false,
  });

  Map<String, Object?> toJson() => <String, Object?>{
        'code': code,
        'message': message,
        if (hasData || data != null) 'data': data,
      };
}

/// JSON-RPC 2.0 error response (`id` may be `null` only for uncorrelated diagnostics).
class RpcFailure extends RpcMessage {
  final String? id;
  final RpcErrorObject error;

  const RpcFailure({required this.id, required this.error});

  @override
  Map<String, Object?> toJson() => <String, Object?>{
        'jsonrpc': '2.0',
        'id': id,
        'error': error.toJson(),
      };
}

/// Outer `jsb: "1.0"` envelope wrapping a single JSON-RPC 2.0 message.
class Envelope {
  final String jsb;
  final EnvelopeMeta? meta;
  final RpcMessage rpc;
  final Map<String, Object?> extra;

  const Envelope({
    this.jsb = '1.0',
    this.meta,
    required this.rpc,
    this.extra = const <String, Object?>{},
  });

  Map<String, Object?> toJson() {
    final map = <String, Object?>{...extra, 'jsb': jsb};
    if (meta != null) {
      final metaMap = meta!.toJson();
      if (metaMap.isNotEmpty) map['meta'] = metaMap;
    }
    map['rpc'] = rpc.toJson();
    return map;
  }
}

bool _hasOnlyKeys(Map<String, Object?> map, Set<String> allowed) {
  for (final key in map.keys) {
    if (!allowed.contains(key)) return false;
  }
  return true;
}

EnvelopeMeta _parseMeta(Object? value) {
  if (value is! Map<String, Object?>) {
    throw const WireDecodeException(
      ErrorCode.invalidRequest,
      'Invalid request',
    );
  }
  String? sid;
  if (value.containsKey('sid')) {
    final rawSid = value['sid'];
    if (rawSid is! String || rawSid.isEmpty) {
      throw const WireDecodeException(
        ErrorCode.invalidRequest,
        'Invalid request',
      );
    }
    sid = rawSid;
  }
  int? timeout;
  if (value.containsKey('timeout')) {
    final rawTimeout = value['timeout'];
    if (!isNonNegativeSafeInteger(rawTimeout)) {
      throw const WireDecodeException(
        ErrorCode.invalidRequest,
        'Invalid request',
      );
    }
    timeout = (rawTimeout! as num).toInt();
  }
  int? ts;
  if (value.containsKey('ts')) {
    final rawTs = value['ts'];
    if (!isNonNegativeSafeInteger(rawTs)) {
      throw const WireDecodeException(
        ErrorCode.invalidRequest,
        'Invalid request',
      );
    }
    ts = (rawTs! as num).toInt();
  }
  String? traceId;
  if (value.containsKey('traceId')) {
    final rawTrace = value['traceId'];
    if (rawTrace is! String) {
      throw const WireDecodeException(
        ErrorCode.invalidRequest,
        'Invalid request',
      );
    }
    traceId = rawTrace;
  }
  final extra = <String, Object?>{};
  for (final entry in value.entries) {
    if (entry.key != 'sid' &&
        entry.key != 'timeout' &&
        entry.key != 'ts' &&
        entry.key != 'traceId') {
      extra[entry.key] = entry.value;
    }
  }
  return EnvelopeMeta(
    sid: sid,
    timeout: timeout,
    ts: ts,
    traceId: traceId,
    extra: extra,
  );
}

RpcMessage _parseRpc(Object? value) {
  if (value is! Map<String, Object?> || value['jsonrpc'] != '2.0') {
    throw const WireDecodeException(
      ErrorCode.invalidRequest,
      'Invalid request',
    );
  }
  if (value.containsKey('method')) {
    if (!_hasOnlyKeys(value, const {'jsonrpc', 'method', 'params', 'id'})) {
      throw const WireDecodeException(
        ErrorCode.invalidRequest,
        'Invalid request',
      );
    }
    final method = value['method'];
    if (method is! String || !wireMethodPattern.hasMatch(method)) {
      throw const WireDecodeException(
        ErrorCode.invalidRequest,
        'Invalid request',
      );
    }
    Map<String, Object?>? params;
    if (value.containsKey('params')) {
      final rawParams = value['params'];
      if (rawParams is! Map<String, Object?>) {
        throw const WireDecodeException(
          ErrorCode.invalidRequest,
          'Invalid request',
        );
      }
      params = rawParams;
    }
    if (value.containsKey('id')) {
      final id = value['id'];
      if (notificationOnlyMethodPattern.hasMatch(method) || !isValidRpcId(id)) {
        throw const WireDecodeException(
          ErrorCode.invalidRequest,
          'Invalid request',
        );
      }
      return RpcRequest(id: id! as String, method: method, params: params);
    }
    return RpcNotification(method: method, params: params);
  }

  if (value.containsKey('error')) {
    if (!_hasOnlyKeys(value, const {'jsonrpc', 'id', 'error'}) ||
        !value.containsKey('id')) {
      throw const WireDecodeException(
        ErrorCode.invalidRequest,
        'Invalid request',
      );
    }
    final id = value['id'];
    if (id != null && !isValidRpcId(id)) {
      throw const WireDecodeException(
        ErrorCode.invalidRequest,
        'Invalid request',
      );
    }
    final error = value['error'];
    if (error is! Map<String, Object?> ||
        !_hasOnlyKeys(error, const {'code', 'message', 'data'})) {
      throw const WireDecodeException(
        ErrorCode.invalidRequest,
        'Invalid request',
      );
    }
    final code = error['code'];
    final message = error['message'];
    if (!isSafeJsonInteger(code) || message is! String) {
      throw const WireDecodeException(
        ErrorCode.invalidRequest,
        'Invalid request',
      );
    }
    return RpcFailure(
      id: id as String?,
      error: RpcErrorObject(
        code: (code! as num).toInt(),
        message: message,
        data: error['data'],
        hasData: error.containsKey('data'),
      ),
    );
  }

  if (!_hasOnlyKeys(value, const {'jsonrpc', 'id', 'result'}) ||
      !value.containsKey('result') ||
      !isValidRpcId(value['id'])) {
    throw const WireDecodeException(
      ErrorCode.invalidRequest,
      'Invalid request',
    );
  }
  return RpcSuccess(id: value['id']! as String, result: value['result']);
}

/// Decodes and validates a single JSON-RPC 2.0 `jsb: "1.0"` wire envelope.
Envelope decodeEnvelope(String raw) {
  final Object? decoded;
  try {
    decoded = jsonDecode(raw);
  } catch (cause) {
    throw WireDecodeException(ErrorCode.parseError, 'Parse error', cause);
  }
  final sanitized = sanitizeJsonValue(decoded);
  if (sanitized is! Map<String, Object?> || sanitized['jsb'] != '1.0') {
    throw const WireDecodeException(
      ErrorCode.invalidRequest,
      'Invalid request',
    );
  }
  final meta = sanitized.containsKey('meta') ? _parseMeta(sanitized['meta']) : null;
  final rpc = _parseRpc(sanitized['rpc']);
  final extra = <String, Object?>{};
  for (final entry in sanitized.entries) {
    if (entry.key != 'jsb' && entry.key != 'meta' && entry.key != 'rpc') {
      extra[entry.key] = entry.value;
    }
  }
  return Envelope(jsb: '1.0', meta: meta, rpc: rpc, extra: extra);
}

/// Validates and serializes a single `jsb: "1.0"` wire envelope into JSON text.
String encodeEnvelope(Envelope envelope) {
  final map = sanitizeJsonValue(envelope.toJson());
  if (map is! Map<String, Object?> || map['jsb'] != '1.0') {
    throw const WireDecodeException(
      ErrorCode.invalidRequest,
      'Invalid request',
    );
  }
  if (map.containsKey('meta')) _parseMeta(map['meta']);
  _parseRpc(map['rpc']);
  return jsonEncode(map);
}
