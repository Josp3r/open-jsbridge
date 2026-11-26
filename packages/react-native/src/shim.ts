/**
 * Host Shim injected via react-native-webview `injectedJavaScriptBeforeContentLoaded`.
 * Satisfies protocol §2 (frozen transport, buffered __OJSB_RECEIVE__, ojsb:transportready)
 * and guards against non-main-frame execution.
 */
export const OJSB_RN_SHIM = `(function () {
  if (window.__OJSB_TRANSPORT__ || !window.ReactNativeWebView) return;
  if (window.top && window.top !== window) return;
  var buf = [], recv;
  function deliver(m) { recv ? recv(m) : (buf.length < 256 && buf.push(m)); }
  var t = Object.freeze({
    name: 'rn',
    protocols: Object.freeze([1]),
    postMessage: function (s) { window.ReactNativeWebView.postMessage(s); }
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
})(); true;`;

/**
 * Encodes an envelope JSON string for safe injection into WebView via injectJavaScript (protocol §11.5).
 * Double-encodes the string literal and escapes U+2028 / U+2029 line separators.
 */
export function encodeReceiveScript(envelopeJson: string): string {
  const literal = JSON.stringify(envelopeJson)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `window.__OJSB_RECEIVE__&&window.__OJSB_RECEIVE__(${literal});true;`;
}
