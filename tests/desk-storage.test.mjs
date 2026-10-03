import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from './fixtures/idbshim.mjs';
globalThis.indexedDB = indexedDB;
const db = await import('../js/db.js');
test('a guarded write commits only while the stored phone record still matches', async () => {
  await db.init();
  const old = { id: 't1', amount: 1000 }; await db.put('tx', old);
  await db.writeAtomic({ expected: { tx: [{ id: 't1', value: old }] }, put: { tx: [{ ...old, amount: 1500 }] } });
  assert.equal((await db.get('tx', 't1')).amount, 1500);
  await assert.rejects(db.writeAtomic({ expected: { tx: [{ id: 't1', value: old }] }, put: { tx: [{ ...old, amount: 2000 }] } }), e => e.code === 'STALE');
  assert.equal((await db.get('tx', 't1')).amount, 1500);
});
test('a competing save between the first check and commit aborts every desktop change', async () => {
  const old = { id: 't2', amount: 1000 }; await db.put('tx', old);
  const computer = db.writeAtomic({ expected: { tx: [{ id: 't2', value: old }] }, put: { tx: [{ ...old, amount: 2000 }], accounts: [{ id: 'a', opening: 9999 }] } });
  const phone = db.put('tx', { ...old, amount: 3000 });
  await assert.rejects(computer, e => e.code === 'STALE'); await phone;
  assert.equal((await db.get('tx', 't2')).amount, 3000); assert.equal(await db.get('accounts', 'a'), null);
});
test('guarding a new id prevents a second save using that id', async () => {
  await db.writeAtomic({ expected: { tx: [{ id: 'new', value: undefined }] }, put: { tx: [{ id: 'new', amount: 500 }] } });
  await assert.rejects(db.writeAtomic({ expected: { tx: [{ id: 'new', value: undefined }] }, put: { tx: [{ id: 'new', amount: 700 }] } }), e => e.code === 'STALE');
});
