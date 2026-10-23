/**
 * dsh-notepad — workspace note storage.
 *
 * One note per workspace, kept at `<workspace>/.dsh/notepad.json`. A note is an
 * ordered list of text segments; each segment may be archived after it was
 * sent, and only archived segments can be deleted by the client.
 *
 * Version 2 stores the segment list under `segments` and repeats the merged
 * body under `text` so the file stays human readable and older builds can
 * still read the content. Version 1 files (a single `text`) and hand-edited
 * plain-text files are migrated on read as one segment.
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

/** Default maximum note file size (UTF-8 bytes). */
export const DEFAULT_MAX_BYTES = 512 * 1024;

/** Maximum number of segments accepted from the client. */
export const MAX_SEGMENTS = 200;

/** Maximum characters in one segment. */
export const MAX_SEGMENT_CHARS = 160_000;

/** Storage envelope version. */
export const NOTE_VERSION = 2;

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
 * Normalize one segment read from disk. Reading is forgiving: a malformed
 * entry is skipped instead of making the whole note unreadable.
 * @param {unknown} value
 * @param {number} index
 * @param {Set<string>} seen
 * @returns {{id: string, text: string, archived: boolean, archivedAt: string | null} | null}
 */
function readSegment(value, index, seen) {
  if (typeof value === 'string') value = { text: value };
  if (value === null || typeof value !== 'object') return null;
  if (typeof value.text !== 'string') return null;
  const text = value.text;
  let id = typeof value.id === 'string' && value.id !== '' ? value.id.slice(0, 128) : `seg-${index + 1}`;
  let suffix = 1;
  while (seen.has(id)) {
    id = `${id}-${suffix}`;
    suffix += 1;
  }
  seen.add(id);
  const archived = value.archived === true;
  const archivedAt = archived && typeof value.archivedAt === 'string' && value.archivedAt !== ''
    ? value.archivedAt
    : null;
  return { id, text, archived, archivedAt };
}

/**
 * Normalize a segment list for a write. Unlike {@link readSegment}, malformed
 * entries are an input error here: the route must not silently drop content.
 *
 * Accepts the modern `segments` array, a single legacy text string, or
 * `{ text }`.
 *
 * @param {unknown} input
 * @returns {Array<{id: string, text: string, archived: boolean, archivedAt: string | null}>}
 */
export function normalizeSegments(input) {
  if (typeof input === 'string') {
    if (input === '') return [];
    return [{ id: 'seg-1', text: input, archived: false, archivedAt: null }];
  }
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    if (Array.isArray(input.segments)) return normalizeSegments(input.segments);
    if (typeof input.text === 'string') return normalizeSegments(input.text);
    throw new NoteStoreError('bad-input', 'Note must be a string or a segments array.');
  }
  if (!Array.isArray(input)) {
    throw new NoteStoreError('bad-input', 'Note must be a string or a segments array.');
  }
  if (input.length > MAX_SEGMENTS) {
    throw new NoteStoreError('too-many', `Too many segments (${input.length}; limit ${MAX_SEGMENTS}).`);
  }
  const seen = new Set();
  return input.map((value, index) => {
    const segment = normalizeWriteSegment(value, index, seen);
    return segment;
  });
}

/**
 * Strict per-segment normalization for writes.
 * @param {unknown} value
 * @param {number} index
 * @param {Set<string>} seen
 */
function normalizeWriteSegment(value, index, seen) {
  if (typeof value === 'string') value = { text: value };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new NoteStoreError('bad-input', `Segment ${index + 1} is not an object.`);
  }
  if (typeof value.text !== 'string') {
    throw new NoteStoreError('bad-input', `Segment ${index + 1} has no text field.`);
  }
  if (value.text.length > MAX_SEGMENT_CHARS) {
    throw new NoteStoreError(
      'too-large',
      `Segment ${index + 1} is too large (${value.text.length} characters; limit ${MAX_SEGMENT_CHARS}).`,
    );
  }
  let id = typeof value.id === 'string' && value.id !== '' ? value.id.slice(0, 128) : `seg-${index + 1}`;
  let suffix = 1;
  while (seen.has(id)) {
    id = `${id}-${suffix}`;
    suffix += 1;
  }
  seen.add(id);
  const archived = value.archived === true;
  const archivedAt = archived && typeof value.archivedAt === 'string' && value.archivedAt !== ''
    ? value.archivedAt
    : null;
  return { id, text: value.text, archived, archivedAt };
}

/**
 * Merge segments into the plain body stored next to the list.
 * @param {Array<{text: string}>} segments
 */
export function mergeSegments(segments) {
  return segments.map((segment) => segment.text).join('\n\n');
}

/**
 * Decode a stored note file.
 * @param {string} raw file contents
 * @param {number | undefined} mtimeMs
 */
export function parseNote(raw, mtimeMs) {
  let segmentsInput;
  let updatedAt;
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      if (Array.isArray(parsed.segments)) segmentsInput = parsed.segments;
      else if (typeof parsed.text === 'string') segmentsInput = parsed.text;
      if (typeof parsed.updatedAt === 'string') updatedAt = parsed.updatedAt;
    }
  } catch {
    /* Not our envelope: keep the raw text. */
  }
  if (segmentsInput === undefined) segmentsInput = raw;
  const seen = new Set();
  const segments = [];
  const values = typeof segmentsInput === 'string'
    ? (segmentsInput === '' ? [] : [segmentsInput])
    : Array.isArray(segmentsInput) ? segmentsInput : [];
  for (const value of values) {
    const segment = readSegment(value, segments.length, seen);
    if (segment !== null) segments.push(segment);
  }
  return {
    segments,
    text: mergeSegments(segments),
    updatedAt: updatedAt ?? (typeof mtimeMs === 'number' ? new Date(mtimeMs).toISOString() : null),
    mtimeMs: typeof mtimeMs === 'number' ? mtimeMs : null,
    exists: true,
    size: Buffer.byteLength(raw, 'utf8'),
  };
}

/**
 * Read one workspace note. A missing file is an empty note, not an error.
 * @param {string} root workspace root
 * @returns {Promise<{segments: Array<{id: string, text: string, archived: boolean, archivedAt: string | null}>, text: string, updatedAt: string | null, mtimeMs: number | null, exists: boolean, size: number}>}
 */
export async function readNote(root) {
  const file = notePath(root);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { segments: [], text: '', updatedAt: null, mtimeMs: null, exists: false, size: 0 };
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
 * Replace one workspace note atomically. Accepts either a segment array or a
 * legacy plain-text string.
 * @param {string} root workspace root
 * @param {unknown} note segments array or legacy text
 * @param {{ maxBytes?: number }} [options]
 */
export async function writeNote(root, note, options = {}) {
  const segments = normalizeSegments(note);
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES;
  const dir = path.join(root, NOTE_DIR);
  const file = path.join(dir, NOTE_FILE);
  const updatedAt = new Date().toISOString();
  const payload = `${JSON.stringify({
    version: NOTE_VERSION,
    segments: segments.map((segment) => ({
      id: segment.id,
      text: segment.text,
      ...(segment.archived ? { archived: true } : {}),
      ...(segment.archivedAt ? { archivedAt: segment.archivedAt } : {}),
    })),
    text: mergeSegments(segments),
    updatedAt,
  }, null, 2)}\n`;
  const size = Buffer.byteLength(payload, 'utf8');
  if (size > maxBytes) {
    throw new NoteStoreError('too-large', `Note is too large (${size} bytes; limit ${maxBytes} bytes).`);
  }
  await fs.mkdir(dir, { recursive: true });
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
    segments,
    text: mergeSegments(segments),
    updatedAt,
    mtimeMs: stat.mtimeMs,
    exists: true,
    size: stat.size,
  };
}
