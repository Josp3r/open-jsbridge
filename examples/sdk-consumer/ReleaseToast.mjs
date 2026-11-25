import { bridge, ui } from '@open-jsbridge/web';

const text = 'Open JSBridge native toast';
const run = document.getElementById('run');
const status = document.getElementById('status');

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
