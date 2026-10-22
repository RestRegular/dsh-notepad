import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handleRequest } from '../index.js';
import { notePath } from '../lib/note-store.js';

function fakeContext({ workspaces = [], sessions = {} } = {}) {
  return {
    logger: { warn() {} },
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => workspaces };
      if (name === 'agents') {
        return {
          get(id) {
            const cwd = sessions[id];
            return cwd === undefined ? undefined : { session: { header: { cwd } } };
          },
        };
      }
      return undefined;
    },
  };
}

async function serve(t, ctx) {
  const server = createServer((req, res) => {
    handleRequest(ctx, req, res).catch((error) => {
      res.writeHead(500).end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function tempDir(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-notepad-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('ping identifies the plugin', async (t) => {
  const base = await serve(t, fakeContext());
  const response = await fetch(`${base}/dsh-notepad/api/ping`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.plugin, 'dsh-notepad');
  assert.equal(body.version, '0.1.0');
});

test('GET/PUT round-trip is scoped to a registered workspace', async (t) => {
  const root = await tempDir(t);
  const base = await serve(t, fakeContext({ workspaces: [{ path: root }] }));

  const empty = await (await fetch(`${base}/dsh-notepad/api/note?root=${encodeURIComponent(root)}&sessionId=s1`)).json();
  assert.equal(empty.ok, true);
  assert.equal(empty.text, '');
  assert.equal(empty.exists, false);

  const save = await fetch(`${base}/dsh-notepad/api/note`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, sessionId: 's1', text: '遇到的问题\n下一步' }),
  });
  assert.equal(save.status, 200);
  const saved = await save.json();
  assert.equal(saved.ok, true);
  assert.equal(saved.text, '遇到的问题\n下一步');
  assert.ok(saved.mtimeMs > 0);

  const raw = await readFile(notePath(root), 'utf8');
  assert.equal(JSON.parse(raw).text, '遇到的问题\n下一步');

  const read = await (await fetch(`${base}/dsh-notepad/api/note?root=${encodeURIComponent(root)}&sessionId=s1`)).json();
  assert.equal(read.text, '遇到的问题\n下一步');
  assert.equal(read.exists, true);
  assert.equal(read.updatedAt, saved.updatedAt);
});

test('the requesting session cwd is accepted even when it is not in the registry', async (t) => {
  const root = await tempDir(t);
  const base = await serve(t, fakeContext({ workspaces: [], sessions: { s2: root } }));
  const response = await fetch(`${base}/dsh-notepad/api/note?root=${encodeURIComponent(root)}&sessionId=s2`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test('an unknown workspace is rejected', async (t) => {
  const root = await tempDir(t);
  const base = await serve(t, fakeContext({ workspaces: [{ path: path.join(root, 'other') }] }));
  const response = await fetch(`${base}/dsh-notepad/api/note?root=${encodeURIComponent(root)}&sessionId=s1`);
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'unknown-workspace');
});

test('unknown endpoints and methods are rejected', async (t) => {
  const base = await serve(t, fakeContext());
  assert.equal((await fetch(`${base}/dsh-notepad/api/nope`)).status, 404);
  const post = await fetch(`${base}/dsh-notepad/api/note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(post.status, 405);
});

test('a malformed JSON body is a 400', async (t) => {
  const root = await tempDir(t);
  const base = await serve(t, fakeContext({ workspaces: [{ path: root }] }));
  const response = await fetch(`${base}/dsh-notepad/api/note`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: '{oops',
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'bad-input');
});

test('a cross-origin request is forbidden', async (t) => {
  const base = await serve(t, fakeContext());
  const response = await fetch(`${base}/dsh-notepad/api/ping`, {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(response.status, 403);
});
