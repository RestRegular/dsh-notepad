/**
 * dsh-notepad — Host half.
 *
 * Stores one plain-text note per workspace in `<workspace>/.dsh/notepad.json`
 * and exposes it to the same-origin browser overlay through the loopback route
 * `/dsh-notepad/api/note`. Pasted images are written to the plugin-owned
 * directory `<workspace>/.dsh/notepad/images/` through `/dsh-notepad/api/image`.
 *
 * Security:
 *   - only loopback requests with a same-origin (or absent) Origin are served;
 *   - the resolved root must be a registered workspace or the exact cwd of the
 *     requesting session;
 *   - the file paths themselves are fixed (`.dsh/notepad.json` and the image
 *     directory), so the route cannot be used to read or write arbitrary
 *     workspace files. Image uploads must be a supported raster format whose
 *     bytes match the declared MIME type.
 *
 * @module dsh-notepad
 */

import path from 'node:path';
import {
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  deleteStoredImage,
  saveClipboardImage,
} from './lib/image-store.js';
import {
  DEFAULT_MAX_BYTES,
  NOTE_VERSION,
  NoteStoreError,
  readNote,
  unsentCount,
  writeNote,
} from './lib/note-store.js';

/** Loopback route prefix. */
const ROUTE = '/dsh-notepad/api';

/** Plugin version mirrored in package.json. */
const VERSION = '0.9.4';

/** Request body cap for note writes. */
const BODY_LIMIT = 1024 * 1024;

/** Request body cap for base64 image uploads (decoded cap + base64 overhead). */
const IMAGE_BODY_LIMIT = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64 * 1024;

/** Longest segment accepted by the AI optimizer. */
const MAX_OPTIMIZE_CHARS = 60_000;

/** End-to-end deadline for one AI optimization. */
const OPTIMIZE_TIMEOUT_MS = 120_000;

/** Default output cap for one optimized segment. */
const OPTIMIZE_MAX_TOKENS = 4096;
/** Entries kept in the in-process optimizer cache. */
const OPTIMIZE_CACHE_LIMIT = 64;

/** Maximum key + value characters kept in the optimizer cache. */
const OPTIMIZE_CACHE_CHARS = 2_000_000;

/** Shared instruction for the optional writing assistant. */
const OPTIMIZE_SYSTEM = [
  'You are a writing assistant for a developer notepad.',
  'Rewrite the user\'s note so it is clearer, more concise, and better organized,',
  'while preserving its original language, meaning, technical facts, Markdown,',
  'code, file paths, and image links. Never invent facts or drop information.',
  'Return only the rewritten note text: no preamble, no explanation, and no code fence.',
].join(' ');

/** Longest custom AI instruction accepted from the client. */
const MAX_OPTIMIZE_INSTRUCTION_CHARS = 4000;

/** Always kept at the end of the system prompt, even for a custom preset. */
const OPTIMIZE_OUTPUT_RULE = [
  'Return only the rewritten text: no preamble, no explanation, and no code fence.',
  'Preserve the original language, technical facts, Markdown, code, file paths, and image links.',
  'Never invent facts or drop information.',
].join(' ');

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
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > limit) {
        tooLarge = true;
        chunks.length = 0;
        reject(new NoteStoreError('too-large', 'Request body is too large.'));
        // Drain the rest so the 413 response can still be delivered.
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

/**
 * Count pending segments for every registered workspace. The sidebar badge
 * only needs counts, so this route never returns note text or image paths.
 * The notepad header dropdown also needs to know which workspaces actually
 * hold notepad content (`hasContent`), which never exposes that content.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<Array<{id: string, path: string, title: string, count: number, hasContent: boolean}>>}
 */
async function listUnsentCounts(ctx) {
  const registry = ctx.get('workspaceRegistry');
  const list = registry !== undefined && typeof registry.list === 'function' ? registry.list() : [];
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const workspace of list) {
    const root = typeof workspace?.path === 'string' ? workspace.path : '';
    if (root === '') continue;
    let count = 0;
    // `count` is exactly the number of unarchived, non-empty segments, so a
    // workspace is offered by the header dropdown only when it has at least
    // one pending card. Archived-only or blank notes stay hidden.
    let hasContent = false;
    try {
      const note = await readNote(root);
      count = unsentCount(note);
      hasContent = count > 0;
    } catch {
      // A workspace directory may have disappeared; keep the other badges.
      count = 0;
    }
    out.push({
      id: String(workspace.id ?? workspace.workspaceId ?? ''),
      path: root,
      title: typeof workspace.title === 'string' ? workspace.title : '',
      count,
      hasContent,
    });
  }
  return out;
}

/**
 * Strip a surrounding Markdown code fence the model may add despite the
 * instruction, then trim. Inner code fences survive.
 * @param {string} value
 * @returns {string}
 */
function cleanOptimizedText(value) {
  let text = String(value ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .trim();
  const fenced = /^```[^\n]*\r?\n([\s\S]*?)\r?\n```$/u.exec(text);
  if (fenced !== null) text = fenced[1].trim();
  return text;
}

/**
 * Results of earlier optimizer calls. Re-optimizing content that has not
 * changed returns the previous answer instead of billing another model call.
 * The cache is per host process and bounded by entry count and characters.
 * @type {Map<string, string>}
 */
const optimizeCache = new Map();
let optimizeCacheChars = 0;

/**
 * @param {string} key
 * @param {string} text
 */
function cacheOptimizedText(key, text) {
  const previous = optimizeCache.get(key);
  if (previous !== undefined) {
    optimizeCacheChars -= key.length + previous.length;
    optimizeCache.delete(key);
  }
  optimizeCache.set(key, text);
  optimizeCacheChars += key.length + text.length;
  while (optimizeCache.size > OPTIMIZE_CACHE_LIMIT || optimizeCacheChars > OPTIMIZE_CACHE_CHARS) {
    const oldest = optimizeCache.keys().next();
    if (oldest.done === true) break;
    const value = optimizeCache.get(oldest.value) ?? '';
    optimizeCacheChars -= oldest.value.length + value.length;
    optimizeCache.delete(oldest.value);
  }
}

/** Workspace + title + instruction + text: everything the prompt depends on. */
function optimizeCacheKey(root, title, text, instruction) {
  return `${root}\u0000${title}\u0000${instruction ?? ''}\u0000${text}`;
}

/**
 * Compose the system prompt for one optimization. A client-supplied preset
 * replaces the default wording, but the output contract is always appended so
 * a user-written instruction cannot make the model wrap or explain its answer.
 * @param {string} instruction
 * @returns {string}
 */
function optimizeSystemPrompt(instruction) {
  const custom = typeof instruction === 'string' ? instruction.trim() : '';
  if (custom === '') return OPTIMIZE_SYSTEM;
  return `${custom.slice(0, MAX_OPTIMIZE_INSTRUCTION_CHARS)}\n\n${OPTIMIZE_OUTPUT_RULE}`;
}

/**
 * Ask the currently selected default model to improve one note segment.
 * The LLM service is optional: a deployment without one reports a stable
 * `unavailable` code instead of failing the whole notepad.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} text
 * @param {string} title
 * @param {string} instruction
 * @returns {Promise<string>}
 */
async function optimizeText(ctx, text, title, instruction) {
  const llm = ctx.get('llm');
  if (llm === undefined || llm === null || typeof llm.prepareCall !== 'function'
    || typeof llm.resolveCallConfig !== 'function') {
    throw new NoteStoreError('unavailable', 'The AI model service is not available.');
  }
  const defaultModel = ctx.get('agentDefaultModel');
  if (defaultModel === undefined || defaultModel === null || typeof defaultModel.currentSelection !== 'function') {
    throw new NoteStoreError('unavailable', 'No default model is configured.');
  }
  let selection;
  try {
    selection = defaultModel.currentSelection();
  } catch (error) {
    throw new NoteStoreError('unavailable', `No default model is configured: ${error?.message ?? error}`);
  }
  if (selection === undefined || selection === null
    || typeof selection.provider !== 'string' || selection.provider === ''
    || typeof selection.model !== 'string' || selection.model === '') {
    throw new NoteStoreError('unavailable', 'No default model is configured.');
  }
  const signal = AbortSignal.timeout(OPTIMIZE_TIMEOUT_MS);
  // Reasoning models can spend a small output budget before emitting any text,
  // so keep a healthy floor. The old 1024-token minimum could yield an empty
  // answer ("the model returned no text") even though the call succeeded.
  const maxTokens = Math.min(8192, Math.max(OPTIMIZE_MAX_TOKENS, Math.ceil(text.length / 2)));
  let base;
  try {
    base = await llm.resolveCallConfig({
      provider: selection.provider,
      model: selection.model,
      maxTokens,
    });
  } catch (error) {
    throw new NoteStoreError('llm-failed', `Could not prepare the model call: ${error?.message ?? error}`);
  }
  if (typeof base !== 'object' || base === null) {
    throw new NoteStoreError('llm-failed', 'The model call configuration is empty.');
  }
  const heading = title.trim() === '' ? '' : `Card title: ${title.trim()}\n\n`;
  const prompt = `${heading}Rewrite this note:\n\n${text}`;
  const system = optimizeSystemPrompt(instruction);

  /**
   * Run one streaming model call and return the raw text output.
   * @param {string} systemPrompt
   * @returns {Promise<string>}
   */
  const run = async (systemPrompt) => {
    let output = '';
    try {
      const prepared = await llm.prepareCall(base, signal);
      for await (const chunk of prepared.stream({
        ...base,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: prompt }],
        }],
        signal,
      })) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text;
        else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
          const failure = chunk.reason.failure;
          throw new NoteStoreError('llm-failed', `The model call failed: ${failure?.message ?? 'unknown error'}`);
        } else if (chunk?.type === 'finish' && chunk.reason?.kind === 'aborted') {
          throw new NoteStoreError('timeout', 'The model did not answer in time.');
        }
      }
    } catch (error) {
      if (error instanceof NoteStoreError) throw error;
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw new NoteStoreError('timeout', 'The model did not answer in time.');
      }
      throw new NoteStoreError('llm-failed', `The model call failed: ${error?.message ?? error}`);
    }
    return output;
  };

  let cleaned = cleanOptimizedText(await run(system));
  if (cleaned === '' && system !== OPTIMIZE_SYSTEM) {
    // A malformed custom preset should not cost the user the optimization;
    // retry once with the built-in instruction.
    cleaned = cleanOptimizedText(await run(OPTIMIZE_SYSTEM));
  }
  if (cleaned === '') {
    throw new NoteStoreError('llm-failed', 'The model returned no text.');
  }
  return cleaned;
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
      let status = 400;
      if (error.code === 'unknown-workspace' || error.code === 'bad-root' || error.code === 'not-owned') status = 403;
      else if (error.code === 'too-large') status = 413;
      else if (error.code === 'unsupported-type') status = 415;
      else if (error.code === 'unavailable') status = 503;
      else if (error.code === 'timeout') status = 504;
      else if (error.code === 'llm-failed') status = 502;
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
    sendJson(res, {
      ok: true,
      plugin: 'dsh-notepad',
      version: VERSION,
      noteVersion: NOTE_VERSION,
      imageTypes: Object.keys(IMAGE_TYPES),
      maxImageBytes: MAX_IMAGE_BYTES,
    });
    return;
  }
  if (action === 'image') {
    if (req.method === 'POST') {
      const body = await readJsonBody(req, IMAGE_BODY_LIMIT);
      const root = await resolveRequestRoot(ctx, body);
      const image = await saveClipboardImage(root, {
        name: body.name,
        mime: body.mime,
        data: body.data,
      });
      sendJson(res, { ok: true, root, ...image });
      return;
    }
    if (req.method === 'DELETE') {
      const body = await readJsonBody(req);
      const root = await resolveRequestRoot(ctx, body);
      const result = await deleteStoredImage(root, body.path);
      sendJson(res, { ok: true, root, ...result });
      return;
    }
    sendJson(res, { ok: false, code: 'method', error: 'Use POST or DELETE.' }, 405);
    return;
  }
  if (action === 'unsent') {
    if (req.method !== 'GET') {
      sendJson(res, { ok: false, code: 'method', error: 'Use GET.' }, 405);
      return;
    }
    const workspaces = await listUnsentCounts(ctx);
    sendJson(res, { ok: true, workspaces });
    return;
  }
  if (action === 'optimize') {
    if (req.method !== 'POST') {
      sendJson(res, { ok: false, code: 'method', error: 'Use POST.' }, 405);
      return;
    }
    const body = await readJsonBody(req);
    const root = await resolveRequestRoot(ctx, body);
    const text = typeof body.text === 'string' ? body.text : '';
    if (text.trim() === '') {
      throw new NoteStoreError('bad-input', 'There is no text to optimize.');
    }
    if (text.length > MAX_OPTIMIZE_CHARS) {
      throw new NoteStoreError(
        'too-large',
        `Segment is too large to optimize (${text.length} characters; limit ${MAX_OPTIMIZE_CHARS}).`,
      );
    }
    const title = typeof body.title === 'string' ? body.title : '';
    const instruction = typeof body.system === 'string'
      ? body.system.slice(0, MAX_OPTIMIZE_INSTRUCTION_CHARS + 1)
      : '';
    if (instruction.length > MAX_OPTIMIZE_INSTRUCTION_CHARS) {
      throw new NoteStoreError(
        'too-large',
        `AI instruction is too long (limit ${MAX_OPTIMIZE_INSTRUCTION_CHARS} characters).`,
      );
    }
    const cacheKey = optimizeCacheKey(root, title, text, instruction);
    const cached = optimizeCache.get(cacheKey);
    if (typeof cached === 'string' && cached !== '') {
      sendJson(res, { ok: true, root, text: cached, cached: true });
      return;
    }
    const optimized = await optimizeText(ctx, text, title, instruction);
    cacheOptimizedText(cacheKey, optimized);
    sendJson(res, { ok: true, root, text: optimized, cached: false });
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
