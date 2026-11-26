import type { DevtoolsController, DevtoolsEntry } from './recorder.js';

export type DevtoolsOverlayPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface DevtoolsOverlayOptions {
  /** Target container element. Defaults to `document.body ?? document.documentElement`. */
  container?: HTMLElement;
  /** Floating anchor corner. Defaults to `'bottom-right'`. */
  position?: DevtoolsOverlayPosition;
  /** Open the drawer immediately on mount. Defaults to `false`. */
  initiallyOpen?: boolean;
  /** Panel header title. Defaults to `'Open JSBridge Devtools'`. */
  title?: string;
  /** CSS z-index for the overlay host. Defaults to `2147483000`. */
  zIndex?: number;
  /** Optional hook invoked with serialized HAR JSON when the user clicks Export HAR. */
  onExportHar?: (harJson: string) => void;
}

export interface DevtoolsOverlayHandle {
  readonly hostElement: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  unmount(): void;
}

const OVERLAY_STYLES = `
:host {
  all: initial;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  color: #e2e8f0;
}
.ojsb-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: #0f172a;
  color: #f8fafc;
  border: 1px solid #334155;
  border-radius: 999px;
  padding: 6px 12px;
  cursor: pointer;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.35);
  font: inherit;
}
.ojsb-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #94a3b8;
}
.ojsb-dot[data-state="ready"] { background: #22c55e; }
.ojsb-dot[data-state="connecting"] { background: #eab308; }
.ojsb-dot[data-state="unavailable"] { background: #ef4444; }
.ojsb-badge {
  background: #1e293b;
  border-radius: 10px;
  padding: 1px 6px;
  font-size: 11px;
}
.ojsb-badge-err {
  background: #7f1d1d;
  color: #fecaca;
}
.ojsb-panel {
  width: min(520px, calc(100vw - 24px));
  max-height: min(480px, calc(100vh - 64px));
  display: flex;
  flex-direction: column;
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.55);
  margin-bottom: 8px;
}
.ojsb-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: #1e293b;
  border-bottom: 1px solid #334155;
  gap: 8px;
}
.ojsb-title { font-weight: 700; color: #f8fafc; }
.ojsb-meta { font-size: 11px; color: #94a3b8; }
.ojsb-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid #1e293b;
  align-items: center;
}
.ojsb-btn {
  background: #1e293b;
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 6px;
  padding: 3px 8px;
  cursor: pointer;
  font: inherit;
}
.ojsb-btn[data-active="true"] {
  background: #2563eb;
  border-color: #3b82f6;
  color: #ffffff;
}
.ojsb-input {
  flex: 1;
  min-width: 110px;
  background: #020617;
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 6px;
  padding: 3px 8px;
  font: inherit;
}
.ojsb-body {
  overflow-y: auto;
  padding: 8px 12px;
  flex: 1;
}
.ojsb-row {
  border-bottom: 1px solid #1e293b;
  padding: 6px 0;
  cursor: pointer;
}
.ojsb-row-head {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.ojsb-dir { font-weight: 700; color: #38bdf8; }
.ojsb-dir[data-dir="receive"] { color: #4ade80; }
.ojsb-err { color: #f87171; font-weight: 700; }
.ojsb-dim { color: #94a3b8; font-size: 11px; }
.ojsb-pre {
  margin: 6px 0 0;
  padding: 6px 8px;
  background: #020617;
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 11px;
  color: #cbd5e1;
}
.ojsb-section { margin-bottom: 10px; }
.ojsb-section-title { font-weight: 700; margin-bottom: 4px; color: #93c5fd; }
`;

function applyPosition(element: HTMLElement, position: DevtoolsOverlayPosition, zIndex: number): void {
  element.style.position = 'fixed';
  element.style.zIndex = String(zIndex);
  element.style.display = 'flex';
  element.style.flexDirection = position.startsWith('top') ? 'column-reverse' : 'column';
  element.style.alignItems = position.endsWith('left') ? 'flex-start' : 'flex-end';
  element.style.top = position.startsWith('top') ? '12px' : '';
  element.style.bottom = position.startsWith('bottom') ? '12px' : '';
  element.style.left = position.endsWith('left') ? '12px' : '';
  element.style.right = position.endsWith('right') ? '12px' : '';
}

function clearChildren(node: Node): void {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function matchesFilter(entry: DevtoolsEntry, query: string, errorsOnly: boolean): boolean {
  if (errorsOnly && entry.kind !== 'error' && entry.code === undefined) return false;
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    (entry.method?.toLowerCase().includes(needle) ?? false) ||
    (typeof entry.id === 'string' && entry.id.toLowerCase().includes(needle)) ||
    (entry.traceId?.toLowerCase().includes(needle) ?? false) ||
    (entry.code !== undefined && String(entry.code).includes(needle)) ||
    entry.kind.includes(needle)
  );
}

/**
 * Mounts a zero-dependency, Shadow DOM-isolated floating inspector overlay in a browser document.
 * Uses only `createElement` and `textContent` (no `innerHTML`).
 */
export function mountDevtoolsOverlay(
  controller: DevtoolsController,
  options: DevtoolsOverlayOptions = {},
): DevtoolsOverlayHandle {
  if (typeof document === 'undefined') {
    throw new Error('mountDevtoolsOverlay() requires a browser DOM (document is undefined)');
  }
  const container = options.container ?? document.body ?? document.documentElement;
  if (!container) {
    throw new Error('Could not find a container element for Open JSBridge Devtools overlay');
  }

  const position = options.position ?? 'bottom-right';
  const titleText = options.title ?? 'Open JSBridge Devtools';
  const zIndex = options.zIndex ?? 2_147_483_000;

  let openState = options.initiallyOpen === true;
  let activeTab: 'messages' | 'capabilities' = 'messages';
  let filterQuery = '';
  let errorsOnly = false;
  let expandedSeq: number | undefined;
  let exportFeedback = '';
  let unmounted = false;

  const host = document.createElement('div');
  host.setAttribute('data-ojsb-devtools', 'true');
  applyPosition(host, position, zIndex);

  const root: ParentNode = typeof host.attachShadow === 'function'
    ? host.attachShadow({ mode: 'open' })
    : host;

  const style = document.createElement('style');
  style.textContent = OVERLAY_STYLES;
  root.appendChild(style);

  const panel = document.createElement('div');
  panel.className = 'ojsb-panel';
  panel.style.display = openState ? 'flex' : 'none';

  const header = document.createElement('div');
  header.className = 'ojsb-header';
  const titleWrap = document.createElement('div');
  const titleEl = document.createElement('div');
  titleEl.className = 'ojsb-title';
  titleEl.textContent = titleText;
  const metaEl = document.createElement('div');
  metaEl.className = 'ojsb-meta';
  titleWrap.appendChild(titleEl);
  titleWrap.appendChild(metaEl);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ojsb-btn';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => setOpen(false));
  header.appendChild(titleWrap);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const toolbar = document.createElement('div');
  toolbar.className = 'ojsb-toolbar';

  const messagesTabBtn = document.createElement('button');
  messagesTabBtn.type = 'button';
  messagesTabBtn.className = 'ojsb-btn';
  messagesTabBtn.textContent = 'Messages';
  messagesTabBtn.addEventListener('click', () => {
    activeTab = 'messages';
    render();
  });

  const capsTabBtn = document.createElement('button');
  capsTabBtn.type = 'button';
  capsTabBtn.className = 'ojsb-btn';
  capsTabBtn.textContent = 'Capabilities';
  capsTabBtn.addEventListener('click', () => {
    activeTab = 'capabilities';
    render();
  });

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'ojsb-input';
  searchInput.placeholder = 'Filter method / id / code';
  searchInput.addEventListener('input', () => {
    filterQuery = searchInput.value.trim();
    render();
  });

  const errorsBtn = document.createElement('button');
  errorsBtn.type = 'button';
  errorsBtn.className = 'ojsb-btn';
  errorsBtn.textContent = 'Errors';
  errorsBtn.addEventListener('click', () => {
    errorsOnly = !errorsOnly;
    render();
  });

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'ojsb-btn';
  clearBtn.textContent = 'Clear';
  clearBtn.addEventListener('click', () => {
    expandedSeq = undefined;
    controller.clear();
  });

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'ojsb-btn';
  exportBtn.textContent = 'Export HAR';
  exportBtn.addEventListener('click', () => {
    const json = controller.exportHarJson(true);
    options.onExportHar?.(json);
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(json).catch(() => {});
    }
    exportFeedback = 'HAR exported';
    render();
  });

  toolbar.appendChild(messagesTabBtn);
  toolbar.appendChild(capsTabBtn);
  toolbar.appendChild(searchInput);
  toolbar.appendChild(errorsBtn);
  toolbar.appendChild(clearBtn);
  toolbar.appendChild(exportBtn);
  panel.appendChild(toolbar);

  const body = document.createElement('div');
  body.className = 'ojsb-body';
  panel.appendChild(body);
  root.appendChild(panel);

  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'ojsb-pill';
  const dot = document.createElement('span');
  dot.className = 'ojsb-dot';
  const pillLabel = document.createElement('span');
  pillLabel.textContent = 'JSB';
  const countBadge = document.createElement('span');
  countBadge.className = 'ojsb-badge';
  const errBadge = document.createElement('span');
  errBadge.className = 'ojsb-badge ojsb-badge-err';
  pill.appendChild(dot);
  pill.appendChild(pillLabel);
  pill.appendChild(countBadge);
  pill.appendChild(errBadge);
  pill.addEventListener('click', () => setOpen(!openState));
  root.appendChild(pill);

  function setOpen(next: boolean): void {
    if (unmounted) return;
    openState = next;
    panel.style.display = openState ? 'flex' : 'none';
    render();
  }

  function renderMessages(): void {
    const filtered = controller.entries().filter((entry) => matchesFilter(entry, filterQuery, errorsOnly));
    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ojsb-dim';
      empty.textContent = 'No messages captured.';
      body.appendChild(empty);
      return;
    }

    for (let i = filtered.length - 1; i >= 0; i -= 1) {
      const entry = filtered[i]!;
      const row = document.createElement('div');
      row.className = 'ojsb-row';
      row.addEventListener('click', () => {
        expandedSeq = expandedSeq === entry.seq ? undefined : entry.seq;
        render();
      });

      const head = document.createElement('div');
      head.className = 'ojsb-row-head';

      const dir = document.createElement('span');
      dir.className = 'ojsb-dir';
      dir.setAttribute('data-dir', entry.direction);
      dir.textContent = entry.direction === 'send' ? '→' : '←';
      head.appendChild(dir);

      const method = document.createElement('span');
      method.textContent = entry.method ?? entry.kind;
      head.appendChild(method);

      if (entry.code !== undefined) {
        const code = document.createElement('span');
        code.className = 'ojsb-err';
        code.textContent = `ERR ${entry.code}`;
        head.appendChild(code);
      }

      const detail = document.createElement('span');
      detail.className = 'ojsb-dim';
      const parts = [entry.kind, `${entry.bytes}B`];
      if (entry.roundTripMs !== undefined) parts.push(`${entry.roundTripMs.toFixed(1)}ms`);
      if (entry.hostHandlerMs !== undefined) parts.push(`host ${entry.hostHandlerMs.toFixed(1)}ms`);
      if (entry.id) parts.push(`#${entry.id}`);
      detail.textContent = parts.join(' · ');
      head.appendChild(detail);

      row.appendChild(head);

      if (expandedSeq === entry.seq) {
        const pre = document.createElement('pre');
        pre.className = 'ojsb-pre';
        pre.textContent = JSON.stringify(entry.envelope, null, 2);
        row.appendChild(pre);
      }

      body.appendChild(row);
    }
  }

  function renderCapabilities(): void {
    const snap = controller.session();
    const caps = snap.capabilities;
    if (!caps) {
      const empty = document.createElement('div');
      empty.className = 'ojsb-dim';
      empty.textContent = 'Handshake has not completed yet.';
      body.appendChild(empty);
      return;
    }

    const addSection = (heading: string, lines: readonly string[]) => {
      const section = document.createElement('div');
      section.className = 'ojsb-section';
      const headingEl = document.createElement('div');
      headingEl.className = 'ojsb-section-title';
      headingEl.textContent = heading;
      section.appendChild(headingEl);
      const pre = document.createElement('pre');
      pre.className = 'ojsb-pre';
      pre.textContent = lines.length > 0 ? lines.join('\n') : '(none)';
      section.appendChild(pre);
      body.appendChild(section);
    };

    const methodLines = Object.entries(caps.methods)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, versions]) => `${name} (${versions.map((v) => `@${v}`).join(', ')})`);
    addSection(`Methods (${methodLines.length})`, methodLines);
    addSection(`Events (${caps.events.length})`, [...caps.events].sort());
    addSection(`Features (${caps.features.length})`, [...caps.features].sort());
    if (snap.limits) {
      addSection('Limits', [JSON.stringify(snap.limits, null, 2)]);
    }
  }

  function render(): void {
    if (unmounted) return;
    const snap = controller.session();
    dot.setAttribute('data-state', snap.state);
    countBadge.textContent = String(snap.totalMessages);
    errBadge.textContent = `${snap.totalErrors} err`;
    errBadge.style.display = snap.totalErrors > 0 ? 'inline-block' : 'none';

    const hostLabel = snap.host ? `${snap.host.name}/${snap.host.platform} ${snap.host.version}` : 'no host';
    const sidLabel = snap.sid ? `sid=${snap.sid}` : 'no sid';
    metaEl.textContent = [snap.state, hostLabel, sidLabel, exportFeedback].filter(Boolean).join(' · ');

    messagesTabBtn.setAttribute('data-active', String(activeTab === 'messages'));
    capsTabBtn.setAttribute('data-active', String(activeTab === 'capabilities'));
    errorsBtn.setAttribute('data-active', String(errorsOnly));

    if (!openState) return;
    clearChildren(body);
    if (activeTab === 'messages') renderMessages();
    else renderCapabilities();
  }

  const unsubscribe = controller.subscribe(render);
  container.appendChild(host);
  render();

  return {
    hostElement: host,
    open() {
      setOpen(true);
    },
    close() {
      setOpen(false);
    },
    toggle() {
      setOpen(!openState);
    },
    isOpen() {
      return openState;
    },
    unmount() {
      if (unmounted) return;
      unmounted = true;
      unsubscribe();
      host.remove();
    },
  };
}
