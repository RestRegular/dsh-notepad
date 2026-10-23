import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_MAX_BYTES,
  MAX_SEGMENTS,
  NOTE_DIR,
  NOTE_FILE,
  NOTE_VERSION,
  NoteStoreError,
  notePath,
  parseNote,
  readNote,
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
  assert.equal(note.segments.length, 1);
  assert.equal(note.segments[0].text, '旧内容');
  assert.equal(note.text, '旧内容');
  assert.equal(note.updatedAt, '2026-01-01T00:00:00.000Z');
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
