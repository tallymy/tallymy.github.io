// Regression tests for the security audit's confirmed findings (run-4, the code changed since run-3): each failed before its fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

console.warn = () => {};   // db.js logs each failed save
const disk = new Map();
globalThis.localStorage = { getItem: k => disk.get(k) ?? null, setItem: (k, v) => disk.set(k, String(v)), removeItem: k => disk.delete(k), key: i => [...disk.keys()][i], get length() { return disk.size; } };
const IO = await import('../js/io.js'), E = await import('../js/engine.js');
const St = await import('../js/state.js'), { S } = St;
const { saveSplit, ME } = await import('../js/views/splitbill.js');

test("a backup's removed categories only move into a category an entry can have: never an income one, a made-up id or a prototype key", () => {
  for (const to of ['constructor', '__proto__', 'salary', 'nope', 'toString']) assert.equal(IO.backupSettings({ movedCats: { groceries: to } }).movedCats, undefined, to);
  const ok = { kids: 'household', health: 'c_pharmacy', fun: 'other' };
  assert.deepEqual(IO.backupSettings({ movedCats: ok }).movedCats, ok);
  // What a crafted one did: every later guess of the category landed on 'constructor', and Home's monthSpend threw.
  E.movedCategories(IO.backupSettings({ movedCats: { groceries: 'constructor' } }).movedCats);
  try { assert.doesNotThrow(() => E.monthSpend([{ id: 't', type: 'expense', date: '2026-10-01', amount: 500, accountId: 'a', category: E.categorize('BERAS 5KG'), createdAt: 1 }], '2026-10')); }
  finally { E.movedCategories({}); }
});

test("a friend's debt comes from a file only on the row that moves it through Owed to you or You owe", () => {
  const jt = { id: 'jt', name: 'Joint', kind: 'bank', scope: 'joint', opening: 0, createdAt: 1 }, jt2 = { ...jt, id: 'jt2', name: 'Joint savings', kind: 'savings' };
  const local = { accounts: [jt, { id: 'mine', name: 'Mine', kind: 'bank', opening: 0, createdAt: 1 }], tx: [], recurring: [], kv: { settings: { myName: 'Aina' } } };
  const file = { app: IO.BACKUP_APP, v: 1, kind: 'joint', by: 'Wei', accounts: [jt, jt2], recurring: [], gone: [], kv: {}, tx: [
    { id: 'p1', type: 'transfer', date: '2026-09-20', amount: 50000, accountId: 'jt', toAccountId: 'jt2', category: 'other', owedBy: 'Ali', source: 'quick', createdAt: 1, updatedAt: 2 },
    { id: 'p2', type: 'expense', date: '2026-09-21', amount: 30000, accountId: 'jt', category: 'dining', owedTo: 'Siti', source: 'quick', createdAt: 1, updatedAt: 2 }] };
  const m = IO.mergeJoint(local, IO.readBackup(JSON.stringify(file)));
  assert.equal(m.tx.length, 2, 'the rows still come in');
  assert.deepEqual(E.openShares(m.tx), { owedMe: [], iOwe: [] }, "the partner's file puts no debts on this phone's Home");
  // A backup keeps the real ones: shares into Owed to you, a bill in You owe, and the paybacks.
  const acc = [{ id: 'b', name: 'Bank', kind: 'bank', opening: 0 }, { id: 'om', name: 'Owed to you', kind: 'owedme', opening: 0 }, { id: 'io', name: 'You owe', kind: 'iowe', opening: 0 }];
  const tx = [
    { id: 's1', type: 'transfer', date: '2026-09-01', amount: 900, accountId: 'b', toAccountId: 'om', category: 'other', owedBy: 'Ali', source: 'quick', createdAt: 1 },
    { id: 's2', type: 'transfer', date: '2026-09-02', amount: 400, accountId: 'om', toAccountId: 'b', category: 'other', repaidBy: 'Ali', source: 'quick', createdAt: 1 },
    { id: 's3', type: 'expense', date: '2026-09-03', amount: 700, accountId: 'io', category: 'dining', owedTo: 'Siti', source: 'quick', createdAt: 1 },
    { id: 's4', type: 'transfer', date: '2026-09-04', amount: 200, accountId: 'b', toAccountId: 'io', category: 'other', repaidTo: 'Siti', source: 'quick', createdAt: 1 },
    { id: 'x1', type: 'transfer', date: '2026-09-05', amount: 999900, accountId: 'b', toAccountId: 'io', category: 'other', owedBy: 'Boss', source: 'quick', createdAt: 1 }];
  const back = IO.readBackup(IO.makeBackup({ accounts: acc, tx, recurring: [], kv: {} }));
  const open = E.openShares(back.tx), who = l => l.map(f => `${f.name}:${f.sen}`);
  assert.deepEqual([who(open.owedMe), who(open.iOwe)], [['Ali:500'], ['Siti:500']]);
});

test('an entry moved off the joint account (a split bill a friend paid) goes from the partner\'s phone too', async () => {
  const jt = { id: 'jt', name: 'Joint', kind: 'bank', scope: 'joint', opening: 100000, createdAt: 1 };
  disk.clear(); await St.load();
  await St.replaceAll({ accounts: [jt, { id: 'mine', name: 'Mine', kind: 'bank', opening: 0, createdAt: 1 }], tx: [], recurring: [], kv: { settings: { myName: 'Aina', onboarded: true } } });
  await St.saveTx({ id: 'bill', type: 'expense', date: '2026-09-15', accountId: 'jt', category: 'dining', merchant: 'Kedai', amount: 9000, source: 'quick', createdAt: 1 });
  await St.saveTx({ id: 'e1', type: 'expense', date: '2026-09-16', accountId: 'jt', category: 'dining', amount: 500, source: 'quick', createdAt: 1 });
  const partner = { accounts: [jt], tx: S.tx.map(t => ({ ...t, spouse: true })), recurring: [], kv: { settings: { myName: 'Wei' } } };
  await new Promise(r => setTimeout(r, 5));   // the split comes later than the swap (a marker must be newer than the row)
  await saveSplit({ tx: S.tx.find(x => x.id === 'bill'), people: [ME, 'Ali'], who: [[]], paidBy: 'Ali', today: '2026-10-01' });
  await St.saveTx({ ...S.tx.find(x => x.id === 'e1'), accountId: 'mine' });   // and an ordinary edit to a personal account
  const m = IO.mergeJoint(partner, IO.readBackup(IO.makeJointShare({ accounts: S.accounts, tx: S.tx, kv: S.kv, recurring: S.recurring }, 'Aina')));
  assert.deepEqual(m.drop.sort(), ['bill', 'e1']);
  const theirs = partner.tx.filter(t => !m.drop.includes(t.id)).concat(m.tx);
  assert.equal(E.balances(partner.accounts, theirs).by.jt, E.balances(S.accounts, S.tx).by.jt, 'both phones show the same joint balance');
  // Put back on the joint account later, it goes to the partner again.
  await St.saveTx({ ...S.tx.find(x => x.id === 'e1'), accountId: 'jt' });
  const again = IO.mergeJoint({ ...partner, tx: theirs }, IO.readBackup(IO.makeJointShare({ accounts: S.accounts, tx: S.tx, kv: S.kv, recurring: S.recurring }, 'Aina')));
  assert.ok(again.tx.some(t => t.id === 'e1'));
});

// Atomic sample removal and cancelled/failed restores are now exercised against
// the restore action and database in restore-integrity.test.mjs. The former
// source-pattern check required deleting sample data before user confirmation.

test('with the sample ended first, a restore keeps its budgets and no-spend days', async () => {
  const { startSample, endSample } = await import('../js/sample.js');
  disk.clear(); await St.load();
  assert.ok(await startSample('2026-10-01', 'Cash'));
  await endSample();   // what restoreText now does first
  const data = IO.readBackup(IO.makeBackup({ accounts: [{ id: 'real', name: 'Maybank', kind: 'bank', opening: 0, createdAt: 1 }], tx: [], recurring: [],
    kv: { budgets: { total: 150000, byCat: { dining: 50000 } }, settings: IO.backupSettings({ noSpend: ['2026-09-02'] }) } }));
  await St.replaceAll(data);
  await St.setKv('settings', { ...S.kv.settings, ...data.settings });
  assert.equal(S.kv.settings.sample, false, 'no sample card over real data');
  assert.equal(S.kv.budgets.total, 150000);
  assert.deepEqual(S.kv.settings.noSpend, ['2026-09-02']);
});
