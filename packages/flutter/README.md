# `open_jsbridge_flutter`

Pure Dart **Scheme A** host implementation for [Open JSBridge (`jsb 1.0`)](../../docs/flutter.md).

- **Zero runtime dependencies**: drop into any Flutter app without WebView plugin version lock-in.
- **Protocol-complete core (`OJSBridge` / `BridgeCore`)**: JSON-RPC 2.0 `jsb: "1.0"` envelope codec, safe-integer bounds, `__proto__` stripping (preserving `constructor` & `prototype`), idempotent `bridge.hello` handshake, request deduplication, `bridge.subscribe` / `bridge.unsubscribe` / `bridge.event`, `bridge.cancel`, `bridge.progress`, `ConcurrencyMode.serial`, `limits.maxMessageBytes` / `maxInflight`, and Host → Web `callWeb`.
- **Secure by default (protocol S1–S4)**:
  - `OriginAllowlist` accepts only exact HTTPS origins (`https://host[:port]`).
  - `Trust.degraded` channels (`webview_flutter`, default `flutter_inappwebview` `callHandler`) are **disabled by default** unless `allowDegradedTransport: true` is explicitly configured and only expose handlers marked `allowDegraded: true`.
  - Host → Web script delivery double-encodes envelopes via `encodeReceiveScript` (escaping `U+2028` / `U+2029`) and checks document identity before delivery.

## Quick Start (`flutter_inappwebview`)

```dart
import 'package:open_jsbridge_flutter/open_jsbridge_flutter.dart';

final registry = HandlerRegistry()
  ..on(
    'device.getInfo',
    (params, ctx) => {'os': 'android', 'osVersion': '15'},
    allowDegraded: true,
  );

final bridge = OJSBridge(
  registry: registry,
  allowedOrigins: OriginAllowlist(['https://m.acme.com']),
  // Protocol S2: explicitly opt in only when you enforce navigation & frame isolation.
  allowDegradedTransport: true,
  events: ['network.statusChanged'],
);

final transport = InAppWebViewTransport(
  evaluateJavascript: (script) async {
    await controller.evaluateJavascript(source: script);
  },
);
bridge.attachTransport(transport);

// Inject bridge.shimFor(transport, initialUrl: initialUri) at AT_DOCUMENT_START (forMainFrameOnly: true).
// Wire addJavaScriptHandler(handlerName: 'ojsb', callback: (args) => transport.handleCallHandler(args[0] as String)).
// Call transport.onDocumentCommit(url) on main-frame commit and transport.onProcessTerminated() on render crash.
```

## Verification

Run static analysis and all Dart conformance & host tests (zero external pub dependencies required):

```sh
cd packages/flutter
dart pub get --offline
dart analyze --fatal-infos --fatal-warnings
dart run test/all_tests.dart
```

From the repository root, Node conformance tests also validate the exported Flutter JS shims:

```sh
node --test conformance-tests/flutter-shim.test.mjs
```
