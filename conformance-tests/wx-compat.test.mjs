import assert from 'node:assert/strict';
import test from 'node:test';
import { ErrorCode } from '../dist/packages/protocol/src/index.js';
import { createMockAdapter } from '../dist/packages/web-mock/src/index.js';
import { createBridge } from '../dist/packages/web-sdk/src/index.js';
import { createWxCompat, WxCompatError } from '../dist/packages/wx-compat/src/index.js';

const minimalJpegBase64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');

test('wx-compat maps v1 standard methods with both Promise and callback semantics and exposes no *Sync APIs', async () => {
  const shown = [];
  const adapter = createMockAdapter({
    deviceInfo: { os: 'ios', osVersion: '26.2' },
    getNetworkStatus: () => ({ type: 'wifi' }),
    showToast: (text) => { shown.push(text); },
    events: ['network.statusChanged', 'app.foregrounded', 'app.backgrounded'],
  });
  const bridge = createBridge({ adapter });
  const wx = createWxCompat(bridge);

  // Strictly async-only: no *Sync methods on facade.
  assert.equal(Object.keys(wx).some((key) => key.endsWith('Sync')), false);
  assert.equal(wx.canIUse('getSystemInfoSync'), false);
  assert.equal(wx.canIUse('getSystemInfo'), false); // before ready

  await bridge.ready();

  assert.equal(wx.canIUse('getSystemInfo'), true);
  assert.equal(wx.canIUse('getNetworkType'), true);
  assert.equal(wx.canIUse('showToast'), true);
  assert.equal(wx.canIUse('chooseMedia'), false); // not configured on adapter
  assert.equal(wx.canIUse('onNetworkStatusChange'), true);
  assert.equal(wx.canIUse('onAppShow'), true);
  assert.equal(wx.canIUse('onAppHide'), true);
  assert.equal(wx.canIUse('request'), false);

  const lifecycle = [];
  const sys = await wx.getSystemInfo({
    success: (res) => lifecycle.push(`success:${res.system}`),
    complete: (res) => lifecycle.push(`complete:${res.errMsg}`),
  });
  assert.deepEqual(sys, {
    errMsg: 'getSystemInfo:ok',
    platform: 'ios',
    system: 'iOS 26.2',
    os: 'ios',
    osVersion: '26.2',
  });
  assert.deepEqual(lifecycle, ['success:iOS 26.2', 'complete:getSystemInfo:ok']);

  const net = await wx.getNetworkType();
  assert.deepEqual(net, {
    errMsg: 'getNetworkType:ok',
    networkType: 'wifi',
    isConnected: true,
  });

  const toastRes = await wx.showToast({ title: 'Saved' });
  assert.deepEqual(toastRes, { errMsg: 'showToast:ok' });
  assert.deepEqual(shown, ['Saved']);

  // Validation error invokes fail -> complete and rejects with WxCompatError.
  const failEvents = [];
  await assert.rejects(
    wx.showToast({
      title: '',
      fail: (err) => failEvents.push(`fail:${err.code}`),
      complete: (res) => failEvents.push(`complete:${res.errMsg}`),
    }),
    (error) => error instanceof WxCompatError && error.code === ErrorCode.InvalidParams,
  );
  assert.deepEqual(failEvents, [`fail:${ErrorCode.InvalidParams}`, 'complete:showToast:fail invalid title']);

  // Unadvertised capability rejects cleanly with MethodNotFound.
  await assert.rejects(
    wx.chooseMedia(),
    (error) => error instanceof WxCompatError && error.code === ErrorCode.MethodNotFound,
  );

  bridge.close();
});

test('wx-compat chooseMedia converts thumbnailBase64 to tempFilePath, handles cancel, and rejects unsupported v1 params', async () => {
  let mode = 'selected';
  const adapter = createMockAdapter({
    chooseMedia: () => {
      if (mode === 'cancelled') return { status: 'cancelled', files: [] };
      return {
        status: 'selected',
        files: [{
          type: 'image',
          id: '0123456789abcdef0123456789abcdef',
          mime: 'image/jpeg',
          size: 4096,
          width: 800,
          height: 600,
          expiresAt: Date.now() + 60_000,
          thumbnailBase64: minimalJpegBase64,
        }],
      };
    },
  });

  const bridge = createBridge({ adapter });
  const wx = createWxCompat(bridge);
  await bridge.ready();
  assert.equal(wx.canIUse('chooseMedia'), true);

  const selected = await wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album'] });
  assert.equal(selected.errMsg, 'chooseMedia:ok');
  assert.equal(selected.type, 'image');
  assert.equal(selected.tempFiles.length, 1);
  assert.equal(selected.tempFiles[0].id, '0123456789abcdef0123456789abcdef');
  assert.equal(selected.tempFiles[0].fileType, 'image');
  assert.equal(selected.tempFiles[0].tempFilePath.startsWith('blob:'), true);

  mode = 'cancelled';
  await assert.rejects(
    wx.chooseMedia(),
    (error) => error instanceof WxCompatError &&
      error.code === ErrorCode.Cancelled &&
      error.errMsg === 'chooseMedia:fail cancel',
  );

  await assert.rejects(
    wx.chooseMedia({ count: 2 }),
    (error) => error instanceof WxCompatError && error.code === ErrorCode.InvalidParams,
  );
  await assert.rejects(
    wx.chooseMedia({ mediaType: ['video'] }),
    (error) => error instanceof WxCompatError && error.code === ErrorCode.InvalidParams,
  );
  await assert.rejects(
    wx.chooseMedia({ sourceType: ['camera'] }),
    (error) => error instanceof WxCompatError && error.code === ErrorCode.InvalidParams,
  );

  bridge.close();
});

test('wx-compat event listeners deduplicate, unregister individually or in bulk, and dispose cleanly', async () => {
  const adapter = createMockAdapter({
    events: ['network.statusChanged', 'app.foregrounded', 'app.backgrounded'],
  });
  const bridge = createBridge({ adapter });
  const wx = createWxCompat(bridge);

  const networkLog = [];
  const onNet = (res) => networkLog.push(res);
  const sub1 = wx.onNetworkStatusChange(onNet);
  const sub2 = wx.onNetworkStatusChange(onNet);
  assert.equal(sub1, sub2);
  await sub1.ready;

  const lifecycleLog = [];
  const onShow = () => lifecycleLog.push('show');
  const onHide = () => lifecycleLog.push('hide');
  const showSub = wx.onAppShow(onShow);
  const hideSub = wx.onAppHide(onHide);
  await Promise.all([showSub.ready, hideSub.ready]);

  adapter.emit('network.statusChanged', { type: 'none' });
  adapter.emit('network.statusChanged', { type: 'cellular' });
  adapter.emit('app.foregrounded', null);
  adapter.emit('app.backgrounded', null);

  assert.deepEqual(networkLog, [
    { isConnected: false, networkType: 'none' },
    { isConnected: true, networkType: 'cellular' },
  ]);
  assert.deepEqual(lifecycleLog, ['show', 'hide']);

  wx.offNetworkStatusChange(onNet);
  adapter.emit('network.statusChanged', { type: 'wifi' });
  assert.equal(networkLog.length, 2);

  wx.dispose();
  adapter.emit('app.foregrounded', null);
  adapter.emit('app.backgrounded', null);
  assert.deepEqual(lifecycleLog, ['show', 'hide']);

  bridge.close();
});
