import {
  BridgeError,
  createBridge,
  type Bridge,
  type BridgeOptions,
} from '../packages/web-sdk/src/index.js';
import { createMediaHelpers, type ImageResource } from '../packages/web-sdk/src/media.js';
import { createTransferHelpers } from '../packages/web-sdk/src/transfer.js';
import { createMockAdapter, HostError, type MockAdapter } from '../packages/web-mock/src/index.js';
import { attachDevtools, mountDevtoolsOverlay, type AttachedDevtools, type DevtoolsOverlayHandle } from '../packages/devtools/src/index.js';

type PlatformPreset = 'ios' | 'android';
type FrameCategory = 'rpc' | 'progress' | 'event';
type FrameFilter = 'all' | FrameCategory;

interface CapturedFrame {
  id: number;
  time: string;
  direction: 'req' | 'res' | 'err' | 'progress' | 'event';
  category: FrameCategory;
  summary: string;
  payload: unknown;
}

const UPLOAD_ENDPOINT = 'https://upload.open-jsbridge.dev/v1/images';

const QUICK_SNIPPETS: Record<'web' | 'ios' | 'android', { code: string; install: string; doc: string }> = {
  web: {
    code: `import { bridge } from '@open-jsbridge/web/auto';
import { device } from '@open-jsbridge/web/device';
import { transfer } from '@open-jsbridge/web/transfer';

await bridge.ready();
const info = await device.getInfo();
console.log(info.os, info.osVersion);`,
    install: 'npm install @open-jsbridge/web',
    doc: 'https://github.com/Josp3r/open-jsbridge/blob/main/docs/web-sdk.md',
  },
  ios: {
    code: `import NativeIOSHost

let attachment = try NativeIOSHost.attach(
    to: webView,
    allowing: URL(string: "https://app.example.com")!,
    options: .init(deviceInfo: true, networkStatus: true, toast: true, media: true)
)
// 转发 navigationDelegate 的 didCommit 与进程终止回调`,
    install: '.package(url: "https://github.com/Josp3r/open-jsbridge", exact: "1.0.0")',
    doc: 'https://github.com/Josp3r/open-jsbridge/blob/main/docs/native-ios.md',
  },
  android: {
    code: `import dev.openjsbridge.host.AndroidBridge

val bridge = AndroidBridge.attach(
    webView = webView,
    allowedOrigin = "https://app.example.com",
    options = AndroidBridge.Options(deviceInfo = true, networkStatus = true, toast = true)
)
// 缺少 WebMessageListener 时返回 null，绝不启用不安全回退`,
    install: 'implementation("io.github.josp3r:open-jsbridge-android:1.0.0")',
    doc: 'https://github.com/Josp3r/open-jsbridge/blob/main/docs/native-android.md',
  },
};

const NETWORK_CYCLE = ['wifi', 'cellular', 'ethernet', 'none'] as const;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

const elQuickCode = byId<HTMLElement>('quick-code');
const elQuickInstall = byId<HTMLElement>('quick-install');
const elQuickDocLink = byId<HTMLAnchorElement>('quick-doc-link');
const elCopySnippet = byId<HTMLButtonElement>('copy-snippet');

const elStatus = byId<HTMLElement>('pg-status');
const elSid = byId<HTMLElement>('pg-sid');
const elHost = byId<HTMLElement>('pg-host');
const elPlatform = byId<HTMLSelectElement>('pg-platform');
const elReconnect = byId<HTMLButtonElement>('pg-reconnect');
const elDevtoolsToggle = byId<HTMLButtonElement>('pg-devtools-toggle');
const elExportHar = byId<HTMLButtonElement>('pg-export-har');

const btnHello = byId<HTMLButtonElement>('btn-hello');
const btnDevice = byId<HTMLButtonElement>('btn-device');
const btnNetwork = byId<HTMLButtonElement>('btn-network');
const btnMissing = byId<HTMLButtonElement>('btn-missing');
const toastForm = byId<HTMLFormElement>('toast-form');
const toastInput = byId<HTMLInputElement>('toast-input');

const btnChooseMedia = byId<HTMLButtonElement>('btn-choose-media');
const btnUpload = byId<HTMLButtonElement>('btn-upload');
const btnCancelUpload = byId<HTMLButtonElement>('btn-cancel-upload');
const btnReleaseMedia = byId<HTMLButtonElement>('btn-release-media');
const elMediaStage = byId<HTMLElement>('media-stage');
const elMediaThumb = byId<HTMLImageElement>('media-thumb');
const elMediaInfo = byId<HTMLElement>('media-info');
const elProgressWrap = byId<HTMLElement>('upload-progress-wrap');
const elProgressFill = byId<HTMLElement>('upload-progress-fill');
const elProgressLabel = byId<HTMLElement>('upload-progress-label');
const elProgressSeq = byId<HTMLElement>('upload-progress-seq');

const btnSubNetwork = byId<HTMLButtonElement>('btn-sub-network');
const btnEmitNetwork = byId<HTMLButtonElement>('btn-emit-network');
const btnSubApp = byId<HTMLButtonElement>('btn-sub-app');
const btnEmitApp = byId<HTMLButtonElement>('btn-emit-app');

const elResult = byId<HTMLElement>('pg-result');
const elFrameList = byId<HTMLUListElement>('frame-list');
const elFrameDetail = byId<HTMLElement>('frame-detail');
const elFrameCount = byId<HTMLElement>('frame-count');
const btnClearFrames = byId<HTMLButtonElement>('btn-clear-frames');
const elToastBanner = byId<HTMLElement>('toast-banner');

let currentSnippet: 'web' | 'ios' | 'android' = 'web';
let bridge: Bridge;
let mock: MockAdapter;
let mediaApi: ReturnType<typeof createMediaHelpers>;
let transferApi: ReturnType<typeof createTransferHelpers>;
let devtools: AttachedDevtools | undefined;
let overlay: DevtoolsOverlayHandle | undefined;

let networkIndex = 0;
let appForeground = true;
let currentSid: string | undefined;
let activeMedia: ImageResource | undefined;
let heldMediaIds = new Set<string>();
let activeUploadAbort: AbortController | undefined;
let networkUnsub: (() => void) | undefined;
let appUnsubs: (() => void)[] = [];
let toastTimer: ReturnType<typeof setTimeout> | undefined;

let frames: CapturedFrame[] = [];
let nextFrameId = 1;
let selectedFrameId: number | undefined;
let activeFilter: FrameFilter = 'all';

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function showToastBanner(text: string): void {
  elToastBanner.textContent = text;
  elToastBanner.dataset.visible = 'true';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elToastBanner.dataset.visible = 'false';
  }, 2400);
}

function nowTime(): string {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function makeHexId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function generateSampleJpegBase64(platform: PlatformPreset): string {
  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 180;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = platform === 'ios' ? '#0e5a6d' : '#1b5e3c';
    ctx.fillRect(0, 0, 240, 180);
    ctx.fillStyle = '#f7f6f2';
    ctx.fillRect(18, 18, 204, 144);
    ctx.fillStyle = '#14171c';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('Open JSBridge 1.0', 34, 62);
    ctx.fillStyle = '#4c535f';
    ctx.font = '13px monospace';
    ctx.fillText(`host: ${platform}`, 34, 92);
    ctx.fillText('240x180 JPEG thumb', 34, 114);
    ctx.fillText(nowTime(), 34, 136);
  }
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

function pushFrame(raw: string, source: 'send' | 'recv'): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const meta = parsed.meta as Record<string, unknown> | undefined;
  if (typeof meta?.sid === 'string') currentSid = meta.sid;
  const rpc = parsed.rpc as Record<string, unknown> | undefined;
  if (!rpc) return;

  let direction: CapturedFrame['direction'] = source === 'send' ? 'req' : 'res';
  let category: FrameCategory = 'rpc';
  let summary = '';

  if (typeof rpc.method === 'string') {
    if (rpc.method === 'bridge.progress') {
      direction = 'progress';
      category = 'progress';
      const p = rpc.params as Record<string, unknown> | undefined;
      const chunk = p?.chunk as Record<string, unknown> | undefined;
      summary = `bridge.progress #${String(p?.seq ?? '?')} (${String(chunk?.sent ?? 0)}/${String(chunk?.total ?? 0)})`;
    } else if (rpc.method === 'bridge.event') {
      direction = 'event';
      category = 'event';
      const p = rpc.params as Record<string, unknown> | undefined;
      summary = `bridge.event · ${String(p?.name ?? '')}`;
    } else if (rpc.method === 'bridge.cancel') {
      direction = 'req';
      category = 'rpc';
      const p = rpc.params as Record<string, unknown> | undefined;
      summary = `→ bridge.cancel (${String(p?.requestId ?? '')})`;
    } else {
      direction = 'req';
      category = 'rpc';
      summary = `→ ${rpc.method} [${String(rpc.id ?? 'notify')}]`;
    }
  } else if ('error' in rpc) {
    direction = 'err';
    category = 'rpc';
    const err = rpc.error as Record<string, unknown>;
    summary = `← ERR ${String(err.code)} ${String(err.message)} [${String(rpc.id ?? 'null')}]`;
  } else {
    direction = 'res';
    category = 'rpc';
    const res = rpc.result as Record<string, unknown> | undefined;
    if (typeof res?.sid === 'string') currentSid = res.sid;
    summary = `← OK [${String(rpc.id ?? '')}]`;
  }

  const item: CapturedFrame = {
    id: nextFrameId++,
    time: nowTime(),
    direction,
    category,
    summary,
    payload: parsed,
  };
  frames.unshift(item);
  if (frames.length > 120) frames.pop();
  selectedFrameId = item.id;
  renderFrames();
}

function renderFrames(): void {
  const visible = activeFilter === 'all' ? frames : frames.filter((f) => f.category === activeFilter);
  elFrameCount.textContent = `${visible.length} frames`;

  if (visible.length === 0) {
    elFrameList.innerHTML = '<li class="frame-empty">当前筛选条件下暂无 Wire 报文。</li>';
    if (frames.length === 0) {
      elFrameDetail.textContent = '// 选择上方任意一条 Wire 报文查看原始信封';
    }
    return;
  }

  elFrameList.innerHTML = '';
  for (const frame of visible) {
    const li = document.createElement('li');
    li.className = 'frame-item';
    li.dataset.selected = String(frame.id === selectedFrameId);
    li.innerHTML = `<div class="frame-item-top"><span class="frame-dir" data-dir="${frame.direction}"></span><span class="pg-meta"></span></div>`;
    const dirSpan = li.querySelector('.frame-dir') as HTMLElement;
    const timeSpan = li.querySelector('.pg-meta') as HTMLElement;
    dirSpan.textContent = frame.summary;
    timeSpan.textContent = frame.time;
    li.addEventListener('click', () => {
      selectedFrameId = frame.id;
      renderFrames();
    });
    elFrameList.appendChild(li);
  }

  const selected = visible.find((f) => f.id === selectedFrameId) ?? visible[0];
  if (selected) {
    selectedFrameId = selected.id;
    elFrameDetail.textContent = formatJson(selected.payload);
  }
}

function setResult(value: unknown, isError = false): void {
  elResult.dataset.error = String(isError);
  elResult.textContent = formatJson(value);
}

function formatError(error: unknown): Record<string, unknown> {
  if (error instanceof BridgeError) {
    return { name: error.name, code: error.code, message: error.message, data: error.data };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

function syncUi(): void {
  const state = bridge.state;
  elStatus.dataset.state = state === 'ready' ? 'ready' : state === 'connecting' ? 'connecting' : 'idle';
  elStatus.textContent =
    state === 'ready' ? '已连接 · Ready' :
    state === 'connecting' ? '握手中…' :
    state === 'unavailable' ? '不可用' : '待握手';
  elSid.textContent = `sid: ${currentSid ? currentSid.slice(0, 12) + '…' : '—'}`;
  elHost.textContent = bridge.host
    ? `host: ${bridge.host.name} (${bridge.host.platform} ${bridge.host.version})`
    : 'host: —';

  const uploading = Boolean(activeUploadAbort);
  btnUpload.disabled = !activeMedia || uploading;
  btnCancelUpload.disabled = !uploading;
  btnReleaseMedia.disabled = !activeMedia || uploading;
  btnSubNetwork.textContent = networkUnsub ? '退订 network.statusChanged' : '订阅 network.statusChanged';
  btnSubApp.textContent = appUnsubs.length > 0 ? '退订 app 前后台' : '订阅 app 前后台';
  elDevtoolsToggle.textContent = overlay ? '关闭 Devtools 浮层' : 'Devtools 浮层';
}

function initSession(platform: PlatformPreset): void {
  if (activeUploadAbort) {
    activeUploadAbort.abort();
    activeUploadAbort = undefined;
  }
  if (networkUnsub) {
    networkUnsub();
    networkUnsub = undefined;
  }
  for (const off of appUnsubs) off();
  appUnsubs = [];
  if (overlay) {
    overlay.unmount();
    overlay = undefined;
  }
  devtools?.destroy();
  bridge?.close();

  currentSid = undefined;
  activeMedia = undefined;
  heldMediaIds = new Set<string>();
  elMediaStage.hidden = true;
  elProgressWrap.hidden = true;

  mock = createMockAdapter({
    platform,
    hostName: platform === 'ios' ? 'ios-wk' : 'android-wml',
    hostVersion: '1.0.0',
    deviceInfo: platform === 'ios'
      ? { os: 'ios', osVersion: '18.4' }
      : { os: 'android', osVersion: '15' },
    getNetworkStatus: () => ({ type: NETWORK_CYCLE[networkIndex]! }),
    events: ['network.statusChanged', 'app.foregrounded', 'app.backgrounded'],
    supportsCancel: true,
    supportsCallbacks: true,
    allowedUploadUrls: [UPLOAD_ENDPOINT],
    showToast: (text) => {
      showToastBanner(`[${platform === 'ios' ? 'iOS' : 'Android'} Toast] ${text}`);
    },
    chooseMedia: async () => {
      const id = makeHexId();
      heldMediaIds.add(id);
      return {
        status: 'selected',
        files: [{
          type: 'image',
          id,
          mime: 'image/jpeg',
          size: 486_400,
          width: 1200,
          height: 900,
          expiresAt: Date.now() + 300_000,
          thumbnailBase64: generateSampleJpegBase64(platform),
        }],
      };
    },
    releaseMedia: async (ids) => {
      for (const id of ids) heldMediaIds.delete(id);
    },
    uploadMedia: async (params, ctx) => {
      const id = typeof params?.id === 'string' ? params.id : '';
      if (!heldMediaIds.has(id)) {
        throw new HostError(-32003, 'Upload failed', { reason: 'handle_not_found' });
      }
      const total = 486_400;
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 260);
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new HostError(-32002, 'Upload cancelled', { reason: 'cancelled' }));
          }, { once: true });
        });
        if (ctx.signal.aborted) {
          throw new HostError(-32002, 'Upload cancelled', { reason: 'cancelled' });
        }
        ctx.callback({ sent: Math.round((total * i) / steps), total });
      }
      return {
        status: 201,
        body: JSON.stringify({ ok: true, id, endpoint: UPLOAD_ENDPOINT }),
      };
    },
  });

  const observedAdapter: NonNullable<BridgeOptions['adapter']> = {
    name: mock.name,
    async send(raw: string): Promise<string | null> {
      pushFrame(raw, 'send');
      const reply = await mock.send(raw);
      if (reply !== null) pushFrame(reply, 'recv');
      return reply;
    },
    listen(onMessage: (raw: string) => void): () => void {
      return mock.listen((raw) => {
        pushFrame(raw, 'recv');
        onMessage(raw);
      });
    },
  };

  bridge = createBridge({ adapter: observedAdapter });
  mediaApi = createMediaHelpers(bridge);
  transferApi = createTransferHelpers(bridge);
  devtools = attachDevtools(bridge, { mount: false });
  syncUi();
}

async function executeAction(action: () => Promise<unknown>): Promise<void> {
  try {
    const out = await action();
    setResult(out, false);
  } catch (error) {
    setResult(formatError(error), true);
  } finally {
    syncUi();
  }
}

// Hero Quick Start code tabs
document.querySelectorAll<HTMLButtonElement>('.code-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const key = tab.dataset.snippet as 'web' | 'ios' | 'android';
    currentSnippet = key;
    document.querySelectorAll<HTMLButtonElement>('.code-tab').forEach((item) => {
      item.setAttribute('aria-selected', String(item === tab));
    });
    const entry = QUICK_SNIPPETS[key];
    elQuickCode.textContent = entry.code;
    elQuickInstall.innerHTML = '';
    const codeEl = document.createElement('code');
    codeEl.textContent = entry.install;
    elQuickInstall.appendChild(codeEl);
    elQuickDocLink.href = entry.doc;
  });
});

elCopySnippet.addEventListener('click', () => {
  const text = `${QUICK_SNIPPETS[currentSnippet].install}\n\n${QUICK_SNIPPETS[currentSnippet].code}`;
  void navigator.clipboard?.writeText(text).then(() => {
    elCopySnippet.textContent = 'Copied';
    setTimeout(() => { elCopySnippet.textContent = 'Copy'; }, 1400);
  });
});

// Inspector filter buttons
document.querySelectorAll<HTMLButtonElement>('.filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeFilter = (btn.dataset.filter as FrameFilter) ?? 'all';
    document.querySelectorAll<HTMLButtonElement>('.filter-btn').forEach((item) => {
      item.setAttribute('aria-pressed', String(item === btn));
    });
    renderFrames();
  });
});

btnClearFrames.addEventListener('click', () => {
  frames = [];
  selectedFrameId = undefined;
  renderFrames();
});

// Toolbar actions
elPlatform.addEventListener('change', () => {
  initSession(elPlatform.value as PlatformPreset);
  void executeAction(() => bridge.ready());
});

elReconnect.addEventListener('click', () => {
  initSession(elPlatform.value as PlatformPreset);
  void executeAction(() => bridge.ready());
});

elDevtoolsToggle.addEventListener('click', () => {
  if (!devtools) return;
  if (overlay) {
    overlay.unmount();
    overlay = undefined;
  } else {
    overlay = mountDevtoolsOverlay(devtools.controller, { position: 'bottom-right' });
    overlay.open();
  }
  syncUi();
});

elExportHar.addEventListener('click', () => {
  if (!devtools) return;
  const har = devtools.controller.exportHar();
  const blob = new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `open-jsbridge-playground-${Date.now()}.har.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToastBanner(`已导出 HAR（${har.log.entries.length} 条记录）`);
});

// 1. Core & Basic Capabilities
btnHello.addEventListener('click', () => {
  void executeAction(async () => {
    const host = await bridge.ready();
    return {
      sid: currentSid ?? null,
      host,
      capabilities: {
        device: bridge.has('device.getInfo', 1),
        network: bridge.has('network.getStatus', 1),
        toast: bridge.has('ui.toast.show', 1),
        chooseMedia: bridge.has('media.chooseMedia', 1),
        releaseMedia: bridge.has('media.release', 1),
        upload: bridge.has('transfer.upload', 1),
      },
    };
  });
});

btnDevice.addEventListener('click', () => {
  void executeAction(() => bridge.call('device.getInfo@1'));
});

btnNetwork.addEventListener('click', () => {
  void executeAction(() => bridge.call('network.getStatus@1'));
});

btnMissing.addEventListener('click', () => {
  void executeAction(() => bridge.call('demo.missing'));
});

toastForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = toastInput.value.trim();
  void executeAction(() => bridge.call('ui.toast.show@1', { text }));
});

// 2. Media + Streaming Upload + AbortSignal + Release
btnChooseMedia.addEventListener('click', () => {
  void executeAction(async () => {
    const selection = await mediaApi.media.chooseMedia({
      mediaType: ['image'],
      sourceType: ['album'],
      count: 1,
    });
    if (selection.status === 'selected') {
      activeMedia = selection.files[0];
      elMediaThumb.src = activeMedia.thumbUrl;
      elMediaInfo.innerHTML = '';
      const line1 = document.createElement('div');
      line1.innerHTML = '句柄 ID: <code></code>';
      (line1.querySelector('code') as HTMLElement).textContent = activeMedia.id;
      const line2 = document.createElement('div');
      line2.textContent = `${activeMedia.mime} · ${activeMedia.width}×${activeMedia.height} · ${Math.round(activeMedia.size / 1024)} KiB · TTL 5m`;
      elMediaInfo.append(line1, line2);
      elMediaStage.hidden = false;
      elProgressWrap.hidden = true;
    }
    return selection;
  });
});

btnUpload.addEventListener('click', () => {
  if (!activeMedia || activeUploadAbort) return;
  const targetId = activeMedia.id;
  const controller = new AbortController();
  activeUploadAbort = controller;
  elProgressWrap.hidden = false;
  elProgressFill.style.width = '0%';
  elProgressLabel.textContent = '上传中 0%';
  elProgressSeq.textContent = 'seq: —';
  syncUi();

  void executeAction(async () => {
    try {
      return await transferApi.transfer.upload(
        {
          id: targetId,
          request: {
            url: UPLOAD_ENDPOINT,
            method: 'POST',
            fieldName: 'file',
            formData: { scene: 'playground' },
          },
        },
        {
          signal: controller.signal,
          onProgress: (progress, seq) => {
            const pct = progress.total > 0 ? Math.min(100, Math.round((progress.sent / progress.total) * 100)) : 0;
            elProgressFill.style.width = `${pct}%`;
            elProgressLabel.textContent = `上传中 ${pct}% (${Math.round(progress.sent / 1024)} / ${Math.round(progress.total / 1024)} KiB)`;
            elProgressSeq.textContent = `seq: ${seq}`;
          },
        },
      );
    } finally {
      activeUploadAbort = undefined;
      syncUi();
    }
  });
});

btnCancelUpload.addEventListener('click', () => {
  if (!activeUploadAbort) return;
  activeUploadAbort.abort();
  elProgressLabel.textContent = '已触发 AbortSignal → 发送 bridge.cancel';
});

btnReleaseMedia.addEventListener('click', () => {
  if (!activeMedia) return;
  const releasedId = activeMedia.id;
  void executeAction(async () => {
    const res = await mediaApi.media.release({ ids: [releasedId] });
    showToastBanner(`已释放媒体句柄 ${releasedId.slice(0, 8)}…（再次上传将返回 -32003）`);
    return { released: releasedId, result: res };
  });
});

// 3. Events
btnSubNetwork.addEventListener('click', () => {
  if (networkUnsub) {
    networkUnsub();
    networkUnsub = undefined;
    setResult({ event: 'network.statusChanged', subscribed: false });
    syncUi();
    return;
  }
  void executeAction(async () => {
    const off = bridge.on<{ type: string }>('network.statusChanged', (payload) => {
      setResult({ receivedEvent: 'network.statusChanged', payload });
      showToastBanner(`收到事件 network.statusChanged → ${payload.type}`);
    });
    await off.ready;
    networkUnsub = off;
    return { event: 'network.statusChanged', subscribed: true };
  });
});

btnEmitNetwork.addEventListener('click', () => {
  networkIndex = (networkIndex + 1) % NETWORK_CYCLE.length;
  const type = NETWORK_CYCLE[networkIndex]!;
  const delivered = mock.emit('network.statusChanged', { type });
  if (!delivered) {
    setResult({ emitted: 'network.statusChanged', type, delivered: false, note: '请先点击「订阅 network.statusChanged」' });
  }
});

btnSubApp.addEventListener('click', () => {
  if (appUnsubs.length > 0) {
    for (const off of appUnsubs) off();
    appUnsubs = [];
    setResult({ events: ['app.foregrounded', 'app.backgrounded'], subscribed: false });
    syncUi();
    return;
  }
  void executeAction(async () => {
    const offBg = bridge.on('app.backgrounded', () => {
      setResult({ receivedEvent: 'app.backgrounded', payload: null });
      showToastBanner('收到事件 app.backgrounded');
    });
    const offFg = bridge.on('app.foregrounded', () => {
      setResult({ receivedEvent: 'app.foregrounded', payload: null });
      showToastBanner('收到事件 app.foregrounded');
    });
    await Promise.all([offBg.ready, offFg.ready]);
    appUnsubs = [offBg, offFg];
    return { events: ['app.foregrounded', 'app.backgrounded'], subscribed: true };
  });
});

btnEmitApp.addEventListener('click', () => {
  appForeground = !appForeground;
  const eventName = appForeground ? 'app.foregrounded' : 'app.backgrounded';
  const delivered = mock.emit(eventName, null);
  if (!delivered) {
    setResult({ emitted: eventName, delivered: false, note: '请先点击「订阅 app 前后台」' });
  }
});

// Boot Playground and perform initial handshake so visitors see a live ready bridge immediately.
initSession('ios');
void executeAction(() => bridge.ready());
