# `@open-jsbridge/devtools`

Zero-dependency inspector and HAR-like traffic recorder for Open JSBridge (`docs/web-sdk.md` §6.2, `docs/protocol.md` §14.4).

## Features

- **Purely observational `BridgePlugin`**: attaches via `bridge.use()` without mutating outbound or inbound wire frames.
- **Session & capability snapshot**: captures `bridge.hello` host info, `sid`, advertised `methods` (with versions), `events`, `features`, and negotiated `limits`.
- **Bounded ring buffer & timing correlation**: tracks direction, kind (`request`/`response`/`error`/`notification`), UTF-8 byte size, `roundTripMs`, `hostHandlerMs` (`meta.timing`), and error codes.
- **Default sensitive-field redaction**: masks common credential keys (`authorization`, `cookie`, `access_token`, etc.) and large `thumbnailBase64` strings in captured snapshots and HAR exports.
- **HAR 1.2-like JSON export**: `controller.exportHar()` / `controller.exportHarJson()` for attaching bridge traces to bug reports.
- **Shadow DOM floating overlay**: `mountDevtoolsOverlay()` renders an isolated drawer using `createElement` + `textContent` (no `innerHTML`).

## Usage

### Headless Capture (Node.js or Browser)

```ts
import { createBridge } from '@open-jsbridge/web';
import { createDevtools } from '@open-jsbridge/devtools';

const bridge = createBridge();
const devtools = createDevtools(bridge, { maxEntries: 500 });

await bridge.call('device.getInfo');

console.log(devtools.session());
console.log(devtools.exportHarJson());

devtools.detach();
```

### Browser Floating Overlay

```ts
import { bridge } from '@open-jsbridge/web/auto';
import { attachDevtools } from '@open-jsbridge/devtools';

const attached = attachDevtools(bridge, {
  mount: {
    position: 'bottom-right',
    onExportHar: (json) => console.log(json),
  },
});

// Cleanup when tearing down
attached.destroy();
```
