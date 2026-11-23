(function () {
  'use strict';
  const channel = window.__ojsb_wml;
  if (window !== window.top || !channel || '__OJSB_TRANSPORT__' in window) return;

  const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
  const bufferLimit = 256;
  const messageLimit = 65536;
  let token = newToken();
  let active = false;
  let pendingChallenge;
  let outbound = [];
  let outboundLength = 0;
  let inbound = [];
  let receiver;

  function send(raw) {
    channel.postMessage('rpc:' + token + ':' + raw);
  }

  function deliver(raw) {
    if (receiver) receiver(raw);
    else if (inbound.length < bufferLimit) inbound.push(raw);
  }

  channel.addEventListener('message', (event) => {
    const raw = event.data;
    if (typeof raw !== 'string') return;
    if (pendingChallenge !== undefined && raw === 'ready:' + pendingChallenge + ':' + token) {
      channel.postMessage('push:' + pendingChallenge + ':' + token);
      pendingChallenge = undefined;
      active = true;
      const pending = outbound;
      outbound = [];
      outboundLength = 0;
      pending.forEach(send);
      return;
    }
    const prefix = 'rpc:' + token + ':';
    if (raw.startsWith(prefix)) deliver(raw.slice(prefix.length));
  });

  Object.defineProperty(window, '__OJSB_RECEIVE__', {
    get: () => deliver,
    set(value) {
      receiver = typeof value === 'function' ? value : undefined;
      if (!receiver) return;
      const pending = inbound;
      inbound = [];
      pending.forEach(deliver);
    },
  });
  Object.defineProperty(window, '__OJSB_ANDROID_COMMIT__', {
    value(challenge) {
      active = false;
      pendingChallenge = challenge;
      channel.postMessage('commit:' + challenge + ':' + token);
    },
  });
  Object.defineProperty(window, '__OJSB_TRANSPORT__', {
    value: Object.freeze({
      name: 'android-wml',
      protocols: Object.freeze([1]),
      postMessage(raw) {
        if (typeof raw !== 'string') throw new TypeError('Expected a JSON string');
        if (active) {
          send(raw);
        } else if (outbound.length < bufferLimit && raw.length <= messageLimit - outboundLength) {
          outbound.push(raw);
          outboundLength += raw.length;
        } else {
          throw new Error('Android bridge startup buffer is full');
        }
      },
    }),
  });

  window.addEventListener('pagehide', () => {
    channel.postMessage('leave:' + token);
    token = newToken();
    active = false;
    pendingChallenge = undefined;
    inbound = [];
    outbound = [];
    outboundLength = 0;
  });
  window.dispatchEvent(new CustomEvent('ojsb:transportready'));
})();
