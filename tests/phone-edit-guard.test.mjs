import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { indexedDB } from './fixtures/idbshim.mjs';

let competitor = null;
globalThis.indexedDB = {
  open(name, version) {
    const request = indexedDB.open(name, version); let success;
    Object.defineProperty(request, 'onsuccess', { set(fn) { success = fn; }, get() { return () => {
      const connection = request.result, transact = connection.transaction.bind(connection);
      connection.transaction = (...args) => {
        if (competitor && args[1] === 'readwrite') {
          const row = competitor; competitor = null;
          const earlier = transact(['tx'], 'readwrite'); earlier.objectStore('tx').put(row);
        }
        return transact(...args);
      }; success?.();
    }; } }); return request;
  },
};
const dbSource = await readFile(new URL('../js/db.js', import.meta.url), 'utf8');
const db = await import(`data:text/javascript;base64,${Buffer.from(dbSource).toString('base64')}`); await db.init();
const source = await readFile(new URL('../js/state.js', import.meta.url), 'utf8');
const saveSource = source.slice(source.indexOf('export async function saveTx('), source.indexOf('export async function saveTxs(')).replace('export ', '');
const io = await readFile(new URL('../js/io.js', import.meta.url), 'utf8');
const typedSource = io.slice(io.indexOf('export function typedShift('), io.indexOf('const ATM =')).replace('export ', '');
const old = { id: 't1', accountId: 'a1', type: 'expense', amount: 1000, date: '2026-09-01', source: 'quick', merchant: 'Phone-opened', note: '', createdAt: 1 };
const account = { id: 'a1', opening: 10000, typed: true, createdAt: new Date('2026-10-01T09:00:00').getTime() };
async function seed() {
  competitor = null;
  await db.writeAtomic({ clear: ['tx', 'accounts', 'kv'], put: { tx: [old], accounts: [account], kv: [{ key: 'settings', value: {} }] } });
}
function harness(accounts = [account], txs = [old]) {
  const S = { accounts: structuredClone(accounts), tx: structuredClone(txs), kv: { settings: {} } };
  const c = vm.createContext({ S, db, structuredClone, settings: () => S.kv.settings, today: () => '2026-10-03', pad2: n => String(n).padStart(2, '0'),
    isFx: a => !!a?.currency && a.currency !== 'MYR', stamp: row => ({ ...row, updatedAt: 12345 }), kvRows: kv => Object.entries(kv).map(([key, value]) => ({ key, value })),
    bookGeneration: () => S.kv.bookGeneration, bookGuard: generation => ({ kv: [{ id: 'bookGeneration', value: generation == null ? undefined : { key: 'bookGeneration', value: generation } }] }),
    load: async () => { S.tx = await db.all('tx'); S.accounts = await db.all('accounts'); }, leftJoint: () => [], markGone: async () => {},
  });
  vm.runInContext(`${typedSource}\n${saveSource}`, c); return c;
}
test('PC edit made after phone opened form cannot be overwritten', async () => {
  await seed(); const phone = harness(); const pc = { ...old, amount: 2500, merchant: 'PC latest' }; await db.put('tx', pc);
  await assert.rejects(phone.saveTx({ ...old, amount: 4000 }, { expected: old }), e => e.code === 'STALE');
  assert.equal((await db.get('tx', old.id)).merchant, 'PC latest'); assert.equal((await db.get('accounts', account.id)).opening, 10000);
});
test('PC deletion after phone opened form is not resurrected', async () => {
  await seed(); const phone = harness(); await db.del('tx', old.id);
  await assert.rejects(phone.saveTx({ ...old, amount: 4000 }, { expected: old }), e => e.code === 'STALE');
  assert.equal(await db.get('tx', old.id), null); assert.equal((await db.get('accounts', account.id)).opening, 10000);
});
test('competing PC write between initial expected read and atomic commit aborts phone changes', async () => {
  await seed(); const phone = harness(); competitor = { ...old, amount: 2500, merchant: 'PC wins race' };
  await assert.rejects(phone.saveTx({ ...old, amount: 4000 }, { expected: old }), e => e.code === 'STALE');
  assert.equal((await db.get('tx', old.id)).merchant, 'PC wins race'); assert.equal((await db.get('accounts', account.id)).opening, 10000);
});
test('successful guarded historical edit adjusts typed balance exactly once with its row', async () => {
  await seed(); const phone = harness(); await phone.saveTx({ ...old, amount: 4000 }, { expected: old });
  assert.equal((await db.get('tx', old.id)).amount, 4000); assert.equal((await db.get('accounts', account.id)).opening, 13000);
});
test('changed account opening refuses guarded row and balance adjustment', async () => {
  await seed(); const phone = harness(); await db.put('accounts', { ...account, opening: 20000 });
  await assert.rejects(phone.saveTx({ ...old, amount: 4000 }, { expected: old }), e => e.code === 'STALE');
  assert.equal((await db.get('tx', old.id)).amount, 1000); assert.equal((await db.get('accounts', account.id)).opening, 20000);
});
test('unguarded direct save retains existing replacement semantics', async () => {
  await seed(); const phone = harness(); await phone.saveTx({ ...old, merchant: 'Direct caller' });
  assert.equal((await db.get('tx', old.id)).merchant, 'Direct caller'); assert.equal((await db.get('accounts', account.id)).opening, 10000);
});
test('changed phone settings reject an edit before its row or opening is changed', async () => {
  await seed(); const phone = harness(); await db.put('kv', { key: 'settings', value: { myName: 'Latest' } });
  await assert.rejects(phone.saveTx({ ...old, amount: 4000 }, { expected: old }), e => e.code === 'STALE');
  assert.equal((await db.get('tx', old.id)).amount, 1000); assert.equal((await db.get('accounts', account.id)).opening, 10000);
});
test('guarded foreign-currency transfer commits rate and opening adjustment with the row', async () => {
  await seed(); const fx = { ...account, id: 'fx', currency: 'USD', rate: 4.5 };
  const original = { ...old, type: 'transfer', toAccountId: fx.id, toAmount: 200 };
  await db.put('accounts', fx); await db.put('tx', original);
  const phone = harness([account, fx], [original]); await phone.saveTx({ ...original, amount: 2000, toAmount: 500 }, { expected: original });
  assert.equal((await db.get('accounts', fx.id)).rate, 4);
  assert.equal((await db.get('accounts', account.id)).opening, 11000);
  assert.equal((await db.get('tx', old.id)).toAmount, 500);
});
test('moving a guarded joint row to personal records its joint deletion marker atomically', async () => {
  await seed(); const joint = { ...account, scope: 'joint' }, personal = { ...account, id: 'personal' };
  await db.put('accounts', joint); await db.put('accounts', personal);
  const phone = harness([joint, personal]); await phone.saveTx({ ...old, accountId: personal.id }, { expected: old });
  assert.equal((await db.get('tx', old.id)).accountId, personal.id);
  assert.ok((await db.getKv('jointGone'))[old.id] > 0);
  assert.equal((await db.get('accounts', joint.id)).opening, 9000);
  assert.equal((await db.get('accounts', personal.id)).opening, 11000);
});
