import test from 'node:test';
import assert from 'node:assert/strict';
import { deskWrite, deskEditable, deskAccount, recordVersion, pairingCode, sdpFingerprint } from '../js/desk-protocol.js';
const day = '2026-10-03';
const id = 'dt_12345678-1234-1234-1234-123456789abc';
const state = () => ({ accounts: [{ id: 'bank', kind: 'bank', scope: 'me', opening: 10000, typed: true, createdAt: new Date(2026, 9, 3).getTime() }], tx: [], settings: {}, categories: [{ id: 'dining', type: 'expense' }, { id: 'salary', type: 'income' }] });
const value = () => ({ type: 'expense', amount: 1500, date: day, accountId: 'bank', category: 'dining', merchant: 'Cafe', note: '' });
test('computer additions use integer sen and guard the transaction, account and settings together', () => {
  const s = state(), w = deskWrite(s, { kind: 'save', id, base: null, value: value() }, day);
  assert.equal(w.tx[0].amount, 1500); assert.deepEqual(w.expected.tx, [{ id, value: undefined }]);
  assert.deepEqual(w.expected.accounts[0].value, s.accounts[0]); assert.equal(w.accounts.length, 0);
});
test('a stale computer form cannot overwrite a phone edit', () => {
  const s = state(), old = { id, ...value() }; s.tx.push({ ...old, amount: 2000 });
  assert.throws(() => deskWrite(s, { kind: 'save', id, base: recordVersion(old), value: value() }, day), e => e.code === 'STALE');
});
test('backdated edits and deletes keep a typed balance correct', () => {
  const s = state(), old = { id, ...value(), date: '2026-10-01' }; s.tx.push(old);
  const edited = deskWrite(s, { kind: 'save', id, base: recordVersion(old), value: { ...value(), date: old.date, amount: 2000 } }, day);
  assert.equal(edited.accounts[0].opening, 10500);
  const deleted = deskWrite(s, { kind: 'delete', id, base: recordVersion(old) }, day);
  assert.equal(deleted.accounts[0].opening, 8500); assert.deepEqual(deleted.del, { tx: [id] });
});
test('receipt and split entries remain protected from incomplete desktop edits', () => {
  assert.equal(deskEditable({ ...value(), receiptId: 'p1' }), false);
  assert.equal(deskEditable({ ...value(), items: [{ name: 'Tea', cents: 1500 }] }), false);
  assert.equal(deskEditable({ ...value(), split: { Ali: 500 } }), false);
  assert.equal(deskAccount({ kind: 'bank', scope: 'joint' }), false);
});
test('malformed money, categories, dates and oversized notes are rejected', () => {
  for (const patch of [{ amount: 1.5 }, { amount: -1 }, { amount: NaN }, { date: '2026-02-30' }, { date: '2099-01-01' }, { category: 'salary' }, { note: 'x'.repeat(201) }])
    assert.throws(() => deskWrite(state(), { kind: 'save', id, base: null, value: { ...value(), ...patch } }, day));
});
test('the longest computer note survives a backup round trip unchanged', async () => {
  const { makeBackup, readBackup } = await import('../js/io.js');
  const s = state(), note = 'x'.repeat(200);
  const saved = deskWrite(s, { kind: 'save', id, base: null, value: { ...value(), note } }, day);
  const restored = readBackup(makeBackup({ accounts: s.accounts, tx: saved.tx, recurring: [], kv: {} }));
  assert.equal(restored.dropped, 0);
  assert.equal(restored.tx[0].note, note);
});
test('computer category or type changes drop an old subcategory, unchanged category keeps it', () => {
  const s = state(), old = { id, ...value(), sub: 'Breakfast' }; s.tx.push(old);
  s.categories.push({ id: 'transport', type: 'expense' });
  const save = patch => deskWrite(s, { kind: 'save', id, base: recordVersion(old), value: { ...value(), ...patch } }, day).tx[0];
  assert.equal(save({ amount: 2000 }).sub, 'Breakfast');
  assert.equal(save({ category: 'transport' }).sub, undefined);
  assert.equal(save({ type: 'income', category: 'salary' }).sub, undefined);
});
test('both devices derive the same pairing number, bound to both encryption certificates', async () => {
  const fp = n => `a=fingerprint:sha-256 ${Array(32).fill(n).join(':')}\r\n`;
  const code = await pairingCode(fp('AA'), fp('BB'));
  assert.match(code, /^\d{4} \d{4}$/); assert.equal(code, await pairingCode(fp('AA'), fp('BB')));
  assert.notEqual(code, await pairingCode(fp('AA'), fp('CC')));
  assert.throws(() => sdpFingerprint(fp('AA') + fp('BB')));
});
