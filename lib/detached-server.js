/**
 * dsh-notepad — detached-window Host server.
 *
 * The DSH Web UI is served behind an authentication cookie that only the
 * Desktop WebContents (or the browser tab opened from the printed `dsh web`
 * URL) owns. A notepad window that has to survive the DSH interface being
 * minimized or closed therefore cannot reuse `/dsh-notepad/api`: opening that
 * URL in an external browser would be rejected with 401.
 *
 * This module starts a small, plugin-owned HTTP server bound to loopback. Its
 * URL carries a random bearer token, it serves the standalone notepad page,
 * and it reads/writes the same workspace note file through `note-store`. The
 * token is only minted after a same-origin DSH client asks for a detached
 * window and proves it may read that workspace, so a browser that merely sees
 * the token cannot enumerate other workspaces.
 *
 * @module dsh-notepad/lib/detached-server
 */

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_MAX_BYTES,
  NOTE_DIR,
  NoteStoreError,
  readNote,
  writeNote,
} from './note-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE_FILE = path.join(HERE, 'detached.html');
const CSS_FILE = path.join(HERE, 'detached.css');
const SCRIPT_FILE = path.join(HERE, 'detached.js');
const ICON_FILE = path.join(HERE, '..', 'icon.svg');

/** Request body cap for note writes. */
const BODY_LIMIT = 1024 * 1024;

/** A window that has not sent a heartbeat for this long is considered gone. */
const ACTIVE_MS = 90_000;

/** Image files the detached page may render. */
const IMAGE_MIME = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
});

/** Longest AI instruction accepted from a DSH client. */
const MAX_AI_INSTRUCTION = 4000;

/** One live detached server per Host process. */
let current = null;

function samePath(a, b) {
  const norm = (value) => {
    let out = String(value ?? '').replace(/[\\/]+/gu, '/').replace(/\/+$/u, '');
    if (process.platform === 'win32') out = out.toLowerCase();
    return out;
  };
  return norm(a) === norm(b);
}

function rootKey(value) {
  const resolved = path.resolve(String(value ?? ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** Keep the detached page's presentation config small and predictable. */
function sanitizeConfig(raw) {
  const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    lang: value.lang === 'en' ? 'en' : 'zh',
    theme: ['host', 'ocean', 'violet', 'emerald', 'amber', 'rose'].includes(value.theme)
      ? value.theme
      : 'host',
    uiStyle: value.uiStyle === 'flat' ? 'flat' : 'glass',
    blur: clampInt(value.blur, 0, 40, 10),
    font: ['system', 'sans', 'serif', 'mono'].includes(value.font) ? value.font : 'system',
    fontSize: clampInt(value.fontSize, 11, 20, 13),
    maxSegmentHeight: clampInt(value.maxSegmentHeight, 80, 800, 240),
    saveMode: value.saveMode === 'manual' ? 'manual' : 'auto',
    buttonGroups: value.buttonGroups !== false,
    ai: typeof value.ai === 'string' ? value.ai.slice(0, MAX_AI_INSTRUCTION) : '',
  };
}

/** Pick a registered workspace title, falling back to the folder name. */
function workspaceTitle(ctx, root) {
  try {
    const registry = ctx.get('workspaceRegistry');
    const list = registry !== undefined && typeof registry.list === 'function' ? registry.list() : [];
    if (Array.isArray(list)) {
      const row = list.find((item) => item !== null && typeof item === 'object' && samePath(item.path, root));
      if (row !== undefined && typeof row.title === 'string' && row.title.trim() !== '') return row.title;
    }
  } catch {
    /* A missing registry only costs a nicer title. */
  }
  const parts = String(root ?? '').split(/[\\/]+/u).filter(Boolean);
  return parts.length === 0 ? String(root ?? '') : parts[parts.length - 1];
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > limit) {
        tooLarge = true;
        chunks.length = 0;
        reject(new NoteStoreError('too-large', 'Request body is too large.'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const value = text === '' ? {} : JSON.parse(text);
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('not an object');
        }
        resolve(value);
      } catch {
        reject(new NoteStoreError('bad-input', 'Request body is not a JSON object.'));
      }
    });
    req.on('error', reject);
  });
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.') || address === '';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function mimeFor(file) {
  const extension = path.extname(file).slice(1).toLowerCase();
  return IMAGE_MIME[extension] ?? '';
}

/** The token is compared without leaking the first differing byte. */
function tokenMatches(server, candidate) {
  if (typeof candidate !== 'string' || candidate.length !== server.token.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(server.token));
}

/** Resolve a root only when DSH registered it on this server. */
function recordFor(server, root) {
  if (typeof root !== 'string' || root.trim() === '') return null;
  return server.roots.get(rootKey(root)) ?? null;
}

function readToken(req, url) {
  const query = url.searchParams.get('token') ?? '';
  if (query !== '') return query;
  const header = req.headers['x-dsh-notepad-token'];
  return typeof header === 'string' ? header : '';
}

function originAllowed(server, req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  try {
    return new URL(origin).host === `127.0.0.1:${server.port}`;
  } catch {
    return false;
  }
}

function errorStatus(error) {
  if (!(error instanceof NoteStoreError)) return 500;
  if (error.code === 'unknown-workspace' || error.code === 'bad-root' || error.code === 'not-owned') return 403;
  if (error.code === 'too-large') return 413;
  if (error.code === 'unsupported-type') return 415;
  if (error.code === 'unavailable') return 503;
  if (error.code === 'timeout') return 504;
  if (error.code === 'llm-failed') return 502;
  return 400;
}

function errorPayload(error) {
  return {
    ok: false,
    code: error instanceof NoteStoreError ? error.code : 'internal',
    error: String(error?.message ?? error),
  };
}

async function servePage(server, res, record) {
  let html = await fs.readFile(PAGE_FILE, 'utf8');
  html = html
    .replaceAll('__NP_TOKEN__', escapeHtml(server.token))
    .replaceAll('__NP_ROOT__', escapeHtml(record.root));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': [
      "default-src 'none'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  });
  res.end(html);
}

async function serveStatic(res, file, type) {
  const data = await fs.readFile(file);
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

async function serveImage(res, record, rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    sendJson(res, 400, { ok: false, code: 'bad-input', error: 'path is required.' });
    return;
  }
  const imagesDir = path.resolve(record.root, NOTE_DIR, 'notepad', 'images');
  const target = path.resolve(record.root, rawPath.replace(/\\/gu, '/'));
  if (!samePath(target, imagesDir) && !samePath(path.dirname(target), imagesDir)) {
    // Only direct children of this workspace's image directory are public.
    sendJson(res, 403, { ok: false, code: 'not-owned', error: 'Image is outside the notepad image directory.' });
    return;
  }
  if (mimeFor(target) === '') {
    sendJson(res, 415, { ok: false, code: 'unsupported-type', error: 'Unsupported image type.' });
    return;
  }
  let real;
  let realDir;
  try {
    [real, realDir] = await Promise.all([fs.realpath(target), fs.realpath(imagesDir)]);
  } catch {
    sendJson(res, 404, { ok: false, code: 'not-found', error: 'Image not found.' });
    return;
  }
  if (!samePath(path.dirname(real), realDir)) {
    sendJson(res, 403, { ok: false, code: 'not-owned', error: 'Image is outside the notepad image directory.' });
    return;
  }
  const data = await fs.readFile(real);
  res.writeHead(200, {
    'Content-Type': mimeFor(real),
    'Content-Length': String(data.length),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

async function handle(server, req, res) {
  if (!isLoopback(req)) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'Loopback only.' });
    return;
  }
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${server.port}`);
  if (!tokenMatches(server, readToken(req, url))) {
    sendText(res, 403, 'dsh-notepad: invalid or missing token.\n');
    return;
  }
  if (!originAllowed(server, req)) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'Cross-origin request refused.' });
    return;
  }

  const pathname = url.pathname;

  if (pathname === '/window') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Use GET.\n');
      return;
    }
    const record = recordFor(server, url.searchParams.get('root') ?? '');
    if (record === null) {
      sendText(res, 403, 'dsh-notepad: this window is not attached to a workspace.\n');
      return;
    }
    record.lastSeen = Date.now();
    record.retired = false;
    await servePage(server, res, record);
    return;
  }

  if (pathname === '/detached.css') {
    await serveStatic(res, CSS_FILE, 'text/css; charset=utf-8');
    return;
  }
  if (pathname === '/detached.js') {
    await serveStatic(res, SCRIPT_FILE, 'text/javascript; charset=utf-8');
    return;
  }
  if (pathname === '/detached-icon.svg') {
    await serveStatic(res, ICON_FILE, 'image/svg+xml');
    return;
  }

  if (pathname === '/api/ping') {
    sendJson(res, 200, { ok: true, plugin: 'dsh-notepad', detached: true });
    return;
  }

  if (pathname === '/api/state') {
    const record = recordFor(server, url.searchParams.get('root') ?? '');
    if (record === null) {
      sendJson(res, 403, { ok: false, code: 'unknown-workspace', error: 'Unknown detached workspace.' });
      return;
    }
    if (req.method === 'GET') {
      record.lastSeen = Date.now();
      const note = await readNote(record.root);
      sendJson(res, 200, {
        ok: true,
        root: record.root,
        title: workspaceTitle(server.ctx, record.root),
        ...note,
      });
      return;
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (!Array.isArray(body.segments)) {
        throw new NoteStoreError('bad-input', 'segments is required.');
      }
      const note = await writeNote(record.root, body.segments, {
        maxBytes: DEFAULT_MAX_BYTES,
      });
      record.lastSeen = Date.now();
      sendJson(res, 200, {
        ok: true,
        root: record.root,
        title: workspaceTitle(server.ctx, record.root),
        ...note,
      });
      return;
    }
    sendJson(res, 405, { ok: false, code: 'method', error: 'Use GET or PUT.' });
    return;
  }

  if (pathname === '/api/config') {
    const record = recordFor(server, url.searchParams.get('root') ?? '');
    if (record === null) {
      sendJson(res, 403, { ok: false, code: 'unknown-workspace', error: 'Unknown detached workspace.' });
      return;
    }
    sendJson(res, 200, { ok: true, ...record.config });
    return;
  }

  if (pathname === '/api/image') {
    const record = recordFor(server, url.searchParams.get('root') ?? '');
    if (record === null) {
      sendJson(res, 403, { ok: false, code: 'unknown-workspace', error: 'Unknown detached workspace.' });
      return;
    }
    await serveImage(res, record, url.searchParams.get('path') ?? '');
    return;
  }

  if (pathname === '/api/heartbeat') {
    const body = await readBody(req);
    const record = recordFor(server, body.root);
    if (record === null) {
      sendJson(res, 403, { ok: false, code: 'unknown-workspace', error: 'Unknown detached workspace.' });
      return;
    }
    record.lastSeen = Date.now();
    sendJson(res, 200, { ok: true, retired: record.retired === true });
    return;
  }

  if (pathname === '/api/bye') {
    let root = url.searchParams.get('root') ?? '';
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        if (typeof body.root === 'string') root = body.root;
      } catch {
        /* A beacon may arrive without a readable body; the query still works. */
      }
    }
    const record = recordFor(server, root);
    if (record !== null) {
      record.retired = true;
      record.lastSeen = 0;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/retire') {
    const body = await readBody(req);
    const record = recordFor(server, body.root);
    if (record === null) {
      sendJson(res, 403, { ok: false, code: 'unknown-workspace', error: 'Unknown detached workspace.' });
      return;
    }
    record.retired = true;
    record.lastSeen = 0;
    sendJson(res, 200, { ok: true, retired: true });
    return;
  }

  if (pathname === '/api/optimize') {
    const body = await readBody(req);
    const record = recordFor(server, body.root);
    if (record === null) {
      sendJson(res, 403, { ok: false, code: 'unknown-workspace', error: 'Unknown detached workspace.' });
      return;
    }
    if (typeof record.optimize !== 'function') {
      sendJson(res, 503, { ok: false, code: 'unavailable', error: 'The AI model service is not available.' });
      return;
    }
    const text = typeof body.text === 'string' ? body.text : '';
    if (text.trim() === '') {
      sendJson(res, 400, { ok: false, code: 'bad-input', error: 'There is no text to optimize.' });
      return;
    }
    const title = typeof body.title === 'string' ? body.title : '';
    const value = await record.optimize(text, title, record.config.ai);
    sendJson(res, 200, { ok: true, text: value });
    return;
  }

  if (pathname === '/api/title') {
    const record = recordFor(server, url.searchParams.get('root') ?? '');
    if (record === null) {
      sendJson(res, 403, { ok: false, code: 'unknown-workspace', error: 'Unknown detached workspace.' });
      return;
    }
    sendJson(res, 200, { ok: true, title: workspaceTitle(server.ctx, record.root) });
    return;
  }

  sendJson(res, 404, { ok: false, code: 'not-found', error: 'Not found.' });
}

/**
 * Start the detached server if it is not running.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<string>} base window URL including the token
 */
export async function ensureDetachedServer(ctx) {
  if (current !== null) {
    if (current.starting !== null) return current.starting;
    return current.baseUrl;
  }
  const token = randomBytes(24).toString('hex');
  const server = {
    ctx,
    token,
    port: 0,
    baseUrl: '',
    roots: new Map(),
    server: null,
    starting: null,
  };
  server.server = createServer((req, res) => {
    handle(server, req, res).catch((error) => {
      if (res.headersSent === true) {
        try {
          res.end();
        } catch {
          /* The peer may already be gone. */
        }
        return;
      }
      sendJson(res, errorStatus(error), errorPayload(error));
    });
  });
  current = server;
  server.starting = new Promise((resolve, reject) => {
    const onError = (error) => {
      server.starting = null;
      if (current === server) current = null;
      try {
        server.server.close();
      } catch {
        /* ignore */
      }
      reject(error);
    };
    server.server.once('error', onError);
    server.server.listen(0, '127.0.0.1', () => {
      server.server.off('error', onError);
      const address = server.server.address();
      if (address === null || typeof address === 'string') {
        onError(new Error('dsh-notepad: detached server did not bind a port.'));
        return;
      }
      server.port = address.port;
      server.baseUrl = `http://127.0.0.1:${server.port}/window?token=${server.token}`;
      server.starting = null;
      server.server.on('error', (error) => {
        ctx.logger?.warn?.(`dsh-notepad: detached server error: ${error?.message ?? error}`);
      });
      try {
        server.server.unref();
      } catch {
        /* unref is only an orderly-shutdown nicety. */
      }
      resolve(server.baseUrl);
    });
  });
  return server.starting;
}

/**
 * Register one workspace the detached page may open. The token is returned by
 * this function only after the caller validated the root against DSH auth.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} root
 * @param {{config?: Record<string, unknown>, optimize?: (text: string, title: string, instruction: string) => Promise<string>}} options
 * @returns {Promise<{url: string, token: string}>}
 */
export async function registerDetachedRoot(ctx, root, options = {}) {
  const baseUrl = await ensureDetachedServer(ctx);
  const server = current;
  if (server === null) throw new Error('dsh-notepad: detached server is unavailable.');
  const key = rootKey(root);
  let record = server.roots.get(key);
  if (record === undefined) {
    record = { root: path.resolve(root), key, lastSeen: 0, retired: false, config: sanitizeConfig(undefined), optimize: null };
    server.roots.set(key, record);
  }
  record.root = path.resolve(root);
  record.config = sanitizeConfig(options.config);
  if (typeof options.optimize === 'function') record.optimize = options.optimize;
  return {
    url: `${baseUrl}&root=${encodeURIComponent(record.root)}`,
    token: server.token,
  };
}

/**
 * Whether a detached window is connected for this root.
 * @param {string} root
 * @returns {{active: boolean, seen: boolean, retired: boolean, url: string}}
 */
export function detachedStatus(root) {
  const server = current;
  if (server === null) return { active: false, seen: false, retired: false, url: '' };
  const record = server.roots.get(rootKey(root));
  if (record === undefined) return { active: false, seen: false, retired: false, url: server.baseUrl };
  const seen = record.lastSeen > 0;
  const active = record.retired !== true && seen && Date.now() - record.lastSeen < ACTIVE_MS;
  return {
    active,
    seen,
    retired: record.retired === true,
    url: `${server.baseUrl}&root=${encodeURIComponent(record.root)}`,
  };
}

/**
 * Mark a detached window retired, so the DSH panel can come back immediately.
 * @param {string} root
 * @returns {boolean}
 */
export function retireDetachedRoot(root) {
  const server = current;
  if (server === null) return false;
  const record = server.roots.get(rootKey(root));
  if (record === undefined) return false;
  record.retired = true;
  record.lastSeen = 0;
  return true;
}

/** Stop the server and forget every token/root (plugin unload). */
export function shutdownDetachedServer() {
  const server = current;
  current = null;
  if (server === null) return;
  try {
    server.server?.close();
  } catch {
    /* ignore */
  }
}

/** Exported for tests: the current token, without exposing it through HTTP. */
export function currentDetachedToken() {
  return current?.token ?? '';
}

/** Exported for tests: whether the server is listening. */
export function currentDetachedPort() {
  return current?.port ?? 0;
}
