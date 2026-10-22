/**
 * dsh-notepad — offline client smoke test.
 *
 * Loads the real client bundle in a browser-shaped shim with a miniature React
 * runtime, runs apply(ctx), renders the floating notepad, then exercises load,
 * autosave, insert-into-composer, minimize, hide and the global hotkey.
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

const documentShim = {
  head: { appendChild(node) { styleTags.push(node); } },
  body: { appendChild() {}, removeChild() {} },
  activeElement: null,
  visibilityState: 'visible',
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
};

const loadedModules = [];
globalThis.window = windowShim;
globalThis.document = documentShim;

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
let storedText = '初始内容\n第二行';
let storedMtime = 1000;
const requests = [];

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
  if (url.pathname !== '/dsh-notepad/api/note') {
    return jsonResponse({ ok: false, error: 'not found' }, 404);
  }
  if ((init.method ?? 'GET') === 'PUT') {
    const body = JSON.parse(init.body);
    storedText = body.text;
    storedMtime += 1;
    return jsonResponse({ ok: true, root: body.root, text: storedText, mtimeMs: storedMtime, updatedAt: new Date().toISOString() });
  }
  return jsonResponse({ ok: true, root: ROOT, text: storedText, mtimeMs: storedMtime, updatedAt: new Date().toISOString() });
};

const inserted = [];
let persistedDrafts = 0;
const inputActions = {
  captureInsertion: () => ({ from: 4, to: 4, draftRev: 7 }),
  insertText(text, span) {
    inserted.push({ text, span });
    return true;
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
const listSource = {
  getSnapshot: () => ({
    phase: 'ready',
    ids: [SESSION],
    byId: { [SESSION]: { id: SESSION, cwd: ROOT, retainedBy: { mainView: 1 } } },
  }),
  subscribe: () => () => {},
};

const localeRegistered = [];
const locale = {
  register(namespace, dict) {
    localeRegistered.push({ namespace, dict });
    return () => {};
  },
  bind(namespace) {
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
    if (name === 'sessions') return { list: listSource };
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

const initial = await renderRounds(6);
assert.ok(initial.seen.some(({ element }) => element.type === 'section' && element.props['data-dsh-notepad'] === 'true'), 'card renders');
assert.ok(initial.text.includes('记事本'), 'title rendered');
assert.ok(initial.text.includes('demo-workspace'), 'workspace name rendered');
assert.ok(requests.some((request) => request.method === 'GET' && request.url.includes('session-smoke-1')), 'loads the note for the session');

const textarea = initial.seen.find(({ element }) => element.type === 'textarea');
assert.ok(textarea, 'textarea rendered');
assert.equal(textarea.element.props.value, storedText, 'loaded note text is shown');
assert.equal(textarea.element.props.disabled, false);

// Autosave ---------------------------------------------------------------
await textarea.element.props.onChange({ target: { value: '遇到的问题\n下一步：写测试' } });
assert.ok(findByTitle(initial.seen, '插入到输入框'));
await new Promise((resolve) => setTimeout(resolve, 650));
const afterSave = await renderRounds(2);
const put = requests.filter((request) => request.method === 'PUT').at(-1);
assert.ok(put, 'autosave issues a PUT');
const putBody = JSON.parse(put.body);
assert.equal(putBody.text, '遇到的问题\n下一步：写测试');
assert.equal(put.body && putBody.root, ROOT);
assert.equal(putBody.sessionId, SESSION);
assert.ok(afterSave.text.includes('已保存'), 'status shows saved');

// Insert into composer ---------------------------------------------------
const insertButton = findByTitle(afterSave.seen, '插入到输入框');
assert.ok(insertButton, 'insert button rendered');
assert.equal(insertButton.element.props.disabled, false);
await insertButton.element.props.onClick();
assert.equal(inserted.length, 1);
assert.equal(inserted[0].text, '遇到的问题\n下一步：写测试');
assert.deepEqual(inserted[0].span, { from: 4, to: 4, draftRev: 7 });
assert.equal(persistedDrafts, 1, 'draft persistence is requested after insert');
const afterInsert = await renderRounds(1);
assert.ok(afterInsert.text.includes('已插入输入框'), 'insert toast shown');

// Minimize ---------------------------------------------------------------
const minimizeButton = findByTitle(afterInsert.seen, '最小化');
assert.ok(minimizeButton, 'minimize button rendered');
minimizeButton.element.props.onClick();
const minimized = await renderRounds(2);
const minimizedCard = minimized.seen.find(({ element }) => element.type === 'section' && element.props['data-dsh-notepad'] === 'true');
assert.equal(minimizedCard.element.props['data-minimized'], 'true');
assert.equal(minimized.seen.some(({ element }) => element.type === 'textarea'), false);

const expandButton = findByTitle(minimized.seen, '展开');
assert.ok(expandButton, 'expand button appears when minimized');
expandButton.element.props.onClick();
const expanded = await renderRounds(2);
assert.ok(expanded.seen.some(({ element }) => element.type === 'textarea'), 'textarea returns after expand');

// Hide / restore ---------------------------------------------------------
const hideButton = findByTitle(expanded.seen, '隐藏（Ctrl+Shift+N）');
assert.ok(hideButton, 'hide button rendered');
hideButton.element.props.onClick();
const hidden = await renderRounds(2);
assert.equal(hidden.seen.some(({ element }) => element.props?.className === 'dsh-np-card'), false, 'card is gone when hidden');
const restoreButton = hidden.seen.find(({ element }) => element.props?.className === 'dsh-np-restore');
assert.ok(restoreButton, 'restore button rendered while hidden');
assert.equal(restoreButton.element.props.title, '显示记事本（Ctrl+Shift+N）');
restoreButton.element.props.onClick();
const restored = await renderRounds(2);
assert.ok(restored.seen.some(({ element }) => element.props?.className === 'dsh-np-card'), 'restore brings the card back');

// Global hotkey ----------------------------------------------------------
const keydown = listeners.get('keydown');
assert.ok(keydown && keydown.size > 0, 'global keydown listener installed');
const pressHotkey = () => {
  for (const listener of keydown) {
    listener({ key: 'N', ctrlKey: true, metaKey: false, shiftKey: true, preventDefault() {} });
  }
};
pressHotkey();
const hotkeyHidden = await renderRounds(2);
assert.equal(hotkeyHidden.seen.some(({ element }) => element.type === 'section'), false, 'hotkey hides the card');
pressHotkey();
const hotkeyShown = await renderRounds(2);
assert.ok(hotkeyShown.seen.some(({ element }) => element.type === 'section'), 'hotkey shows the card again');

// UI persistence ---------------------------------------------------------
const storedUi = JSON.parse(storage.get('dsh-notepad.ui.v1'));
assert.equal(typeof storedUi.x, 'number');
assert.equal(typeof storedUi.y, 'number');
assert.equal(storedUi.hidden, false);
assert.equal(storedUi.minimized, false);

// Copy fallback ----------------------------------------------------------
const copyButton = findByTitle(hotkeyShown.seen, '复制全部');
assert.ok(copyButton, 'copy button rendered');
assert.equal(copyButton.element.props.disabled, false);

for (const cleanup of cleanups) {
  try { cleanup(); } catch { /* ignore */ }
}
// Stop the presence interval created inside the component.
for (const timer of process._getActiveHandles?.() ?? []) {
  if (timer && typeof timer.unref === 'function') timer.unref();
}

console.log('ok — dsh-notepad client smoke test passed');
process.exit(0);
