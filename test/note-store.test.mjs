import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_MAX_BYTES,
  NOTE_DIR,
  NOTE_FILE,
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
    text: '',
    updatedAt: null,
    mtimeMs: null,
    exists: false,
    size: 0,
  });
});

test('writes and reads a JSON envelope atomically', async (t) => {
  const root = await workspace(t);
  const text = '第一行\n第二行\n- [ ] 下一步\n';
  const written = await writeNote(root, text);
  assert.equal(written.text, text);
  assert.ok(written.mtimeMs > 0);
  assert.ok(written.updatedAt);

  const file = notePath(root);
  assert.equal(file, path.join(root, NOTE_DIR, NOTE_FILE));
  const raw = await readFile(file, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.text, text);
  assert.equal(typeof parsed.updatedAt, 'string');

  const note = await readNote(root);
  assert.equal(note.text, text);
  assert.equal(note.exists, true);
  assert.equal(note.mtimeMs, written.mtimeMs);
  assert.equal(note.updatedAt, written.updatedAt);

  const leftovers = (await readdir(path.join(root, NOTE_DIR))).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('a hand-edited plain-text file is preserved as the note body', async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, NOTE_DIR), { recursive: true });
  await writeFile(path.join(root, NOTE_DIR, NOTE_FILE), 'plain text, not JSON', 'utf8');
  const note = await readNote(root);
  assert.equal(note.text, 'plain text, not JSON');
  assert.equal(note.exists, true);
  assert.equal(typeof note.updatedAt, 'string');
});

test('a JSON file without a text field falls back to its raw bytes', async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, NOTE_DIR), { recursive: true });
  await writeFile(path.join(root, NOTE_DIR, NOTE_FILE), '{"version":1}', 'utf8');
  const note = await readNote(root);
  assert.equal(note.text, '{"version":1}');
});

test('parseNote keeps a valid updatedAt and derives one from mtime otherwise', () => {
  assert.equal(parseNote('{"text":"hi","updatedAt":"2026-01-01T00:00:00.000Z"}', 5).updatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(parseNote('{"text":"hi"}', 1000).updatedAt, new Date(1000).toISOString());
  assert.equal(parseNote('raw', undefined).updatedAt, null);
});

test('oversized notes are rejected without touching the previous file', async (t) => {
  const root = await workspace(t);
  await writeNote(root, 'keep me');
  const before = await readNote(root);
  await assert.rejects(
    () => writeNote(root, 'x'.repeat(DEFAULT_MAX_BYTES + 1)),
    (error) => error instanceof NoteStoreError && error.code === 'too-large',
  );
  const after = await readNote(root);
  assert.equal(after.text, 'keep me');
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('the size limit counts UTF-8 bytes, not characters', async (t) => {
  const root = await workspace(t);
  const threeBytes = '汉'.repeat(3);
  await assert.rejects(
    () => writeNote(root, threeBytes, { maxBytes: 8 }),
    (error) => error instanceof NoteStoreError && error.code === 'too-large',
  );
  const ok = await writeNote(root, '汉'.repeat(2), { maxBytes: 8 });
  assert.equal(ok.text, '汉汉');
});

test('writeNote rejects non-string text', async (t) => {
  const root = await workspace(t);
  await assert.rejects(
    () => writeNote(root, null),
    (error) => error instanceof NoteStoreError && error.code === 'bad-input',
  );
});
