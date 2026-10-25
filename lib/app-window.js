/**
 * dsh-notepad — native-looking app window launcher.
 *
 * DSH's Electron main process denies `window.open` and hands http(s) URLs to
 * the system browser; plugins cannot create a `BrowserWindow` from the Web
 * renderer. The closest plugin-only form of a dedicated window is a Chromium
 * "app mode" window: Edge / Chrome runs the standalone page without tabs or an
 * address bar, with its own taskbar window that minimizes independently.
 *
 * The launcher is executed by the Host, so a click in the DSH page never has
 * to survive a popup blocker. When no Chromium browser is found the caller can
 * fall back to the normal browser window.
 *
 * @module dsh-notepad/lib/app-window
 */

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detachedStatus, registerDetachedRoot } from './detached-server.js';

/** Chromium's app-mode profile is shared by every detached notepad window. */
export const APP_PROFILE_DIR = path.join(os.tmpdir(), 'dsh-notepad-app-profile');

/**
 * Locate a Chromium browser that supports `--app=`.
 * @param {{platform?: string, env?: Record<string, string | undefined>, exists?: (file: string) => boolean}} [options]
 * @returns {string} executable path or ''
 */
export function findBrowserExecutable(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? fs.existsSync;
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const candidates = [];

  if (platform === 'win32') {
    const roots = [
      env.LOCALAPPDATA,
      env.ProgramFiles,
      env['ProgramFiles(x86)'],
      env.ProgramW6432,
    ].filter((value) => typeof value === 'string' && value !== '');
    for (const root of roots) {
      candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    for (const root of roots) {
      candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      path.join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      path.join(home, 'Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    const names = [
      'google-chrome',
      'google-chrome-stable',
      'chromium',
      'chromium-browser',
      'microsoft-edge',
      'microsoft-edge-stable',
    ];
    const directories = String(env.PATH ?? '').split(path.delimiter).filter(Boolean);
    for (const directory of directories) {
      for (const name of names) candidates.push(path.join(directory, name));
    }
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
    );
  }

  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      /* A permission error on one candidate should not hide the next one. */
    }
  }
  return '';
}

/**
 * Arguments for one app-mode window. The profile is dedicated so Chrome does
 * not restore unrelated tabs or attach the notepad to the user's main session.
 * @param {{url: string, width?: number, height?: number, profileDir?: string, platform?: string}} options
 * @returns {string[]}
 */
export function buildAppWindowArgs(options) {
  const width = Math.min(1200, Math.max(360, Math.round(Number(options.width) || 560)));
  const height = Math.min(1200, Math.max(320, Math.round(Number(options.height) || 760)));
  const profileDir = options.profileDir ?? APP_PROFILE_DIR;
  const args = [
    `--app=${options.url}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if ((options.platform ?? process.platform) === 'linux') {
    args.push('--class=dsh-notepad');
  }
  return args;
}

/**
 * Open the detached page as a Chromium app window.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} root
 * @param {{
 *   config?: Record<string, unknown>,
 *   optimize?: (text: string, title: string, instruction: string) => Promise<string>,
 *   width?: number,
 *   height?: number,
 *   spawn?: typeof nodeSpawn,
 *   platform?: string,
 *   env?: Record<string, string | undefined>,
 *   exists?: (file: string) => boolean,
 *   profileDir?: string,
 * }} [options]
 * @returns {Promise<{ok: boolean, opened?: 'app' | 'existing', url?: string, mode?: string, code?: string, error?: string}>}
 */
export async function openDetachedAppWindow(ctx, root, options = {}) {
  const registered = await registerDetachedRoot(ctx, root, {
    config: options.config,
    optimize: options.optimize,
  });
  if (detachedStatus(root).active === true) {
    return { ok: true, opened: 'existing', url: registered.url, mode: 'app' };
  }

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? fs.existsSync;
  const executable = findBrowserExecutable({ platform, env, exists });
  if (executable === '') {
    return {
      ok: false,
      code: 'no-browser',
      error: 'No Chromium browser with app-window support was found.',
      url: registered.url,
    };
  }

  const args = buildAppWindowArgs({
    url: registered.url,
    width: options.width,
    height: options.height,
    profileDir: options.profileDir,
    platform,
  });
  const spawn = options.spawn ?? nodeSpawn;

  let child;
  try {
    child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
  } catch (error) {
    return {
      ok: false,
      code: 'spawn-failed',
      error: String(error?.message ?? error),
      url: registered.url,
    };
  }

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.unref?.();
      } catch {
        /* The detached process owns its own lifetime. */
      }
      finish({ ok: true, opened: 'app', url: registered.url, mode: 'app' });
    }, 350);
    child.once?.('error', (error) => {
      finish({
        ok: false,
        code: error?.code === 'ENOENT' ? 'no-browser' : 'spawn-failed',
        error: String(error?.message ?? error),
        url: registered.url,
      });
    });
  });
}
