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
};

const loadedModules = [];
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
  if (url.pathname === '/dsh-notepad/api/unsent') {
    unsentRequests.push(url.search);
    return jsonResponse({
      ok: true,
      workspaces: [
        { id: 'ws-demo', path: ROOT, title: 'demo', count: 1 },
        { id: 'ws-other', path: 'D:\\Projects\\other', title: 'other', count: 2 },
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

const inputActions = {
  captureInsertion: () => ({ from: 4, to: 4, draftRev: 7 }),
  insertText(text, span) {
    inserted.push({ text, span });
    return true;
  },
  setDraft(text) {
    replacedDrafts.push(text);
  },
  persistDraft() {
    persistedDrafts += 1;
  },
};

const sessionState = {
  key: SESSION,
  props: { sessionId: SESSION, inputActions },
  hooks: {},
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

const conversation = {
  async send(text) {
    sent.push(text);
  },
};
const scopedContext = {
  get(name) { return name === 'conversation' ? conversation : undefined; },
};
const promptModes = [];
const submittedModes = [];
const sessionFace = {
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
const sessionsService = {
  list: listSource,
  scope: () => scopedContext,
  binding: () => ({ session: sessionFace }),
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
  },
  workspaces: {
    list: {
      getSnapshot: () => ({
        items: [{ workspaceId: 'ws-demo', path: ROOT, sessionIds: [SESSION] }],
      }),
    },
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
    if (name === 'uiWorkspace') return uiWorkspace;
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

assert.deepEqual(injected, ['shell.overlay']);
assert.equal(styleTags.length, 1, 'styles injected once');
assert.ok(styleTags[0].textContent.includes('.dsh-np-card'));
assert.ok(styleTags[0].textContent.includes('var(--dsw-font-family'), 'uses the DSH/system font family');
assert.ok(!styleTags[0].textContent.includes('ui-monospace'), 'no monospace font remains');
assert.ok(styleTags[0].textContent.includes('body[data-ds-dark-theme]'), 'dark-mode overrides exist');
assert.ok(styleTags[0].textContent.includes('transition:height'), 'collapse animation exists');
assert.ok(styleTags[0].textContent.includes('visibility:hidden'), 'hide animation exists');
assert.ok(styleTags[0].textContent.includes('.dsh-np-title-add'), 'empty titles use a click target');
assert.ok(!styleTags[0].textContent.includes('.dsh-np-title-add:hover'), 'the empty-title click target has no hover style');
assert.ok(styleTags[0].textContent.includes('.dsh-np-actiongroup'), 'hover action groups have styles');
assert.ok(styleTags[0].textContent.includes('.dsh-np-preview'), 'image preview styles exist');
assert.ok(styleTags[0].textContent.includes('.dsh-np-confirm'), 'delete confirmation styles exist');
assert.deepEqual(localeRegistered.map((entry) => entry.namespace), ['dsh-notepad']);
const overlay = registrations.find((entry) => entry.options.name === 'shell.overlay');
assert.ok(overlay, 'registers shell.overlay');
assert.equal(overlay.options.id, 'notepad');
assert.equal(overlay.options.order, 70);

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
assert.ok(findByTitle(initial.seen, '显示归档'), 'archive toggle is present without a count badge');
assert.ok(!initial.seen.some(({ element }) => element.props?.className === 'dsh-np-badge'), 'archive count badge is gone');
assert.ok(!initial.text.includes('显示归档（1）'), 'archive toggle title omits the count');
assert.ok(initial.text.includes('已保存'), 'status shows saved');
assert.equal(sidebarRows[0].attributes['data-np-unsent'], '2', 'the current workspace row shows its pending count');
assert.equal(sidebarRows[1].attributes['data-np-unsent'], '2', 'other workspace rows keep their own counts');
assert.ok(unsentRequests.length > 0, 'sidebar counts are fetched');

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
assert.deepEqual(inserted.at(-1).span, { from: 4, to: 4, draftRev: 7 });
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

// Select all + batch replace / insert / send ------------------------------
const selectAll = afterSendSave.seen.find(({ element }) => element.type === 'input'
  && element.props.type === 'checkbox'
  && element.props['aria-label'] === '全选');
assert.ok(selectAll, 'select-all checkbox exists');
selectAll.element.props.onChange({ target: { checked: true } });
const selected = await renderRounds(2);
assert.ok(selected.text.includes('已选 2 段'), 'select-all selects every active segment');
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
assert.equal(clipboardWrites.at(-1), '第一', 'copy-all writes only active segments');
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
  '第一\n![picked.png](pics/picked.png)\n![clip.png](.dsh/notepad/images/uploaded-1.png)',
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
assert.deepEqual(textareas(afterAddTwo.seen).map(({ element }) => element.props.value), ['', '', '第一'], 'new segments land on top');

const firstNew = textareas(afterAddTwo.seen)[0];
const secondNew = textareas(afterAddTwo.seen)[1];
firstNew.element.props.onChange({ target: { value: 'A' } });
const afterA = await renderRounds(1);
secondNew.element.props.onChange({ target: { value: 'B' } });
const afterAB = await renderRounds(1);
assert.deepEqual(textareas(afterAB.seen).map(({ element }) => element.props.value), ['A', 'B', '第一']);

// Arrow keys move the caret between cards ---------------------------------
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
arrowAreas[0].element.props.onKeyDown({
  key: 'ArrowDown',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  preventDefault() {},
  currentTarget: arrowNodes[0],
});
assert.equal(arrowNodes[1].focused, true, 'ArrowDown focuses the next card');
assert.equal(arrowNodes[1].caret, 0, 'ArrowDown puts the caret at the start of the next card');
arrowAreas[1].element.props.onKeyDown({
  key: 'ArrowUp',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  preventDefault() {},
  currentTarget: arrowNodes[1],
});
assert.equal(arrowNodes[0].focused, true, 'ArrowUp focuses the previous card');
assert.equal(arrowNodes[0].caret, 1, 'ArrowUp puts the caret at the end of the previous card');

const titleInputsBefore = findAllByClass(afterAB.seen, 'dsh-np-title-input');
const titleAdds = findAllByClass(afterAB.seen, 'dsh-np-title-add');
assert.equal(titleInputsBefore.length, 0, 'empty titles do not render an input');
assert.equal(titleAdds.length, 3, 'each empty title exposes a click target');
assert.ok(!afterAB.text.includes('分段标题（可选）'), 'empty titles render no placeholder text');
assert.equal(titleAdds[0].element.props.children, undefined, 'the empty-title click target is blank');
titleAdds[0].element.props.onClick();
const afterTitleClick = await renderRounds(1);
const revealedTitleInputs = findAllByClass(afterTitleClick.seen, 'dsh-np-title-input');
assert.equal(revealedTitleInputs.length, 1, 'clicking the blank title area reveals the title input');
assert.equal(revealedTitleInputs[0].element.props.autoFocus, true, 'the revealed title input is focused');
revealedTitleInputs[0].element.props.onChange({ target: { value: '合并标题' } });
const afterTitle = await renderRounds(1);
assert.equal(findAllByClass(afterTitle.seen, 'dsh-np-title-input')[0].element.props.value, '合并标题');

// Insert / send hover groups ----------------------------------------------
assert.equal(findAllByClass(afterTitle.seen, 'dsh-np-actiongroup').length, 8,
  'the toolbar and every card wrap insert / send in an expanding group');
assert.equal(findAllByTitle(afterTitle.seen, '在新会话中插入').length, 4,
  'each insert button exposes a new-session action');
assert.equal(findAllByTitle(afterTitle.seen, '在新会话中发送').length, 4,
  'each send button exposes a new-session action');
assert.equal(findAllByTitle(afterTitle.seen, '替换此段').length, 6,
  'replace buttons stay separate on active and archived cards');
assert.equal(findAllByTitle(afterTitle.seen, '替换为选中的 2 段').length, 0, 'no selection yet');
assert.equal(findAllByTitle(afterTitle.seen, '替换输入框内容').length, 1, 'the toolbar replace button stays ungrouped');

const indexes = findAllByClass(afterTitle.seen, 'dsh-np-index');
assert.equal(indexes.length, 3, 'each card exposes a clickable index');
indexes[0].element.props.onClick();
const afterSelectOne = await renderRounds(1);
const selectOneIndexes = findAllByClass(afterSelectOne.seen, 'dsh-np-index');
selectOneIndexes[1].element.props.onClick();
const afterSelectTwo = await renderRounds(1);
assert.ok(afterSelectTwo.text.includes('已选 2 段'), 'clicking indexes selects segments');

const mergeButton = findByTitle(afterSelectTwo.seen, '合并选中的 2 段');
assert.ok(mergeButton, 'merge button reflects the selection');
await mergeButton.element.props.onClick();
const afterMerge = await renderRounds(2);
assert.deepEqual(
  textareas(afterMerge.seen).map(({ element }) => element.props.value),
  ['A\n\nB', '第一'],
  'merging keeps the merged card at the topmost selected position',
);
assert.equal(findAllByClass(afterMerge.seen, 'dsh-np-title-input')[0].element.props.value, '合并标题', 'merged card keeps the titles');

const optimizeOne = findAllByTitle(afterMerge.seen, 'AI 优化此段')[0];
assert.ok(optimizeOne, 'each card exposes an AI optimize button');
await optimizeOne.element.props.onClick();
const afterOptimizeOne = await renderRounds(3);
assert.equal(optimizeRequests.at(-1).text, 'A\n\nB', 'the AI request carries the card text');
assert.equal(optimizeRequests.at(-1).title, '合并标题', 'the AI request carries the card title');
assert.deepEqual(
  textareas(afterOptimizeOne.seen).map(({ element }) => element.props.value),
  ['优化：A\n\nB', '第一'],
  'single-card AI optimization replaces only that card',
);
const undoOptimizeOne = findByTitle(afterOptimizeOne.seen, '撤销优化');
assert.ok(undoOptimizeOne, 'the optimized card button turns into undo');
await undoOptimizeOne.element.props.onClick();
const afterUndoOptimizeOne = await renderRounds(2);
assert.deepEqual(
  textareas(afterUndoOptimizeOne.seen).map(({ element }) => element.props.value),
  ['A\n\nB', '第一'],
  'undoing the card optimization restores its text',
);
assert.equal(findAllByTitle(afterUndoOptimizeOne.seen, '撤销优化').length, 0,
  'the undo button returns to AI optimize after use');

const optimizeCountBefore = optimizeRequests.length;
const optimizeAgain = findAllByTitle(afterUndoOptimizeOne.seen, 'AI 优化此段')[0];
await optimizeAgain.element.props.onClick();
const afterOptimizeAgain = await renderRounds(2);
assert.equal(optimizeRequests.length, optimizeCountBefore,
  'unchanged content is optimized from the cache without another model call');
assert.deepEqual(
  textareas(afterOptimizeAgain.seen).map(({ element }) => element.props.value),
  ['优化：A\n\nB', '第一'],
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
  ['优化：优化：A\n\nB', '优化：第一'],
  'batch optimization rewrites only the selected cards',
);
const toolbarUndo = afterOptimizeSelected.seen.find(({ element }) => element.type === 'button'
  && element.props.className === 'dsh-np-btn' && element.props.title === '撤销优化');
assert.ok(toolbarUndo, 'the toolbar AI button turns into undo after a batch run');
await toolbarUndo.element.props.onClick();
const afterBatchUndo = await renderRounds(2);
assert.deepEqual(
  textareas(afterBatchUndo.seen).map(({ element }) => element.props.value),
  ['优化：A\n\nB', '第一'],
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
  ['第一', '优化：A\n\nB'],
  'dragging a card updates the display order',
);
assert.equal(sidebarRows[0].attributes['data-np-unsent'], '2', 'workspace badge follows the live pending count');

await new Promise((resolve) => setTimeout(resolve, 650));
const afterFeatureSave = await renderRounds(1);
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
    key: '0',
    code: 'Digit0',
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
assert.ok(findByTitle(afterReset.seen, '复位记事本位置和尺寸 · Ctrl+Shift+0'),
  'the header exposes a clickable reset button too');

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
  prompt: '优化：A\n\nB',
  clearPreviousDraft: true,
});
assert.ok((await renderRounds(1)).text.includes('已在新会话中填入内容'));

const sendNewButton = findByTitle(afterActiveDelete.seen, '在新会话中发送');
assert.ok(sendNewButton, 'the send group exposes the new-session action');
const sentBeforeNew = sent.length;
await sendNewButton.element.props.onClick();
const afterSendNew = await renderRounds(3);
assert.equal(createdSessions, 1, 'sending in a new session creates it first');
assert.equal(createdSessionRequests.at(-1).cwd, ROOT);
assert.equal(sent.length, sentBeforeNew + 1);
assert.equal(sent.at(-1), '优化：A\n\nB', 'the new session receives the segment text');
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
assert.equal(registeredShortcuts.length, 1, 'the client registers the reset command with DSH shortcuts');
const resetCommand = registeredShortcuts[0];
assert.equal(resetCommand.id, 'notepad.resetGeometry');
assert.deepEqual(resetCommand.defaults['desktop:windows'], { code: 'Digit0', modifiers: ['primary', 'shift'] });
assert.deepEqual(resetCommand.defaults['web:windows'], { code: 'Digit0', modifiers: ['primary', 'shift'] });
assert.ok(resetCommand.regions.includes('editable'), 'the reset shortcut also works while typing');
assert.equal(resetCommand.resolve().status, 'handled');
assert.equal(typeof resetCommand.resolve().run, 'function');

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
