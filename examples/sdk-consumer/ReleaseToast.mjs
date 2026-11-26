import { bridge, media, ui } from '@open-jsbridge/web/auto';

const text = 'Open JSBridge native toast';
const run = document.getElementById('run');
const status = document.getElementById('status');
const pick = document.getElementById('pick');
const mediaStatus = document.getElementById('media-status');
const preview = document.getElementById('media-preview');

function setStatus(state, message) {
  document.documentElement.dataset.probe = state;
  status.textContent = message;
}

async function probe() {
  run.disabled = true;
  setStatus('running', 'Checking native capabilities…');
  try {
    const device = await bridge.call('device.getInfo');
    if (!['ios', 'android'].includes(device.os) || typeof device.osVersion !== 'string' || !device.osVersion) {
      throw new Error('Expected a native device profile');
    }
    if (!bridge.has('ui.toast.show', 1)) throw new Error('Toast v1 is absent from the native handshake');
    const acknowledgement = await ui.toast.show({ text });
    if (acknowledgement === null || typeof acknowledgement !== 'object' ||
        Array.isArray(acknowledgement) || Object.keys(acknowledgement).length !== 0) {
      throw new Error('Expected an empty Toast acknowledgement');
    }
    setStatus('passed', `Toast accepted by ${device.os}`);
    return { status: 'passed', os: device.os, text };
  } catch (error) {
    setStatus('failed', error.message);
    throw error;
  } finally {
    run.disabled = false;
  }
}

window.__sdkToastProbe = probe;
run.addEventListener('click', () => { probe().catch(() => {}); });
setStatus('ready', 'Ready to call the native SDK');

async function mediaProbe() {
  pick.disabled = true;
  mediaStatus.textContent = 'Select a photo…';
  document.documentElement.dataset.mediaProbe = 'running';
  try {
    const selection = await media.chooseMedia();
    if (selection.status === 'cancelled') {
      mediaStatus.textContent = 'Selection cancelled';
      document.documentElement.dataset.mediaProbe = 'cancelled';
      return { status: 'cancelled' };
    }
    const resource = selection.files[0];
    if (preview.src.startsWith('blob:')) URL.revokeObjectURL(preview.src);
    preview.src = resource.thumbUrl;
    await preview.decode();
    preview.hidden = false;
    mediaStatus.textContent = 'Preview ready';
    document.documentElement.dataset.mediaProbe = 'selected';
    return {
      status: 'selected', ...resource, thumbnailWidth: preview.naturalWidth, thumbnailHeight: preview.naturalHeight,
    };
  } catch (error) {
    mediaStatus.textContent = error.message;
    document.documentElement.dataset.mediaProbe = 'failed';
    throw error;
  } finally {
    pick.disabled = false;
  }
}

window.__sdkMediaProbe = mediaProbe;
window.__sdkThumbReadable = async (url) => {
  if (typeof url !== 'string' || !url.startsWith('blob:')) return false;
  try { return (await fetch(url)).ok; }
  catch { return false; }
};
pick.addEventListener('click', () => { mediaProbe().catch(() => {}); });
