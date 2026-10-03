// The Android app (js/native.js): inert on the website, correct inside the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

globalThis.location = { href: 'https://localhost/', origin: 'https://localhost' };

test('outside the Android app nothing is changed', async () => {
  const { isNative, sharedFiles, external } = await import('../js/native.js');
  assert.equal(isNative, false);
  assert.deepEqual(await sharedFiles(), []);
  assert.equal(globalThis.navigator.share, undefined, 'no share sheet is invented');
  assert.equal(typeof external, 'function');
});

test('links: Tally\'s own files stay in the app, everything else opens outside it', async () => {
  const { external } = await import('../js/native.js');
  assert.equal(external('privacy.html'), null);
  assert.equal(external('#/home'), null);
  assert.equal(external('start.html'), 'https://tallymy.github.io/start.html', 'the landing page is not in the app');
  assert.equal(external('start.zh-Hant.html'), 'https://tallymy.github.io/start.zh-Hant.html');
  assert.equal(external('https://sheets.new'), 'https://sheets.new/');
  assert.equal(external('mailto:fir1412dev@gmail.com'), 'mailto:fir1412dev@gmail.com');
});

test('first.js: a new visitor goes to the landing page, the Android app never does', () => {
  const src = readFileSync(new URL('../js/first.js', import.meta.url), 'utf8');
  const run = native => {
    const moved = [];
    vm.runInNewContext(src, {
      document: { documentElement: { dataset: {} }, referrer: '' },
      localStorage: { getItem: () => null }, matchMedia: () => ({ matches: false }), navigator: { languages: ['en'] },
      location: { search: '', hash: '', origin: 'https://tallymy.github.io', replace: u => moved.push(u) },
      ...(native ? { Capacitor: { isNativePlatform: () => true } } : {}),
    });
    return moved;
  };
  assert.deepEqual(run(false), ['start.html']);
  assert.deepEqual(run(true), []);
});

test('inside the app: a big file is written in whole base64 chunks and handed to Save as', async () => {
  const calls = [];
  const fs = {
    writeFile: async o => { calls.push(['write', o]); }, appendFile: async o => { calls.push(['append', o]); },
    getUri: async o => ({ uri: `file:///cache/${o.path}` }),
  };
  let saved;
  globalThis.Capacitor = { isNativePlatform: () => true, convertFileSrc: u => u, Plugins: { Filesystem: fs, TallyNative: { saveToDevice: async o => { saved = o; return {}; } }, Share: {}, App: {} } };
  globalThis.document = { addEventListener() {} };
  globalThis.window = { open() {} };
  const n = await import('../js/native.js?inside');
  assert.equal(n.isNative, true);
  const bytes = new Uint8Array(7 * 1024 * 1024).map((_, i) => i % 251);
  await n.saveFile('Tally backup: 2026/10.json', new Blob([bytes]), 'application/json');
  assert.deepEqual(calls.map(c => c[0]), ['write', 'append', 'append'], '3 MB + 3 MB + 1 MB');
  const joined = Buffer.concat(calls.map(c => Buffer.from(c[1].data, 'base64')));
  assert.equal(joined.length, bytes.length);
  assert.ok(joined.equals(Buffer.from(bytes)), 'the pieces rejoin to the same bytes');
  assert.ok(!/[/:]/.test(calls[0][1].path.replace(/^out\//, '')), 'the file name has no path characters');
  assert.equal(calls[0][1].directory, 'CACHE');
  assert.deepEqual([saved.name, saved.mime], ['Tally backup: 2026/10.json', 'application/json']);
  assert.equal(globalThis.navigator.canShare({ files: [new File(['x'], 'a.json')] }), true, 'the share sheet is offered');
  delete globalThis.Capacitor; delete globalThis.document; delete globalThis.window; delete globalThis.navigator.share; delete globalThis.navigator.canShare;
});
