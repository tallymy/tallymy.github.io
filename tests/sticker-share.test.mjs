import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../js/views/home.js', import.meta.url), 'utf8');
const sheet = source.slice(source.indexOf('async function stickerSheet('), source.indexOf('/** How the saved file'));
function harness({ native = true, share = async () => {}, save = async () => ({ cancelled: false }), encode = async () => new Blob(['art'], { type: 'image/webp' }) } = {}) {
  const events = [], buttons = new Map(), swatch = { innerHTML: '' };
  let html, close;
  function button(x) {
    return { dataset: { x }, disabled: true, classList: { toggle() {} }, addEventListener(_, action) { this.click = action; } };
  }
  const context = vm.createContext({
    Blob, File, isNative: native, navigator: { share: async payload => { events.push(['share', payload]); return share(payload); } },
    bookOf: () => ({ id: 'book', stickers: [{ id: 'art', name: 'Earned' }] }), filledIn: () => new Set([1]),
    panelOf: () => 0, bookState: () => ({ n: 1 }), today: () => '', canSave: () => true, say: x => x,
    t: x => x, esc: x => x, ICON: { x: '', share: '', download: '' }, stkSvg: () => '', stkUrl: null,
    openSheet(markup, options) {
      html = markup; close = options.onClose;
      buttons.set('save', button('save')); if (markup.includes('data-x="share"')) buttons.set('share', button('share'));
      return { querySelectorAll: () => [...buttons.values()], querySelector: () => swatch };
    },
    stickerCanvas: async () => ({ c: {} }), wordOf: () => '', encode, fileName: () => 'sticker.webp',
    URL: { createObjectURL: () => 'blob:art', revokeObjectURL: () => events.push(['revoked']) },
    download: async (...args) => { events.push(['save', ...args]); return save(...args); },
    toast: message => events.push(['toast', message]), settings: () => ({ stickerHowto: false }),
    setSetting: async (...args) => events.push(['setting', ...args]), howTo: () => events.push(['howto']), console: { error() {} },
  });
  vm.runInContext(sheet, context);
  return { events, buttons, get html() { return html; }, close: () => close(), open: () => context.stickerSheet({ dataset: { ym: '2026-10', day: '1' }, closest: () => null }) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('native shares only artwork without saving, and blocks duplicate actions until chooser returns', async () => {
  let finish; const h = harness({ share: () => new Promise(resolve => { finish = resolve; }) }); await h.open();
  const pending = h.buttons.get('share').click(); await tick();
  assert.equal(h.buttons.get('save').disabled, true); assert.equal(h.buttons.get('share').disabled, true);
  await h.buttons.get('save').click(); assert.equal(h.events.length, 1);
  const payload = h.events[0][1]; assert.deepEqual(Object.keys(payload), ['files']); assert.equal(payload.files[0].name, 'sticker.webp');
  finish(); await pending; assert.equal(h.buttons.get('share').disabled, false); assert.equal(h.events.length, 1);
});
test('cancelled share emits no saved/success message and remains retryable', async () => {
  const h = harness({ share: async () => { throw Object.assign(Error('closed'), { name: 'AbortError' }); } }); await h.open(); await h.buttons.get('share').click();
  assert.deepEqual(h.events.map(x => x[0]), ['share']); assert.equal(h.buttons.get('share').disabled, false);
});
test('failed share offers recovery and keeps Save available', async () => {
  const h = harness({ share: async () => { throw Error('offline target'); } }); await h.open(); await h.buttons.get('share').click();
  assert.match(h.events[1][1], /could not be shared/); assert.equal(h.buttons.get('save').disabled, false);
});
test('native Save awaits copy and only then announces saved and opens first-save help', async () => {
  let finish; const h = harness({ save: () => new Promise(resolve => { finish = resolve; }) }); await h.open();
  const pending = h.buttons.get('save').click(); await tick(); assert.deepEqual(h.events.map(x => x[0]), ['save']);
  assert.equal(h.buttons.get('share').disabled, true); finish({ cancelled: false }); await pending;
  assert.deepEqual(h.events.map(x => x[0]), ['save', 'toast', 'setting', 'howto']); assert.equal(h.events[1][1], 'Sticker saved.');
});
test('cancelled Save never records saved/help and re-enables controls', async () => {
  const h = harness({ save: async () => ({ cancelled: true }) }); await h.open(); await h.buttons.get('save').click();
  assert.deepEqual(h.events.map(x => x[0]), ['save']); assert.equal(h.buttons.get('save').disabled, false);
});
test('failed Save reports failure and retains retry', async () => {
  let fail = true; const h = harness({ save: async () => { if (fail) throw Error('full'); return { cancelled: false }; } });
  await h.open(); await h.buttons.get('save').click(); assert.match(h.events.at(-1)[1], /Could not save/); assert.equal(h.buttons.get('save').disabled, false);
  fail = false; await h.buttons.get('save').click(); assert.ok(h.events.some(x => x[1] === 'Sticker saved.'));
});
test('generation failure can be retried from the same sheet', async () => {
  let fail = true; const h = harness({ encode: async () => { if (fail) throw Error('canvas'); return new Blob(['art']); } });
  await h.open(); assert.equal(h.buttons.get('share').disabled, false); fail = false; await h.buttons.get('share').click();
  assert.equal(h.events.at(-1)[0], 'share');
});
test('closing during generation neither leaks preview URL nor shares a file', async () => {
  let finish; const h = harness({ encode: () => new Promise(resolve => { finish = resolve; }) }); const pending = h.open(); await tick();
  h.close(); finish(new Blob(['art'])); await pending; assert.deepEqual(h.events, []);
});
test('browser retains Save-only fallback', async () => {
  const h = harness({ native: false, save: async () => undefined }); await h.open();
  assert.equal(h.buttons.has('share'), false); await h.buttons.get('save').click(); assert.equal(h.events[0][0], 'save');
});
