/**
 * dsh-notepad — workspace note storage.
 *
 * One plain-text note per workspace, kept at `<workspace>/.dsh/notepad.json`.
 * The JSON envelope lets the file carry its own `updatedAt` while still
 * degrading gracefully: if the file is not JSON (a user or another tool
 * edited it by hand), the raw bytes are returned as the note text instead of
 * losing the content.
 *
 * @module dsh-notepad/lib/note-store
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Directory under the workspace root. */
export const NOTE_DIR = '.dsh';

/** File name inside {@link NOTE_DIR}. */
export const NOTE_FILE = 'notepad.json';

/** Default maximum note size (UTF-8 bytes). */
export const DEFAULT_MAX_BYTES = 512 * 1024;

/** Storage envelope version. */
export const NOTE_VERSION = 1;

/** A note-store failure with a stable machine-readable code. */
export class NoteStoreError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'NoteStoreError';
    this.code = code;
  }
}

/**
 * Absolute path of the note file.
 * @param {string} root workspace root
 */
export function notePath(root) {
  return path.join(root, NOTE_DIR, NOTE_FILE);
}

/**
 * Decode a stored note file.
 * @param {string} raw file contents
 * @param {number | undefined} mtimeMs
 */
export function parseNote(raw, mtimeMs) {
  let text = raw;
  let updatedAt;
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.text === 'string') {
      text = parsed.text;
      if (typeof parsed.updatedAt === 'string') updatedAt = parsed.updatedAt;
    }
  } catch {
    /* Not our envelope: keep the raw text. */
  }
  return {
    text,
    updatedAt: updatedAt ?? (typeof mtimeMs === 'number' ? new Date(mtimeMs).toISOString() : null),
    mtimeMs: typeof mtimeMs === 'number' ? mtimeMs : null,
    exists: true,
    size: Buffer.byteLength(raw, 'utf8'),
  };
}

/**
 * Read one workspace note. A missing file is an empty note, not an error.
 * @param {string} root workspace root
 * @returns {Promise<{text: string, updatedAt: string | null, mtimeMs: number | null, exists: boolean, size: number}>}
 */
export async function readNote(root) {
  const file = notePath(root);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { text: '', updatedAt: null, mtimeMs: null, exists: false, size: 0 };
    }
    throw error;
  }
  let mtimeMs;
  try {
    const stat = await fs.stat(file);
    mtimeMs = stat.mtimeMs;
  } catch {
    mtimeMs = undefined;
  }
  return parseNote(raw, mtimeMs);
}

/**
 * Replace one workspace note atomically.
 * @param {string} root workspace root
 * @param {string} text note body
 * @param {{ maxBytes?: number }} [options]
 */
export async function writeNote(root, text, options = {}) {
  if (typeof text !== 'string') {
    throw new NoteStoreError('bad-input', 'Note text must be a string.');
  }
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES;
  const size = Buffer.byteLength(text, 'utf8');
  if (size > maxBytes) {
    throw new NoteStoreError('too-large', `Note is too large (${size} bytes; limit ${maxBytes} bytes).`);
  }
  const dir = path.join(root, NOTE_DIR);
  const file = path.join(dir, NOTE_FILE);
  await fs.mkdir(dir, { recursive: true });
  const updatedAt = new Date().toISOString();
  const payload = `${JSON.stringify({ version: NOTE_VERSION, text, updatedAt }, null, 2)}\n`;
  const tmp = path.join(dir, `.${NOTE_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(tmp, payload, 'utf8');
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  const stat = await fs.stat(file);
  return {
    text,
    updatedAt,
    mtimeMs: stat.mtimeMs,
    exists: true,
    size: stat.size,
  };
}
