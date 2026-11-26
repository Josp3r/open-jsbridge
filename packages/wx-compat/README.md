# `@open-jsbridge/wx-compat`

Optional, zero-dependency, async-only thin compatibility layer mapping Open JSBridge v1 standard capabilities to familiar `wx.*`-style APIs (`docs/native-capability-catalog.md`, `docs/team-status.md` D-002).

## Design Boundaries

- **Not inside `@open-jsbridge/web` core** — opt-in package with zero bytes added to the 7 KiB core bundle.
- **Not a WeChat runtime** — maps only APIs that genuinely overlap with Open JSBridge's standard profile.
- **Async-only** — intentionally provides zero `*Sync` methods.
- **Honest data & capabilities** — `canIUse(api)` queries `bridge.has()` / `bridge.hasEvent()` on the live session, and `getSystemInfo()` / `getNetworkType()` never fabricate fields not reported by the native host.

## Mapped APIs (v1 Standard Profile)

| `wx-compat` API | Open JSBridge Standard Capability |
|---|---|
| `getSystemInfo(options?)` | `device.getInfo@1` |
| `getNetworkType(options?)` | `network.getStatus@1` |
| `showToast({ title, ... })` | `ui.toast.show@1` |
| `chooseMedia(options?)` | `media.chooseMedia@1` (with `thumbUrl` object URL lifecycle) |
| `onNetworkStatusChange` / `offNetworkStatusChange` | `network.statusChanged` |
| `onAppShow` / `offAppShow` | `app.foregrounded` |
| `onAppHide` / `offAppHide` | `app.backgrounded` |
| `canIUse(api)` | `bridge.has()` / `bridge.hasEvent()` |
| `dispose()` | Unsubscribes all listeners registered on this facade |

## Usage

```ts
import { createBridge } from '@open-jsbridge/web';
import { createWxCompat } from '@open-jsbridge/wx-compat';

const bridge = createBridge();
const wx = createWxCompat(bridge);

await bridge.ready();

if (wx.canIUse('getSystemInfo')) {
  const info = await wx.getSystemInfo({
    success: (res) => console.log(res.system),
    complete: () => console.log('done'),
  });
  console.log(info.platform, info.osVersion);
}

const sub = wx.onNetworkStatusChange(({ isConnected, networkType }) => {
  console.log({ isConnected, networkType });
});
await sub.ready;

wx.dispose();
```
