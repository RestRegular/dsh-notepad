/**
 * dsh-notepad — detached window server tests.
 *
 * Runs the real loopback server against a temporary workspace: token checks,
 * page delivery, note read/write, image confinement, AI proxy and the
 * active/retire lifecycle used by the floating panel.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  currentDetachedPort,
  detachedStatus,
  registerDetachedRoot,
  retireDetachedRoot,
  shutdownDetachedServer,
} from '../lib/detached-server.js';
import { readNote, writeNote } from '../lib/note-store.js';

function fakeContext(root) {
  return {
    logger: { warn() {} },
    get(name) {
      if (name === 'workspaceRegistry') {
        return { list: () => [{ id: 'ws-detached', path: root, title: 'Detached demo' }] };
      }
      return undefined;
    },
  };
}

async function tempRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-notepad-detached-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function tokenOf(url) {
  return new URL(url).searchParams.get('token') ?? '';
}

async function getJson(url) {
  const response = await fetch(url);
  return { response, body: await response.json() };
}

test('serves a token-guarded detached page and note API', async (t) => {
  t.after(() => shutdownDetachedServer());
  const root = await tempRoot(t);
  const ctx = fakeContext(root);
  await writeNote(root, [
    { id: 's1', text: 'hello detached', title: 'One', archived: false },
  ]);
  const registered = await registerDetachedRoot(ctx, root, {
    config: { lang: 'en', theme: 'ocean', ai: 'Custom AI instruction' },
    optimize: async (text, title, instruction) => `AI:${text}:${title}:${instruction}`,
  });
  assert.match(registered.url, /^http:\/\/127\.0\.0\.1:\d+\/window\?token=/u);
  assert.ok(currentDetachedPort() > 0);
  const token = tokenOf(registered.url);
  assert.ok(token.length >= 32);

  // A missing token is refused before any file is touched.
  const denied = await fetch(`http://127.0.0.1:${currentDetachedPort()}/window?root=${encodeURIComponent(root)}`);
  assert.equal(denied.status, 403);

  const page = await fetch(registered.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('Detached demo') === false, 'the page itself does not embed the title');
  assert.ok(html.includes(`data-root="${root.replaceAll('\\', '/')}"`)
    || html.includes('data-root='), 'the page receives its workspace root');
  assert.ok(html.includes('detached.css'), 'the standalone stylesheet is linked');
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/u);

  const css = await fetch(`http://127.0.0.1:${currentDetachedPort()}/detached.css?token=${token}`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /text\/css/u);
  assert.ok((await css.text()).includes('.np-card'));
  const script = await fetch(`http://127.0.0.1:${currentDetachedPort()}/detached.js?token=${token}`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') ?? '', /javascript/u);
  assert.ok((await script.text()).includes('dsh-notepad:reattached'));

  const stateUrl = `http://127.0.0.1:${currentDetachedPort()}/api/state?token=${token}&root=${encodeURIComponent(root)}`;
  const state = await getJson(stateUrl);
  assert.equal(state.response.status, 200);
  assert.equal(state.body.title, 'Detached demo');
  assert.equal(state.body.segments[0].text, 'hello detached');

  const config = await getJson(`http://127.0.0.1:${currentDetachedPort()}/api/config?token=${token}&root=${encodeURIComponent(root)}`);
  assert.equal(config.body.theme, 'ocean');
  assert.equal(config.body.lang, 'en');
  assert.equal(config.body.ai, 'Custom AI instruction');

  const put = await fetch(stateUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      segments: [
        { id: 's1', text: 'edited in the detached window', title: 'One', archived: false },
        { id: 's2', text: 'second', title: '', archived: false },
      ],
    }),
  });
  assert.equal(put.status, 200);
  const stored = await readNote(root);
  assert.deepEqual(stored.segments.map((segment) => segment.text), ['edited in the detached window', 'second']);

  const optimize = await fetch(`http://127.0.0.1:${currentDetachedPort()}/api/optimize?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, text: 'draft', title: 'T' }),
  });
  assert.equal(optimize.status, 200);
  assert.equal((await optimize.json()).text, 'AI:draft:T:Custom AI instruction');

  // Cross-origin writes are refused even with the token.
  const crossOrigin = await fetch(stateUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ segments: [] }),
  });
  assert.equal(crossOrigin.status, 403);
});

test('only serves images inside the workspace notepad directory', async (t) => {
  t.after(() => shutdownDetachedServer());
  const root = await tempRoot(t);
  const ctx = fakeContext(root);
  const images = path.join(root, '.dsh', 'notepad', 'images');
  await mkdir(images, { recursive: true });
  await writeFile(path.join(images, 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await writeFile(path.join(root, 'secret.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeNote(root, []);

  const { url } = await registerDetachedRoot(ctx, root);
  const token = tokenOf(url);
  const base = `http://127.0.0.1:${currentDetachedPort()}`;
  const good = await fetch(`${base}/api/image?token=${token}&root=${encodeURIComponent(root)}&path=${encodeURIComponent('.dsh/notepad/images/pixel.png')}`);
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('content-type'), 'image/png');

  const escape = await fetch(`${base}/api/image?token=${token}&root=${encodeURIComponent(root)}&path=${encodeURIComponent('secret.png')}`);
  assert.equal(escape.status, 403);

  const missing = await fetch(`${base}/api/image?token=${token}&root=${encodeURIComponent(root)}&path=${encodeURIComponent('.dsh/notepad/images/nope.png')}`);
  assert.equal(missing.status, 404);
});

test('tracks active, retired and unknown detached windows', async (t) => {
  t.after(() => shutdownDetachedServer());
  const root = await tempRoot(t);
  const ctx = fakeContext(root);
  await writeNote(root, []);
  const { url } = await registerDetachedRoot(ctx, root, { config: { lang: 'zh' } });
  const token = tokenOf(url);
  const base = `http://127.0.0.1:${currentDetachedPort()}`;

  assert.equal(detachedStatus(root).active, false, 'a registered but unopened window is not active');

  const page = await fetch(url);
  await page.text();
  assert.equal(detachedStatus(root).active, true, 'loading the page marks it active');

  const heartbeat = await fetch(`${base}/api/heartbeat?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root }),
  });
  assert.equal(heartbeat.status, 200);
  assert.equal((await heartbeat.json()).retired, false);

  const retire = await fetch(`${base}/api/retire?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root }),
  });
  assert.equal(retire.status, 200);
  assert.equal(detachedStatus(root).active, false);
  assert.equal(detachedStatus(root).retired, true);

  const heartbeatAfterRetire = await fetch(`${base}/api/heartbeat?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root }),
  });
  assert.equal((await heartbeatAfterRetire.json()).retired, true, 'heartbeat does not revive a retired window');

  const again = await registerDetachedRoot(ctx, root, { config: { lang: 'en' } });
  assert.equal(detachedStatus(root).retired, true, 'a URL prefetch does not revive a retired window');
  const reopened = await fetch(again.url);
  await reopened.text();
  assert.equal(detachedStatus(root).active, true, 'loading the window page revives it');

  assert.equal(retireDetachedRoot(root), true);
});
