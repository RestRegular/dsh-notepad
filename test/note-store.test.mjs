import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_MAX_BYTES,
  MAX_IMAGES_PER_SEGMENT,
  MAX_SEGMENTS,
  NOTE_DIR,
  NOTE_FILE,
  NOTE_VERSION,
  NoteStoreError,
  imageMarkdown,
  notePath,
  parseNote,
  readNote,
  unsentCount,
  writeNote,
} from '../lib/note-store.js';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-notepad-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('a missing note is an empty note', async (t) => {
  const root = await workspace(t);
  const note = await readNote(root);
  assert.deepEqual(note, {
    version: null,
    segments: [],
    text: '',
    updatedAt: null,
    mtimeMs: null,
    exists: false,
    size: 0,
  });
});

test('writes and reads a segmented JSON envelope atomically', async (t) => {
  const root = await workspace(t);
  const segments = [
    { id: 'seg-a', text: '第一段\n第二行' },
    { id: 'seg-b', text: '已经发送的分段', archived: true, archivedAt: '2026-01-01T00:00:00.000Z' },
  ];
  const written = await writeNote(root, segments);
  assert.equal(written.text, '第一段\n第二行\n\n已经发送的分段');
  assert.equal(written.segments.length, 2);
  assert.equal(written.segments[0].archived, false);
  assert.equal(written.segments[1].archived, true);
  assert.equal(written.segments[1].archivedAt, '2026-01-01T00:00:00.000Z');
  assert.ok(written.mtimeMs > 0);
  assert.ok(written.updatedAt);

  const file = notePath(root);
  assert.equal(file, path.join(root, NOTE_DIR, NOTE_FILE));
  const raw = await readFile(file, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, NOTE_VERSION);
  assert.deepEqual(parsed.segments.map((segment) => segment.id), ['seg-a', 'seg-b']);
  assert.equal(parsed.segments[1].archived, true);
  assert.equal(parsed.text, '第一段\n第二行\n\n已经发送的分段');
  assert.equal(typeof parsed.updatedAt, 'string');

  const note = await readNote(root);
  assert.deepEqual(note.segments, written.segments);
  assert.equal(note.text, written.text);
  assert.equal(note.exists, true);
  assert.equal(note.mtimeMs, written.mtimeMs);
  assert.equal(note.updatedAt, written.updatedAt);

  const leftovers = (await readdir(path.join(root, NOTE_DIR))).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('a legacy plain-text string still writes one segment', async (t) => {
  const root = await workspace(t);
  const text = '第一行\n第二行\n- [ ] 下一步\n';
  const written = await writeNote(root, text);
  assert.equal(written.text, text);
  assert.equal(written.segments.length, 1);
  assert.equal(written.segments[0].text, text);
  assert.equal(written.segments[0].archived, false);
});

test('a version 1 envelope is migrated to one segment on read', async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, NOTE_DIR), { recursive: true });
  await writeFile(notePath(root), JSON.stringify({ version: 1, text: '旧内容', updatedAt: '2026-01-01T00:00:00.000Z' }), 'utf8');
  const note = await readNote(root);
  assert.equal(note.version, 1);
  assert.equal(note.segments.length, 1);
  assert.equal(note.segments[0].text, '旧内容');
  assert.equal(note.text, '旧内容');
  assert.equal(note.updatedAt, '2026-01-01T00:00:00.000Z');
});

test('a version 4 envelope reports its version so the client can migrate card order', async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, NOTE_DIR), { recursive: true });
  await writeFile(notePath(root), JSON.stringify({
    version: 4,
    segments: [
      { id: 'new', text: '最新', createdAt: '2026-01-02T00:00:00.000Z' },
      { id: 'old', text: '较早', createdAt: '2026-01-01T00:00:00.000Z' },
    ],
  }), 'utf8');
  const note = await readNote(root);
  assert.equal(note.version, 4);
  assert.deepEqual(note.segments.map((segment) => segment.id), ['new', 'old']);
});

test('a hand-edited plain-text file is preserved as one segment', async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, NOTE_DIR), { recursive: true });
  await writeFile(notePath(root), 'plain text, not JSON', 'utf8');
  const note = await readNote(root);
  assert.equal(note.segments.length, 1);
  assert.equal(note.segments[0].text, 'plain text, not JSON');
  assert.equal(note.text, 'plain text, not JSON');
  assert.equal(note.exists, true);
  assert.equal(typeof note.updatedAt, 'string');
});

test('a JSON file without text or segments falls back to its raw bytes', async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, NOTE_DIR), { recursive: true });
  await writeFile(notePath(root), '{"version":1}', 'utf8');
  const note = await readNote(root);
  assert.equal(note.segments.length, 1);
  assert.equal(note.segments[0].text, '{"version":1}');
});

test('reading is forgiving: malformed stored segments are skipped', async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, NOTE_DIR), { recursive: true });
  await writeFile(notePath(root), JSON.stringify({
    version: 2,
    segments: [
      { id: 'a', text: '保留' },
      { id: 'b' },
      null,
      { id: 'c', text: '也保留', archived: true },
      '字符串分段',
    ],
  }), 'utf8');
  const note = await readNote(root);
  assert.deepEqual(note.segments.map((segment) => segment.text), ['保留', '也保留', '字符串分段']);
  assert.equal(note.segments[1].archived, true);
  assert.equal(note.text, '保留\n\n也保留\n\n字符串分段');
});

test('parseNote keeps a valid updatedAt and derives one from mtime otherwise', () => {
  assert.equal(parseNote('{"text":"hi","updatedAt":"2026-01-01T00:00:00.000Z"}', 5).updatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(parseNote('{"text":"hi"}', 1000).updatedAt, new Date(1000).toISOString());
  assert.equal(parseNote('raw', undefined).updatedAt, null);
});

test('segment titles and creation times round-trip and stay backward compatible', async (t) => {
  const root = await workspace(t);
  const written = await writeNote(root, [
    { id: 'a', text: '新内容', title: '  标题一  ', createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'b', text: '旧内容' },
  ]);
  assert.equal(written.segments[0].title, '  标题一  ');
  assert.equal(written.segments[0].createdAt, '2026-01-02T00:00:00.000Z');
  assert.equal(written.segments[1].title, '');
  assert.equal(written.segments[1].createdAt, null);

  const raw = JSON.parse(await readFile(notePath(root), 'utf8'));
  assert.equal(raw.version, NOTE_VERSION);
  assert.equal(raw.segments[0].title, '  标题一  ');
  assert.equal(raw.segments[0].createdAt, '2026-01-02T00:00:00.000Z');
  assert.equal(raw.segments[1].title, undefined);

  const note = await readNote(root);
  assert.equal(note.segments[0].title, '  标题一  ');
  assert.equal(note.segments[1].createdAt, null);

  await assert.rejects(
    () => writeNote(root, [{ text: 'x', title: 42 }]),
    (error) => error instanceof NoteStoreError && error.code === 'bad-input',
  );
  await assert.rejects(
    () => writeNote(root, [{ text: 'x', createdAt: 42 }]),
    (error) => error instanceof NoteStoreError && error.code === 'bad-input',
  );
});

test('unsentCount counts only active segments that carry content', () => {
  assert.equal(unsentCount({
    segments: [
      { text: '有内容' },
      { text: '   ' },
      { text: '', images: [{ path: 'a.png', name: 'a.png' }] },
      { text: '已归档', archived: true },
    ],
  }), 2);
  assert.equal(unsentCount({ segments: [] }), 0);
  assert.equal(unsentCount({}), 0);
});

test('duplicate segment ids are made unique on write', async (t) => {
  const root = await workspace(t);
  const written = await writeNote(root, [
    { id: 'same', text: 'a' },
    { id: 'same', text: 'b' },
  ]);
  assert.equal(new Set(written.segments.map((segment) => segment.id)).size, 2);
  assert.equal(written.segments[0].id, 'same');
});

test('oversized notes are rejected without touching the previous file', async (t) => {
  const root = await workspace(t);
  await writeNote(root, 'keep me');
  const before = await readNote(root);
  await assert.rejects(
    () => writeNote(root, [{ id: 'a', text: 'x'.repeat(DEFAULT_MAX_BYTES + 1) }], { maxBytes: 500 }),
    (error) => error instanceof NoteStoreError
      && (error.code === 'too-large' || error.code === 'bad-input'),
  );
  const after = await readNote(root);
  assert.equal(after.text, 'keep me');
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('the size limit counts UTF-8 bytes, not characters', async (t) => {
  const root = await workspace(t);
  await assert.rejects(
    () => writeNote(root, [{ id: 'a', text: '汉'.repeat(30) }], { maxBytes: 120 }),
    (error) => error instanceof NoteStoreError && error.code === 'too-large',
  );
  const ok = await writeNote(root, [{ id: 'a', text: '汉'.repeat(2) }], { maxBytes: 4096 });
  assert.equal(ok.text, '汉汉');
});

test('too many segments are rejected', async (t) => {
  const root = await workspace(t);
  const segments = Array.from({ length: MAX_SEGMENTS + 1 }, (_, index) => ({ text: String(index) }));
  await assert.rejects(
    () => writeNote(root, segments),
    (error) => error instanceof NoteStoreError && error.code === 'too-many',
  );
});

test('writeNote rejects malformed input', async (t) => {
  const root = await workspace(t);
  for (const value of [null, 42, { text: 3 }, [{ id: 'a' }]]) {
    await assert.rejects(
      () => writeNote(root, value),
      (error) => error instanceof NoteStoreError && error.code === 'bad-input',
    );
  }
});

test('image references round-trip and render as Markdown in the body', async (t) => {
  const root = await workspace(t);
  const written = await writeNote(root, [
    {
      id: 'a',
      text: '看截图',
      images: [
        { path: '.dsh/notepad/images/a b.png', name: 'a b.png' },
        { path: 'C:\\tmp\\x(1).png', name: 'x' },
      ],
    },
    { id: 'b', text: '', images: [{ path: 'only.png' }] },
  ]);
  assert.deepEqual(written.segments[0].images, [
    { path: '.dsh/notepad/images/a b.png', name: 'a b.png' },
    { path: 'C:/tmp/x(1).png', name: 'x' },
  ]);
  assert.deepEqual(written.segments[1].images, [{ path: 'only.png', name: 'only.png' }]);
  assert.equal(
    written.text,
    '看截图\n![a b.png](.dsh/notepad/images/a%20b.png)\n![x](C:/tmp/x%281%29.png)\n\n![only.png](only.png)',
  );
  assert.equal(imageMarkdown({ path: 'a#b?.png', name: '' }), '![a#b?.png](a%23b%3F.png)');

  const raw = JSON.parse(await readFile(notePath(root), 'utf8'));
  assert.equal(raw.version, NOTE_VERSION);
  assert.deepEqual(raw.segments[0].images[0], { path: '.dsh/notepad/images/a b.png', name: 'a b.png' });
  const note = await readNote(root);
  assert.deepEqual(note.segments, written.segments);
});

test('image reading is forgiving and writing is strict', async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, NOTE_DIR), { recursive: true });
  const many = Array.from({ length: MAX_IMAGES_PER_SEGMENT + 3 }, (_, index) => `img-${index}.png`);
  await writeFile(notePath(root), JSON.stringify({
    version: 3,
    segments: [{
      id: 'a',
      text: '带图',
      images: [null, 42, { path: '' }, 'C:\\pics\\a.png', { path: 'b.png', name: '  B  ' }, ...many],
    }],
  }), 'utf8');
  const note = await readNote(root);
  assert.equal(note.segments[0].images.length, MAX_IMAGES_PER_SEGMENT);
  assert.deepEqual(note.segments[0].images[0], { path: 'C:/pics/a.png', name: 'a.png' });
  assert.deepEqual(note.segments[0].images[1], { path: 'b.png', name: 'B' });

  await assert.rejects(
    () => writeNote(root, [{ text: 'x', images: [{ path: '' }] }]),
    (error) => error instanceof NoteStoreError && error.code === 'bad-input',
  );
  await assert.rejects(
    () => writeNote(root, [{ text: 'x', images: [{}] }]),
    (error) => error instanceof NoteStoreError && error.code === 'bad-input',
  );
  await assert.rejects(
    () => writeNote(root, [{
      text: 'x',
      images: Array.from({ length: MAX_IMAGES_PER_SEGMENT + 1 }, (_, index) => ({ path: `${index}.png` })),
    }]),
    (error) => error instanceof NoteStoreError && error.code === 'too-many',
  );
});
