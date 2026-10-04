import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { indexedDB, rows } from './fixtures/idbshim.mjs';

globalThis.crypto ||= webcrypto;

let failPhotos = false;
globalThis.indexedDB = {
  open(name, version) {
    const request = indexedDB.open(name, version);
    let success;
    Object.defineProperty(request, 'onsuccess', { set(fn) { success = fn; }, get() { return () => {
      const connection = request.result, transact = connection.transaction.bind(connection);
      connection.transaction = (...args) => {
        const transaction = transact(...args), objectStore = transaction.objectStore.bind(transaction);
        transaction.objectStore = name => {
          const store = objectStore(name), put = store.put;
          if (name === 'receipts' && failPhotos) store.put = value => {
            const write = put(value);
            write.onsuccess = () => { transaction.error = Object.assign(Error('Disk full'), { name: 'QuotaExceededError' }); transaction.abort(); };
            return write;
          };
          return store;
        };
        return transaction;
      };
      success?.();
    }; } });
    return request;
  },
};
const dbSource = await readFile(new URL('../js/db.js', import.meta.url), 'utf8');
const db = await import(`data:text/javascript;base64,${Buffer.from(dbSource).toString('base64')}`);
await db.init();
const state = await readFile(new URL('../js/state.js', import.meta.url), 'utf8');
const setup = await readFile(new URL('../js/views/setup.js', import.meta.url), 'utf8');
const stateOperations = state.slice(state.indexOf('export async function replaceAll('), state.indexOf('/** Write records as given')).replaceAll('export ', '');
const restore = setup.slice(setup.indexOf('async function restoreText('), setup.indexOf('/** The backup, as JSON'));
function context(choice = 'replace', sample = false) {
  const events = [];
  const old = { id: 'old', accountId: 'sample', receiptId: 'oldphoto', sample: false };
  const S = { accounts: [{ id: 'sample', sample: true }, { id: 'own' }], tx: [old], recurring: [], kv: { settings: { sample }, budgets: {}, goals: [], subcats: { food: ['Own'] }, subRules: { shop: ['food', 'Own'] }, catColors: { food: '#123456' }, catIcons: { food: 'food' }, dismissed: [] } };
  const incoming = { accounts: [{ id: 'new' }], tx: [{ id: 'newtx', accountId: 'new', receiptId: 'newphoto' }], recurring: [], kv: {}, settings: {} };
  const c = vm.createContext({ db, Blob, S, uid: prefix => `${prefix}${Math.random()}`, TRANSIENT_KV: ['reviewDraft', 'scanQueue', 'jointGone', 'deskPlace'], BACKUP_KV: ['budgets', 'subcats', 'subRules'], kvRows: kv => Object.entries(kv || {}).map(([key, value]) => ({ key, value })), load: async () => {},
    beginBackupWork: () => ({}), backupStage: async () => {}, finishBackupWork() {},
    restoreSnapshot: async () => ({book:structuredClone(S),expected:{},expectedKeys:{}}), checkBackupWork() {}, commitBackupWork() {},
    readBackup: () => structuredClone(incoming), settings: () => S.kv.settings,
    sampleRows: () => ({ ids: new Set(['sample']), tx: [old], recurring: [] }), confirmSheet: async () => true,
    openSheet: () => ({ addEventListener: (name, fn) => fn({ target: { closest: () => ({ dataset: { x: choice } }) } }) }),
    esc: x => x, t: (s, ...args) => s.replace(/\{(\d+)\}/g, (_, n) => args[n]), closeSheet() {},
    mergeBackup: (local, data) => ({ accounts: [...local.accounts, ...data.accounts], tx: [...local.tx, ...data.tx], recurring: [], kv: local.kv }), overCap: () => false,
    photosToWrite: rows => new Set(rows.map(x => x.receiptId).filter(Boolean)), reencode: async blob => { events.push('decode'); return blob; },
    today: () => '2026-10-03', nowTime: () => '10:00', getLang: () => 'en', setLang() {},
    document: { documentElement: { style: {} } }, applyLook() {}, markSeen: async () => {}, tickQuietly: async () => {}, persistStorage() {}, go() {}, render() {},
    toast: message => events.push(message), impErr: message => events.push(message), importJoint() {},
  });
  vm.runInContext(`${stateOperations}\n${restore}`, c);
  return { c, S, events };
}
async function seed() {
  failPhotos = false;
  await db.writeAtomic({ clear: ['accounts', 'tx', 'recurring', 'receipts', 'kv'], put: {
    accounts: [{ id: 'sample' }, { id: 'own' }], tx: [{ id: 'old', accountId: 'sample', receiptId: 'oldphoto' }], receipts: [{ id: 'oldphoto', blob: new Blob(['old photo']) }], kv: [{ key: 'lastBackup', value: 'previous' }],
  } });
}
test('successful restore commits decoded receipt bytes with the new book', async () => {
  await seed(); const h = context(); await h.c.restoreText('backup', { 'photos/newphoto.jpg': new Uint8Array([1, 2, 3]) });
  assert.equal((await db.get('tx', 'newtx')).receiptId, 'newphoto');
  assert.deepEqual([...new Uint8Array(await (await db.get('receipts', 'newphoto')).blob.arrayBuffer())], [1, 2, 3]);
  assert.equal(await db.get('receipts', 'oldphoto'), null); assert.equal(h.events[0], 'decode');
});
test('quota abort during receipt write preserves old ledger, images and backup timestamp', async () => {
  await seed(); const h = context(); failPhotos = true;
  await assert.rejects(h.c.restoreText('backup', { 'photos/newphoto.jpg': new Uint8Array([1]) }), error => error.name === 'QuotaExceededError');
  failPhotos = false;
  assert.ok(await db.get('tx', 'old')); assert.equal(await db.get('tx', 'newtx'), null);
  assert.equal(await (await db.get('receipts', 'oldphoto')).blob.text(), 'old photo');
  assert.equal(await db.getKv('lastBackup'), 'previous');
});
test('cancelling restore after sample-removal confirmation leaves user-added sample rows intact', async () => {
  await seed(); const h = context('no', true); await h.c.restoreText('backup');
  assert.ok(await db.get('tx', 'old')); assert.ok(await db.get('receipts', 'oldphoto'));
  assert.equal(h.S.kv.settings.sample, true); assert.deepEqual(h.events, []);
});
test('sample removal and merged receipt restore roll back together on quota failure', async () => {
  await seed(); const h = context('merge', true); failPhotos = true;
  await assert.rejects(h.c.restoreText('backup', { 'photos/newphoto.jpg': new Uint8Array([1]) }), error => error.name === 'QuotaExceededError');
  failPhotos = false;
  assert.ok(await db.get('accounts', 'sample')); assert.ok(await db.get('tx', 'old'));
  assert.ok(await db.get('receipts', 'oldphoto')); assert.equal(await db.get('tx', 'newtx'), null);
});
test('missing receipt produces an explicit warning alongside restored entry count', async () => {
  await seed(); const h = context(); await h.c.restoreText('backup');
  assert.match(h.events.at(-1), /1 Receipt photos could not be read and will be skipped/);
});
test('restoring into an encrypted phone atomically seals receipt Blob and retains its lock', async () => {
  await seed(); const h = context();
  const lock = { enc: { key: 'wrapped-key' } };
  await db.put('kv', { key: 'settings', value: { lock } });
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  db.setKey(key, 'wrapped-key'); db.expectSealed(true); h.S.kv.settings.lock = lock;
  try {
    await h.c.restoreText('backup', { 'photos/newphoto.jpg': new Uint8Array([3, 4, 5]) });
    const raw = rows('receipts').find(x => x.id === 'newphoto');
    assert.ok(raw.ct); assert.equal(raw.blob, undefined);
    assert.deepEqual([...new Uint8Array(await (await db.get('receipts', 'newphoto')).blob.arrayBuffer())], [3, 4, 5]);
    assert.equal((await db.getKv('settings')).lock.enc.key, 'wrapped-key');
  } finally { db.setKey(null); db.expectSealed(false); }
});
