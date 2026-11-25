import { blob, bridge, media, ui } from '@open-jsbridge/web';

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

function dataUrlFor(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function mediaProbe(expectedBase64) {
  pick.disabled = true;
  mediaStatus.textContent = 'Select a photo…';
  document.documentElement.dataset.mediaProbe = 'running';
  let reference;
  try {
    const selection = await media.chooseMedia();
    if (selection.status === 'cancelled') {
      mediaStatus.textContent = 'Selection cancelled';
      document.documentElement.dataset.mediaProbe = 'cancelled';
      return { status: 'cancelled' };
    }
    const resource = selection.files[0];
    reference = resource.blobRef;
    const file = await blob.read(resource);
    const url = await dataUrlFor(file);
    const bytesBase64 = url.slice(url.indexOf(',') + 1);
    if (expectedBase64 !== undefined && bytesBase64 !== expectedBase64) {
      throw new Error('Selected image bytes differ from the fixture');
    }
    preview.src = url;
    preview.hidden = false;
    const action = expectedBase64 === undefined ? 'Read' : 'Verified';
    mediaStatus.textContent = `${action} ${file.size} bytes`;
    document.documentElement.dataset.mediaProbe = 'selected';
    return { status: 'selected', size: file.size, mime: file.type, bytesBase64, blobRef: reference };
  } catch (error) {
    if (reference) await blob.release(reference).catch(() => {});
    mediaStatus.textContent = error.message;
    document.documentElement.dataset.mediaProbe = 'failed';
    throw error;
  } finally {
    pick.disabled = false;
  }
}

window.__sdkMediaProbe = mediaProbe;
window.__sdkMediaRead = (blobRef) => bridge.call('bridge.blob.read@1', { blobRef, index: 0 });
window.__sdkMediaRelease = (blobRef) => blob.release(blobRef);
pick.addEventListener('click', () => {
  mediaProbe(window.__sdkExpectedMediaBase64).then((result) => {
    if (result.status === 'selected') return blob.release(result.blobRef);
  }).catch(() => {});
});
