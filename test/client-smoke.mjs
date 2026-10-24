/**
 * dsh-notepad — offline client smoke test.
 *
 * Loads the real client bundle in a browser-shaped shim with a miniature React
 * runtime, runs apply(ctx), renders the floating notepad, then exercises the
 * segmented workflow: load, edit/autosave, Enter split, single/batch insert,
 * replace, send (auto-archive), archive show/hide/restore/delete, select-all,
 * collapse, minimize/restore, resize and the global hotkey.
 *
 * Run: node test/client-smoke.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const CLIENT_PATH = new URL('../client.js', import.meta.url);
const ROOT = 'D:\\Projects\\demo-workspace';
const SESSION = 'session-smoke-1';

// ---------------------------------------------------------------------------
// Mini React
// ---------------------------------------------------------------------------
const instances = new Map();
let rendering = null;
let scheduled = false;

function schedule() {
  scheduled = true;
}

function normalize(children) {
  const flat = [];
  for (const child of children) {
    if (Array.isArray(child)) flat.push(...normalize(child));
    else if (child !== null && child !== undefined && child !== false && child !== true) flat.push(child);
  }
  return flat;
}

const React = {
  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) };
    const kids = normalize(children);
    if (kids.length > 0) merged.children = kids.length === 1 ? kids[0] : kids;
    return { $$element: true, type, props: merged };
  },
  useState(init) {
    const inst = rendering;
    const index = inst.cursor++;
    if (!(index in inst.hooks)) inst.hooks[index] = typeof init === 'function' ? init() : init;
    const setter = (value) => {
      const next = typeof value === 'function' ? value(inst.hooks[index]) : value;
      if (next !== inst.hooks[index]) {
        inst.hooks[index] = next;
        schedule();
      }
    };
    return [inst.hooks[index], setter];
  },
  useRef(init) {
    const inst = rendering;
    const index = inst.cursor++;
    if (!(index in inst.hooks)) inst.hooks[index] = { current: init };
    return inst.hooks[index];
  },
  useEffect(fn, deps) {
    const inst = rendering;
    const index = inst.cursor++;
    const key = `ef${index}`;
    const previous = inst.hooks[index];
    if (previous === undefined || !sameDeps(previous.deps, deps)) {
      inst.hooks[index] = { deps, cleanup: previous?.cleanup };
      inst.pending.push({ key, fn });
    }
  },
  useLayoutEffect(fn, deps) {
    return React.useEffect(fn, deps);
  },
};

function sameDeps(a, b) {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}

function renderTree(element, path = '0', seen = null) {
  if (element === null || element === undefined || element === false || element === true) return [];
  if (typeof element === 'string' || typeof element === 'number') return [String(element)];
  if (Array.isArray(element)) return element.flatMap((child, index) => renderTree(child, `${path}.${index}`, seen));
  if (!element.$$element) return [String(element)];
  const { type, props } = element;
  if (seen !== null) seen.push({ element, path });
  if (typeof type === 'function') {
    let inst = instances.get(path);
    if (inst === undefined) {
      inst = { hooks: [], cursor: 0, pending: [], effects: new Map() };
      instances.set(path, inst);
    }
    inst.cursor = 0;
    inst.pending = [];
    const saved = rendering;
    rendering = inst;
    let output;
    try {
      output = type(props);
    } finally {
      rendering = saved;
    }
    const children = renderTree(output, path, seen);
    for (const item of inst.pending) {
      const previous = inst.effects.get(item.key);
      try {
        previous?.();
      } catch { /* ignore cleanup failures */ }
      let cleanup;
      try {
        cleanup = item.fn();
      } catch (error) {
        console.error('[effect threw]', item.key, error);
      }
      inst.effects.set(item.key, typeof cleanup === 'function' ? cleanup : undefined);
    }
    return children;
  }
  return renderTree(props.children, `${path}.c`, seen);
}

// ---------------------------------------------------------------------------
// Browser shim
// ---------------------------------------------------------------------------
const styleTags = [];
const storage = new Map();
const listeners = new Map();

function addListener(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
}
function removeListener(type, fn) {
  listeners.get(type)?.delete(fn);
}

const conversationNode = {
  getBoundingClientRect: () => ({ width: 900, height: 700, top: 0, left: 0, right: 900, bottom: 700 }),
};

function makeWorkspaceRow(key) {
  const attributes = { 'data-row-key': `workspace:${key}` };
  return {
    attributes,
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null; },
    setAttribute(name, value) { attributes[name] = String(value); },
    removeAttribute(name) { delete attributes[name]; },
  };
}
const sidebarRows = [makeWorkspaceRow('ws-demo'), makeWorkspaceRow('ws-other')];
globalThis.MutationObserver = class MutationObserver {
  constructor(callback) { this.callback = callback; }
  observe() {}
  disconnect() {}
};

const documentShim = {
  head: { appendChild(node) { styleTags.push(node); } },
  body: { appendChild() {}, removeChild() {} },
  activeElement: null,
  visibilityState: 'visible',
  documentElement: {
    attributes: { 'data-windows-titlebar': '' },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); },
    getAttribute(name) { return this.attributes[name] ?? null; },
  },
  createElement(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      textContent: '',
      value: '',
      attributes: {},
      style: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      remove() { this.removed = true; },
      select() {},
    };
  },
  createElementNS(namespace, tag) {
    const node = {
      namespace,
      tagName: String(tag).toUpperCase(),
      attributes: {},
      children: [],
      setAttribute(name, value) { this.attributes[name] = value; },
      appendChild(child) { this.children.push(child); return child; },
      replaceChildren(...children) { this.children = children; },
      querySelector(selector) {
        if (selector !== '[data-dsh-notepad-logo]') return null;
        const walk = (item) => {
          if (item?.attributes?.['data-dsh-notepad-logo'] !== undefined) return true;
          return Array.isArray(item?.children) && item.children.some(walk);
        };
        return this.children.some(walk) ? {} : null;
      },
    };
    return node;
  },
  querySelector(selector) {
    return selector === '[data-conversation-content]' ? conversationNode : null;
  },
  querySelectorAll(selector) {
    if (selector === '[data-row-key^="workspace:"]') return sidebarRows;
    if (selector === '[data-conversation-content]') return [conversationNode];
    return [];
  },
  addEventListener: addListener,
  removeEventListener: removeListener,
  execCommand() { return true; },
};

const windowShim = {
  __ModuleLoader__: {
    factories: new Map(),
    load(module) {
      if (this.factories.has(module.id)) {
        throw new Error(`duplicate factory registration for "${module.id}"`);
      }
      this.factories.set(module.id, module);
      loadedModules.push(module);
    },
  },
  innerWidth: 1280,
  innerHeight: 800,
  localStorage: {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
  },
  addEventListener: addListener,
  removeEventListener: removeListener,
  getComputedStyle() {
    const values = {
      '--dsh-frame-chrome-top': '32px',
      '--dsh-frame-top-clearance': '32px',
      '--dsh-windows-titlebar-height': '32px',
    };
    return { getPropertyValue(name) { return values[name] ?? ''; } };
  },
  open(url, name, features) {
    openedWindows.push({ url, name, features });
    detachedActive = true;
    return { closed: false, focus() {} };
  },
};

const loadedModules = [];
const openedWindows = [];
let detachedActive = false;
globalThis.window = windowShim;
globalThis.document = documentShim;
const clipboardWrites = [];
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    language: 'zh-CN',
    clipboard: {
      async writeText(text) {
        clipboardWrites.push(text);
      },
    },
  },
});
globalThis.FileReader = class FileReader {
  readAsDataURL(file) {
    this.result = `data:${file?.type ?? 'image/png'};base64,${file?.__base64 ?? 'AAAA'}`;
    this.onload?.();
  }
};
globalThis.__DSH_HOST_PATHS__ = {
  pathFor(file) {
    return typeof file?.__path === 'string' ? file.__path : '';
  },
};

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
const source = readFileSync(CLIENT_PATH, 'utf8');
(0, eval)(source);

assert.equal(loadedModules.length, 1, 'bundle registers exactly one factory');
const module = loadedModules[0];
assert.equal(module.id, '@restregular/dsh-notepad');

let secondRunError;
try {
  (0, eval)(source);
} catch (error) {
  secondRunError = error;
}
assert.equal(secondRunError, undefined, 're-running the same bundle is a no-op');
assert.equal(loadedModules.length, 1);

const realmLoads = [];
const realm = createContext({
  window: {
    __ModuleLoader__: {
      factories: new Map(),
      load(realmModule) {
        this.factories.set(realmModule.id, realmModule);
        realmLoads.push(realmModule.id);
      },
    },
  },
});
runInContext(source, realm);
runInContext(source, realm);
assert.deepEqual(realmLoads, ['@restregular/dsh-notepad'], 'the classic-script realm tolerates a second execution');

const face = module.factory((spec) => {
  if (spec === 'react') return React;
  throw new Error(`unexpected require("${spec}")`);
});
assert.equal(typeof face.apply, 'function');
assert.deepEqual(face.inject, ['slots']);

// ---------------------------------------------------------------------------
// Fake services + fetch
// ---------------------------------------------------------------------------
let storedSegments = [
  { id: 's1', text: '第一段内容', createdAt: '2026-01-01T00:00:02.000Z', archived: false },
  { id: 's2', text: '第二段内容', createdAt: '2026-01-01T00:00:01.000Z', archived: false },
  { id: 'a1', text: '已归档内容', createdAt: '2026-01-01T00:00:00.000Z', archived: true, archivedAt: '2026-01-01T00:00:00.000Z' },
];
let storedMtime = 1000;
const requests = [];
const inserted = [];
const replacedDrafts = [];
const sent = [];
let persistedDrafts = 0;
let uploadedImages = 0;
const deletedImages = [];
const optimizeRequests = [];
const unsentRequests = [];

function merge(segments) {
  return segments
    .map((segment) => {
      const parts = [];
      if (String(segment.text ?? '').trim() !== '') parts.push(segment.text);
      for (const image of segment.images ?? []) parts.push(`![${image.name}](${image.path})`);
      return parts.join('\n');
    })
    .filter((text) => text.trim() !== '')
    .join('\n\n');
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
  };
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), 'http://127.0.0.1:1');
  requests.push({ url: url.pathname + url.search, method: init.method ?? 'GET', body: init.body });
  if (url.pathname === '/dsh-notepad/api/image') {
    if ((init.method ?? 'POST') === 'DELETE') {
      const body = JSON.parse(init.body);
      deletedImages.push(body.path);
      return jsonResponse({ ok: true, root: body.root, deleted: true });
    }
    const body = JSON.parse(init.body);
    uploadedImages += 1;
    return jsonResponse({
      ok: true,
      root: body.root,
      path: `.dsh/notepad/images/uploaded-${uploadedImages}.png`,
      name: body.name ?? 'image.png',
      mime: body.mime ?? 'image/png',
      size: 4,
    });
  }
  if (url.pathname === '/dsh-notepad/api/detach-url') {
    return jsonResponse({
      ok: true,
      url: 'http://127.0.0.1:45678/window?token=smoke-token',
    });
  }
  if (url.pathname === '/dsh-notepad/api/detached') {
    return jsonResponse({ ok: true, active: detachedActive, seen: detachedActive, retired: false });
  }
  if (url.pathname === '/dsh-notepad/api/detached/retire') {
    detachedActive = false;
    return jsonResponse({ ok: true, retired: true });
  }
  if (url.pathname === '/dsh-notepad/api/unsent') {
    unsentRequests.push(url.search);
    return jsonResponse({
      ok: true,
      workspaces: [
        { id: 'ws-demo', path: ROOT, title: 'demo', count: 1, hasContent: true },
        { id: 'ws-other', path: 'D:\\Projects\\other', title: 'other', count: 2, hasContent: false },
        { id: 'ws-third', path: 'D:\\Projects\\third', title: 'third', count: 3, hasContent: true },
      ],
    });
  }
  if (url.pathname === '/dsh-notepad/api/optimize') {
    const body = JSON.parse(init.body);
    optimizeRequests.push(body);
    return jsonResponse({ ok: true, root: body.root, text: `优化：${body.text}` });
  }
  if (url.pathname !== '/dsh-notepad/api/note') {
    return jsonResponse({ ok: false, error: 'not found' }, 404);
  }
  if ((init.method ?? 'GET') === 'PUT') {
    const body = JSON.parse(init.body);
    storedSegments = body.segments.map((segment) => ({ ...segment, archived: segment.archived === true }));
    storedMtime += 1;
    return jsonResponse({
      ok: true,
      root: body.root,
      segments: storedSegments,
      text: merge(storedSegments),
      mtimeMs: storedMtime,
      updatedAt: new Date().toISOString(),
    });
  }
  return jsonResponse({
    ok: true,
    root: ROOT,
    segments: storedSegments,
    text: merge(storedSegments),
    mtimeMs: storedMtime,
    updatedAt: new Date().toISOString(),
  });
};

const draftState = { draft: '', draftRev: 7 };
const draftListeners = new Set();
/** Mirror the DSH input store the plugin reads with `hooks.input`. */
const inputStore = {
  getSnapshot: () => ({ draft: draftState.draft, draftRev: draftState.draftRev, phase: 'plain' }),
  subscribe(listener) {
    draftListeners.add(listener);
    return () => { draftListeners.delete(listener); };
  },
};
function writeDraft(text) {
  draftState.draft = text;
  draftState.draftRev += 1;
  for (const listener of [...draftListeners]) listener();
}

const inputActions = {
  captureInsertion: () => ({ from: draftState.draft.length, to: draftState.draft.length, draftRev: draftState.draftRev }),
  insertText(text, span) {
    inserted.push({ text, span });
    const at = Number.isFinite(span?.from) ? span.from : draftState.draft.length;
    writeDraft(`${draftState.draft.slice(0, at)}${text}${draftState.draft.slice(at)}`);
    return true;
  },
  setDraft(text) {
    replacedDrafts.push(text);
    writeDraft(text);
  },
  persistDraft() {
    persistedDrafts += 1;
  },
};

const sessionState = {
  key: SESSION,
  props: { sessionId: SESSION, inputActions },
  hooks: { input: inputStore },
  keyedHooks: {},
};
const currentSource = {
  getSnapshot: () => sessionState,
  subscribe: () => () => {},
};
let sessionRunning = false;
const listSource = {
  getSnapshot: () => ({
    phase: 'ready',
    ids: [SESSION],
    byId: { [SESSION]: { id: SESSION, cwd: ROOT, running: sessionRunning, retainedBy: { mainView: 1 } } },
  }),
  subscribe: () => () => {},
};

const composerSends = [];
const conversation = {
  async send(text) {
    sent.push(text);
  },
  async sendSession(session, text) {
    composerSends.push({ session, text });
    sent.push(text);
    return { kind: 'success' };
  },
};
const scopedContext = {
  get(name) { return name === 'conversation' ? conversation : undefined; },
};
const promptModes = [];
const submittedModes = [];
const sessionFace = {
  sessionId: SESSION,
  beginSubmission(input) {
    submittedModes.push(input.mode);
    return { requestId: 'echo-1', abandon() {} };
  },
  async prompt(content, mode) {
    promptModes.push(mode);
    sent.push(content.map((part) => part.text).join(''));
    return { ok: true, value: { accepted: true, mode } };
  },
};
let createdSessions = 0;
const createdSessionRequests = [];
/** A created session only gets a live prompt face after openSession(). */
const liveSessions = new Set([SESSION]);
const sessionsService = {
  list: listSource,
  scope: (sessionId) => (liveSessions.has(sessionId) ? scopedContext : { get: () => undefined }),
  binding: (sessionId) => (liveSessions.has(sessionId) ? { session: sessionFace } : undefined),
  async create(options) {
    createdSessions += 1;
    createdSessionRequests.push(options);
    return { ok: true, value: { sessionId: `session-new-${createdSessions}` } };
  },
};

const uiWorkspace = {
  startSessionCalls: [],
  openSessionCalls: [],
  startSession(workspaceId, options) {
    this.startSessionCalls.push({ workspaceId, options });
  },
  openSession(sessionId) {
    this.openSessionCalls.push(sessionId);
    liveSessions.add(sessionId);
  },
};

/** Host Workspace projection: ROOT is registered as a real Workspace. */
const workspacesService = {
  list: {
    getSnapshot: () => ({
      items: [{ workspaceId: 'ws-demo', path: ROOT, sessionIds: [SESSION] }],
      phase: 'ready',
    }),
  },
};

const busyEnter = { value: 'queue' };
const configForms = {
  get(namespace) {
    if (namespace !== 'ui-conversation') return undefined;
    return {
      getSnapshot: () => ({ value: { busyEnter: busyEnter.value } }),
      subscribe: () => () => {},
    };
  },
};

const localeRegistered = [];
const locale = {
  register(namespace, dict) {
    localeRegistered.push({ namespace, dict });
    return () => {};
  },
  bind() {
    const dict = localeRegistered.at(-1)?.dict.zh ?? {};
    return (key, params) => {
      let value = dict[key] ?? key;
      if (params) {
        for (const [name, replacement] of Object.entries(params)) {
          value = value.replaceAll(`{${name}}`, String(replacement));
        }
      }
      return value;
    };
  },
};

const registrations = [];
const injected = [];
const cleanups = [];
const slots = {
  inject(name, factory) {
    injected.push(name);
    const result = factory();
    return typeof result === 'function' ? result : () => {};
  },
  register(options, component) {
    registrations.push({ options, component });
    return () => {};
  },
};

const ctx = {
  get(name) {
    if (name === 'slots') return slots;
    if (name === 'locale') return locale;
    if (name === 'uiSession') return { adapter: { current: currentSource } };
    if (name === 'sessions') return sessionsService;
    if (name === 'conversation') return conversation;
    if (name === 'uiWorkspace') return uiWorkspace;
    if (name === 'workspaces') return workspacesService;
    if (name === 'configForms') return configForms;
    return undefined;
  },
  effect(fn) {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return () => {};
  },
};

face.apply(ctx);

assert.deepEqual(injected, ['shell.overlay', 'settings.section']);
// Workspace resolution feeds the live sidebar badge: a stale / differently
// spelled path must not leave the current Workspace without an id.
const resolveWorkspaceId = face.__test.resolveWorkspaceId;
assert.equal(
  resolveWorkspaceId(ctx, 'd:\\\\PROJECTS\\\\demo\\\\', SESSION, []),
  'ws-demo',
  'Session membership resolves the Workspace regardless of path spelling',
);
assert.equal(
  resolveWorkspaceId(ctx, 'D:\\\\Elsewhere\\\\demo', 'unknown-session',
    [{ id: 'ws-reg', path: 'd:\\\\elsewhere\\\\demo' }]),
  'ws-reg',
  'the registry list matches a Windows path case-insensitively',
);
assert.equal(
  resolveWorkspaceId(ctx, 'D:\\\\Elsewhere', 'unknown-session', []),
  '',
  'a directory no Workspace claims resolves to nothing',
);
assert.equal(styleTags.length, 1, 'styles injected once');
assert.ok(styleTags[0].textContent.includes('.dsh-np-card'));
assert.ok(styleTags[0].textContent.includes('var(--dsw-font-family'), 'uses the DSH/system font family');
assert.ok(styleTags[0].textContent.includes('--np-font'), 'the notepad font follows a style variable');
assert.ok(styleTags[0].textContent.includes('body[data-ds-dark-theme]'), 'dark-mode overrides exist');
assert.ok(styleTags[0].textContent.includes('transition:height'), 'collapse animation exists');
assert.ok(styleTags[0].textContent.includes('visibility:hidden'), 'hide animation exists');
assert.ok(styleTags[0].textContent.includes('.dsh-np-title-add'), 'empty titles use a click target');
assert.ok(!styleTags[0].textContent.includes('.dsh-np-title-add:hover'), 'the empty-title click target has no hover style');
assert.ok(styleTags[0].textContent.includes('.dsh-np-actiongroup'), 'hover action groups have styles');
assert.ok(styleTags[0].textContent.includes('var(--np-group-delay'), 'action groups use the configurable hover delay');
assert.ok(styleTags[0].textContent.includes('@keyframes dsh-np-item-out'), 'archive / delete cards have an exit animation');
assert.ok(styleTags[0].textContent.includes('max-height:var(--np-seg-max'), 'the card height limit is configurable');
assert.ok(styleTags[0].textContent.includes('overflow-y:hidden'),
  'the textarea hides its scrollbar until the height limit');
assert.ok(styleTags[0].textContent.includes('.dsh-np-preview'), 'image preview styles exist');
assert.ok(styleTags[0].textContent.includes('.dsh-np-confirm'), 'delete confirmation styles exist');
assert.ok(styleTags[0].textContent.includes('.dsh-np-set'), 'settings tab styles exist');
assert.ok(styleTags[0].textContent.includes('.dsh-np-toggle'), 'settings use toggle switches');
assert.ok(styleTags[0].textContent.includes('.dsh-np-drop'), 'settings use a custom dropdown');
assert.ok(styleTags[0].textContent.includes('.dsh-np-img-remove{position:absolute;top:-6px;right:-6px'),
  'the image remove button sits on the thumbnail corner');
assert.ok(styleTags[0].textContent.includes('.dsh-np-tools{position:relative;display:flex;align-items:flex-start;flex:none;height:auto;min-height:36px'),
  'the button bar hugs its one-row content and keeps bottom breathing room');
assert.ok(styleTags[0].textContent.includes('padding:0 2px 4px') && styleTags[0].textContent.includes('.dsh-np-toolbar-actions{position:absolute;right:2px;top:0'),
  'the action buttons are top-aligned with padding below them');
assert.ok(!styleTags[0].textContent.includes('.dsh-np-tools::-webkit-scrollbar'),
  'the button bar no longer has a scrollbar');
assert.ok(styleTags[0].textContent.includes('.dsh-np-toolbar-actions{position:absolute;right:2px'),
  'the action buttons sit at the right edge');
assert.ok(styleTags[0].textContent.includes('flex-wrap:nowrap'), 'the action buttons never wrap');
assert.ok(styleTags[0].textContent.includes('.dsh-np-toolbar-actions') && styleTags[0].textContent.includes('z-index:1'),
  'the action buttons sit below the left-hand text');
assert.ok(styleTags[0].textContent.includes('.dsh-np-selectall{position:relative;z-index:2'),
  'the select-all text covers overflowing actions');
assert.ok(styleTags[0].textContent.includes(
  'background:color-mix(in srgb,var(--np-surface) 80%,transparent);backdrop-filter:saturate(1.15) blur(var(--np-blur))'),
'the select-all label uses a frosted-glass surface instead of an opaque block');
assert.ok(styleTags[0].textContent.includes(
  '.dsh-np-selectall::after{content:"";position:absolute;right:-12px;top:0;bottom:0;width:12px;background:linear-gradient(90deg,color-mix(in srgb,var(--np-surface) 80%,transparent),transparent)'),
'the selection label fades into the glass edge');
assert.ok(styleTags[0].textContent.includes('border-bottom:1px solid var(--dsw-alias-border-l1') && styleTags[0].textContent.includes('overflow:hidden'),
  'the button bar clips overflow instead of scrolling');
assert.ok(styleTags[0].textContent.includes('padding:8px 2px 8px 0'),
  'the card list keeps its normal padding');
assert.ok(styleTags[0].textContent.includes('.dsh-np-btn[data-danger=true]:hover'),
  'the toolbar danger item turns red on hover');
assert.deepEqual(localeRegistered.map((entry) => entry.namespace), ['dsh-notepad']);
const overlay = registrations.find((entry) => entry.options.name === 'shell.overlay');
assert.ok(overlay, 'registers shell.overlay');
assert.equal(overlay.options.id, 'notepad');
assert.equal(overlay.options.order, 70);
const settingsRegistration = registrations.find((entry) => entry.options.name === 'settings.section');
assert.ok(settingsRegistration, 'registers a settings.section tab');
assert.equal(settingsRegistration.options.id, 'notepad');

// Settings sidebar icon: a 16-grid single-color line drawing, not the host gear.
const navSvg = documentShim.createElementNS('http://www.w3.org/2000/svg', 'svg');
face.__test.paintNotepadNavIcon(navSvg);
assert.equal(navSvg.attributes.viewBox, '0 0 16 16', 'the nav icon uses the host 16-grid viewBox');
assert.equal(navSvg.children.length, 2, 'the nav icon is a frame plus note lines');
assert.equal(navSvg.children[0].attributes.stroke, 'currentColor');
assert.equal(navSvg.children[1].attributes['stroke-width'], '1.3');
const markedCells = [];
const navCell = {
  textContent: '记事本',
  classList: { add(name) { markedCells.push(name); } },
  querySelector(selector) { return selector.includes('_navIcon') ? navSvg : null; },
};
const originalQuerySelectorAll = documentShim.querySelectorAll;
documentShim.querySelectorAll = (selector) => selector.includes('_navCell') ? [navCell] : originalQuerySelectorAll.call(documentShim, selector);
const stopNav = face.__test.wrapSettingsNav(() => '记事本');
documentShim.querySelectorAll = originalQuerySelectorAll;
assert.ok(markedCells.includes('dsh-notepad-nav'), 'only our settings nav row is marked');
stopNav();

// ---------------------------------------------------------------------------
// Render + interactions
// ---------------------------------------------------------------------------
function createOverlay() {
  return overlay.component();
}

async function renderRounds(rounds = 1, wait = 25) {
  let text = [];
  let seen = [];
  for (let index = 0; index < rounds; index += 1) {
    scheduled = false;
    seen = [];
    text = renderTree(createOverlay(), '0', seen);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return { text: text.join(' '), seen };
}

/** Wait for the archive / delete exit animation before asserting removal. */
async function settleLeave() {
  await new Promise((resolve) => setTimeout(resolve, 210));
}

function findByTitle(seen, title) {
  return seen.find(({ element }) => element.type === 'button' && element.props.title === title);
}

function findAllByTitle(seen, title) {
  return seen.filter(({ element }) => element.type === 'button' && element.props.title === title);
}

function findByClass(seen, className) {
  return seen.find(({ element }) => element.props?.className === className);
}

function findAllByClass(seen, className) {
  return seen.filter(({ element }) => element.props?.className === className);
}

function textareas(seen) {
  return seen.filter(({ element }) => element.type === 'textarea');
}

function archivedCards(seen) {
  return seen.filter(({ element }) => element.type === 'article' && element.props['data-archived'] === 'true');
}

/** Entries rendered inside one article (its descendant subtree in this render). */
function withinCard(seen, card, predicate) {
  return seen.find(({ element, path }) => path.startsWith(`${card.path}.c`) && predicate(element));
}

async function pressButton(seen, title) {
  const target = findByTitle(seen, title);
  assert.ok(target, `${title} button exists`);
  await target.element.props.onClick();
}

const initial = await renderRounds(8);
assert.ok(initial.seen.some(({ element }) => element.type === 'section' && element.props['data-dsh-notepad'] === 'true'), 'card renders');
assert.ok(initial.text.includes('记事本'), 'title rendered');
assert.ok(initial.text.includes('demo-workspace'), 'workspace name rendered');
assert.ok(requests.some((request) => request.method === 'GET' && request.url.includes('session-smoke-1')), 'loads the note for the session');
assert.equal(textareas(initial.seen).length, 2, 'two active segments render');
assert.deepEqual(textareas(initial.seen).map(({ element }) => element.props.value), ['第一段内容', '第二段内容']);
assert.equal(archivedCards(initial.seen).length, 1, 'archived card is present in the document');
assert.equal(archivedCards(initial.seen)[0].element.props['data-collapsed'], 'false',
  'legacy / manually archived cards start expanded');
assert.ok(withinCard(initial.seen, archivedCards(initial.seen)[0], (element) =>
  element.type === 'button' && element.props.className === 'dsh-np-fold'),
'archived cards expose a fold toggle');
assert.ok(findByTitle(initial.seen, '显示归档'), 'archive toggle is present without a count badge');
assert.ok(!initial.seen.some(({ element }) => element.props?.className === 'dsh-np-badge'), 'archive count badge is gone');
assert.ok(!initial.text.includes('显示归档（1）'), 'archive toggle title omits the count');
assert.ok(initial.text.includes('已保存'), 'status shows saved');
assert.equal(sidebarRows[0].attributes['data-np-unsent'], '2', 'the current workspace row shows its pending count');
assert.equal(sidebarRows[1].attributes['data-np-unsent'], '2', 'other workspace rows keep their own counts');
assert.ok(unsentRequests.length > 0, 'sidebar counts are fetched');
const selectAllLabel = findByClass(initial.seen, 'dsh-np-selectall');
assert.equal(selectAllLabel.element.props.children[1].props.children, '全选',
  'the selection hint reads 全选 when nothing is selected');
const initialGroup = findAllByClass(initial.seen, 'dsh-np-actiongroup')[0];
const groupPrimary = initialGroup.element.props.children[0];
let blurredGroupButton = 0;
groupPrimary.props.onPointerUp({ currentTarget: { blur() { blurredGroupButton += 1; } } });
assert.equal(blurredGroupButton, 1,
  'pointer activation blurs the action button so the group can collapse after the mouse leaves');
const headerChildren = findByClass(initial.seen, 'dsh-np-head').element.props.children;
const headerButtons = (Array.isArray(headerChildren) ? headerChildren : [headerChildren])
  .filter((child) => child?.type === 'button');
const undoIndex = headerButtons.findIndex((child) => String(child.props.title ?? '').startsWith('撤销 ·'));
const redoIndex = headerButtons.findIndex((child) => String(child.props.title ?? '').startsWith('重做 ·'));
const copyIndex = headerButtons.findIndex((child) => child.props.title === '复制全部');
assert.ok(undoIndex >= 0 && redoIndex > undoIndex && copyIndex > redoIndex,
  'undo and redo sit in the header immediately left of copy-all');
const initialToolbarChildren = findByClass(initial.seen, 'dsh-np-toolbar-actions').element.props.children;
assert.ok((Array.isArray(initialToolbarChildren) ? initialToolbarChildren : [initialToolbarChildren])
  .every((child) => !String(child?.props?.title ?? '').startsWith('撤销 ·')),
'the action bar no longer carries undo');

// Auto refresh keeps the list scroll position -----------------------------
const listRefProp = findByClass(initial.seen, 'dsh-np-list')?.element.props.ref;
assert.ok(listRefProp, 'the scrollable list exposes a ref');
const listNode = { scrollTop: 42 };
listRefProp.current = listNode;
storedMtime += 1;
for (const listener of [...(listeners.get('focus') ?? [])]) listener({});
listNode.scrollTop = 0;
await new Promise((resolve) => setTimeout(resolve, 40));
await renderRounds(1);
assert.equal(listNode.scrollTop, 42, 'auto refresh restores the list scroll position');

// Edit + autosave ---------------------------------------------------------
const firstTextarea = textareas(initial.seen)[0];
firstTextarea.element.props.onChange({ target: { value: '第一段改' } });
await new Promise((resolve) => setTimeout(resolve, 650));
const afterEdit = await renderRounds(2);
const put = requests.filter((request) => request.method === 'PUT').at(-1);
assert.ok(put, 'autosave issues a PUT');
const putBody = JSON.parse(put.body);
assert.equal(putBody.segments[0].text, '第一段改');
assert.equal(putBody.segments.length, 3);
assert.equal(putBody.root, ROOT);
assert.equal(putBody.sessionId, SESSION);
assert.ok(afterEdit.text.includes('已保存'), 'status shows saved after autosave');

// Enter splits the first segment -----------------------------------------
const splitSource = textareas(afterEdit.seen)[0];
splitSource.element.props.onKeyDown({
  key: 'Enter',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  preventDefault() {},
  currentTarget: { selectionStart: 2, selectionEnd: 2, value: '第一段改' },
});
const afterSplit = await renderRounds(2);
assert.equal(textareas(afterSplit.seen).length, 3, 'Enter creates a new card');
assert.deepEqual(
  textareas(afterSplit.seen).map(({ element }) => element.props.value),
  ['第一', '段改', '第二段内容'],
  'Enter splits text at the caret',
);

// Single insert / replace -------------------------------------------------
const insertButton = findByTitle(afterSplit.seen, '插入此段');
assert.ok(insertButton, 'single insert button exists');
assert.equal(insertButton.element.props.disabled, false);
await insertButton.element.props.onClick();
assert.equal(inserted.at(-1).text, '第一');
assert.deepEqual(inserted.at(-1).span, { from: 0, to: 0, draftRev: 7 });
const afterInsert = await renderRounds(1);
assert.ok(afterInsert.text.includes('已插入输入框'), 'insert toast shown');

const replaceButton = findByTitle(afterInsert.seen, '替换此段');
assert.ok(replaceButton, 'single replace button exists');
await replaceButton.element.props.onClick();
assert.equal(replacedDrafts.at(-1), '第一');
const afterReplace = await renderRounds(1);
assert.ok(afterReplace.text.includes('已替换输入框内容'), 'replace toast shown');
assert.ok(persistedDrafts >= 2, 'draft persistence is requested after insert and replace');

// Collapse / expand -------------------------------------------------------
await pressButton(afterReplace.seen, '折叠');
const collapsed = await renderRounds(2);
const collapsedCard = collapsed.seen.find(({ element }) => element.type === 'section' && element.props['data-dsh-notepad'] === 'true');
assert.equal(collapsedCard.element.props['data-minimized'], 'true');
assert.equal(collapsedCard.element.props.style.height, '44px', 'collapsed card uses the header height');
assert.ok(findByTitle(collapsed.seen, '展开'), 'expand button appears');

await pressButton(collapsed.seen, '展开');
const expanded = await renderRounds(2);
const expandedCard = expanded.seen.find(({ element }) => element.type === 'section' && element.props['data-dsh-notepad'] === 'true');
assert.equal(expandedCard.element.props['data-minimized'], 'false');
assert.notEqual(expandedCard.element.props.style.height, '44px', 'expanded card returns to its stored height');

// Resize -----------------------------------------------------------------
const storedBeforeResize = JSON.parse(storage.get('dsh-notepad.ui.v1'));
const resizeHandle = findByClass(expanded.seen, 'dsh-np-resize');
assert.ok(resizeHandle, 'resize handle is rendered');
resizeHandle.element.props.onPointerDown({
  button: 0,
  clientX: 600,
  clientY: 400,
  preventDefault() {},
  stopPropagation() {},
});
for (const listener of [...(listeners.get('pointermove') ?? [])]) {
  listener({ clientX: 640, clientY: 430 });
}
await renderRounds(2);
for (const listener of [...(listeners.get('pointerup') ?? [])]) {
  listener({});
}
await renderRounds(2);
const storedAfterResize = JSON.parse(storage.get('dsh-notepad.ui.v1'));
assert.equal(storedAfterResize.width, storedBeforeResize.width + 40, 'width follows the resize drag');
assert.equal(storedAfterResize.height, storedBeforeResize.height + 30, 'height follows the resize drag');

// Hide / restore ----------------------------------------------------------
await pressButton(expanded.seen, '最小化');
const hidden = await renderRounds(2);
const hiddenCard = hidden.seen.find(({ element }) => element.type === 'section' && element.props['data-dsh-notepad'] === 'true');
assert.ok(hiddenCard, 'hidden card stays mounted for the transition');
assert.equal(hiddenCard.element.props['data-hidden'], 'true');
assert.equal(hiddenCard.element.props['aria-hidden'], 'true');
const restoreButton = findByClass(hidden.seen, 'dsh-np-restore');
assert.ok(restoreButton, 'restore button rendered while hidden');
assert.equal(restoreButton.element.props['data-visible'], 'true');
assert.equal(restoreButton.element.props.title, '显示记事本（Ctrl+Shift+N）');
const restoreBadge = findByClass(hidden.seen, 'dsh-np-restore-badge');
assert.ok(restoreBadge, 'the hidden restore button shows a pending badge');
assert.equal(restoreBadge.element.props.children, '3', 'the badge counts unsent active segments');
await restoreButton.element.props.onClick();
const restored = await renderRounds(2);
const restoredCard = restored.seen.find(({ element }) => element.type === 'section' && element.props['data-dsh-notepad'] === 'true');
assert.equal(restoredCard.element.props['data-hidden'], 'false');
const hiddenRestoreButton = findByClass(restored.seen, 'dsh-np-restore');
assert.ok(hiddenRestoreButton, 'restore button stays mounted for its fade-out');
assert.equal(hiddenRestoreButton.element.props['data-visible'], 'false');

// Detached window ---------------------------------------------------------
const detachButton = findAllByTitle(restored.seen, '在独立窗口打开')[0];
assert.ok(detachButton, 'the header exposes the detached-window button');
detachButton.element.props.onClick();
const detached = await renderRounds(2, 60);
assert.equal(openedWindows.length, 1, 'the detached window is opened once');
const opened = new URL(openedWindows[0].url);
assert.equal(opened.origin, 'http://127.0.0.1:45678');
assert.equal(opened.pathname, '/window');
assert.equal(opened.searchParams.get('token'), 'smoke-token');
assert.equal(opened.searchParams.get('root'), ROOT, 'the detached URL carries the workspace root');
assert.equal(openedWindows[0].name, 'dsh-notepad-detached');
assert.ok(openedWindows[0].features.includes('popup=yes'), 'the browser opens a popup window');
assert.ok(requests.some((request) => request.method === 'POST' && request.url === '/dsh-notepad/api/detach-url'),
  'the client asks the Host for the token-guarded URL');
const detachedCard = detached.seen.find(({ element }) => element.type === 'section'
  && element.props['data-dsh-notepad'] === 'true');
assert.equal(detachedCard.element.props['data-hidden'], 'true', 'the floating panel hides while detached');
const detachedRestore = findByClass(detached.seen, 'dsh-np-restore');
assert.equal(detachedRestore.element.props['data-detached'], 'true');
assert.equal(detachedRestore.element.props.title, '收回独立窗口');
detachedRestore.element.props.onClick();
const reattached = await renderRounds(2, 60);
const reattachedCard = reattached.seen.find(({ element }) => element.type === 'section'
  && element.props['data-dsh-notepad'] === 'true');
assert.equal(reattachedCard.element.props['data-hidden'], 'false', 'the restore pill brings the panel back');
assert.equal(detachedActive, false, 'returning the detached window retires it on the Host');
assert.ok(requests.some((request) => request.method === 'POST' && request.url === '/dsh-notepad/api/detached/retire'),
  'the Host is told to release the detached window');

// Archive show / hide -----------------------------------------------------
await pressButton(restored.seen, '显示归档');
const archiveShown = await renderRounds(2);
const archiveSection = findByClass(archiveShown.seen, 'dsh-np-archive');
assert.ok(archiveSection, 'archive section exists');
assert.equal(archiveSection.element.props['data-open'], 'true');
assert.equal(archivedCards(archiveShown.seen).length, 1);
assert.ok(archiveShown.text.includes('已归档内容'));
assert.equal(findAllByTitle(archiveShown.seen, '删除此段').length, 1, 'delete exists only on archived cards');

await pressButton(archiveShown.seen, '隐藏归档');
const archiveHidden = await renderRounds(2);
const hiddenArchive = findByClass(archiveHidden.seen, 'dsh-np-archive');
assert.equal(hiddenArchive.element.props['data-open'], 'false');
await pressButton(archiveHidden.seen, '显示归档');
const archiveShownAgain = await renderRounds(2);

// Send one segment -> it is archived automatically ------------------------
const sendOne = findAllByTitle(archiveShownAgain.seen, '发送此段')[0];
assert.ok(sendOne, 'single send button exists');
await sendOne.element.props.onClick();
const afterSendOne = await renderRounds(3);
assert.equal(sent.at(-1), '第一', 'single segment is sent');
assert.equal(textareas(afterSendOne.seen).length, 2, 'sent segment left the active list');
assert.equal(archivedCards(afterSendOne.seen).length, 2, 'sent segment is auto-archived');
await new Promise((resolve) => setTimeout(resolve, 650));
const afterSendSave = await renderRounds(1);
const sendPut = JSON.parse(requests.filter((request) => request.method === 'PUT').at(-1).body);
assert.ok(sendPut.segments.some((segment) => segment.text === '第一' && segment.archived === true), 'autosave keeps the archived flag');
assert.equal(sendPut.segments.find((segment) => segment.text === '第一').origin, 'send',
  'notepad sends record the send origin');
const sentCard = archivedCards(afterSendOne.seen).find(({ element }) => elementText(element).includes('第一'));
assert.ok(sentCard, 'the sent card is in the archive');
assert.equal(sentCard.element.props['data-collapsed'], 'false', 'send-archived cards start expanded');

// Select all + batch replace / insert / send ------------------------------
const selectAll = afterSendSave.seen.find(({ element }) => element.type === 'input'
  && element.props.type === 'checkbox'
  && element.props['aria-label'] === '全选');
assert.ok(selectAll, 'select-all checkbox exists');
selectAll.element.props.onChange({ target: { checked: true } });
const selected = await renderRounds(2);
assert.ok(selected.text.includes('已选 2 段'), 'select-all selects every active segment');
const toolbarActions = findByClass(selected.seen, 'dsh-np-toolbar-actions');
assert.ok(toolbarActions, 'the action buttons have a dedicated right-aligned container');
const firstAction = Array.isArray(toolbarActions.element.props.children)
  ? toolbarActions.element.props.children[0]
  : toolbarActions.element.props.children;
assert.equal(firstAction?.props?.title, '取消选择', 'cancel-selection is the leftmost action button');
assert.equal(findByClass(selected.seen, 'dsh-np-selectall').element.props.children[1].props.children, '已选 2 段',
  'the left-hand label shows the selection count above the actions');
const batchReplace = findByTitle(selected.seen, '替换为选中的 2 段');
assert.ok(batchReplace, 'batch replace button reflects the selection');
await batchReplace.element.props.onClick();
assert.equal(replacedDrafts.at(-1), '段改\n\n第二段内容', 'batch replace merges selected segments in order');

const batchInsert = findByTitle(selected.seen, '插入选中的 2 段');
assert.ok(batchInsert, 'batch insert button reflects the selection');
await batchInsert.element.props.onClick();
assert.equal(inserted.at(-1).text, '段改\n\n第二段内容', 'batch insert merges selected segments in order');

const batchSend = findByTitle(selected.seen, '发送选中的 2 段');
assert.ok(batchSend, 'batch send button reflects the selection');
await batchSend.element.props.onClick();
const afterBatchSend = await renderRounds(3);
assert.equal(sent.at(-1), '段改\n\n第二段内容', 'batch send merges selected segments');
assert.equal(textareas(afterBatchSend.seen).length, 0, 'all active segments were archived');
assert.ok(afterBatchSend.text.includes('没有进行中的分段'), 'empty active state is shown');
assert.equal(archivedCards(afterBatchSend.seen).length, 4, 'all sent segments are archived');
assert.ok(findByTitle(afterBatchSend.seen, '显示归档') || findByTitle(afterBatchSend.seen, '隐藏归档'), 'archive toggle remains after batch send');

// Delete only archived + undo --------------------------------------------
const deleteButton = findAllByTitle(afterBatchSend.seen, '删除此段')[0];
assert.ok(deleteButton, 'archived card exposes delete');
await deleteButton.element.props.onClick();
await settleLeave();
const afterDelete = await renderRounds(2);
assert.equal(archivedCards(afterDelete.seen).length, 3, 'archived segment deleted');
assert.ok(afterDelete.text.includes('已删除'));
const undoButton = afterDelete.seen.find(({ element }) => element.type === 'button' && element.props.className === 'dsh-np-toast-action');
assert.ok(undoButton, 'delete toast offers undo');
await undoButton.element.props.onClick();
const afterUndo = await renderRounds(2);
assert.equal(archivedCards(afterUndo.seen).length, 4, 'undo restores the archived segment');

// Restore one archived segment -------------------------------------------
const restoreOne = findAllByTitle(afterUndo.seen, '恢复此段')[0];
assert.ok(restoreOne, 'archived card exposes restore');
await restoreOne.element.props.onClick();
const afterRestore = await renderRounds(2);
assert.equal(archivedCards(afterRestore.seen).length, 3, 'restored segment leaves the archive');
assert.equal(textareas(afterRestore.seen).length, 1, 'restored segment returns to the active list');

// Clear archive + undo ----------------------------------------------------
const clearArchive = afterRestore.seen.find(({ element }) => element.type === 'button'
  && element.props.className === 'dsh-np-link'
  && element.props.children === '清空归档');
assert.ok(clearArchive, 'clear-archive link exists');
await clearArchive.element.props.onClick();
await settleLeave();
const afterClear = await renderRounds(2);
assert.equal(archivedCards(afterClear.seen).length, 0, 'clear archive removes every archived card');
assert.ok(afterClear.text.includes('还没有归档的分段'));
const clearUndo = afterClear.seen.find(({ element }) => element.type === 'button' && element.props.className === 'dsh-np-toast-action');
assert.ok(clearUndo, 'clear-archive toast offers undo');
await clearUndo.element.props.onClick();
const afterClearUndo = await renderRounds(2);
assert.equal(archivedCards(afterClearUndo.seen).length, 3, 'clear-archive undo restores the archive');

// Copy all ---------------------------------------------------------------
const copyButton = findByTitle(afterClearUndo.seen, '复制全部');
assert.ok(copyButton, 'copy-all button exists');
assert.equal(copyButton.element.props.disabled, false);
await copyButton.element.props.onClick();
const afterCopy = await renderRounds(1);
assert.ok(afterCopy.text.includes('已复制'), 'copy toast shown');
assert.equal(clipboardWrites.at(-1), '段改', 'copy-all writes only active segments');
assert.ok(!clipboardWrites.at(-1).includes('已归档内容'), 'copy-all never includes archived content');
assert.ok(!clipboardWrites.at(-1).includes('第二段内容'), 'copy-all never includes other archived content');

// Images: pick keeps the host path, paste uploads into the plugin dir ---------
const imageInput = afterCopy.seen.find(({ element }) => element.type === 'input' && element.props.type === 'file');
assert.ok(imageInput, 'each active segment exposes a hidden image input');
assert.ok(findByTitle(afterCopy.seen, '添加图片'), 'the segment header exposes an add-image button');
assert.equal(imageInput.element.props.multiple, true);
assert.equal(imageInput.element.props.accept.includes('image/png'), true);
const pickFile = {
  type: 'image/png',
  name: 'picked.png',
  size: 12,
  __path: 'D:\\Projects\\demo-workspace\\pics\\picked.png',
};
imageInput.element.props.onChange({ currentTarget: { files: [pickFile], value: '' } });
const afterPick = await renderRounds(3);
assert.equal(uploadedImages, 0, 'a selected image with a host path is not copied');
assert.ok(afterPick.text.includes('1 张图片'), 'footer counts picked images');
assert.equal(afterPick.seen.filter(({ element }) => element.props?.className === 'dsh-np-img-name').length, 0,
  'uploaded image chips do not display the file name');
assert.equal(afterPick.seen.filter(({ element }) => element.type === 'img').length, 1, 'image chip renders a thumbnail');
const pickedSrc = afterPick.seen.find(({ element }) => element.type === 'img').element.props.src;
assert.ok(String(pickedSrc).includes('api/file?path='), 'thumbnail uses the authenticated file route');
assert.ok(String(pickedSrc).includes('picked.png'));

// Image preview ----------------------------------------------------------
const openImageButton = afterPick.seen.find(({ element }) => element.type === 'button'
  && element.props['aria-label'] === '打开图片');
assert.ok(openImageButton, 'image chips expose a preview button');
openImageButton.element.props.onClick();
const afterPreview = await renderRounds(1);
assert.ok(findByClass(afterPreview.seen, 'dsh-np-preview'), 'clicking an image chip opens the in-panel preview');
const previewImg = afterPreview.seen.find(({ element }) => element.type === 'img'
  && element.props.className === 'dsh-np-preview-img');
assert.ok(previewImg, 'the preview renders the image');
assert.ok(String(previewImg.element.props.src).includes('picked.png'));
await findByTitle(afterPreview.seen, '关闭预览').element.props.onClick();
const afterPreviewClose = await renderRounds(1);
assert.equal(findByClass(afterPreviewClose.seen, 'dsh-np-preview'), undefined, 'the preview closes');

const imageEditor = findByClass(afterPreviewClose.seen, 'dsh-np-editor');
assert.ok(imageEditor, 'image editor wrapper exists');
let prevented = 0;
imageEditor.element.props.onPaste({
  clipboardData: {
    files: [{
      type: 'image/png',
      name: 'clip.png',
      size: 12,
      __path: 'C:\\screens\\clip.png',
      __base64: 'AAAA',
    }],
  },
  preventDefault() { prevented += 1; },
});
const afterPaste = await renderRounds(4);
assert.equal(prevented, 1, 'an image paste is intercepted');
assert.equal(uploadedImages, 1, 'a pasted image is uploaded even when it has a host path');
assert.ok(afterPaste.text.includes('2 张图片'), 'footer counts pasted images');
const thumbnails = afterPaste.seen.filter(({ element }) => element.type === 'img').map(({ element }) => String(element.props.src));
assert.ok(thumbnails.some((src) => src.includes('uploaded-1.png')), 'pasted image previews the plugin-directory file');

const insertWithImages = findByTitle(afterPaste.seen, '插入此段');
assert.ok(insertWithImages, 'image-bearing segment can still be inserted');
await insertWithImages.element.props.onClick();
assert.equal(
  inserted.at(-1).text,
  '段改\n![picked.png](pics/picked.png)\n![clip.png](.dsh/notepad/images/uploaded-1.png)',
  'insert appends path-based Markdown image references',
);

const removeImageButtons = findAllByTitle(afterPaste.seen, '移除图片');
assert.equal(removeImageButtons.length, 2, 'each image chip has a remove button');
await removeImageButtons.at(-1).element.props.onClick();
const afterRemoveImage = await renderRounds(2);
assert.ok(afterRemoveImage.text.includes('1 张图片'), 'removing a chip updates the footer count');
assert.equal(afterRemoveImage.seen.filter(({ element }) => element.type === 'img').length, 1, 'removed image card is gone');
assert.ok(
  deletedImages.includes('.dsh/notepad/images/uploaded-1.png'),
  'removing a plugin-owned image chip deletes its stored file',
);
await new Promise((resolve) => setTimeout(resolve, 650));
await renderRounds(1);
const imagePut = JSON.parse(requests.filter((request) => request.method === 'PUT').at(-1).body);
const activeWithImages = imagePut.segments.find((segment) => segment.archived !== true);
assert.equal(activeWithImages.images.length, 1, 'autosave persists the remaining image reference');
assert.equal(activeWithImages.images[0].path, 'pics/picked.png');

const unsupportedInput = afterRemoveImage.seen.find(({ element }) => element.type === 'input' && element.props.type === 'file');
unsupportedInput.element.props.onChange({ currentTarget: { files: [{ type: 'text/plain', name: 'a.txt' }], value: '' } });
const afterUnsupported = await renderRounds(1);
assert.ok(afterUnsupported.text.includes('只支持 PNG / JPEG / WebP / GIF 图片'), 'unsupported files are rejected with feedback');
assert.ok(!afterUnsupported.text.includes('2 张图片'), 'unsupported files are not attached');

// New segments, titles, selection by index, merge, AI and reorder ----------
await pressButton(afterUnsupported.seen, '新建分段');
const afterAddOne = await renderRounds(2);
await pressButton(afterAddOne.seen, '新建分段');
const afterAddTwo = await renderRounds(2);
assert.equal(textareas(afterAddTwo.seen).length, 3, 'new segments are created');
assert.deepEqual(textareas(afterAddTwo.seen).map(({ element }) => element.props.value), ['段改', '', ''], 'new segments land at the bottom');
assert.equal(findAllByClass(afterAddTwo.seen, 'dsh-np-title-input').length, 0, 'empty titles still render no inputs');

const firstNew = textareas(afterAddTwo.seen)[1];
const secondNew = textareas(afterAddTwo.seen)[2];
firstNew.element.props.onChange({ target: { value: 'A' } });
const afterA = await renderRounds(1);
secondNew.element.props.onChange({ target: { value: 'B' } });
const afterAB = await renderRounds(1);
assert.deepEqual(textareas(afterAB.seen).map(({ element }) => element.props.value), ['段改', 'A', 'B']);

// Arrow keys leave a card only from the very start / very end of its text --
const arrowAreas = textareas(afterAB.seen);
const arrowNodes = arrowAreas.map(({ element }) => ({
  value: element.props.value,
  selectionStart: 0,
  selectionEnd: 0,
  focused: false,
  caret: -1,
  focus() { this.focused = true; },
  setSelectionRange(position) { this.caret = position; },
  scrollIntoView() {},
}));
arrowAreas.forEach(({ element }, index) => element.props.ref(arrowNodes[index]));
const arrowEvent = (key, currentTarget) => ({
  key,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  preventDefault() {},
  currentTarget,
});
const caretIn = (node, caret) => {
  node.selectionStart = caret;
  node.selectionEnd = caret;
  node.focused = false;
  node.caret = -1;
  return node;
};
// Middle of a single-line card: the arrows stay in the card.
caretIn(arrowNodes[0], 1);
arrowAreas[0].element.props.onKeyDown(arrowEvent('ArrowDown', arrowNodes[0]));
assert.equal(arrowNodes[1].focused, false, 'ArrowDown in the middle of the text stays in the card');
caretIn(arrowNodes[1], 1);
arrowAreas[1].element.props.onKeyDown(arrowEvent('ArrowUp', arrowNodes[1]));
assert.equal(arrowNodes[0].focused, false, 'ArrowUp in the middle of the text stays in the card');
// A multi-line card keeps its arrows even on the first / last line, and still
// hands the caret over from position 0 / the text end.
const multilineSource = {
  value: 'one\ntwo\nthree',
  selectionStart: 5,
  selectionEnd: 5,
  focused: false,
  caret: -1,
  focus() { this.focused = true; },
  setSelectionRange(position) { this.caret = position; },
  scrollIntoView() {},
};
caretIn(arrowNodes[2], 0); // reset the previous target
arrowAreas[0].element.props.onKeyDown(arrowEvent('ArrowDown', caretIn(multilineSource, 8)));
assert.equal(arrowNodes[1].focused, false, 'ArrowDown at the first column of the last line does not jump');
arrowAreas[0].element.props.onKeyDown(arrowEvent('ArrowUp', caretIn(multilineSource, 3)));
assert.equal(arrowNodes[0].focused, false, 'ArrowUp at the end of the first line does not jump');
// Edges: the very end goes down, the very start goes up.
arrowAreas[0].element.props.onKeyDown(arrowEvent('ArrowDown', caretIn(arrowNodes[0], 2)));
assert.equal(arrowNodes[1].focused, true, 'ArrowDown at the end of the text focuses the next card');
assert.equal(arrowNodes[1].caret, 0, 'ArrowDown puts the caret at the start of the next card');
arrowAreas[1].element.props.onKeyDown(arrowEvent('ArrowUp', caretIn(arrowNodes[1], 0)));
assert.equal(arrowNodes[0].focused, true, 'ArrowUp at the start of the text focuses the previous card');
assert.equal(arrowNodes[0].caret, 2, 'ArrowUp puts the caret at the end of the previous card');
arrowAreas[0].element.props.onKeyDown(arrowEvent('ArrowDown', caretIn(multilineSource, 13)));
assert.equal(arrowNodes[1].focused, true, 'ArrowDown at the end of multi-line text still jumps');

const titleInputsBefore = findAllByClass(afterAB.seen, 'dsh-np-title-input');
const titleAdds = findAllByClass(afterAB.seen, 'dsh-np-title-add');
assert.equal(titleInputsBefore.length, 0, 'empty titles do not render an input');
assert.equal(titleAdds.length, 3, 'each empty title exposes a click target');
assert.ok(!afterAB.text.includes('分段标题（可选）'), 'empty titles render no placeholder text');
assert.equal(titleAdds[0].element.props.children, undefined, 'the empty-title click target is blank');
titleAdds[1].element.props.onClick();
const afterTitleClick = await renderRounds(1);
const revealedTitleInputs = findAllByClass(afterTitleClick.seen, 'dsh-np-title-input');
assert.equal(revealedTitleInputs.length, 1, 'clicking the blank title area reveals the title input');
assert.equal(revealedTitleInputs[0].element.props.autoFocus, true, 'the revealed title input is focused');
revealedTitleInputs[0].element.props.onChange({ target: { value: '合并标题' } });
const afterTitle = await renderRounds(1);
assert.equal(findAllByClass(afterTitle.seen, 'dsh-np-title-input')[0].element.props.value, '合并标题');

// Insert / send / archive-delete hover groups ----------------------------
assert.equal(findAllByClass(afterTitle.seen, 'dsh-np-actiongroup').length, 13,
  'the toolbar and every card wrap insert / send / archive-delete in expanding groups, plus expand/collapse-all');
assert.equal(findAllByTitle(afterTitle.seen, '在新会话中插入').length, 4,
  'each insert button exposes a new-session action');
assert.equal(findAllByTitle(afterTitle.seen, '在新会话中发送').length, 4,
  'each send button exposes a new-session action');
const newSessionExtras = afterTitle.seen.filter(({ element }) =>
  element.type === 'button'
  && (element.props.title === '在新会话中插入' || element.props.title === '在新会话中发送'));
assert.ok(newSessionExtras.length === 8, 'all new-session extras exist');
assert.ok(newSessionExtras.some(({ element }) => element.props.children?.type?.name === 'NewSessionIcon'),
  'insert extras use the insert-into-session icon');
assert.ok(newSessionExtras.some(({ element }) => element.props.children?.type?.name === 'NewSessionSendIcon'),
  'send extras use the send-to-session icon');
assert.equal(findAllByTitle(afterTitle.seen, '删除此段（不可恢复）').length, 3,
  'every active card exposes delete in the archive group');
assert.equal(findAllByTitle(afterTitle.seen, '替换此段').length, 6,
  'replace buttons stay separate on active and archived cards');
assert.equal(findAllByTitle(afterTitle.seen, '替换为选中的 2 段').length, 0, 'no selection yet');
assert.equal(findAllByTitle(afterTitle.seen, '替换输入框内容').length, 1, 'the toolbar replace button stays ungrouped');

const indexes = findAllByClass(afterTitle.seen, 'dsh-np-index');
assert.equal(indexes.length, 3, 'each card exposes a clickable index');
indexes[1].element.props.onClick();
const afterSelectOne = await renderRounds(1);
const selectOneIndexes = findAllByClass(afterSelectOne.seen, 'dsh-np-index');
selectOneIndexes[2].element.props.onClick();
const afterSelectTwo = await renderRounds(1);
assert.ok(afterSelectTwo.text.includes('已选 2 段'), 'clicking indexes selects segments');

const mergeButton = findByTitle(afterSelectTwo.seen, '合并选中的 2 段');
assert.ok(mergeButton, 'merge button reflects the selection');
await mergeButton.element.props.onClick();
const afterMerge = await renderRounds(2);
assert.deepEqual(
  textareas(afterMerge.seen).map(({ element }) => element.props.value),
  ['段改', 'A\n\nB'],
  'merging keeps the merged card at the topmost selected position',
);
assert.equal(findAllByClass(afterMerge.seen, 'dsh-np-title-input')[0].element.props.value, '合并标题', 'merged card keeps the titles');

const optimizeOne = findAllByTitle(afterMerge.seen, 'AI 优化此段')[1];
assert.ok(optimizeOne, 'each card exposes an AI optimize button');
const aiTextarea = textareas(afterMerge.seen)[1];
const aiGrowNode = { style: {}, scrollHeight: 400 };
aiTextarea.element.props.ref(aiGrowNode);
await optimizeOne.element.props.onClick();
const afterOptimizeOne = await renderRounds(3);
assert.equal(optimizeRequests.at(-1).text, 'A\n\nB', 'the AI request carries the card text');
assert.equal(optimizeRequests.at(-1).title, '合并标题', 'the AI request carries the card title');
assert.equal(aiGrowNode.style.height, '240px',
  'a taller AI result re-measures and grows the textarea to its limit');
assert.equal(aiGrowNode.style.overflowY, 'auto',
  'a taller AI result enables the textarea scrollbar at the limit');
assert.deepEqual(
  textareas(afterOptimizeOne.seen).map(({ element }) => element.props.value),
  ['段改', '优化：A\n\nB'],
  'single-card AI optimization replaces only that card',
);
const undoOptimizeOne = findByTitle(afterOptimizeOne.seen, '撤销优化');
assert.ok(undoOptimizeOne, 'the optimized card button turns into undo');
await undoOptimizeOne.element.props.onClick();
const afterUndoOptimizeOne = await renderRounds(2);
assert.deepEqual(
  textareas(afterUndoOptimizeOne.seen).map(({ element }) => element.props.value),
  ['段改', 'A\n\nB'],
  'undoing the card optimization restores its text',
);
assert.equal(findAllByTitle(afterUndoOptimizeOne.seen, '撤销优化').length, 0,
  'the undo button returns to AI optimize after use');

const optimizeCountBefore = optimizeRequests.length;
const optimizeAgain = findAllByTitle(afterUndoOptimizeOne.seen, 'AI 优化此段')[1];
await optimizeAgain.element.props.onClick();
const afterOptimizeAgain = await renderRounds(2);
assert.equal(optimizeRequests.length, optimizeCountBefore,
  'unchanged content is optimized from the cache without another model call');
assert.deepEqual(
  textareas(afterOptimizeAgain.seen).map(({ element }) => element.props.value),
  ['段改', '优化：A\n\nB'],
  'the cached answer is applied again',
);

// Batch optimize only visits the selected cards ----------------------------
const selectAllForAi = afterOptimizeAgain.seen.find(({ element }) => element.type === 'input'
  && element.props.type === 'checkbox'
  && element.props['aria-label'] === '全选');
assert.ok(selectAllForAi, 'select-all is available for batch optimization');
selectAllForAi.element.props.onChange({ target: { checked: true } });
const afterSelectForAi = await renderRounds(2);
const optimizeSelectedButton = findByTitle(afterSelectForAi.seen, 'AI 优化选中的 2 段');
assert.ok(optimizeSelectedButton, 'the toolbar only offers to optimize the selection');
const selectedOptimizeBefore = optimizeRequests.length;
await optimizeSelectedButton.element.props.onClick();
const afterOptimizeSelected = await renderRounds(5);
assert.equal(optimizeRequests.length - selectedOptimizeBefore, 2,
  'batch optimization visits every selected card, cache only skipping exact repeats');
assert.deepEqual(
  textareas(afterOptimizeSelected.seen).map(({ element }) => element.props.value),
  ['优化：段改', '优化：优化：A\n\nB'],
  'batch optimization rewrites only the selected cards',
);
const toolbarUndo = afterOptimizeSelected.seen.find(({ element }) => element.type === 'button'
  && element.props.className === 'dsh-np-btn' && element.props.title === '撤销优化');
assert.ok(toolbarUndo, 'the toolbar AI button turns into undo after a batch run');
await toolbarUndo.element.props.onClick();
const afterBatchUndo = await renderRounds(2);
assert.deepEqual(
  textareas(afterBatchUndo.seen).map(({ element }) => element.props.value),
  ['段改', '优化：A\n\nB'],
  'the toolbar undo restores every batch-edited card',
);
assert.equal(findAllByTitle(afterBatchUndo.seen, '撤销优化').length, 0,
  'the batch undo offer clears after use');

const beforeReorder = findAllByClass(afterBatchUndo.seen, 'dsh-np-index');
beforeReorder[0].element.props.onDragStart({ dataTransfer: { setData() {}, effectAllowed: 'move' } });
const activeArticles = afterBatchUndo.seen.filter(({ element }) =>
  element.type === 'article' && element.props['data-archived'] === 'false');
assert.equal(activeArticles.length, 2, 'two active cards remain');
const dragOver = {
  dataTransfer: { types: ['application/x-dsh-notepad-segment'] },
  currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 100 }) },
  clientY: 90,
  preventDefault() {},
  stopPropagation() {},
};
activeArticles[1].element.props.onDragOver(dragOver);
const afterDragOver = await renderRounds(1);
const dragArticles = afterDragOver.seen.filter(({ element }) =>
  element.type === 'article' && element.props['data-archived'] === 'false');
assert.equal(dragArticles[1].element.props['data-drop-after'], 'true', 'drag over marks the insertion side');
dragArticles[1].element.props.onDrop({ dataTransfer: { types: [] }, preventDefault() {}, stopPropagation() {} });
const afterReorder = await renderRounds(2);
assert.deepEqual(
  textareas(afterReorder.seen).map(({ element }) => element.props.value),
  ['优化：A\n\nB', '段改'],
  'dragging a card updates the display order',
);
assert.equal(sidebarRows[0].attributes['data-np-unsent'], '2', 'workspace badge follows the live pending count');

const badgeFetchesBeforeSave = unsentRequests.length;
await new Promise((resolve) => setTimeout(resolve, 650));
const afterFeatureSave = await renderRounds(2);
assert.ok(unsentRequests.length > badgeFetchesBeforeSave,
  'a finished save refreshes the sidebar badges without waiting for the poll');
const featurePut = JSON.parse(requests.filter((request) => request.method === 'PUT').at(-1).body);
const titled = featurePut.segments.find((segment) => segment.title === '合并标题');
assert.ok(titled, 'card titles autosave');
assert.equal(titled.text, '优化：A\n\nB', 'optimized text autosaves');

// Global hotkey ----------------------------------------------------------
const keydown = listeners.get('keydown');
assert.ok(keydown && keydown.size > 0, 'global keydown listener installed');
const pressHotkey = () => {
  for (const listener of [...keydown]) {
    listener({ key: 'N', ctrlKey: true, metaKey: false, shiftKey: true, preventDefault() {} });
  }
};
pressHotkey();
const hotkeyHidden = await renderRounds(2);
const hotkeyCard = hotkeyHidden.seen.find(({ element }) => element.type === 'section' && element.props['data-dsh-notepad'] === 'true');
assert.equal(hotkeyCard.element.props['data-hidden'], 'true', 'hotkey hides the card');
const hotkeyBadge = findByClass(hotkeyHidden.seen, 'dsh-np-restore-badge');
assert.ok(hotkeyBadge, 'the hidden restore button still shows a pending badge');
assert.equal(hotkeyBadge.element.props.children, '2', 'the badge tracks the current pending count');
pressHotkey();
const hotkeyShown = await renderRounds(2);
const hotkeyShownCard = hotkeyShown.seen.find(({ element }) => element.type === 'section' && element.props['data-dsh-notepad'] === 'true');
assert.equal(hotkeyShownCard.element.props['data-hidden'], 'false', 'hotkey shows the card again');

// Host title bar clamp + reset hotkey -------------------------------------
const headerNode = findByClass(hotkeyShown.seen, 'dsh-np-head');
assert.ok(headerNode, 'the drag header is rendered');
headerNode.element.props.onPointerDown({
  button: 0,
  clientX: 120,
  clientY: 400,
  target: null,
  preventDefault() {},
});
for (const listener of [...(listeners.get('pointermove') ?? [])]) {
  listener({ clientX: 120, clientY: -800 });
}
await renderRounds(2);
for (const listener of [...(listeners.get('pointerup') ?? [])]) listener({});
await renderRounds(2);
const draggedUi = JSON.parse(storage.get('dsh-notepad.ui.v1'));
assert.ok(draggedUi.y >= 40, 'the floating card cannot be dragged above the host title bar');

for (const listener of [...keydown]) {
  listener({
    key: 'R',
    code: 'KeyR',
    ctrlKey: true,
    metaKey: false,
    shiftKey: true,
    altKey: false,
    preventDefault() {},
  });
}
const afterReset = await renderRounds(2);
const resetUi = JSON.parse(storage.get('dsh-notepad.ui.v1'));
assert.equal(resetUi.width, 420, 'reset restores the default width');
assert.equal(resetUi.height, 460, 'reset restores the default height');
assert.equal(resetUi.x, 1280 - 420 - 24, 'reset parks the card at its default left');
assert.equal(resetUi.y, 800 - 460 - 24, 'reset parks the card at its default bottom');
assert.ok(afterReset.text.includes('已复位浮窗位置和尺寸'), 'reset shows feedback');
assert.ok(!findByTitle(afterReset.seen, '复位记事本位置和尺寸 · Ctrl+Shift+R'),
  'the header reset button is gone; only the shortcut remains');

// Footer shortcut hint cycles --------------------------------------------
const hintButton = findByClass(afterReset.seen, 'dsh-np-hint');
assert.ok(hintButton, 'the footer shows one shortcut hint');
assert.equal(hintButton.element.type, 'button', 'the hint is clickable');
const firstHint = hintButton.element.props.children;
assert.equal(firstHint, 'Enter 新建分段');
hintButton.element.props.onClick();
const afterHint = await renderRounds(1);
const nextHint = findByClass(afterHint.seen, 'dsh-np-hint').element.props.children;
assert.equal(nextHint, 'Shift+Enter 分段内换行', 'clicking the hint rotates to the next shortcut');
assert.notEqual(nextHint, firstHint);

// Delete an active segment with confirmation ------------------------------
const deleteActiveButtons = findAllByTitle(afterHint.seen, '删除此段（不可恢复）');
assert.equal(deleteActiveButtons.length, 2, 'every active card exposes a delete button');
await deleteActiveButtons[0].element.props.onClick();
const afterDeletePrompt = await renderRounds(1);
const confirmDialog = findByClass(afterDeletePrompt.seen, 'dsh-np-confirm');
assert.ok(confirmDialog, 'deleting an active segment opens a confirmation dialog');
assert.ok(afterDeletePrompt.text.includes('删除后无法恢复'), 'the dialog warns that deletion cannot be undone');
const confirmButtons = findAllByClass(afterDeletePrompt.seen, 'dsh-np-confirm-btn');
assert.equal(confirmButtons.length, 2);
await confirmButtons[0].element.props.onClick();
const afterDeleteCancel = await renderRounds(1);
assert.equal(findByClass(afterDeleteCancel.seen, 'dsh-np-confirm'), undefined, 'cancelling closes the dialog');
assert.equal(textareas(afterDeleteCancel.seen).length, 2, 'cancelling keeps both segments');

await findAllByTitle(afterDeleteCancel.seen, '删除此段（不可恢复）')[0].element.props.onClick();
const afterDeletePromptAgain = await renderRounds(1);
const confirmDeleteButton = findAllByClass(afterDeletePromptAgain.seen, 'dsh-np-confirm-btn')
  .find(({ element }) => element.props['data-danger'] === 'true');
assert.ok(confirmDeleteButton, 'the dialog has a destructive confirm button');
await confirmDeleteButton.element.props.onClick();
await settleLeave();
const afterActiveDelete = await renderRounds(2);
assert.equal(textareas(afterActiveDelete.seen).length, 1, 'the active segment is deleted directly');
assert.equal(afterActiveDelete.seen.filter(({ element }) => element.props?.className === 'dsh-np-toast-action').length, 0,
  'an irreversible delete offers no undo');
assert.ok(afterActiveDelete.text.includes('已删除'));

// New-session insert / send ----------------------------------------------
const insertNewButton = findByTitle(afterActiveDelete.seen, '在新会话中插入');
assert.ok(insertNewButton, 'the insert group exposes the new-session action');
const startSessionCallsBefore = uiWorkspace.startSessionCalls.length;
await insertNewButton.element.props.onClick();
assert.equal(uiWorkspace.startSessionCalls.length, startSessionCallsBefore + 1);
assert.deepEqual(uiWorkspace.startSessionCalls.at(-1).options, {
  prompt: '段改\n![picked.png](pics/picked.png)',
  clearPreviousDraft: true,
});
assert.ok((await renderRounds(1)).text.includes('已在新会话中填入内容'));

const sendNewButton = findByTitle(afterActiveDelete.seen, '在新会话中发送');
assert.ok(sendNewButton, 'the send group exposes the new-session action');
const sentBeforeNew = sent.length;
await sendNewButton.element.props.onClick();
const afterSendNew = await renderRounds(3);
assert.equal(createdSessions, 1, 'sending in a new session creates it first');
assert.deepEqual(createdSessionRequests.at(-1), { workspaceId: 'ws-demo' },
  'the new session names its Workspace so it does not land in Ungrouped');
assert.equal(sent.length, sentBeforeNew + 1);
assert.equal(sent.at(-1), '段改\n![picked.png](pics/picked.png)', 'the new session receives the segment text');
assert.equal(uiWorkspace.openSessionCalls.at(-1), 'session-new-1', 'the new session is opened');
assert.equal(textareas(afterSendNew.seen).length, 0, 'sending in a new session archives the segment');
assert.ok(afterSendNew.text.includes('已在新会话中发送'));

// Busy-Enter send policy -------------------------------------------------
await pressButton(afterSendNew.seen, '新建分段');
const afterBusyAdd = await renderRounds(2);
const busyTextarea = textareas(afterBusyAdd.seen)[0];
busyTextarea.element.props.onChange({ target: { value: '忙碌发送' } });
const afterBusyText = await renderRounds(1);
sessionRunning = true;
busyEnter.value = 'steer';
const sendModesBefore = promptModes.length;
await findAllByTitle(afterBusyText.seen, '发送此段')[0].element.props.onClick();
const afterBusySend = await renderRounds(3);
assert.equal(submittedModes.at(-1), 'steer', 'the busy send uses the configured steer mode');
assert.equal(promptModes.length, sendModesBefore + 1);
assert.equal(promptModes.at(-1), 'steer', 'the session prompt carries the steer mode');
assert.equal(sent.at(-1), '忙碌发送');
sessionRunning = false;
busyEnter.value = 'queue';
assert.equal(textareas(afterBusySend.seen).length, 0, 'the steer send archives the segment');

// Backspace merge / empty delete / scrollbar threshold --------------------
await pressButton(afterBusySend.seen, '新建分段');
const afterSeqAddOne = await renderRounds(2);
textareas(afterSeqAddOne.seen)[0].element.props.onChange({ target: { value: 'alpha' } });
const afterAlpha = await renderRounds(1);
await pressButton(afterAlpha.seen, '新建分段');
const afterSeqAddTwo = await renderRounds(2);
textareas(afterSeqAddTwo.seen)[1].element.props.onChange({ target: { value: 'beta' } });
const afterBeta = await renderRounds(1);
assert.deepEqual(textareas(afterBeta.seen).map(({ element }) => element.props.value), ['alpha', 'beta']);

const betaArea = textareas(afterBeta.seen)[1];
betaArea.element.props.onKeyDown({
  key: 'Backspace',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  preventDefault() {},
  currentTarget: { value: 'beta', selectionStart: 0, selectionEnd: 0 },
});
const afterMergeBackspace = await renderRounds(2);
assert.deepEqual(textareas(afterMergeBackspace.seen).map(({ element }) => element.props.value), ['alphabeta'],
  'Backspace at the start of a segment merges it into the previous card');

await pressButton(afterMergeBackspace.seen, '新建分段');
const afterSplitAdd = await renderRounds(2);
textareas(afterSplitAdd.seen)[1].element.props.onChange({ target: { value: 'split' } });
const afterSplitText = await renderRounds(1);
textareas(afterSplitText.seen)[1].element.props.onKeyDown({
  key: 'Enter',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  preventDefault() {},
  currentTarget: { selectionStart: 5, selectionEnd: 5, value: 'split' },
});
const afterSplitEnd = await renderRounds(2);
assert.deepEqual(textareas(afterSplitEnd.seen).map(({ element }) => element.props.value), ['alphabeta', 'split', ''],
  'splitting at the end places the new card after its source (oldest to newest)');

const trailingDelete = findAllByTitle(afterSplitEnd.seen, '删除此段（不可恢复）').at(-1);
assert.ok(trailingDelete, 'the empty card exposes its delete action');
await trailingDelete.element.props.onClick();
await settleLeave();
const afterEmptyDelete = await renderRounds(2);
assert.equal(findByClass(afterEmptyDelete.seen, 'dsh-np-confirm'), undefined,
  'deleting an empty segment skips the confirmation dialog');
assert.equal(textareas(afterEmptyDelete.seen).length, 2, 'the empty segment is deleted');

await pressButton(afterEmptyDelete.seen, '新建分段');
const afterEmptyAgain = await renderRounds(2);
assert.equal(textareas(afterEmptyAgain.seen).length, 3);
textareas(afterEmptyAgain.seen).at(-1).element.props.onKeyDown({
  key: 'Backspace',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  preventDefault() {},
  currentTarget: { value: '', selectionStart: 0, selectionEnd: 0 },
});
const leavingEmpty = await renderRounds(1);
assert.ok(leavingEmpty.seen.some(({ element }) => element.props?.['data-leaving'] === 'true'),
  'Backspace deletion starts the same exit animation as the delete button');
await settleLeave();
const afterEmptyBackspace = await renderRounds(2);
assert.equal(textareas(afterEmptyBackspace.seen).length, 2,
  'Backspace in an empty segment deletes it');

const growArea = textareas(afterEmptyBackspace.seen)[0];
const shortNode = { style: {}, scrollHeight: 80 };
growArea.element.props.ref(shortNode);
assert.equal(shortNode.style.height, '80px', 'the textarea grows with its content');
assert.equal(shortNode.style.overflowY, 'hidden', 'no scrollbar appears before the height limit');
const longNode = { style: {}, scrollHeight: 400 };
growArea.element.props.ref(longNode);
assert.equal(longNode.style.height, '240px', 'the card stops growing at its max height');
assert.equal(longNode.style.overflowY, 'auto', 'the scrollbar appears once the limit is reached');

// Host shortcut registration ---------------------------------------------
const registeredShortcuts = [];
const faceTwo = module.factory((spec) => {
  if (spec === 'react') return React;
  throw new Error(`unexpected require("${spec}")`);
});
faceTwo.apply({
  get(name) {
    if (name === 'slots') {
      return {
        inject(overlayName, factory) { factory(); return () => {}; },
        register() { return () => {}; },
      };
    }
    if (name === 'shortcuts') {
      return {
        register(command) { registeredShortcuts.push(command); return () => {}; },
      };
    }
    return undefined;
  },
  effect(fn) { return fn(); },
});
assert.equal(registeredShortcuts.length, 5, 'the client registers toggle / reset / undo / redo / save with DSH shortcuts');
const resetCommand = registeredShortcuts.find((command) => command.id === 'notepad.resetGeometry');
assert.ok(resetCommand, 'the reset command is registered');
assert.deepEqual(resetCommand.defaults['desktop:windows'], { code: 'KeyR', modifiers: ['primary', 'shift'] });
assert.deepEqual(resetCommand.defaults['web:windows'], { code: 'KeyR', modifiers: ['primary', 'shift'] });
assert.ok(resetCommand.regions.includes('editable'), 'the reset shortcut also works while typing');
assert.equal(resetCommand.resolve().status, 'handled');
assert.equal(typeof resetCommand.resolve().run, 'function');

const toggleCommand = registeredShortcuts.find((command) => command.id === 'notepad.toggleVisibility');
assert.ok(toggleCommand, 'the visibility command is registered');
assert.deepEqual(toggleCommand.defaults['desktop:windows'], { code: 'KeyN', modifiers: ['primary', 'shift'] });
const undoCommand = registeredShortcuts.find((command) => command.id === 'notepad.undo');
assert.ok(undoCommand, 'the undo command is registered');
assert.deepEqual(undoCommand.defaults['desktop:windows'], { code: 'KeyZ', modifiers: ['primary'] });
assert.deepEqual(undoCommand.regions, ['page'], 'undo never steals a textarea native undo');
const redoCommand = registeredShortcuts.find((command) => command.id === 'notepad.redo');
assert.ok(redoCommand, 'the redo command is registered');
assert.deepEqual(redoCommand.defaults['desktop:windows'], { code: 'KeyZ', modifiers: ['primary', 'shift'] });
const saveCommand = registeredShortcuts.find((command) => command.id === 'notepad.save');
assert.ok(saveCommand, 'the save command is registered');
assert.deepEqual(saveCommand.defaults['desktop:windows'], { code: 'KeyS', modifiers: ['primary'] });

// ---------------------------------------------------------------------------
// Settings tab, history, collapse, copy, workspace switching and AI selection
// ---------------------------------------------------------------------------
function elementText(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(elementText).join('');
  if (node !== null && node !== undefined && node.$$element) return elementText(node.props?.children);
  return '';
}

function renderSettings() {
  const seen = [];
  const text = renderTree(settingsRegistration.component(), 'settings', seen).join(' ');
  return { text, seen };
}

function settingsNumber(seen, label) {
  return seen.find(({ element }) => element.type === 'input'
    && element.props['aria-label'] === label);
}

function settingsSwitches(seen) {
  return seen.filter(({ element }) => element.type === 'button' && element.props.role === 'switch');
}

let settingsView = renderSettings();
assert.ok(settingsView.text.includes('记事本设置'), 'the settings tab renders its title');
assert.ok(settingsView.text.includes('独立窗口'), 'the settings tab exposes the detached-window card');
const settingsDetachButton = settingsView.seen.find(({ element }) => element.type === 'button'
  && elementText(element) === '在独立窗口打开');
assert.ok(settingsDetachButton, 'the settings card has an open-detached button');
const opensBeforeSettingsDetach = openedWindows.length;
settingsDetachButton.element.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(openedWindows.length, opensBeforeSettingsDetach + 1, 'the settings button opens the detached window');
assert.equal(new URL(openedWindows.at(-1).url).searchParams.get('root'), ROOT,
  'the settings button opens the last active workspace');
assert.equal(settingsSwitches(settingsView.seen).length, 2, 'auto-save and button groups use toggles');
assert.equal(settingsView.seen.filter(({ element }) =>
  element.type === 'input' && element.props['aria-label'] === '显示 / 隐藏记事本').length, 1,
'the shortcut binding field exists');
assert.equal(settingsView.seen.filter(({ element }) =>
  element.type === 'input' && element.props['aria-label'] === '默认宽度').length, 1,
 'the default width field exists');
assert.equal(settingsView.seen.filter(({ element }) =>
  element.type === 'input' && element.props['aria-label'] === '展开 hover 时间阈值').length, 1,
 'the hover delay field is visible while button groups are enabled');

// Manual save mode: no debounce PUT, and the header exposes a save button.
await renderRounds(1, 700);
const putCountBeforeManual = requests.filter((request) => request.method === 'PUT').length;
settingsSwitches(settingsView.seen)[0].element.props.onClick();
let afterToggle = await renderRounds(2);
assert.ok(findByTitle(afterToggle.seen, '立即保存当前内容 · Ctrl+S')
  || afterToggle.seen.some(({ element }) => element.type === 'button'
    && String(element.props.title ?? '').startsWith('立即保存当前内容')),
'the header shows a manual save button');

const manualArea = textareas(afterToggle.seen)[0];
const manualValue = `${manualArea.element.props.value}手动`;
manualArea.element.props.onChange({ target: { value: manualValue } });
await renderRounds(2, 700);
assert.equal(requests.filter((request) => request.method === 'PUT').length, putCountBeforeManual,
  'manual mode does not issue a debounced save');
const manualSaveButton = afterToggle.seen.find(({ element }) => element.type === 'button'
  && String(element.props.title ?? '').startsWith('立即保存当前内容'));
assert.ok(manualSaveButton, 'the manual save button exists');
await manualSaveButton.element.props.onClick();
await renderRounds(2, 80);
const manualPut = JSON.parse(requests.filter((request) => request.method === 'PUT').at(-1).body);
assert.ok(manualPut.segments.some((segment) => segment.text === manualValue),
  'the manual save button writes the current note');
settingsView = renderSettings();
settingsSwitches(settingsView.seen)[0].element.props.onClick();
await renderRounds(1);

// Theme / font size / button group mode are applied live.
settingsView = renderSettings();
const themeButton = settingsView.seen.find(({ element }) => element.type === 'button'
  && element.props['aria-label'] === '配色主题');
themeButton.element.props.onClick();
settingsView = renderSettings();
const oceanOption = settingsView.seen.find(({ element }) => element.type === 'button'
  && element.props.role === 'option' && elementText(element).includes('海蓝'));
assert.ok(oceanOption, 'the custom theme dropdown lists the ocean theme');
oceanOption.element.props.onClick();
const themed = await renderRounds(2);
const themedCard = themed.seen.find(({ element }) => element.type === 'section'
  && element.props['data-dsh-notepad'] === 'true');
assert.equal(themedCard.element.props['data-np-theme'], 'ocean', 'the color theme reaches the floating card');
settingsView = renderSettings();
const themedSettings = settingsView.seen.find(({ element }) => element.props?.className === 'dsh-np-set');
assert.equal(themedSettings.element.props['data-np-theme'], 'ocean', 'the color theme also reaches the settings UI');
assert.ok(!settingsView.text.includes('这些设置只保存在当前浏览器'), 'the settings storage note is gone');
assert.ok(!settingsView.text.includes('并保存在本机'), 'the old settings intro explanation is gone');

settingsView = renderSettings();
settingsNumber(settingsView.seen, '字号').element.props.onChange({ target: { value: '15' } });
settingsView = renderSettings();
settingsNumber(settingsView.seen, '字号').element.props.onBlur();
const sized = await renderRounds(2);
const sizedCard = sized.seen.find(({ element }) => element.type === 'section'
  && element.props['data-dsh-notepad'] === 'true');
assert.equal(sizedCard.element.props.style['--np-font-size'], '15px', 'the font size reaches the floating card');

settingsView = renderSettings();
settingsSwitches(settingsView.seen)[1].element.props.onClick();
const flatGroups = await renderRounds(2);
assert.ok(flatGroups.seen.filter(({ element }) => element.props?.className === 'dsh-np-actiongroup')
  .every(({ element }) => element.props['data-expanded'] === 'true'),
'disabling button groups expands every action at once');
settingsView = renderSettings();
assert.equal(settingsNumber(settingsView.seen, '展开 hover 时间阈值'), undefined,
  'the hover delay setting is hidden while button groups are disabled');
settingsSwitches(settingsView.seen)[1].element.props.onClick();
await renderRounds(1);

// Shortcut rebinding + restore.
settingsView = renderSettings();
const toggleShortcut = settingsView.seen.find(({ element }) => element.type === 'input'
  && element.props['aria-label'] === '显示 / 隐藏记事本');
toggleShortcut.element.props.onKeyDown({
  key: 'Y',
  code: 'KeyY',
  ctrlKey: true,
  metaKey: false,
  shiftKey: false,
  altKey: true,
  preventDefault() {},
});
settingsView = renderSettings();
const rebound = settingsView.seen.find(({ element }) => element.type === 'input'
  && element.props['aria-label'] === '显示 / 隐藏记事本');
assert.equal(rebound.element.props.value, 'Ctrl+Alt+Y', 'a pressed chord is bound to the shortcut');
settingsView.seen.find(({ element }) => element.type === 'button'
  && elementText(element) === '恢复默认快捷键').element.props.onClick();
settingsView = renderSettings();
assert.equal(settingsView.seen.find(({ element }) => element.type === 'input'
  && element.props['aria-label'] === '显示 / 隐藏记事本').element.props.value, 'Ctrl+Shift+N',
'restore-defaults brings back every default chord');

// AI preset + selection-only optimization.
settingsView = renderSettings();
const presetPromptField = settingsView.seen.find(({ element }) => element.type === 'textarea'
  && element.props['aria-label'] === '预设提示词');
assert.ok(presetPromptField, 'the selected preset shows its prompt below the dropdown');
assert.equal(presetPromptField.element.props.readOnly, true, 'the preset prompt is read-only');
assert.ok(String(presetPromptField.element.props.value).includes('writing assistant'),
  'the built-in preset prompt is displayed');
settingsView.seen.find(({ element }) => element.type === 'button'
  && element.props['aria-label'] === '提示词预设').element.props.onClick();
settingsView = renderSettings();
settingsView.seen.find(({ element }) => element.type === 'button'
  && element.props.role === 'option' && elementText(element).includes('自定义'))
  .element.props.onClick();
settingsView = renderSettings();
const customPrompt = settingsView.seen.find(({ element }) => element.type === 'textarea'
  && element.props['aria-label'] === '自定义提示词');
assert.ok(customPrompt, 'the field title switches to the custom prompt');
assert.notEqual(customPrompt.element.props.readOnly, true, 'the custom prompt becomes editable');
customPrompt.element.props.onChange({ target: { value: 'CUSTOM PROMPT' } });
await renderRounds(1);

let selectionView = await renderRounds(2);
const selectionArea = textareas(selectionView.seen)[0];
const selectionText = selectionArea.element.props.value;
const selectionNode = {
  value: selectionText,
  selectionStart: 1,
  selectionEnd: Math.min(3, selectionText.length),
  focus() {},
  setSelectionRange(start, end) { this.range = [start, end]; },
  scrollIntoView() {},
};
selectionArea.element.props.ref(selectionNode);
selectionArea.element.props.onSelect();
selectionView = await renderRounds(1);
const optimizeSelectionButton = findByTitle(selectionView.seen, 'AI 优化选中内容');
assert.ok(optimizeSelectionButton, 'a text selection switches the AI button to selection mode');
const selectedText = selectionText.slice(1, Math.min(3, selectionText.length));
const expectedSelectionResult = `${selectionText.slice(0, 1)}优化：${selectedText}${selectionText.slice(Math.min(3, selectionText.length))}`;
selectionNode.value = expectedSelectionResult;
await optimizeSelectionButton.element.props.onClick();
const selectionDone = await renderRounds(3);
assert.equal(optimizeRequests.at(-1).text, selectedText, 'only the selected text is sent to the model');
assert.equal(optimizeRequests.at(-1).system, 'CUSTOM PROMPT', 'the custom AI prompt is sent to the host');
assert.equal(textareas(selectionDone.seen)[0].element.props.value, expectedSelectionResult,
  'the optimized selection is spliced back into the card');
assert.deepEqual(selectionNode.range, [1, 1 + '优化：'.length + selectedText.length],
  'the rewritten range stays selected');

// Plugin history: structural operations undo / redo, textarea chords stay native.
await renderRounds(1);
const historyBase = await renderRounds(1);
const cardsBeforeHistory = textareas(historyBase.seen).length;
await pressButton(historyBase.seen, '新建分段');
const afterAddedHistory = await renderRounds(2);
assert.equal(textareas(afterAddedHistory.seen).length, cardsBeforeHistory + 1, 'a new card is added');
const undoShortcutCommand = registeredShortcuts.find((command) => command.id === 'notepad.undo');
const redoShortcutCommand = registeredShortcuts.find((command) => command.id === 'notepad.redo');
assert.ok(undoShortcutCommand && redoShortcutCommand, 'undo / redo commands are registered');
const pressUndoRedo = (shiftKey) => {
  for (const listener of [...(listeners.get('keydown') ?? [])]) {
    listener({
      key: shiftKey ? 'Z' : 'z',
      code: 'KeyZ',
      ctrlKey: true,
      metaKey: false,
      shiftKey,
      altKey: false,
      preventDefault() {},
    });
  }
};
pressUndoRedo(false);
const afterUndoHistory = await renderRounds(2);
assert.equal(textareas(afterUndoHistory.seen).length, cardsBeforeHistory,
  'undo removes the new card');
pressUndoRedo(true);
const afterRedoHistory = await renderRounds(2);
assert.equal(textareas(afterRedoHistory.seen).length, cardsBeforeHistory + 1,
  'redo restores the new card');
pressUndoRedo(false);
await renderRounds(2);

// Text typed since the previous operation must survive undo / redo.
const textHistoryView = await renderRounds(1);
const preservedArea = textareas(textHistoryView.seen)[0];
const preservedValue = `${preservedArea.element.props.value}保留文本`;
preservedArea.element.props.onChange({ target: { value: preservedValue } });
await new Promise((resolve) => setTimeout(resolve, 800));
const afterTextHistory = await renderRounds(1);
await pressButton(afterTextHistory.seen, '新建分段');
await renderRounds(2);
pressUndoRedo(false);
const afterTextUndo = await renderRounds(2);
assert.equal(textareas(afterTextUndo.seen)[0].element.props.value, preservedValue,
  'plugin undo keeps text typed after the previous history step');
assert.equal(textareas(afterTextUndo.seen).length, cardsBeforeHistory,
  'plugin undo still removes the structural step');
pressUndoRedo(true);
const afterTextRedo = await renderRounds(2);
assert.equal(textareas(afterTextRedo.seen)[0].element.props.value, preservedValue,
  'plugin redo does not drop the typed text either');
assert.equal(textareas(afterTextRedo.seen).length, cardsBeforeHistory + 1,
  'redo restores the structural step');
pressUndoRedo(false);
await renderRounds(2);

// A native textarea undo must not be intercepted by the plugin.
const nativeGuard = listeners.get('keydown');
const textareaTarget = { tagName: 'TEXTAREA' };
const nativeView = await renderRounds(1);
const countBeforeNative = textareas(nativeView.seen).length;
for (const listener of [...(nativeGuard ?? [])]) {
  listener({
    key: 'z',
    code: 'KeyZ',
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: textareaTarget,
    preventDefault() { throw new Error('the plugin must not prevent native textarea undo'); },
  });
}
await renderRounds(1);
assert.equal(textareas((await renderRounds(1)).seen).length, countBeforeNative,
  'a textarea undo is left to the browser');

// Composer insert / replace are plugin history steps ----------------------
writeDraft('');
let composerView = await renderRounds(1);
const composerInsert = findByTitle(composerView.seen, '插入此段');
assert.ok(composerInsert, 'a card exposes the composer insert');
await composerInsert.element.props.onClick();
const insertedDraftText = inserted.at(-1).text;
assert.equal(draftState.draft, insertedDraftText, 'inserting a segment fills the composer');
pressUndoRedo(false);
assert.equal(draftState.draft, '', 'plugin undo removes the composer insert');
pressUndoRedo(true);
assert.equal(draftState.draft, insertedDraftText, 'plugin redo restores the composer insert');

writeDraft('替换前的输入框内容');
composerView = await renderRounds(1);
const composerReplace = findByTitle(composerView.seen, '替换此段');
assert.ok(composerReplace, 'a card exposes the composer replace');
await composerReplace.element.props.onClick();
const replacedDraftText = replacedDrafts.at(-1);
assert.notEqual(replacedDraftText, '替换前的输入框内容', 'replace overwrites the composer');
pressUndoRedo(false);
assert.equal(draftState.draft, '替换前的输入框内容',
  'plugin undo restores the draft the replace overwrote');
pressUndoRedo(true);
assert.equal(draftState.draft, replacedDraftText, 'plugin redo re-applies the composer replace');

// Collapse and expand.
let collapseView = await renderRounds(2);
const foldButtons = collapseView.seen.filter(({ element }) => element.type === 'button'
  && element.props.className === 'dsh-np-fold');
assert.ok(foldButtons.length > 0, 'cards expose a fold button instead of a checkbox');
const activeBeforeFold = textareas(collapseView.seen).length;
foldButtons[0].element.props.onClick();
collapseView = await renderRounds(2);
assert.ok(findByClass(collapseView.seen, 'dsh-np-seg-preview'), 'a folded card shows its preview');
assert.equal(textareas(collapseView.seen).length, activeBeforeFold - 1, 'folding hides the editor');
await pressButton(collapseView.seen, '全部展开');
collapseView = await renderRounds(2);
assert.equal(textareas(collapseView.seen).length, activeBeforeFold, 'expand-all restores every editor');
await pressButton(collapseView.seen, '全部折叠');
collapseView = await renderRounds(2);
assert.equal(textareas(collapseView.seen).length, 0, 'collapse-all folds every active card');
await pressButton(collapseView.seen, '全部展开');
await renderRounds(2);

// Copy one segment and copy the selection.
let copyView = await renderRounds(2);
const segmentCopy = copyView.seen.find(({ element }) => element.type === 'button'
  && element.props.title === '复制此段');
await segmentCopy.element.props.onClick();
assert.ok(clipboardWrites.length > 0, 'copying one segment writes the clipboard');
const indexesForCopy = findAllByClass(copyView.seen, 'dsh-np-index');
indexesForCopy[0].element.props.onClick();
copyView = await renderRounds(1);
const copySelectedButton = copyView.seen.find(({ element }) => element.type === 'button'
  && String(element.props.title ?? '').startsWith('复制选中的'));
assert.ok(copySelectedButton, 'the toolbar exposes copy-selected');
await copySelectedButton.element.props.onClick();
assert.ok(clipboardWrites.at(-1).includes('优化：'), 'copy-selected writes the selected content');

// Workspace dropdown: only workspaces with note content, switching opens a session.
let workspaceView = await renderRounds(2);
const workspaceButton = workspaceView.seen.find(({ element }) => element.type === 'button'
  && element.props['aria-label'] === '切换工作区');
workspaceButton.element.props.onClick();
workspaceView = await renderRounds(1);
const menuItems = workspaceView.seen.filter(({ element }) => element.type === 'button'
  && element.props.role === 'menuitem');
assert.ok(menuItems.some(({ element }) => elementText(element).includes('demo')),
  'a workspace with non-empty segments is listed');
assert.ok(!menuItems.some(({ element }) => elementText(element).includes('other')),
  'a workspace without note content is not listed');
const thirdWorkspace = workspaceView.seen.find(({ element }) => element.type === 'button'
  && element.props.role === 'menuitem' && elementText(element).includes('third'));
assert.ok(thirdWorkspace, 'a workspace with content is listed');
const startCallsBeforeSwitch = uiWorkspace.startSessionCalls.length;
thirdWorkspace.element.props.onClick();
await renderRounds(2);
assert.deepEqual(uiWorkspace.startSessionCalls.at(-1), {
  workspaceId: 'ws-third',
  options: { clearPreviousDraft: true },
}, 'choosing a workspace starts a new session in it');
assert.equal(uiWorkspace.startSessionCalls.length, startCallsBeforeSwitch + 1);

// Archive order + auto-scroll, with the exit animation before removal.
let archiveView = await renderRounds(2);
if (findByTitle(archiveView.seen, '隐藏归档')) {
  await pressButton(archiveView.seen, '隐藏归档');
  archiveView = await renderRounds(1);
}
const firstActiveText = textareas(archiveView.seen)[0].element.props.value;
const archiveButton = findAllByTitle(archiveView.seen, '归档此段')[0];
await archiveButton.element.props.onClick();
const leavingView = await renderRounds(1);
assert.ok(leavingView.seen.some(({ element }) => element.props?.['data-leaving'] === 'true'),
  'archiving starts an exit animation');
await settleLeave();
const archivedView = await renderRounds(2);
const firstArchived = archivedCards(archivedView.seen)[0];
assert.ok(firstArchived && elementText(firstArchived.element).includes(firstActiveText),
  'the newest archived segment sits at the top of the archive');
assert.equal(firstArchived.element.props['data-collapsed'], 'false', 'manually archived cards start expanded');
await new Promise((resolve) => setTimeout(resolve, 650));
const archivedPut = requests
  .filter((request) => request.method === 'PUT')
  .map((request) => JSON.parse(request.body))
  .find((body) => body.segments.some((segment) => segment.text === firstActiveText && segment.archived === true));
assert.ok(archivedPut, 'the manual archive reaches the note file');
assert.equal(archivedPut.segments.find((segment) => segment.text === firstActiveText).origin, 'manual',
  'the archive button records the manual origin');
const archiveListElement = findByClass(archivedView.seen, 'dsh-np-archive-list');
let archiveScrollCalls = 0;
if (archiveListElement) {
  archiveListElement.element.props.ref({
    firstElementChild: { scrollIntoView() { archiveScrollCalls += 1; } },
  });
}
await pressButton(archivedView.seen, '显示归档');
await renderRounds(2);
await new Promise((resolve) => setTimeout(resolve, 100));
assert.ok(archiveScrollCalls > 0, 'opening the archive scrolls to the newest archived card');

// Backspace deleting the last active card must preserve the archive.
let wipeView = await renderRounds(2);
let wipeActive = textareas(wipeView.seen).length;
if (wipeActive > 0) {
  const selectAllForWipe = wipeView.seen.find(({ element }) => element.type === 'input'
    && element.props.type === 'checkbox' && element.props['aria-label'] === '全选');
  assert.ok(selectAllForWipe, 'select-all is available before the archive-preserving test');
  selectAllForWipe.element.props.onChange({ target: { checked: true } });
  wipeView = await renderRounds(2);
  await pressButton(wipeView.seen, `归档选中的 ${wipeActive} 段`);
  await settleLeave();
  wipeView = await renderRounds(2);
}
assert.equal(textareas(wipeView.seen).length, 0, 'all active cards are archived before the test');
await pressButton(wipeView.seen, '新建分段');
const wipeAdded = await renderRounds(2);
assert.equal(textareas(wipeAdded.seen).length, 1, 'a fresh empty active card is created');
const archivedBeforeBackspace = archivedCards(wipeAdded.seen).length;
assert.ok(archivedBeforeBackspace > 0, 'the archive still has cards before Backspace');
textareas(wipeAdded.seen)[0].element.props.onKeyDown({
  key: 'Backspace',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  preventDefault() {},
  currentTarget: { value: '', selectionStart: 0, selectionEnd: 0 },
});
await settleLeave();
const afterWipeBackspace = await renderRounds(2);
assert.equal(archivedCards(afterWipeBackspace.seen).length, archivedBeforeBackspace,
  'Backspace deleting the last active card keeps every archived segment');
assert.equal(textareas(afterWipeBackspace.seen).length, 1,
  'a fresh empty card replaces the deleted last active card');

// Chat composer sends are auto-archived and default collapsed ------------
let chatView = await renderRounds(2);
const archivedBeforeChatSend = archivedCards(chatView.seen).length;
const chatMessage = '自动保存的对话消息';
await conversation.sendSession({ sessionId: SESSION }, chatMessage);
await new Promise((resolve) => setTimeout(resolve, 120));
chatView = await renderRounds(2);
assert.equal(archivedCards(chatView.seen).length, archivedBeforeChatSend + 1,
  'a sent chat message is saved into the workspace archive');
const chatCard = archivedCards(chatView.seen).find(({ element }) => elementText(element).includes(chatMessage));
assert.ok(chatCard, 'the auto-saved chat message renders as an archive card');
assert.equal(chatCard.element.props['data-collapsed'], 'true', 'auto-saved chat messages start collapsed');
assert.ok(withinCard(chatView.seen, chatCard, (element) => element.props?.className === 'dsh-np-seg-preview'),
  'a collapsed auto-saved card keeps a preview');
assert.ok(!withinCard(chatView.seen, chatCard, (element) => element.props?.className === 'dsh-np-seg-archived-text'),
  'a collapsed auto-saved card hides its full body');
const savedChat = storedSegments.filter((segment) => segment.text === chatMessage);
assert.equal(savedChat.length, 1, 'the auto-saved card is persisted');
assert.equal(savedChat[0].archived, true);
assert.equal(savedChat[0].origin, 'compose', 'chat sends record the compose origin');

const expandChat = withinCard(chatView.seen, chatCard, (element) =>
  element.type === 'button' && element.props.title === '展开分段');
assert.ok(expandChat, 'an auto-saved archive card can be expanded');
expandChat.element.props.onClick();
chatView = await renderRounds(2);
const expandedChat = archivedCards(chatView.seen).find(({ element }) => elementText(element).includes(chatMessage));
assert.equal(expandedChat.element.props['data-collapsed'], 'false', 'expanding reveals the archived card');
assert.ok(withinCard(chatView.seen, expandedChat, (element) => element.props?.className === 'dsh-np-seg-archived-text'),
  'expanded archive cards show their full body');

const archivedBeforeDuplicate = archivedCards(chatView.seen).length;
await conversation.sendSession({ sessionId: SESSION }, `  ${chatMessage}\n`);
await new Promise((resolve) => setTimeout(resolve, 80));
chatView = await renderRounds(2);
assert.equal(archivedCards(chatView.seen).length, archivedBeforeDuplicate,
  'identical chat content is de-duplicated');
await conversation.sendSession({ sessionId: SESSION }, '已归档内容');
await new Promise((resolve) => setTimeout(resolve, 80));
chatView = await renderRounds(2);
assert.equal(archivedCards(chatView.seen).length, archivedBeforeDuplicate,
  'content that already exists as an active or archived segment is de-duplicated');
assert.equal(storedSegments.filter((segment) => segment.text.trim() === chatMessage).length, 1,
  'the saved archive file still holds exactly one copy');

// Capture the live panel geometry as the new default.
settingsView = renderSettings();
const liveUi = JSON.parse(storage.get('dsh-notepad.ui.v1'));
const captureButton = settingsView.seen.find(({ element }) => element.type === 'button'
  && elementText(element) === '将当前位置和尺寸设为默认');
assert.ok(captureButton, 'the window card offers to capture the current geometry');
captureButton.element.props.onClick();
const capturedSettings = JSON.parse(storage.get('dsh-notepad.settings.v1'));
assert.equal(capturedSettings.defaultWidth, liveUi.width, 'the captured default width matches the panel');
assert.equal(capturedSettings.defaultHeight, liveUi.height, 'the captured default height matches the panel');
assert.equal(capturedSettings.defaultX, liveUi.x, 'the captured default x matches the panel');
assert.equal(capturedSettings.defaultY, liveUi.y, 'the captured default y matches the panel');
settingsView = renderSettings();
const restoreDefaults = settingsView.seen.find(({ element }) => element.type === 'button'
  && elementText(element) === '恢复默认位置和尺寸数值');
assert.ok(restoreDefaults, 'the window card can restore factory geometry values');
restoreDefaults.element.props.onClick();
const restoredSettings = JSON.parse(storage.get('dsh-notepad.settings.v1'));
assert.equal(restoredSettings.defaultWidth, 420);
assert.equal(restoredSettings.defaultHeight, 460);
assert.equal(restoredSettings.defaultX, null);
assert.equal(restoredSettings.defaultY, null);

// Back to the default look so later assertions stay stable.
settingsView = renderSettings();
const hostTheme = (() => {
  const button = settingsView.seen.find(({ element }) => element.type === 'button'
    && element.props['aria-label'] === '配色主题');
  button.element.props.onClick();
  const view = renderSettings();
  return view.seen.find(({ element }) => element.type === 'button'
    && element.props.role === 'option' && elementText(element).includes('跟随宿主'));
})();
if (hostTheme) hostTheme.element.props.onClick();
settingsView = renderSettings();
const sizeInput = settingsNumber(settingsView.seen, '字号');
if (sizeInput) sizeInput.element.props.onChange({ target: { value: '13' } });
settingsView = renderSettings();
const sizeCommit = settingsNumber(settingsView.seen, '字号');
if (sizeCommit) sizeCommit.element.props.onBlur();
settingsView = renderSettings();
if (settingsView.seen.find(({ element }) => element.type === 'button'
  && element.props['aria-label'] === '提示词预设')) {
  settingsView.seen.find(({ element }) => element.type === 'button'
    && element.props['aria-label'] === '提示词预设').element.props.onClick();
  const balanced = renderSettings().seen.find(({ element }) => element.type === 'button'
    && element.props.role === 'option' && elementText(element).includes('通用润色'));
  if (balanced) balanced.element.props.onClick();
}
await renderRounds(1);

// Sends are irreversible: never a history step, never unarchived ----------
let sendView = await renderRounds(2);
await pressButton(sendView.seen, '新建分段');
sendView = await renderRounds(2);
const sendArea = textareas(sendView.seen).at(-1);
const sendText = '发送后不可撤销的分段';
sendArea.element.props.onChange({ target: { value: sendText } });
await new Promise((resolve) => setTimeout(resolve, 800));
sendView = await renderRounds(2);
writeDraft('');
const sentBeforeHistory = sent.length;
const sendCandidates = findAllByTitle(sendView.seen, '发送此段');
assert.ok(sendCandidates.length > 0, 'the filled card exposes its send button');
await sendCandidates.at(-1).element.props.onClick();
await settleLeave();
let afterSendView = await renderRounds(2);
assert.equal(sent.length, sentBeforeHistory + 1, 'the segment is sent once');
const sentHistoryCard = archivedCards(afterSendView.seen)
  .find(({ element }) => elementText(element).includes(sendText));
assert.ok(sentHistoryCard, 'the sent segment is archived');
assert.equal(sentHistoryCard.element.props['data-collapsed'], 'false', 'a send-archived card starts expanded');

for (let index = 0; index < 6; index += 1) pressUndoRedo(false);
afterSendView = await renderRounds(2);
assert.equal(sent.length, sentBeforeHistory + 1, 'undo never resends a segment');
const sentAfterUndo = archivedCards(afterSendView.seen)
  .find(({ element }) => elementText(element).includes(sendText));
assert.ok(sentAfterUndo, 'undo never unarchives a sent segment');
assert.equal(sentAfterUndo.element.props['data-archived'], 'true',
  'the sent card is pinned to the archive across undo');

for (let index = 0; index < 6; index += 1) pressUndoRedo(true);
afterSendView = await renderRounds(2);
assert.equal(sent.length, sentBeforeHistory + 1, 'redo never resends a segment');
assert.ok(archivedCards(afterSendView.seen)
  .some(({ element }) => elementText(element).includes(sendText)),
'redo never unarchives a sent segment');

// A stale composer step must not wipe text typed after the insert.
await renderRounds(1);
writeDraft('');
const staleComposerView = await renderRounds(1);
await findByTitle(staleComposerView.seen, '插入此段').element.props.onClick();
const staleDraftText = draftState.draft;
writeDraft(`${staleDraftText}手动补充`);
pressUndoRedo(false);
assert.equal(draftState.draft, `${staleDraftText}手动补充`,
  'a composer step that no longer matches the draft is retired instead of wiping typed text');

// UI persistence ---------------------------------------------------------
const storedUi = JSON.parse(storage.get('dsh-notepad.ui.v1'));
assert.equal(typeof storedUi.x, 'number');
assert.equal(typeof storedUi.y, 'number');
assert.equal(storedUi.width, 420);
assert.equal(storedUi.height, 460);
assert.equal(storedUi.hidden, false);
assert.equal(storedUi.minimized, false);
assert.equal(storedUi.showArchive, true);

for (const cleanup of cleanups) {
  try { cleanup(); } catch { /* ignore */ }
}
// Stop the presence interval created inside the component.
for (const timer of process._getActiveHandles?.() ?? []) {
  if (timer && typeof timer.unref === 'function') timer.unref();
}

console.log('ok — dsh-notepad client smoke test passed');
process.exit(0);
