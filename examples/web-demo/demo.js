import { BridgeError, bridge } from '../../dist/packages/web-sdk/src/index.js';
import { installMockTransport } from '../../dist/packages/web-mock/src/index.js';

const echoMethod = 'conformance.echo';
const connectButton = document.querySelector('#connect');
const sendButton = document.querySelector('#send');
const errorButton = document.querySelector('#try-error');
const connectionStatus = document.querySelector('#connection-status');
const message = document.querySelector('#message');
const result = document.querySelector('#result');
const inspector = document.querySelector('#inspector');
const workbench = document.querySelector('.workbench');
const description = document.querySelector('#demo-description');
const operation = document.querySelector('#operation');
const request = document.querySelector('#request');
const response = document.querySelector('#response');
const nativeMode = new URLSearchParams(window.location.search).get('host') === 'native';
const observeMock = !nativeMode && !('__OJSB_TRANSPORT__' in window);

const format = (value) => JSON.stringify(value, null, 2);
let busy = false;
let sent = false;

function showFrame(direction, raw) {
  if (direction === 'response') {
    response.textContent = raw === null ? '收到空回执。' : format(JSON.parse(raw));
    return;
  }
  const frame = JSON.parse(raw);
  operation.textContent = sent
    ? `${operation.textContent} → ${frame.rpc.method}`
    : frame.rpc.method;
  sent = true;
  request.textContent = format(frame);
}

function syncControls() {
  const ready = bridge.state === 'ready';
  const unavailable = bridge.state === 'unavailable';
  connectButton.disabled = busy || ready || unavailable;
  sendButton.disabled = busy || unavailable;
  errorButton.disabled = busy || !ready;
  connectionStatus.dataset.state = bridge.state;
  const host = bridge.host;
  if (host) connectionStatus.dataset.platform = host.platform;
  else delete connectionStatus.dataset.platform;
  connectionStatus.textContent = host ? `已连接 ${host.name === 'mock' ? 'Mock' : host.name}`
    : unavailable ? '通道不可用，请刷新重试' : busy ? '握手中' : '未连接';
  inspector.setAttribute('aria-busy', String(busy));
}

function showError(error) {
  result.dataset.error = 'true';
  result.textContent = format(error instanceof BridgeError
    ? { name: error.name, code: error.code, message: error.message, data: error.data }
    : { message: error instanceof Error ? error.message : String(error) });
}

async function run(label, action) {
  if (busy) return;
  busy = true;
  if (observeMock) {
    sent = false;
    operation.textContent = label;
    request.textContent = '等待请求…';
    response.textContent = '等待响应…';
  }
  result.textContent = '处理中…';
  delete result.dataset.error;
  syncControls();

  try {
    result.textContent = format(await action());
  } catch (error) {
    showError(error);
  } finally {
    if (observeMock && !sent) {
      request.textContent = 'SDK 在本地结束调用，未发送请求。';
      response.textContent = '没有宿主响应。';
    }
    busy = false;
    syncControls();
  }
}

connectButton.addEventListener('click', () => {
  void run('bridge.hello', async () => {
    const host = await bridge.ready();
    return { host, 'has(conformance.echo)': bridge.has(echoMethod) };
  });
});

document.querySelector('#echo-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void run(echoMethod, () => bridge.call(echoMethod, { text: message.value }));
});

errorButton.addEventListener('click', () => {
  if (bridge.state !== 'ready') return;
  void run('demo.missing', () => bridge.call('demo.missing'));
});

try {
  if (observeMock) {
    installMockTransport({ onFrame: showFrame });
  } else {
    inspector.hidden = true;
    workbench.dataset.host = 'injected';
    description.textContent = '使用 WebView 注入的通道。发送 echo 后会自动握手并展示调用结果。';
  }
  syncControls();
} catch (error) {
  connectionStatus.textContent = '宿主通道初始化失败';
  showError(error);
}
