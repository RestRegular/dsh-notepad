import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handleRequest } from '../index.js';
import { shutdownDetachedServer } from '../lib/detached-server.js';
import { NOTE_VERSION, notePath, writeNote } from '../lib/note-store.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function fakeContext({ workspaces = [], sessions = {}, llm = undefined, selection = undefined } = {}) {
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
      if (name === 'llm') return llm;
      if (name === 'agentDefaultModel') {
        return selection === undefined ? undefined : { currentSelection: () => selection };
      }
      return undefined;
    },
  };
}

/** Minimal streaming LLM double: one text delta, then a successful finish. */
function fakeLlm(output) {
  return {
    async resolveCallConfig(config) {
      return { ...config };
    },
    async prepareCall(base) {
      return {
        config: base,
        async *stream() {
          if (output !== '') yield { type: 'text-delta', text: output };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      };
    },
  };
}

/** Fake LLM that counts how often a model call is actually prepared. */
function countingLlm(output) {
  const inner = fakeLlm(output);
  const state = { calls: 0 };
  return {
    state,
    llm: {
      resolveCallConfig: (config) => inner.resolveCallConfig(config),
      async prepareCall(base) {
        state.calls += 1;
        return inner.prepareCall(base);
      },
    },
  };
}

/** Fake LLM that counts calls and records the system prompt of each request. */
function capturingLlm(output) {
  const state = { calls: 0, systems: [] };
  return {
    state,
    llm: {
      async resolveCallConfig(config) {
        return { ...config };
      },
      async prepareCall(base) {
        state.calls += 1;
        return {
          async *stream(request) {
            state.systems.push(request.system);
            if (output !== '') yield { type: 'text-delta', text: output };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      },
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
  assert.equal(body.version, manifest.version);
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

test('DELETE image removes only files owned by the plugin directory', async (t) => {
  const root = await tempDir(t);
  const base = await serve(t, fakeContext({ workspaces: [{ path: root }] }));
  const uploaded = await (await imageRequest(base, root)).json();
  const file = path.join(root, ...uploaded.path.split('/'));
  await readFile(file);

  const removed = await fetch(`${base}/dsh-notepad/api/image`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, sessionId: 's1', path: uploaded.path }),
  });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).deleted, true);
  await assert.rejects(() => readFile(file));

  const again = await fetch(`${base}/dsh-notepad/api/image`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, sessionId: 's1', path: uploaded.path }),
  });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).deleted, false);

  const outside = await fetch(`${base}/dsh-notepad/api/image`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, sessionId: 's1', path: '.dsh/notepad.json' }),
  });
  assert.equal(outside.status, 403);
  assert.equal((await outside.json()).code, 'not-owned');
});

test('GET unsent returns a pending count for every registered workspace', async (t) => {
  const rootA = await tempDir(t);
  const rootB = await tempDir(t);
  const rootC = await tempDir(t);
  await writeNote(rootA, [
    { id: 'a', text: '待发一' },
    { id: 'b', text: '待发二' },
    { id: 'c', text: '已发', archived: true, archivedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'd', text: '   ' },
  ]);
  await writeNote(rootB, []);
  await writeNote(rootC, [
    { id: 'e', text: '只剩归档', archived: true, archivedAt: '2026-01-01T00:00:00.000Z' },
  ]);
  const base = await serve(t, fakeContext({
    workspaces: [
      { id: 'ws-a', path: rootA, title: 'A' },
      { id: 'ws-b', path: rootB, title: 'B' },
      { id: 'ws-c', path: rootC, title: 'C' },
    ],
  }));
  const response = await fetch(`${base}/dsh-notepad/api/unsent?sessionId=s1`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.workspaces.map((workspace) => [workspace.id, workspace.count]), [
    ['ws-a', 2],
    ['ws-b', 0],
    ['ws-c', 0],
  ]);
  assert.equal(body.workspaces[0].path, rootA);
  assert.equal(body.workspaces[0].hasContent, true, 'workspaces with active cards are marked for the dropdown');
  assert.equal(body.workspaces[1].hasContent, false, 'empty workspaces are not offered');
  assert.equal(body.workspaces[2].hasContent, false, 'archived-only workspaces are not offered');
  assert.ok(!JSON.stringify(body).includes('待发'), 'counts never expose note text');
  assert.ok(!JSON.stringify(body).includes('只剩归档'), 'counts never expose archived note text');
});

test('POST optimize rewrites one segment with the default model', async (t) => {
  const root = await tempDir(t);
  const base = await serve(t, fakeContext({
    workspaces: [{ id: 'ws', path: root }],
    llm: fakeLlm('优化后的内容'),
    selection: { provider: 'deepseek', model: 'deepseek-chat' },
  }));
  const response = await fetch(`${base}/dsh-notepad/api/optimize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      root,
      sessionId: 's1',
      title: '问题',
      text: '这段文字需要优化',
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.text, '优化后的内容');
});

test('POST optimize reuses the answer for unchanged content', async (t) => {
  const root = await tempDir(t);
  const counting = countingLlm('缓存的优化结果');
  const base = await serve(t, fakeContext({
    workspaces: [{ id: 'ws', path: root }],
    llm: counting.llm,
    selection: { provider: 'deepseek', model: 'deepseek-chat' },
  }));
  const request = () => fetch(`${base}/dsh-notepad/api/optimize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      root,
      sessionId: 's1',
      title: '同一个标题',
      text: '内容完全没变',
    }),
  });
  const first = await (await request()).json();
  assert.equal(first.ok, true);
  assert.equal(first.text, '缓存的优化结果');
  assert.equal(first.cached, false);
  const second = await (await request()).json();
  assert.equal(second.ok, true);
  assert.equal(second.text, '缓存的优化结果');
  assert.equal(second.cached, true, 'the second request is answered from the cache');
  assert.equal(counting.state.calls, 1, 'the model is called exactly once');
});

test('POST optimize forwards a custom preset and caches per prompt', async (t) => {
  const root = await tempDir(t);
  const capturing = capturingLlm('自定义优化结果');
  const base = await serve(t, fakeContext({
    workspaces: [{ id: 'ws', path: root }],
    llm: capturing.llm,
    selection: { provider: 'deepseek', model: 'deepseek-chat' },
  }));
  const request = (system) => fetch(`${base}/dsh-notepad/api/optimize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, sessionId: 's1', title: '', text: '同一段内容', system }),
  });
  const first = await (await request('精简并保留全部事实')).json();
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  assert.ok(capturing.state.systems[0].startsWith('精简并保留全部事实'));
  assert.ok(capturing.state.systems[0].includes('Return only the rewritten text'),
    'the output contract is appended to a custom prompt');
  const same = await (await request('精简并保留全部事实')).json();
  assert.equal(same.cached, true, 'the same prompt is answered from the cache');
  const other = await (await request('改写成专业文档')).json();
  assert.equal(other.cached, false, 'a different prompt re-runs the model');
  assert.equal(capturing.state.calls, 2);
  assert.ok(capturing.state.systems[1].startsWith('改写成专业文档'));
});

test('POST optimize rejects an oversized custom prompt', async (t) => {
  const root = await tempDir(t);
  const base = await serve(t, fakeContext({
    workspaces: [{ path: root }],
    llm: fakeLlm('x'),
    selection: { provider: 'p', model: 'm' },
  }));
  const response = await fetch(`${base}/dsh-notepad/api/optimize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, sessionId: 's1', text: '内容', system: 'x'.repeat(4001) }),
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'too-large');
});

test('POST optimize retries with the built-in prompt when the first answer is empty', async (t) => {
  const root = await tempDir(t);
  const state = { calls: 0, systems: [], configs: [] };
  const llm = {
    async resolveCallConfig(config) {
      state.configs.push(config);
      return { ...config };
    },
    async prepareCall(base) {
      return {
        async *stream(request) {
          state.calls += 1;
          state.systems.push(request.system);
          if (state.calls >= 2) yield { type: 'text-delta', text: '重试后的内容' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      };
    },
  };
  const base = await serve(t, fakeContext({
    workspaces: [{ id: 'ws', path: root }],
    llm,
    selection: { provider: 'deepseek', model: 'deepseek-chat' },
  }));
  const response = await fetch(`${base}/dsh-notepad/api/optimize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      root,
      sessionId: 's1',
      title: '',
      text: '需要重试的短内容',
      system: '一个可能让模型只输出思考过程的提示词',
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.text, '重试后的内容');
  assert.equal(state.calls, 2, 'an empty first answer is retried once');
  assert.ok(state.systems[1].includes('writing assistant'),
    'the retry falls back to the built-in instruction');
  assert.ok(state.configs[0].maxTokens >= 4096,
    'short notes keep a healthy output budget so reasoning does not consume all of it');
});

test('POST optimize reports a missing model as unavailable', async (t) => {
  const root = await tempDir(t);
  const base = await serve(t, fakeContext({ workspaces: [{ path: root }] }));
  const response = await fetch(`${base}/dsh-notepad/api/optimize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, sessionId: 's1', text: '内容' }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'unavailable');
});

test('POST optimize rejects empty text', async (t) => {
  const root = await tempDir(t);
  const base = await serve(t, fakeContext({
    workspaces: [{ path: root }],
    llm: fakeLlm('x'),
    selection: { provider: 'p', model: 'm' },
  }));
  const response = await fetch(`${base}/dsh-notepad/api/optimize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, sessionId: 's1', text: '   ' }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'bad-input');
});

test('detach-url, detached status and retire work through the DSH route', async (t) => {
  t.after(() => shutdownDetachedServer());
  const root = await tempDir(t);
  await writeNote(root, [{ id: 's1', text: 'detached route', archived: false }]);
  const base = await serve(t, fakeContext({
    workspaces: [{ id: 'ws-detached', path: root, title: 'Detached' }],
  }));

  const response = await fetch(`${base}/dsh-notepad/api/detach-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      root,
      sessionId: 's1',
      config: { lang: 'en', theme: 'rose', ai: 'route AI' },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.url, /^http:\/\/127\.0\.0\.1:\d+\/window\?token=[0-9a-f]+&root=/u);

  const page = await fetch(body.url);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('detached.js'));

  const status = await fetch(`${base}/dsh-notepad/api/detached?root=${encodeURIComponent(root)}`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).active, true);

  const retire = await fetch(`${base}/dsh-notepad/api/detached/retire`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root }),
  });
  assert.equal(retire.status, 200);
  assert.equal((await retire.json()).retired, true);

  const after = await fetch(`${base}/dsh-notepad/api/detached?root=${encodeURIComponent(root)}`);
  assert.equal((await after.json()).active, false);
});

test('detach-url refuses an unknown workspace', async (t) => {
  t.after(() => shutdownDetachedServer());
  const root = await tempDir(t);
  const base = await serve(t, fakeContext({ workspaces: [] }));
  const response = await fetch(`${base}/dsh-notepad/api/detach-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, sessionId: 'missing' }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'unknown-workspace');
});
