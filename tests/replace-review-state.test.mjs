import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { indexedDB } from './fixtures/idbshim.mjs';

let abortReplace = false;
globalThis.indexedDB = {
  open(name, version) {
    const request = indexedDB.open(name, version); let success;
    Object.defineProperty(request, 'onsuccess', { set(fn) { success = fn; }, get() { return () => {
      const connection = request.result, transact = connection.transaction.bind(connection);
      connection.transaction = (...args) => {
        const transaction = transact(...args), objectStore = transaction.objectStore.bind(transaction);
        transaction.objectStore = name => {
          const store = objectStore(name), put = store.put;
          if (name === 'accounts' && abortReplace) store.put = value => {
            const write = put(value); write.onsuccess = () => { transaction.error = Object.assign(Error('Full disk'), { name: 'QuotaExceededError' }); transaction.abort(); }; return write;
          };
          return store;
        }; return transaction;
      }; success?.();
    }; } }); return request;
  },
};
const dbSource = await readFile(new URL('../js/db.js', import.meta.url), 'utf8');
const db = await import(`data:text/javascript;base64,${Buffer.from(dbSource).toString('base64')}`); await db.init();
const state = await readFile(new URL('../js/state.js', import.meta.url), 'utf8');
const review = await readFile(new URL('../js/views/review.js', import.meta.url), 'utf8');
const segment = (start, end) => state.slice(state.indexOf(start), state.indexOf(end, state.indexOf(start)));
const functions = [
  segment('export async function setKv(', 'export const settings'),
  segment('export async function saveTx(', 'export async function saveTxs('),
  segment('export const savePhoto =', 'export const deletePhotos'),
  segment('export async function replaceAll(', '/** Add a merged'),
].join('\n').replaceAll('export ', '');
const reviewSource = review.replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');
const old = { id: 'old', type: 'expense', amount: 1000, accountId: 'oldaccount', date: '2026-10-01', merchant: 'Old', note: '', source: 'quick', items: [] };
const incoming = { accounts: [{ id: 'newaccount' }], tx: [{ ...old, id: 'new', accountId: 'newaccount' }], recurring: [], kv: {} };
async function seed() {
  abortReplace = false;
  await db.writeAtomic({ clear: ['accounts', 'tx', 'recurring', 'receipts', 'kv'], put: {
    accounts: [{ id: 'oldaccount' }], tx: [old], kv: [
      { key: 'settings', value: {} }, { key: 'reviewDraft', value: { draft: old } }, { key: 'scanQueue', value: ['oldscan'] },
      { key: 'jointGone', value: { removed: 1 } }, { key: 'deskPlace', value: { editId: 'old' } },
    ],
  } });
}
async function harness(readReceipt = async () => ({ receipt: { items: [], total: 1000 }, ms: 10, tries: 1 })) {
  const S = { accounts: await db.all('accounts'), tx: await db.all('tx'), recurring: [], kv: { settings: {}, subRules: {}, rules: {} } };
  for (const row of await db.all('kv')) S.kv[row.key] = row.value;
  const listeners = {}, timers = new Map(); let timerId = 0, id = 0;
  const messages = [];
  const context = vm.createContext({
    db, S, Blob, Event, structuredClone, performance, URL: { createObjectURL: () => 'blob:old', revokeObjectURL() {} },
    document: { addEventListener: (name, listener) => { listeners[name] = listener; }, dispatchEvent: event => { listeners[event.type]?.(event); }, querySelector: () => null, getElementById: () => null },
    location: { hash: '#/home' }, setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: n => timers.delete(n), setInterval: () => ++timerId, clearInterval() {},
    TRANSIENT_KV: ['reviewDraft', 'scanQueue', 'jointGone', 'deskPlace'], BACKUP_KV: ['budgets'],
    bookGeneration: () => S.kv.bookGeneration, bookGuard: generation => ({ kv: [{ id: 'bookGeneration', value: generation == null ? undefined : { key: 'bookGeneration', value: generation } }] }),
    kvRows: kv => Object.entries(kv || {}).map(([key, value]) => ({ key, value })), uid: prefix => `${prefix}${++id}`, settings: () => S.kv.settings,
    load: async () => { S.accounts = await db.all('accounts'); S.tx = await db.all('tx'); S.kv = { settings: {}, rules: {}, subRules: {} }; for (const row of await db.all('kv')) S.kv[row.key] = row.value; },
    typedShift: () => ({}), stamp: row => ({ ...row, updatedAt: 1 }), isFx: () => false,
    t: (text, ...values) => text.replace(/\{(\d+)\}/g, (_, n) => values[n]), fmtRM: n => `RM ${n / 100}`, fmtAcct: (a, n) => `RM ${n / 100}`, fmtDate: x => x, fmtMonth: x => x,
    ocrSaved: async () => true, ocrProgress() {}, ocrReady: () => true, loadOcr: async () => {}, readReceipt, readPct: () => 0, OCR_BYTES: 0,
    announce() {}, render() {}, go() {}, scanned() {}, toast: message => messages.push(message), startScan() {},
    deletePhotos: ids => db.delMany('receipts', ids), getPhoto: async id => (await db.get('receipts', id))?.blob,
    today: () => '2026-10-03', nowTime: () => '10:00', defaultAccount: () => S.accounts[0]?.id,
    categorize: () => 'food', shopCategory: () => 'food', on: () => false, checksum: () => ({ ok: true }), validIso: () => true,
    getLang: () => 'en', itemKey: text => text, learnNames: () => null, firstWord: () => '', landed() {}, learn: async () => {}, keepToday: async () => {}, accName: x => x,
    $: () => null, $$: () => [], confirmSheet: async () => true, validCorners: () => true, closeSheet() {},
  });
  vm.runInContext(`${functions}\n${reviewSource}\nvar inspectReview = () => ({current, queued:queue.length, reading}); var startPump = pump; var reviewBusy = busy; var viewAct = act;`, context);
  return { context, S, timers, messages };
}
test('Replace clears transient KV and live review state, including on reload', async () => {
  await seed(); const h = await harness(); h.context.editExisting(old, { base: old });
  await h.context.replaceAll(incoming);
  for (const key of ['reviewDraft', 'scanQueue', 'jointGone', 'deskPlace']) assert.equal(await db.getKv(key), null);
  assert.equal(h.context.inspectReview().current, null); assert.equal(h.context.reviewBusy(), false); assert.equal(h.timers.size, 0);
  const reload = await harness(); assert.equal(await reload.context.restoreDraft(), false);
});
test('failed Replace retains old transient KV and current edit', async () => {
  await seed(); const h = await harness(); h.context.editExisting(old, { base: old }); abortReplace = true;
  await assert.rejects(h.context.replaceAll(incoming), error => error.name === 'QuotaExceededError'); abortReplace = false;
  assert.equal(h.context.inspectReview().current.draft.id, old.id); assert.ok(await db.getKv('reviewDraft')); assert.deepEqual(await db.getKv('scanQueue'), ['oldscan']);
});
test('OCR result arriving after Replace cannot restore an old draft/photo/queue', async () => {
  await seed(); let complete; const h = await harness(() => new Promise(resolve => { complete = resolve; }));
  await h.context.enqueue([new Blob(['old scan'])]);
  await h.context.replaceAll(incoming);
  complete({ receipt: { items: [], total: 1000 }, photo: new Blob(['late photo']), ms: 10, tries: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.context.inspectReview().current, null); assert.equal(h.context.reviewBusy(), false);
  assert.equal(await db.getKv('reviewDraft'), null); assert.equal(await db.getKv('scanQueue'), null); assert.deepEqual(await db.all('receipts'), []);
});
test('guarded transient write begun under old book cannot commit after replacement', async () => {
  await seed(); const h = await harness();
  // Replacement is queued first but the old in-memory generation is captured before its load/event.
  const replacement = h.context.replaceAll(incoming), oldWrite = h.context.setKv('reviewDraft', { draft: old });
  const rejected = assert.rejects(oldWrite, error => error.code === 'STALE'); await replacement; await rejected;
  assert.equal(await db.getKv('reviewDraft'), null); assert.equal(h.S.kv.reviewDraft, undefined);
});
test('item review conversion rejects a PC edit made since phone opened original row', async () => {
  await seed(); const h = await harness(); h.context.editExisting({ ...old, merchant: 'Phone typing' }, { base: old });
  await db.put('tx', { ...old, merchant: 'PC latest' });
  const button = { disabled: false }; await h.context.viewAct['rv-save'](button);
  assert.equal((await db.get('tx', old.id)).merchant, 'PC latest'); assert.equal(button.disabled, false);
  assert.match(h.messages.at(-1), /Close this form and reopen/); assert.equal(h.context.inspectReview().current.draft.merchant, 'Phone typing');
});
test('read-ahead completion and progress from discarded queue remain ignored after Replace', async () => {
  await seed(); let complete, progress;
  const h = await harness((file, stage) => { progress = stage; return new Promise(resolve => { complete = resolve; }); });
  h.context.editExisting(old, { base: old }); await h.context.enqueue([new Blob(['ahead scan'])]);
  await h.context.replaceAll(incoming);
  progress('prep'); complete({ receipt: { items: [], total: 1000 }, ms: 10, tries: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.context.inspectReview().current, null); assert.equal(h.context.inspectReview().queued, 0); assert.equal(await db.getKv('scanQueue'), null);
});
test('item review does not resurrect an entry deleted on PC', async () => {
  await seed(); const h = await harness(); h.context.editExisting(old, { base: old }); await db.del('tx', old.id);
  await h.context.viewAct['rv-save']({ disabled: false });
  assert.equal(await db.get('tx', old.id), null); assert.match(h.messages.at(-1), /Close this form and reopen/);
});
test('new review save started in old book cannot write after Replace commits', async () => {
  await seed(); const h = await harness();
  const replacement = h.context.replaceAll(incoming);
  const write = h.context.saveTx({ ...old, id: 'old-unsaved-scan' }, { expected: null });
  const rejected = assert.rejects(write, error => error.code === 'STALE'); await replacement; await rejected;
  assert.equal(await db.get('tx', 'old-unsaved-scan'), null);
});
