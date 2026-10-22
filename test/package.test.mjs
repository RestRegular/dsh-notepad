/**
 * dsh-notepad — package manifest checks.
 *
 * Guards the parts a runtime test cannot see: every exported entry point
 * exists, the bundle patch names the package byte-for-byte, and the display
 * resources (locale metadata + icon) satisfy the plugin manifest rules.
 *
 * Run: node test/package.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Identity and runtime entries ----------------------------------------------
assert.match(manifest.name, /^@[a-z0-9-]+\/[a-z0-9-]+$/u);
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
assert.equal(manifest.type, 'module');
assert.equal(manifest.private, undefined, 'a published package must not be private');

for (const key of ['.', './client', './cordis.patch.yml', './package.json']) {
  const target = manifest.exports?.[key];
  assert.equal(typeof target, 'string', `exports["${key}"] is missing`);
  assert.ok(existsSync(path.join(ROOT, target)), `exports["${key}"] -> ${target} does not exist`);
}

// The bundle patch must insert the package by its exact manifest name --------
const patch = readFileSync(path.join(ROOT, manifest.dsh.bundle.patch), 'utf8');
assert.ok(
  patch.includes(`name: '${manifest.name}'`) || patch.includes(`name: "${manifest.name}"`),
  'cordis.patch.yml must insert the package by its exact name',
);

// Shipped client module is a classic script wrapped in an IIFE --------------
const client = readFileSync(path.join(ROOT, manifest.exports['./client']), 'utf8');
assert.match(client, /^\s*\(\(\) => \{/mu, 'client.js must open with an IIFE so top-level names stay private');
assert.match(client, /\}\)\(\);\s*$/u, 'client.js must close its IIFE');

// Display metadata ----------------------------------------------------------
for (const locale of ['en', 'zh']) {
  const file = path.join(ROOT, 'locale', `${locale}.json`);
  assert.ok(existsSync(file), `locale/${locale}.json is missing`);
  const meta = JSON.parse(readFileSync(file, 'utf8')).meta;
  assert.equal(typeof meta?.title, 'string');
  assert.ok(meta.title.trim() !== '', `locale/${locale}.json meta.title is empty`);
  assert.equal(typeof meta?.description, 'string');
  assert.ok(meta.description.trim() !== '', `locale/${locale}.json meta.description is empty`);
  assert.ok(
    manifest.exports['./locale/*.json'] === './locale/*.json',
    'locale files must be exported for Plugin Manager metadata',
  );
  assert.ok(
    manifest.files.some((entry) => entry.startsWith('locale/')),
    'locale files must be listed in "files" for publishing',
  );
}

const icon = path.join(ROOT, manifest.icon);
assert.ok(existsSync(icon), 'icon.svg is missing');
assert.ok(statSync(icon).size <= 256 * 1024, 'icon must be at most 256 KiB');
const svg = readFileSync(icon, 'utf8');
assert.match(svg, /^<svg[\s>]/u, 'icon must be an SVG document');
assert.match(svg, /viewBox="0 0 \d+ \d+"/u);

// Every runtime file is actually published ---------------------------------
for (const entry of ['index.js', 'client.js', 'lib/note-store.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE']) {
  assert.ok(existsSync(path.join(ROOT, entry)), `${entry} is missing`);
}
assert.ok(manifest.files.includes('lib/'), 'the lib/ directory must be published');
assert.ok(manifest.files.includes('icon.svg'), 'the icon must be published');

console.log('ok — dsh-notepad package manifest checks passed');
