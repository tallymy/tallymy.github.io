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
    deleteFile: async o => calls.push(['delete', o]),
  };
  let saved, finish, opened;
  const saveOpened = new Promise(r => { opened = r; });
  globalThis.Capacitor = { isNativePlatform: () => true, convertFileSrc: u => u, Plugins: { Filesystem: fs, TallyNative: {
    reserveOutput: async o => { calls.push(['reserve', o]); return { path: 'out/reservation-book.json', uri: 'file:///cache/out/reservation-book.json' }; },
    releaseOutput: async o => calls.push(['release', o]),
    saveToDevice: async o => { saved = o; return new Promise(r => { finish = r; opened(); }); },
  }, Share: {}, App: {} } };
  globalThis.document = { addEventListener() {} };
  globalThis.window = { open() {} };
  const n = await import('../js/native.js?inside');
  assert.equal(n.isNative, true);
  const bytes = new Uint8Array(7 * 1024 * 1024).map((_, i) => i % 251);
  const saving = n.saveFile('Tally backup: 2026/10.json', new Blob([bytes]), 'application/json');
  await Promise.race([saveOpened, saving.then(() => { throw Error('Save finished before the picker opened'); })]);
  assert.ok(finish, 'Save as was opened after all cache chunks were written');
  assert.deepEqual(calls.map(c => c[0]), ['reserve', 'write', 'append', 'append'], 'reserves before writes and does not clean before picker finishes');
  finish({ cancelled: false }); await saving;
  assert.deepEqual(calls.map(c => c[0]), ['reserve', 'write', 'append', 'append', 'delete', 'release']);
  assert.equal(calls.at(-1)[1].retain, false);
  const chunks = calls.filter(c => ['write', 'append'].includes(c[0]));
  const joined = Buffer.concat(chunks.map(c => Buffer.from(c[1].data, 'base64')));
  assert.equal(joined.length, bytes.length);
  assert.ok(joined.equals(Buffer.from(bytes)), 'the pieces rejoin to the same bytes');
  assert.equal(calls[0][1].name, 'Tally backup: 2026/10.json', 'native reservation owns safe filename generation');
  assert.equal(chunks[0][1].path, 'out/reservation-book.json');
  assert.equal(chunks[0][1].directory, 'CACHE');
  assert.deepEqual([saved.name, saved.mime], ['Tally backup: 2026/10.json', 'application/json']);
  assert.equal(globalThis.navigator.canShare({ files: [new File(['x'], 'a.json')] }), true, 'the share sheet is offered');
  delete globalThis.Capacitor; delete globalThis.document; delete globalThis.window; delete globalThis.navigator.share; delete globalThis.navigator.canShare;
});

test('external links use the native intent bridge, and an unavailable handler returns false', async () => {
  const opened = [];
  globalThis.Capacitor = { isNativePlatform: () => true, Plugins: { TallyNative: { openExternal: async o => opened.push(o.url) } } };
  globalThis.document = { addEventListener() {} }; globalThis.window = { open() {} };
  const n = await import('../js/native.js?links');
  assert.equal(await n.openExternal('mailto:a@example.com'), true);
  assert.deepEqual(opened, ['mailto:a@example.com']);
  globalThis.Capacitor.Plugins.TallyNative.openExternal = async () => { throw Error('No handler'); };
  assert.equal(await n.openExternal('mailto:a@example.com'), false);
  delete globalThis.Capacitor; delete globalThis.document; delete globalThis.window;
  delete globalThis.navigator.share; delete globalThis.navigator.canShare;
});

test('share intake reads only local cache URLs and releases failed batches without partial delivery', async () => {
  const fetched = [], released = [], errors = [];
  const receipt = { uri: 'https://localhost/_capacitor_file_/cache/shared/receipt', name: 'receipt.jpg', type: 'image/jpeg', size: 7 };
  const batches = [
    { files: [receipt] },
    { files: [receipt, { uri: 'https://evil.example/receipt', name: 'evil', size: 7 }] },
    { files: [{ uri: 'https://localhost/js/app.js', name: 'source', size: 7 }] },
    { files: [receipt, { uri: 'https://localhost/_capacitor_file_/cache/shared/missing', name: 'missing', size: 7 }] },
  ];
  const context = vm.createContext({ Blob, File, URL, Response, DOMException, btoa,
    location: { href: 'https://localhost/', origin: 'https://localhost' },
    Capacitor: { isNativePlatform: () => true, convertFileSrc: uri => uri, Plugins: { TallyNative: {
      takeShared: async () => batches.shift(), releaseShared: async o => released.push(o.uris),
    }, App: {} } },
    document: { addEventListener() {} }, window: { open() {} }, navigator: {},
    fetch: async url => { fetched.push(url); return new Response('receipt', { status: url.endsWith('missing') ? 404 : 200 }); },
    report: message => errors.push(message),
  });
  const src = readFileSync(new URL('../js/native.js', import.meta.url), 'utf8').replace(/\bexport /g, '').replace(/async function sharedError\(message\) \{[\s\S]*?\n\}/, 'async function sharedError(message) { report(message); }');
  vm.runInContext(src + '\nglobalThis.readSharedFiles = sharedFiles;', context);
  const files = await context.readSharedFiles();
  assert.equal(files.length, 1); assert.equal(files[0].name, 'receipt.jpg'); assert.equal(await files[0].text(), 'receipt');
  for (let i = 0; i < 3; i++) assert.equal((await context.readSharedFiles()).length, 0, 'invalid or unreadable batches deliver no partial data');
  assert.equal(fetched.length, 4);
  assert.ok(fetched.every(url => url.startsWith('https://localhost/_capacitor_file_/')));
  assert.deepEqual(released.map(uris => uris.length), [1, 2, 1, 2]);
  assert.equal(errors.length, 3);
});
