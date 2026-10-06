// Every file the browser loads must parse as an ES module (from we go gim: a stray apostrophe once stopped the whole
// app at "Loading…" and `node --check file.js` did not catch it, so each file is piped in as a module).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const walk = dir => readdirSync(join(ROOT, dir)).flatMap(f => { const p = join(dir, f); return statSync(join(ROOT, p)).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : []; });
const check = src => spawnSync(process.execPath, ['--input-type=module', '--check'], { input: src, encoding: 'utf8' });

for (const f of ['sw.js', ...walk('js')]) test(`parses as a module: ${f}`, () => {
  const r = check(readFileSync(join(ROOT, f)));
  assert.equal(r.status, 0, `${f}\n${r.stderr}`);
});
test('the check itself catches a broken file', () => assert.notEqual(check("export const a = ['it's broken'];").status, 0));

test('every app file is cached for offline use by the service worker', () => {
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  // Sync and native-pairing files load only when sync is on / in the native app: the SW caches them on first use, not at install (gates.mjs is the one boot file).
  const lazy = f => (/^js[\\/]book-sync[\\/]/.test(f) && !/gates\.mjs$/.test(f)) || /^js[\\/]native-pair-/.test(f);
  for (const f of walk('js').filter(f => !lazy(f))) assert.ok(sw.includes(`'./${f.replace(/\\/g, '/')}'`), `${f} missing from sw.js CORE`);
});

test('css: braces balance (an unclosed rule silently drops everything after it)', () => {
  const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0, line = 1;
  for (const ch of css) { if (ch === '\n') line++; if (ch === '{') depth++; if (ch === '}') depth--; assert.ok(depth >= 0, `extra } near line ${line}`); }
  assert.equal(depth, 0, 'a { is never closed');
});

test('every kv key the app writes is loaded back on start (state.js KV_KEYS)', () => {
  const src = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const keys = src('js/state.js').match(/const KV_KEYS = \[([^\]]*)\]/)[1];
  const files = ['js', 'js/views'].flatMap(d => readdirSync(new URL(`../${d}/`, import.meta.url)).filter(f => f.endsWith('.js')).map(f => `${d}/${f}`));
  for (const f of files) for (const [, k] of src(f).matchAll(/setKv\('(\w+)'/g)) assert.ok(keys.includes(`'${k}'`), `${f} writes kv '${k}' that is never loaded`);
});

test('no control characters in app files (a "\b" in a regex once became a backspace, silently breaking it)', () => {
  const bad = walk('js').filter(f => /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(readFileSync(join(ROOT, f), 'utf8')));
  assert.deepEqual(bad, []);
});
