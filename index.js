/**
 * dsh-notepad — Host half.
 *
 * Stores one plain-text note per workspace in `<workspace>/.dsh/notepad.json`
 * and exposes it to the same-origin browser overlay through the loopback route
 * `/dsh-notepad/api/note`.
 *
 * Security:
 *   - only loopback requests with a same-origin (or absent) Origin are served;
 *   - the resolved root must be a registered workspace or the exact cwd of the
 *     requesting session;
 *   - the file path itself is fixed (`.dsh/notepad.json`), so the route cannot
 *     be used to read or write arbitrary workspace files.
 *
 * @module dsh-notepad
 */

import path from 'node:path';
import {
  DEFAULT_MAX_BYTES,
  NOTE_VERSION,
  NoteStoreError,
  readNote,
  writeNote,
} from './lib/note-store.js';

/** Loopback route prefix. */
const ROUTE = '/dsh-notepad/api';

/** Plugin version mirrored in package.json. */
const VERSION = '0.2.0';

/** Request body cap. */
const BODY_LIMIT = 1024 * 1024;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** @param {import('node:http').ServerResponse} res */
function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * Read and parse a JSON object body.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 */
function readJsonBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new NoteStoreError('too-large', 'Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const value = text === '' ? {} : JSON.parse(text);
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
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

/** Only the same machine may drive the route. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? '';
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address.startsWith('::ffff:127.') ||
    address === ''
  );
}

/** Reject cross-origin form posts; the page is served from the same origin. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Workspace validation
// ---------------------------------------------------------------------------

/** Case-insensitive path equality (Windows) with lexical normalization. */
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const norm = (value) => {
    let out = value.replace(/[\\/]+/gu, '/').replace(/\/+$/u, '');
    if (process.platform === 'win32') out = out.toLowerCase();
    return out;
  };
  return norm(a) === norm(b);
}

/**
 * Resolve the workspace root a request is allowed to touch.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} args
 * @returns {Promise<string>}
 */
async function resolveRequestRoot(ctx, args) {
  const requested = typeof args.root === 'string' ? args.root : '';
  if (requested === '') {
    throw new NoteStoreError('bad-root', 'root is required.');
  }
  const root = path.resolve(requested);
  if (await isKnownRoot(ctx, root, typeof args.sessionId === 'string' ? args.sessionId : '')) {
    return root;
  }
  throw new NoteStoreError('unknown-workspace', 'This directory is not a registered workspace.');
}

/**
 * A root is allowed when it is a registered workspace or the exact working
 * directory of the requesting session.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} root
 * @param {string} sessionId
 */
async function isKnownRoot(ctx, root, sessionId) {
  const registry = ctx.get('workspaceRegistry');
  if (registry !== undefined && typeof registry.list === 'function') {
    const known = registry.list();
    if (Array.isArray(known) && known.some((workspace) => samePath(workspace?.path, root))) return true;
  }
  if (sessionId !== '') {
    const agent = ctx.get('agents')?.get?.(sessionId);
    const cwd = agent?.session?.header?.cwd;
    if (samePath(cwd, root)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

/**
 * Handle one API request. Exported for route tests.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export async function handleRequest(ctx, req, res) {
  try {
    await dispatchRequest(ctx, req, res);
  } catch (error) {
    if (error instanceof NoteStoreError) {
      const status = error.code === 'unknown-workspace' || error.code === 'bad-root' ? 403 : 400;
      sendJson(res, { ok: false, code: error.code, error: error.message }, status);
      return;
    }
    ctx.logger?.warn?.(`dsh-notepad: ${error?.stack ?? error}`);
    sendJson(res, { ok: false, code: 'internal', error: String(error?.message ?? error) }, 500);
  }
}

/**
 * Dispatch one already-authenticated API request.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function dispatchRequest(ctx, req, res) {
  if (!isLoopback(req) || !sameOrigin(req)) {
    sendJson(res, { ok: false, code: 'forbidden', error: 'Forbidden.' }, 403);
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith(ROUTE)) {
    sendJson(res, { ok: false, code: 'not-found', error: 'Not found.' }, 404);
    return;
  }
  const action = url.pathname.slice(ROUTE.length).replace(/^\/+|\/+$/gu, '');
  if (action === 'ping') {
    sendJson(res, { ok: true, plugin: 'dsh-notepad', version: VERSION, noteVersion: NOTE_VERSION });
    return;
  }
  if (action !== 'note') {
    sendJson(res, { ok: false, code: 'not-found', error: `Unknown endpoint "${action}".` }, 404);
    return;
  }
  if (req.method === 'GET') {
    const root = await resolveRequestRoot(ctx, {
      root: url.searchParams.get('root') ?? '',
      sessionId: url.searchParams.get('sessionId') ?? '',
    });
    const note = await readNote(root);
    sendJson(res, { ok: true, root, ...note });
    return;
  }
  if (req.method === 'PUT') {
    const body = await readJsonBody(req);
    const root = await resolveRequestRoot(ctx, body);
    const note = await writeNote(root, Array.isArray(body.segments) ? body.segments : body.text, {
      maxBytes: DEFAULT_MAX_BYTES,
    });
    sendJson(res, { ok: true, root, ...note });
    return;
  }
  sendJson(res, { ok: false, code: 'method', error: 'Use GET or PUT.' }, 405);
}

/**
 * Mount the loopback route.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function mountRoutes(ctx) {
  const webServer = ctx.webServer ?? ctx.get('webServer');
  if (webServer === undefined) return;
  ctx.effect(
    () =>
      webServer.register({
        kind: 'prefix',
        path: ROUTE,
        async handler(req, res) {
          try {
            await handleRequest(ctx, req, res);
          } catch (error) {
            ctx.logger?.warn?.(`dsh-notepad: ${error?.stack ?? error}`);
          }
        },
      }),
    'dsh-notepad: loopback note route',
  );
}

// ---------------------------------------------------------------------------
// Plugin body
// ---------------------------------------------------------------------------

/** Loader identity of the Host half. */
export const name = 'dsh-notepad';

/**
 * Mount the note route. Without `webServer` the overlay degrades to an
 * in-memory note for the lifetime of the page.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (scoped) => mountRoutes(scoped));
}
