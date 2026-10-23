import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handleRequest } from '../index.js';
import { NOTE_VERSION, notePath } from '../lib/note-store.js';

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
  assert.equal(body.version, '0.3.0');
  assert.equal(body.noteVersion, NOTE_VERSION);
  assert.deepEqual(body.imageTypes, ['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  assert.equal(body.maxImageBytes, 20 * 1024 * 1024);
});

test('GET/PUT round-trip stores segments and archives', async (t) => {
  const root = await tempDir(t);
  const base = await serve(t, fakeContext({ workspaces: [{ path: root }] }));

  const empty = await (await fetch(`${base}/dsh-notepad/api/note?root=${encodeURIComponent(root)}&sessionId=s1`)).json();
  assert.equal(empty.ok, true);
  assert.equal(empty.text, '');
  assert.deepEqual(empty.segments, []);
  assert.equal(empty.exists, false);

  const segments = [
    { id: 'seg-1', text: '遇到的问题\n下一步' },
    { id: 'seg-2', text: '已经发送', archived: true, archivedAt: '2026-01-01T00:00:00.000Z' },
  ];
  const save = await fetch(`${base}/dsh-notepad/api/note`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, sessionId: 's1', segments }),
  });
  assert.equal(save.status, 200);
  const saved = await save.json();
  assert.equal(saved.ok, true);
  assert.equal(saved.text, '遇到的问题\n下一步\n\n已经发送');
  assert.equal(saved.segments.length, 2);
  assert.equal(saved.segments[1].archived, true);
  assert.ok(saved.mtimeMs > 0);

  const raw = await readFile(notePath(root), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, NOTE_VERSION);
  assert.equal(parsed.segments[0].text, '遇到的问题\n下一步');
  assert.equal(parsed.segments[1].archived, true);
  assert.equal(parsed.text, '遇到的问题\n下一步\n\n已经发送');

  const read = await (await fetch(`${base}/dsh-notepad/api/note?root=${encodeURIComponent(root)}&sessionId=s1`)).json();
  assert.equal(read.text, '遇到的问题\n下一步\n\n已经发送');
  assert.equal(read.segments.length, 2);
  assert.equal(read.exists, true);
  assert.equal(read.updatedAt, saved.updatedAt);
});

test('PUT still accepts a legacy text body', async (t) => {
  const root = await tempDir(t);
  const base = await serve(t, fakeContext({ workspaces: [{ path: root }] }));
  const save = await fetch(`${base}/dsh-notepad/api/note`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, sessionId: 's1', text: '旧客户端写入' }),
  });
  assert.equal(save.status, 200);
  const saved = await save.json();
  assert.equal(saved.text, '旧客户端写入');
  assert.equal(saved.segments.length, 1);
  assert.equal(saved.segments[0].text, '旧客户端写入');
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

test('a malformed segments body is a 400 and keeps the old note', async (t) => {
  const root = await tempDir(t);
  const base = await serve(t, fakeContext({ workspaces: [{ path: root }] }));
  await fetch(`${base}/dsh-notepad/api/note`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, sessionId: 's1', segments: [{ id: 'ok', text: '保留' }] }),
  });
  const response = await fetch(`${base}/dsh-notepad/api/note`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, sessionId: 's1', segments: [{ id: 'bad' }] }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'bad-input');
  const read = await (await fetch(`${base}/dsh-notepad/api/note?root=${encodeURIComponent(root)}&sessionId=s1`)).json();
  assert.equal(read.text, '保留');
});

test('a cross-origin request is forbidden', async (t) => {
  const base = await serve(t, fakeContext());
  const response = await fetch(`${base}/dsh-notepad/api/ping`, {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(response.status, 403);
});

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function imageRequest(base, root, overrides = {}) {
  return fetch(`${base}/dsh-notepad/api/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      root,
      sessionId: 's1',
      name: 'shot.png',
      mime: 'image/png',
      data: PNG_BASE64,
      ...overrides,
    }),
  });
}

test('POST image writes under the plugin directory and returns a workspace path', async (t) => {
  const root = await tempDir(t);
  const base = await serve(t, fakeContext({ workspaces: [{ path: root }] }));
  const response = await imageRequest(base, root);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.mime, 'image/png');
  assert.equal(body.size, Buffer.from(PNG_BASE64, 'base64').byteLength);
  assert.match(body.path, /^\.dsh\/notepad\/images\/[a-z0-9]+-[0-9a-f]+-shot\.png$/u);
  const saved = await readFile(path.join(root, ...body.path.split('/')));
  assert.deepEqual(saved, Buffer.from(PNG_BASE64, 'base64'));

  const segments = [{ id: 'seg-1', text: '截图', images: [{ path: body.path, name: 'shot.png' }] }];
  const save = await fetch(`${base}/dsh-notepad/api/note`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, sessionId: 's1', segments }),
  });
  assert.equal(save.status, 200);
  const savedNote = await save.json();
  assert.deepEqual(savedNote.segments[0].images, [{ path: body.path, name: 'shot.png' }]);
  assert.equal(savedNote.text, `截图\n![shot.png](${body.path})`);
});

test('image upload rejects unsupported, mismatched and malformed payloads', async (t) => {
  const root = await tempDir(t);
  const base = await serve(t, fakeContext({ workspaces: [{ path: root }] }));

  const unsupported = await imageRequest(base, root, { mime: 'text/plain', name: 'a.txt' });
  assert.equal(unsupported.status, 415);
  assert.equal((await unsupported.json()).code, 'unsupported-type');

  const mismatched = await imageRequest(base, root, { mime: 'image/png', data: Buffer.from('hello').toString('base64') });
  assert.equal(mismatched.status, 415);
  assert.equal((await mismatched.json()).code, 'unsupported-type');

  const malformed = await imageRequest(base, root, { data: 'not base64!' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, 'bad-input');

  const wrongMethod = await fetch(`${base}/dsh-notepad/api/image`);
  assert.equal(wrongMethod.status, 405);

  const unknownRoot = await imageRequest(base, path.join(root, 'elsewhere'));
  assert.equal(unknownRoot.status, 403);
  assert.equal((await unknownRoot.json()).code, 'unknown-workspace');
});
