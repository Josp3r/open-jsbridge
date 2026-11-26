/// Standard JSON-RPC 2.0 and Open JSBridge protocol error codes.
abstract final class ErrorCode {
  static const int parseError = -32700;
  static const int invalidRequest = -32600;
  static const int methodNotFound = -32601;
  static const int invalidParams = -32602;
  static const int internalError = -32603;

  static const int unavailable = -32000;
  static const int timeout = -32001;
  static const int cancelled = -32002;
  static const int permissionDenied = -32003;
  static const int unsupportedProtocol = -32004;
  static const int notReady = -32005;
  static const int payloadTooLarge = -32006;
  static const int userDenied = -32007;
  static const int rateLimited = -32008;
  static const int sessionExpired = -32009;
  static const int busy = -32010;
}

/// Application or protocol error thrown by a Dart handler or reverse call.
class BridgeException implements Exception {
  final int code;
  final String message;
  final Object? data;

  const BridgeException(this.code, this.message, [this.data]);

  static const BridgeException userDenied =
      BridgeException(ErrorCode.userDenied, 'User denied');
  static const BridgeException permissionDenied =
      BridgeException(ErrorCode.permissionDenied, 'Permission denied');
  static const BridgeException cancelled =
      BridgeException(ErrorCode.cancelled, 'Cancelled');
  static const BridgeException unavailable =
      BridgeException(ErrorCode.unavailable, 'Unavailable');

  @override
  String toString() => 'BridgeException($code, $message)';
}

/// Wire-level decoding or validation failure (-32700 or -32600).
class WireDecodeException implements Exception {
  final int code;
  final String message;
  final Object? cause;

  const WireDecodeException(this.code, this.message, [this.cause]);

  @override
  String toString() => 'WireDecodeException($code, $message)';
}
