import 'dart:convert';

final RegExp _jsIdentifierPattern = RegExp(r'^[A-Za-z_$][A-Za-z0-9_$]*$');

/// Host shim for `flutter_inappwebview` injected at `AT_DOCUMENT_START` (docs/flutter.md §3).
///
/// Guards against non-main frames, freezes `window.__OJSB_TRANSPORT__`, buffers
/// early messages in `window.__OJSB_RECEIVE__`, and awaits
/// `flutterInAppWebViewPlatformReady` if `callHandler` is not ready yet.
const String ojsbInAppWebViewShim = r'''(function () {
  if (window.__OJSB_TRANSPORT__) return;
  if (window.top && window.top !== window) return;
  var buf = [], recv;
  function deliver(m) { recv ? recv(m) : (buf.length < 256 && buf.push(m)); }
  function sendToFlutter(s) {
    if (window.flutter_inappwebview && typeof window.flutter_inappwebview.callHandler === 'function') {
      return window.flutter_inappwebview.callHandler('ojsb', s);
    }
    return new Promise(function (resolve, reject) {
      function onReady() {
        window.removeEventListener('flutterInAppWebViewPlatformReady', onReady);
        if (!window.flutter_inappwebview || typeof window.flutter_inappwebview.callHandler !== 'function') {
          reject(new Error('flutter_inappwebview bridge unavailable'));
          return;
        }
        Promise.resolve(window.flutter_inappwebview.callHandler('ojsb', s)).then(resolve, reject);
      }
      window.addEventListener('flutterInAppWebViewPlatformReady', onReady, { once: true });
    });
  }
  var t = Object.freeze({
    name: 'flutter',
    protocols: Object.freeze([1]),
    postMessage: sendToFlutter
  });
  Object.defineProperty(window, '__OJSB_TRANSPORT__', { value: t, writable: false, configurable: false });
  Object.defineProperty(window, '__OJSB_RECEIVE__', {
    configurable: false,
    get: function () { return deliver; },
    set: function (fn) {
      recv = typeof fn === 'function' ? fn : undefined;
      if (!recv) return;
      var q = buf; buf = [];
      q.forEach(function (m) {
        try { deliver(m); } catch (e) { setTimeout(function () { throw e; }); }
      });
    }
  });
  window.dispatchEvent(new CustomEvent('ojsb:transportready'));
})();''';

/// Builds a Host shim for `webview_flutter` using a `JavaScriptChannel` (docs/flutter.md §3).
///
/// The channel `postMessage` returns `undefined`; replies are pushed back by Dart via
/// [encodeReceiveScript] and `controller.runJavaScript(...)`.
String buildWebviewFlutterShim({String channelName = 'OjsbChannel'}) {
  if (!_jsIdentifierPattern.hasMatch(channelName)) {
    throw ArgumentError.value(
      channelName,
      'channelName',
      'Expected a valid JavaScript identifier',
    );
  }
  return '''(function () {
  if (window.__OJSB_TRANSPORT__) return;
  if (window.top && window.top !== window) return;
  var ch = window.$channelName;
  if (!ch || typeof ch.postMessage !== 'function') return;
  var buf = [], recv;
  function deliver(m) { recv ? recv(m) : (buf.length < 256 && buf.push(m)); }
  var t = Object.freeze({
    name: 'flutter',
    protocols: Object.freeze([1]),
    postMessage: function (s) { ch.postMessage(s); }
  });
  Object.defineProperty(window, '__OJSB_TRANSPORT__', { value: t, writable: false, configurable: false });
  Object.defineProperty(window, '__OJSB_RECEIVE__', {
    configurable: false,
    get: function () { return deliver; },
    set: function (fn) {
      recv = typeof fn === 'function' ? fn : undefined;
      if (!recv) return;
      var q = buf; buf = [];
      q.forEach(function (m) {
        try { deliver(m); } catch (e) { setTimeout(function () { throw e; }); }
      });
    }
  });
  window.dispatchEvent(new CustomEvent('ojsb:transportready'));
})();''';
}

/// Default `webview_flutter` Host shim using channel name `OjsbChannel`.
final String ojsbWebviewFlutterShim = buildWebviewFlutterShim();

/// Encodes an envelope JSON string for safe injection via `evaluateJavascript` / `runJavaScript`.
///
/// Follows protocol §11.5: double-encodes the envelope text as a JS string literal
/// and escapes U+2028 / U+2029 line separators.
String encodeReceiveScript(String envelopeJson) {
  final literal = jsonEncode(envelopeJson)
      .replaceAll('\u2028', r'\u2028')
      .replaceAll('\u2029', r'\u2029');
  return 'window.__OJSB_RECEIVE__&&window.__OJSB_RECEIVE__($literal);';
}
