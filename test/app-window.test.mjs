/**
 * dsh-notepad — app-window launcher tests.
 *
 * The spawned browser is replaced by a recorder so the suite never opens a
 * real window; the tests cover executable discovery, app-mode arguments, the
 * live-window short-circuit and the no-browser failure.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildAppWindowArgs, findBrowserExecutable, openDetachedAppWindow } from '../lib/app-window.js';
import { detachedStatus, shutdownDetachedServer } from '../lib/detached-server.js';
import { writeNote } from '../lib/note-store.js';

function fakeContext(root) {
  return {
    logger: { warn() {} },
    get(name) {
      if (name === 'workspaceRegistry') {
        return { list: () => [{ id: 'ws-app', path: root, title: 'App demo' }] };
      }
      return undefined;
    },
  };
}

async function tempRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-notepad-app-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('finds Chrome or Edge on each supported platform', () => {
  const windowsEnv = {
    LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  };
  const windowsExists = (file) => file === 'C:\\Users\\demo\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
  assert.equal(
    findBrowserExecutable({ platform: 'win32', env: windowsEnv, exists: windowsExists }),
    'C:\\Users\\demo\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  );

  const edgeExists = (file) => file === 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  assert.equal(
    findBrowserExecutable({ platform: 'win32', env: windowsEnv, exists: edgeExists }),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  );

  assert.equal(
    findBrowserExecutable({
      platform: 'darwin',
      env: { HOME: '/Users/demo' },
      exists: (file) => file === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    }),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  );

  assert.equal(
    findBrowserExecutable({
      platform: 'linux',
      env: { PATH: '/usr/local/bin:/usr/bin' },
      exists: (file) => file === '/usr/bin/chromium',
    }),
    '/usr/bin/chromium',
  );

  assert.equal(findBrowserExecutable({ platform: 'linux', env: { PATH: '/nope' }, exists: () => false }), '');
});

test('builds an app window without browser chrome', () => {
  const args = buildAppWindowArgs({
    url: 'http://127.0.0.1:1234/window?token=abc&root=x',
    width: 520,
    height: 760,
    profileDir: '/tmp/np-profile',
    platform: 'linux',
  });
  assert.ok(args.includes('--app=http://127.0.0.1:1234/window?token=abc&root=x'));
  assert.ok(args.includes('--user-data-dir=/tmp/np-profile'));
  assert.ok(args.includes('--window-size=520,760'));
  assert.ok(args.includes('--no-first-run'));
  assert.ok(args.includes('--class=dsh-notepad'));
});

test('launches app mode once and returns the existing window afterwards', async (t) => {
  t.after(() => shutdownDetachedServer());
  const root = await tempRoot(t);
  await writeNote(root, []);
  const ctx = fakeContext(root);
  const calls = [];
  const fakeSpawn = (file, args) => {
    calls.push({ file, args });
    return {
      once() {},
      unref() {},
    };
  };
  const first = await openDetachedAppWindow(ctx, root, {
    config: { lang: 'zh', theme: 'ocean' },
    spawn: fakeSpawn,
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    exists: (file) => file === '/usr/bin/google-chrome',
    width: 500,
    height: 700,
    profileDir: '/tmp/np-test-profile',
  });
  assert.equal(first.ok, true);
  assert.equal(first.opened, 'app');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.some((arg) => arg.startsWith('--app=http://127.0.0.1:')));
  assert.ok(calls[0].args.includes('--window-size=500,700'));

  // Loading the page marks the window active. A second request must not spawn
  // a duplicate browser.
  const page = await fetch(first.url);
  assert.equal(page.status, 200);
  await page.text();
  assert.equal(detachedStatus(root).active, true);
  const second = await openDetachedAppWindow(ctx, root, {
    spawn: () => {
      throw new Error('must not spawn a duplicate');
    },
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    exists: (file) => file === '/usr/bin/google-chrome',
  });
  assert.equal(second.ok, true);
  assert.equal(second.opened, 'existing');
});

test('reports no-browser instead of failing silently', async (t) => {
  t.after(() => shutdownDetachedServer());
  const root = await tempRoot(t);
  await writeNote(root, []);
  const result = await openDetachedAppWindow(fakeContext(root), root, {
    platform: 'linux',
    env: { PATH: '/nothing' },
    exists: () => false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no-browser');
});
