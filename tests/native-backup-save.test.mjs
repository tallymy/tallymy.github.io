import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const io = await readFile(new URL('../js/io.js', import.meta.url), 'utf8');
const setup = await readFile(new URL('../js/views/setup.js', import.meta.url), 'utf8');
// Run the shipped action with a controlled native picker, without importing the app UI.
const downloadSource = io.slice(io.indexOf('export function download('), io.indexOf('export async function shareFile(')).replace('export ', '');
const actionSource = setup.slice(setup.indexOf("  'bk-save': async b => {"), setup.indexOf("  'joint-share':")).trim().replace(/,$/, '');
function harness(native, picker) {
  const events = [], button = { disabled: false, isConnected: true };
  const context = vm.createContext({
    isNative: native, Blob, saveFile: picker,
    URL: { createObjectURL: () => 'blob:backup', revokeObjectURL() {} },
    document: { createElement: () => ({ click: () => events.push('download'), remove() {} }), body: { appendChild() {} } },
    setTimeout() {}, sealedBackup: async () => ({ name: 'book.zip', blob: new Blob(['book']), missing: 0 }),
    $: () => button, t: (s, name) => s.replace('{0}', name),
    backedUp: async message => events.push(['backedUp', message]),
    warnMissingPhotos: () => events.push('photos'), toast: message => events.push(['error', message]),
  });
  vm.runInContext(`${downloadSource}\nvar action = ({${actionSource}})['bk-save'];`, context);
  return { context, button, events, run: () => context.action(button) };
}
test('native backup waits for destination copy before recording a backup', async () => {
  let finish;
  const h = harness(true, () => new Promise(resolve => { finish = resolve; }));
  const saving = h.run(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.button.disabled, true); assert.deepEqual(h.events, []);
  finish({ cancelled: false }); await saving;
  assert.equal(h.events[0][0], 'backedUp'); assert.match(h.events[0][1], /^Saved:/);
  assert.equal(h.button.disabled, false);
});
test('cancelled picker preserves lastBackup and leaves retry available', async () => {
  const h = harness(true, async () => ({ cancelled: true })); await h.run();
  assert.deepEqual(h.events, []); assert.equal(h.button.disabled, false);
});
test('failed native copy reports failure without recording a backup', async () => {
  const h = harness(true, async () => { throw Error('Destination full'); }); await h.run();
  assert.equal(h.events.length, 1); assert.equal(h.events[0][0], 'error');
  assert.equal(h.button.disabled, false);
});
test('native download exposes failure to every awaiting export action', async () => {
  const h = harness(true, async () => { throw Error('Native failure'); });
  await assert.rejects(h.context.download('book.zip', 'book'), /Native failure/);
});
test('browser backup retains download-started behavior', async () => {
  const h = harness(false, () => { throw Error('Unexpected native picker'); }); await h.run();
  assert.equal(h.events[0], 'download'); assert.equal(h.events[1][0], 'backedUp');
  assert.match(h.events[1][1], /^Download started/);
});
