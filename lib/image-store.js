/**
 * dsh-notepad — workspace image storage.
 *
 * Images pasted into the notepad have no host path in the browser, so their
 * base64 payload is written under the plugin directory:
 *
 *   <workspace>/.dsh/notepad/images/<unique>-<name>.<ext>
 *
 * The returned path is workspace-relative, which keeps the note file portable
 * inside one workspace. Selected images keep their original path and never
 * reach this module unless the browser could not expose that path.
 *
 * Only PNG, JPEG, WebP and GIF are accepted, and the payload must actually
 * start with the matching file signature: this route is loopback-only, but it
 * must not be usable as an arbitrary file writer.
 *
 * @module dsh-notepad/lib/image-store
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { NoteStoreError } from './note-store.js';

/** Plugin-owned directory under the workspace root (POSIX spelling). */
export const IMAGE_DIR = '.dsh/notepad/images';

/** Maximum decoded image size accepted from the browser. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Maximum display name kept for one image. */
export const MAX_IMAGE_NAME_CHARS = 160;

/** MIME type to canonical file extension. */
export const IMAGE_TYPES = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

/**
 * Validate a declared MIME type.
 * @param {unknown} mime
 * @returns {string | null} canonical MIME type
 */
export function canonicalImageType(mime) {
  if (typeof mime !== 'string') return null;
  const value = mime.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(IMAGE_TYPES, value) ? value : null;
}

/**
 * Read a supported image signature.
 * @param {Buffer} bytes
 * @returns {string | null} canonical MIME type
 */
export function sniffImageType(bytes) {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6) {
    const gif = bytes.subarray(0, 6).toString('latin1');
    if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  }
  if (bytes.length >= 12
    && bytes.subarray(0, 4).toString('latin1') === 'RIFF'
    && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * Strictly decode canonical base64 (no whitespace, no data-URL prefix).
 * @param {unknown} value
 * @returns {Buffer}
 */
export function decodeBase64(value) {
  if (typeof value !== 'string' || value === '') {
    throw new NoteStoreError('bad-input', 'Image data is required.');
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new NoteStoreError('bad-input', 'Image data is not canonical base64.');
  }
  const bytes = Buffer.from(value, 'base64');
  // Re-encoding catches non-canonical trailing bits that Buffer accepts.
  if (bytes.toString('base64') !== value) {
    throw new NoteStoreError('bad-input', 'Image data is not canonical base64.');
  }
  return bytes;
}

/**
 * Build a safe file stem from a display name.
 * @param {unknown} name
 * @returns {string}
 */
function fileStem(name) {
  const raw = typeof name === 'string' ? name : '';
  let stem = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/gu, '-')
    .replace(/^[.\s]+|[.\s]+$/gu, '')
    .replace(/\.(?:png|jpe?g|webp|gif)$/iu, '')
    .slice(0, 80);
  if (stem === '') stem = 'image';
  stem = stem.replace(/-+/gu, '-').replace(/^-|-$/gu, '');
  return stem === '' ? 'image' : stem;
}

/**
 * Keep a human-readable name; fall back to the stored file name.
 * @param {unknown} name
 * @returns {string}
 */
function displayName(name) {
  const raw = typeof name === 'string' ? name : '';
  const cleaned = raw
    .replace(/[\\/\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_IMAGE_NAME_CHARS);
  return cleaned === '' ? 'image' : cleaned;
}

/**
 * Save one pasted image under the plugin directory.
 *
 * @param {string} root workspace root
 * @param {{ name?: unknown, mime?: unknown, data?: unknown }} input
 * @returns {Promise<{path: string, name: string, mime: string, size: number}>}
 */
export async function saveClipboardImage(root, input) {
  const declared = canonicalImageType(input?.mime);
  if (declared === null) {
    throw new NoteStoreError('unsupported-type', 'Only PNG, JPEG, WebP and GIF images are supported.');
  }
  const bytes = decodeBase64(input?.data);
  if (bytes.byteLength === 0) {
    throw new NoteStoreError('bad-input', 'Image data is empty.');
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new NoteStoreError('too-large', `Image is too large (limit ${MAX_IMAGE_BYTES} bytes).`);
  }
  const sniffed = sniffImageType(bytes);
  if (sniffed === null || sniffed !== declared) {
    throw new NoteStoreError('unsupported-type', 'The image bytes do not match the declared type.');
  }
  const extension = IMAGE_TYPES[declared];
  const name = displayName(input?.name);
  const stem = fileStem(name);
  const dir = path.join(root, ...IMAGE_DIR.split('/'));
  await fs.mkdir(dir, { recursive: true });
  const fileName = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}-${stem}.${extension}`;
  const file = path.join(dir, fileName);
  try {
    await fs.writeFile(file, bytes, { flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new NoteStoreError('internal', 'Could not allocate a unique image file name.');
    }
    throw error;
  }
  return {
    path: `${IMAGE_DIR}/${fileName}`,
    name,
    mime: declared,
    size: bytes.byteLength,
  };
}
