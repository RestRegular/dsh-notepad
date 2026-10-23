/**
 * dsh-notepad — workspace note storage.
 *
 * One note per workspace, kept at `<workspace>/.dsh/notepad.json`. A note is an
 * ordered list of text segments; each segment may be archived after it was
 * sent, and the Client may delete either archived or active segments (active
 * deletion is irreversible and confirmed in the UI).
 *
 * Version 4 adds an optional card title and creation timestamp to every
 * segment. Version 5 stores cards oldest-first; the Client reverses a version 4
 * payload once while reading it. Version 2 stores the segment list under
 * `segments` and repeats the merged body under `text` so the file stays human
 * readable and older builds can still read the content. Version 1 files (a
 * single `text`) and hand-edited plain-text files are migrated on read as one
 * segment. An optional `origin` on archived segments records whether the card
 * was archived manually, auto-archived by a notepad send, or captured from the
 * conversation composer; unknown values are read as the legacy manual origin.
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

/** Maximum characters kept for one segment title. */
export const MAX_SEGMENT_TITLE_CHARS = 200;

/** Maximum characters kept for one creation timestamp. */
export const MAX_SEGMENT_TIME_CHARS = 64;

/**
 * Known archive sources. `manual` is the archive button, `send` is a segment
 * sent from the notepad, and `compose` is a chat message captured from the
 * conversation composer. Missing origins are legacy manual archives.
 */
export const ARCHIVE_ORIGINS = Object.freeze(['manual', 'send', 'compose']);

const ARCHIVE_ORIGIN_SET = new Set(ARCHIVE_ORIGINS);

/** Storage envelope version. Version 5 flips the default card order to oldest-first. */
export const NOTE_VERSION = 5;

/** Maximum image references accepted on one segment. */
export const MAX_IMAGES_PER_SEGMENT = 20;

/** Maximum characters kept for one image path. */
export const MAX_IMAGE_PATH_CHARS = 1024;

/** Maximum characters kept for one image display name. */
export const MAX_IMAGE_NAME_CHARS = 160;

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
 * Final non-empty segment of a path, in either separator spelling.
 * @param {string} value
 */
function baseNameOf(value) {
  const trimmed = String(value ?? '').replace(/[/\\]+$/u, '');
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return trimmed.slice(separator + 1);
}

/**
 * Normalize one stored image reference. Reading and writing share this shape;
 * reading drops invalid entries, writing rejects them.
 * @param {unknown} value
 * @returns {{path: string, name: string} | null}
 */
function readImage(value) {
  if (typeof value === 'string') value = { path: value };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.path !== 'string') return null;
  const filePath = value.path.trim().replace(/\\/gu, '/');
  if (filePath === '' || filePath.length > MAX_IMAGE_PATH_CHARS) return null;
  const name = typeof value.name === 'string' && value.name.trim() !== ''
    ? value.name.trim().replace(/\s+/gu, ' ').slice(0, MAX_IMAGE_NAME_CHARS)
    : baseNameOf(filePath);
  return { path: filePath, name: name === '' ? 'image' : name };
}

/**
 * Normalize every surviving image reference for one segment.
 * @param {unknown} value
 * @returns {Array<{path: string, name: string}>}
 */
function readImages(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (out.length >= MAX_IMAGES_PER_SEGMENT) break;
    const image = readImage(item);
    if (image !== null) out.push(image);
  }
  return out;
}

/**
 * Strict per-segment image normalization for writes.
 * @param {unknown} value
 * @param {number} index
 * @returns {Array<{path: string, name: string}>}
 */
function normalizeWriteImages(value, index) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new NoteStoreError('bad-input', `Segment ${index + 1} images is not an array.`);
  }
  if (value.length > MAX_IMAGES_PER_SEGMENT) {
    throw new NoteStoreError(
      'too-many',
      `Segment ${index + 1} has too many images (${value.length}; limit ${MAX_IMAGES_PER_SEGMENT}).`,
    );
  }
  return value.map((item, imageIndex) => {
    const image = readImage(item);
    if (image === null) {
      throw new NoteStoreError('bad-input', `Segment ${index + 1} image ${imageIndex + 1} is invalid.`);
    }
    return image;
  });
}

/**
 * Render one image as Markdown for the note body and composer transfers.
 * Paths are URL-escaped so the DSH Markdown renderer can resolve them.
 * @param {{path?: string, name?: string}} image
 * @returns {string}
 */
export function imageMarkdown(image) {
  const file = typeof image?.path === 'string' ? image.path.replace(/\\/gu, '/') : '';
  if (file === '') return '';
  const label = (typeof image?.name === 'string' ? image.name : '')
    .replace(/[\r\n]+/gu, ' ')
    .replace(/[[\]]/gu, ' ')
    .trim() || baseNameOf(file) || 'image';
  let target;
  try {
    target = encodeURI(file);
  } catch {
    target = file;
  }
  target = target
    .replace(/#/gu, '%23')
    .replace(/\?/gu, '%3F')
    .replace(/\(/gu, '%28')
    .replace(/\)/gu, '%29');
  return `![${label}](${target})`;
}

/**
 * One segment rendered as text plus one Markdown line per image.
 * @param {{text?: string, images?: Array<{path: string, name: string}>}} segment
 */
export function segmentBody(segment) {
  const text = typeof segment?.text === 'string' ? segment.text : '';
  const images = Array.isArray(segment?.images) ? segment.images : [];
  const parts = [];
  if (text.trim() !== '') parts.push(text);
  for (const image of images) {
    const markdown = imageMarkdown(image);
    if (markdown !== '') parts.push(markdown);
  }
  return parts.join('\n');
}

/**
 * Normalize one archive source. Unknown or malformed values fall back to the
 * legacy `null` origin, which the Client renders as expanded.
 * @param {unknown} value
 * @returns {'manual' | 'send' | 'compose' | null}
 */
function readOrigin(value) {
  return typeof value === 'string' && ARCHIVE_ORIGIN_SET.has(value) ? value : null;
}

/**
 * Normalize one segment read from disk. Reading is forgiving: a malformed
 * entry is skipped instead of making the whole note unreadable.
 * @param {unknown} value
 * @param {number} index
 * @param {Set<string>} seen
 * @returns {{id: string, text: string, title: string, createdAt: string | null, images: Array<{path: string, name: string}>, archived: boolean, archivedAt: string | null, origin: 'manual' | 'send' | 'compose' | null} | null}
 */
function readSegment(value, index, seen) {
  if (typeof value === 'string') value = { text: value };
  if (value === null || typeof value !== 'object') return null;
  const images = readImages(value.images);
  if (typeof value.text !== 'string' && images.length === 0) return null;
  const text = typeof value.text === 'string' ? value.text : '';
  let id = typeof value.id === 'string' && value.id !== '' ? value.id.slice(0, 128) : `seg-${index + 1}`;
  let suffix = 1;
  while (seen.has(id)) {
    id = `${id}-${suffix}`;
    suffix += 1;
  }
  seen.add(id);
  const title = typeof value.title === 'string' ? value.title.slice(0, MAX_SEGMENT_TITLE_CHARS) : '';
  const createdAt = typeof value.createdAt === 'string' && value.createdAt !== ''
    ? value.createdAt.slice(0, MAX_SEGMENT_TIME_CHARS)
    : null;
  const archived = value.archived === true;
  const archivedAt = archived && typeof value.archivedAt === 'string' && value.archivedAt !== ''
    ? value.archivedAt
    : null;
  return { id, text, title, createdAt, images, archived, archivedAt, origin: archived ? readOrigin(value.origin) : null };
}

/**
 * Normalize a segment list for a write. Unlike {@link readSegment}, malformed
 * entries are an input error here: the route must not silently drop content.
 *
 * Accepts the modern `segments` array, a single legacy text string, or
 * `{ text }`.
 *
 * @param {unknown} input
 * @returns {Array<{id: string, text: string, archived: boolean, archivedAt: string | null, origin: 'manual' | 'send' | 'compose' | null}>}
 */
export function normalizeSegments(input) {
  if (typeof input === 'string') {
    if (input === '') return [];
    return [{ id: 'seg-1', text: input, title: '', createdAt: null, images: [], archived: false, archivedAt: null, origin: null }];
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
  const images = normalizeWriteImages(value.images, index);
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
  // Origin only describes how an archived card got there; active segments
  // never carry one.
  const origin = archived ? readOrigin(value.origin) : null;
  const title = value.title === undefined || value.title === null
    ? ''
    : typeof value.title === 'string'
      ? value.title.slice(0, MAX_SEGMENT_TITLE_CHARS)
      : invalidTitle(index);
  const createdAt = value.createdAt === undefined || value.createdAt === null
    ? null
    : typeof value.createdAt === 'string'
      ? value.createdAt.slice(0, MAX_SEGMENT_TIME_CHARS)
      : invalidCreatedAt(index);
  return { id, text: value.text, title, createdAt, images, archived, archivedAt, origin };
}

/**
 * @param {number} index
 * @returns {never}
 */
function invalidTitle(index) {
  throw new NoteStoreError('bad-input', `Segment ${index + 1} title is not a string.`);
}

/**
 * @param {number} index
 * @returns {never}
 */
function invalidCreatedAt(index) {
  throw new NoteStoreError('bad-input', `Segment ${index + 1} createdAt is not a string.`);
}

/**
 * Whether one segment still counts as unsent work: it is active and carries
 * text or at least one image. Archived segments were already sent or filed
 * away, so they never contribute to the pending badge.
 * @param {{text?: string, images?: unknown[], archived?: boolean}} segment
 * @returns {boolean}
 */
export function isUnsentSegment(segment) {
  if (segment === null || typeof segment !== 'object' || segment.archived === true) return false;
  const text = typeof segment.text === 'string' ? segment.text : '';
  const images = Array.isArray(segment.images) ? segment.images : [];
  return text.trim() !== '' || images.length > 0;
}

/**
 * Number of pending segments in one decoded note.
 * @param {{segments?: Array<{text?: string, images?: unknown[], archived?: boolean}>}} note
 * @returns {number}
 */
export function unsentCount(note) {
  const segments = Array.isArray(note?.segments) ? note.segments : [];
  let count = 0;
  for (const segment of segments) {
    if (isUnsentSegment(segment)) count += 1;
  }
  return count;
}

/**
 * Merge segments into the plain body stored next to the list.
 * @param {Array<{text: string, images?: Array<{path: string, name: string}>}>} segments
 */
export function mergeSegments(segments) {
  return segments
    .map((segment) => segmentBody(segment))
    .filter((body) => body.trim() !== '')
    .join('\n\n');
}

/**
 * Decode a stored note file.
 * @param {string} raw file contents
 * @param {number | undefined} mtimeMs
 */
export function parseNote(raw, mtimeMs) {
  let segmentsInput;
  let updatedAt;
  let version = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      if (Number.isFinite(parsed.version)) version = parsed.version;
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
    version,
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
      return { version: null, segments: [], text: '', updatedAt: null, mtimeMs: null, exists: false, size: 0 };
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
      ...(segment.title !== '' ? { title: segment.title } : {}),
      ...(segment.createdAt !== null ? { createdAt: segment.createdAt } : {}),
      ...(segment.images.length > 0
        ? { images: segment.images.map((image) => ({ path: image.path, name: image.name })) }
        : {}),
      ...(segment.archived ? { archived: true } : {}),
      ...(segment.archivedAt ? { archivedAt: segment.archivedAt } : {}),
      ...(segment.archived && segment.origin ? { origin: segment.origin } : {}),
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
