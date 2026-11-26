import { bridge } from '../../dist/packages/web-sdk/src/auto.js';
import { BridgeError } from '../../dist/packages/web-sdk/src/index.js';
import { installMockTransport } from '../../dist/packages/web-mock/src/index.js';

const echoMethod = 'conformance.echo';
const deviceMethod = 'device.getInfo';
const networkMethod = 'network.getStatus';
const networkEvent = 'network.statusChanged';
const connectButton = document.querySelector('#connect');
const sendButton = document.querySelector('#send');
const errorButton = document.querySelector('#try-error');
const deviceButton = document.querySelector('#device-info');
const networkButton = document.querySelector('#network-status');
const eventDemo = document.querySelector('#event-demo');
const toggleEventButton = document.querySelector('#toggle-event');
const emitEventButton = document.querySelector('#emit-event');
const eventStatus = document.querySelector('#event-status');
const eventResult = document.querySelector('#event-result');
const eventFrame = document.querySelector('#event-frame');
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
let mock;
let eventSubscription;
let networkType = 'wifi';

function showFrame(direction, raw) {
  if (direction === 'event') {
    eventFrame.textContent = format(JSON.parse(raw));
    return;
  }
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
  deviceButton.disabled = busy || unavailable || (ready && !bridge.has(deviceMethod, 1));
  networkButton.disabled = busy || unavailable || (ready && !bridge.has(networkMethod, 1));
  const eventAvailable = ready ? bridge.hasEvent(networkEvent) : Boolean(mock);
  eventDemo.hidden = !eventAvailable && !eventSubscription;
  emitEventButton.hidden = !mock;
  toggleEventButton.disabled = busy || unavailable || (!eventAvailable && !eventSubscription);
  emitEventButton.disabled = !mock || busy || unavailable;
  toggleEventButton.textContent = eventSubscription ? '取消订阅' : '订阅事件';
  eventStatus.dataset.state = eventSubscription ? 'ready' : 'idle';
  eventStatus.textContent = eventSubscription ? '已订阅' : '未订阅';
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

deviceButton.addEventListener('click', () => {
  void run(deviceMethod, () => bridge.call(deviceMethod));
});

networkButton.addEventListener('click', () => {
  void run(networkMethod, () => bridge.call(networkMethod));
});

toggleEventButton.addEventListener('click', () => {
  if (eventSubscription) {
    void run('bridge.unsubscribe', () => {
      eventSubscription();
      eventSubscription = undefined;
      return { event: networkEvent, subscribed: false };
    });
    return;
  }
  void run('bridge.subscribe', async () => {
    eventStatus.textContent = '正在订阅…';
    eventResult.textContent = mock ? '点击「切换 Mock 网络」，查看事件数据。' : '等待设备网络变化。';
    const off = bridge.on(networkEvent, (payload) => {
      eventResult.textContent = format(payload);
    });
    try {
      await off.ready;
    } catch (error) {
      off();
      throw error;
    }
    eventSubscription = off;
    return { event: networkEvent, subscribed: true };
  });
});

emitEventButton.addEventListener('click', () => {
  if (!mock) return;
  networkType = networkType === 'wifi' ? 'cellular' : 'wifi';
  if (!mock.emit(networkEvent, { type: networkType })) {
    eventStatus.textContent = eventSubscription ? '已订阅 · Mock 未推送' : '未订阅 · Mock 网络已切换';
    return;
  }
  syncControls();
});

try {
  if (observeMock) {
    mock = installMockTransport({
      deviceInfo: { os: 'ios', osVersion: '27.2' },
      getNetworkStatus: () => ({ type: networkType }),
      events: [networkEvent],
      onFrame: showFrame,
    });
  } else {
    inspector.hidden = true;
    workbench.dataset.host = 'injected';
    description.textContent = '使用 WebView 注入的通道。首次调用会自动握手，页面随后显示宿主支持的能力。';
  }
  syncControls();
} catch (error) {
  connectionStatus.textContent = '宿主通道初始化失败';
  showError(error);
}
