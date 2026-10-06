import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { dueBillTxs } from '../js/engine.js';
// SYNC_CORE overrides the module under test (used once to run these tests against the pre-fix copy).
const core = await import(process.env.SYNC_CORE || '../js/book-sync/sync-core.mjs');
const { projectBook, validateBook, reconcile, bookRevision } = core;
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const clone = x => structuredClone(x);
const acc = { id: 'cash', name: 'Cash', kind: 'cash', opening: 10000, typed: false, currency: 'MYR' };
const bill = { id: 'b1', name: 'Astro', amount: 9900, category: 'bills', accountId: 'cash', day: 5, key: 'astro', auto: true, start: '2026-08-05' };
const state = () => ({ accounts: [clone(acc)], tx: [{ id: 't1', type: 'expense', amount: 100, date: '2026-10-04', accountId: 'cash', category: 'dining', note: 'x' }], recurring: [clone(bill)], kv: { settings: { monthStart: 1, myName: 'Test' }, customCats: [], subcats: {}, budgets: { total: 0, byCat: {} } } });
const book = () => projectBook(state());
const merge = async (b, l, r) => reconcile({ base: b, local: l, remote: r, bookId: 'book1', baseRevision: await bookRevision(b) });
// what each device's postBills does: add due auto-bills (createdAt: its own clock) and move the bill's `last` to today
const post = (b, today, now) => { const o = clone(b); const add = dueBillTxs(o.recurring, today, o.tx, now); o.tx.push(...add); o.recurring = o.recurring.map(r => r.auto ? { ...r, last: today } : r); return o; };
const T0 = Date.UTC(2026, 9, 5, 1), T1 = Date.UTC(2026, 9, 5, 9);

// ---- F3
test('F3 two devices post the same auto-bills at different times: no conflict, earliest createdAt kept, symmetric', async () => {
  const b = book(), l = post(b, '2026-10-06', T0), r = post(b, '2026-10-06', T1);
  assert.ok(l.tx.some(t => t.id === 'rec-b1-2026-10-05'));
  const p = await merge(b, l, r), q = await merge(b, r, l);
  assert.equal(p.status, 'ready', JSON.stringify(p.conflicts)); assert.equal(q.status, 'ready');
  assert.equal(p.nextRevision, q.nextRevision);
  assert.equal(p.candidate.tx.find(x => x.id === 'rec-b1-2026-10-05').createdAt, T0);
  assert.equal(p.candidate.tx.filter(x => x.source === 'recurring').length, l.tx.filter(x => x.source === 'recurring').length);
});
test('F3 devices opened on different days (different last, one has more due dates): merges, last = max', async () => {
  const b = book(), l = post(b, '2026-09-06', T0), r = post(b, '2026-10-06', T1);
  const p = await merge(b, l, r), q = await merge(b, r, l);
  assert.equal(p.status, 'ready', JSON.stringify(p.conflicts)); assert.equal(p.nextRevision, q.nextRevision);
  assert.equal(p.candidate.recurring[0].last, '2026-10-06');
  assert.deepEqual(p.candidate.tx.map(t => t.id).sort(), r.tx.map(t => t.id).sort());
});
test('F3 one side edits the bill amount while the other posts: still a conflict', async () => {
  const b = book(), l = post(b, '2026-10-06', T0), r = post(b, '2026-10-06', T1);
  r.recurring[0].amount = 12000; r.recurring[0].updatedAt = 5;
  assert.equal((await merge(b, l, r)).status, 'conflicts');
});
test('F3 posted bill whose amount was edited on one side is still a conflict', async () => {
  const b = book(), l = post(b, '2026-10-06', T0), r = post(b, '2026-10-06', T1);
  r.tx.find(t => t.id === 'rec-b1-2026-10-05').amount = 5000;
  const p = await merge(b, l, r); assert.equal(p.status, 'conflicts'); assert.ok(p.conflicts.some(c => c.keys.includes('tx/rec-b1-2026-10-05')));
});
test('F3 a hand-made tx (not an auto-bill id) with different createdAt is still a conflict', async () => {
  const b = book(), l = clone(b), r = clone(b), t = { id: 'same', type: 'expense', amount: 1, date: '2026-10-04', accountId: 'cash', category: 'dining', source: 'recurring', bill: 'b1' };
  l.tx.push({ ...t, createdAt: T0 }); r.tx.push({ ...t, createdAt: T1 });
  assert.equal((await merge(b, l, r)).status, 'conflicts');
});
test('F3 deletion semantics unchanged: delete vs untouched merges as delete, delete vs edit conflicts', async () => {
  const b = post(book(), '2026-10-06', T0), l = clone(b), r = clone(b), id = 'rec-b1-2026-10-05';
  l.tx = l.tx.filter(t => t.id !== id);
  let p = await merge(b, l, r); assert.equal(p.status, 'ready'); assert.ok(!p.candidate.tx.some(t => t.id === id));
  r.tx.find(t => t.id === id).amount = 1;
  p = await merge(b, l, r); assert.equal(p.status, 'conflicts');
  const l2 = clone(b); l2.tx = l2.tx.filter(t => t.id !== id); const r2 = clone(b); r2.tx.find(t => t.id === id).createdAt += 77;
  assert.equal((await merge(b, l2, r2)).status, 'conflicts');   // delete vs a changed copy stays a conflict
});

// ---- F4
const full = () => {
  const s = state();
  s.accounts.push({ id: 'usd', name: 'USD', kind: 'bank', opening: 700, currency: 'USD', rate: 4.4, typed: false, scope: 'joint' }, { id: 'owed', name: 'Owed to you', kind: 'owedme', opening: 0 });
  s.tx.push({ id: 'sp', type: 'expense', amount: 3000, date: '2026-10-03', time: '13:05', accountId: 'cash', category: 'dining', merchant: 'Cafe', note: 'n', source: 'receipt', createdAt: Date.UTC(2026, 9, 3), updatedAt: Date.UTC(2026, 9, 3),
    split: { total: 9000, with: ['Ali'], who: [['', 'Ali']], paid: { '': 3000, Ali: 6000 }, items: [{ name: 'Rice', raw: 'RICE', cents: 4500, category: 'dining', qty: 2, unit: 2250 }], acc: 'cash' }, items: [{ name: 'Rice', raw: 'RICE', cents: 4500, category: 'dining' }], tax: 50, service: 10, rounding: -2, warranty: '2027-01-01', returnBy: '2026-11-01', by: 'me', relief: 'none' },
    { id: 'tr', type: 'transfer', amount: 400, date: '2026-10-02', accountId: 'cash', toAccountId: 'usd', toAmount: 90, rate: 4.4, category: 'other' },
    { id: 'ow', type: 'transfer', amount: 100, date: '2026-10-02', accountId: 'cash', toAccountId: 'owed', category: 'other', owedBy: 'Ali' },
    { id: 'inc', type: 'income', amount: 500000, date: '2026-10-01', accountId: 'cash', category: 'salary', createdAt: 0 });
  s.kv = { ...s.kv, rules: { cafe: 'dining' }, shopNames: { cafe: 'Cafe' }, itemNames: { rice: 'Rice' }, goals: [{ id: 'g1', name: 'Trip', target: 100000, by: '2027-01-01', accountId: 'cash', createdAt: 0 }], dismissed: ['x'], catColors: { dining: '#aabbcc' }, subRules: { cafe: ['dining', 'Coffee'] }, jointGone: {}, customCats: [{ id: 'c_a', name: 'Own', color: '#112233' }], subcats: { c_a: ['T'] }, budgets: { total: 100000, byCat: { dining: 5000 } } };
  s.kv.settings = { quickAccount: 'cash', monthStart: 1, weekStart: 1, myName: 'Test', friends: ['Ali'], ownCats: true };
  return s;
};
test('F4 legitimate fixtures still validate (rich book, base fixture, auto-bill book)', () => {
  assert.doesNotThrow(() => projectBook(full()));
  assert.doesNotThrow(() => validateBook(book()));
  assert.doesNotThrow(() => validateBook(post(book(), '2026-10-06', Date.now())));
  const v = validateBook(projectBook(full())); assert.deepEqual(validateBook(clone(v)), v);
});
const rich = () => clone(projectBook(full()));
const poison = (n, mut) => test(`F4 hostile: ${n}`, () => { const b = rich(); mut(b); assert.throws(() => validateBook(b)); });
const tx = (b, id) => b.tx.find(t => t.id === id);
poison('negative amount', b => tx(b, 'inc').amount = -5);
poison('float amount', b => tx(b, 'inc').amount = 1.5);
poison('huge amount within safe integer', b => tx(b, 'inc').amount = 2 ** 52);
poison('amount string', b => tx(b, 'inc').amount = '100');
poison('account opening huge', b => b.accounts[0].opening = 2 ** 52);
poison('account opening float', b => b.accounts[0].opening = 0.5);
poison('toAmount huge', b => tx(b, 'tr').toAmount = 1e15);
poison('split total float', b => tx(b, 'sp').split.total = 90.5);
poison('split paid negative', b => tx(b, 'sp').split.paid.Ali = -1);
poison('split paid huge', b => tx(b, 'sp').split.paid.Ali = 1e13);
poison('split item cents float', b => tx(b, 'sp').split.items[0].cents = 0.1);
poison('items cents huge', b => tx(b, 'sp').items[0].cents = 2 ** 50);
poison('tax float', b => tx(b, 'sp').tax = 1.5);
poison('service huge', b => tx(b, 'sp').service = 2 ** 50);
poison('rounding string', b => tx(b, 'sp').rounding = '1');
poison('impossible date', b => tx(b, 'inc').date = '9999-99-99');
poison('Feb 30', b => tx(b, 'inc').date = '2026-02-30');
poison('bad time', b => tx(b, 'sp').time = '25:99');
poison('bad warranty date', b => tx(b, 'sp').warranty = '2027-13-45');
poison('createdAt out of range', b => tx(b, 'sp').createdAt = 5);
poison('updatedAt in the far future', b => tx(b, 'sp').updatedAt = 4e15);
poison('unknown category id', b => tx(b, 'inc').category = 'nope');
poison('time of wrong type', b => tx(b, 'inc').time = 5);
poison('overlong merchant', b => tx(b, 'sp').merchant = 'x'.repeat(5000));
poison('overlong note', b => tx(b, 'sp').note = 'y'.repeat(300));
poison('control chars in note', b => tx(b, 'sp').note = 'a\u0000b');
poison('id over 60 chars', b => { tx(b, 'inc').id = 'a'.repeat(100); });
poison('unknown account kind', b => b.accounts[0].kind = 'weird');
poison('recurring amount float', b => b.recurring[0].amount = 99.5);
poison('recurring bad start date', b => b.recurring[0].start = '2026-00-10');
poison('recurring last garbage', b => b.recurring[0].last = 'soon');
poison('recurring day 99', b => b.recurring[0].day = 99);
poison('recurring bad freq', b => b.recurring[0].freq = 'hourly');
poison('goal target float', b => b.kv.goals[0].target = 1.5);
poison('goal by garbage', b => b.kv.goals[0].by = 'later');
poison('budget total float', b => b.kv.budgets.total = 1.5);
poison('budget byCat negative', b => b.kv.budgets.byCat.dining = -1);
poison('rule to unknown category', b => b.kv.rules.cafe = 'zzz');
poison('catColors bad hex', b => b.kv.catColors.dining = 'red');
poison('settings monthStart 99', b => b.kv.settings.monthStart = 99);
poison('settings friends proto', b => b.kv.settings.friends = ['__proto__']);
poison('settings quickAccount bad id', b => b.kv.settings.quickAccount = 'a b');
poison('dismissed non-string', b => b.kv.dismissed = [1]);
poison('jointGone future', b => b.kv.jointGone = { x: 4e15 });
poison('split with proto friend', b => tx(b, 'sp').split.with = ['constructor']);
poison('unknown field inside split', b => tx(b, 'sp').split.evil = 1);
poison('unknown field inside item', b => tx(b, 'sp').items[0].evil = 1);
poison('unknown field in account', b => b.accounts[0].evil = 1);
poison('too many tx', b => { const t = tx(b, 'inc'); b.tx = Array.from({ length: 200001 }, (_, i) => ({ ...t, id: `n${i}` })); });
poison('too many accounts', b => { b.accounts = Array.from({ length: 201 }, (_, i) => ({ ...b.accounts[0], id: `a${i}` })); });
poison('too many bills', b => { b.recurring = Array.from({ length: 501 }, (_, i) => ({ ...b.recurring[0], id: `r${i}` })); });
test('F4 prototype keys at any depth are refused (JSON-parsed)', () => {
  for (const [k, v] of [['rules', '{"__proto__":"food"}'], ['shopNames', '{"constructor":"x"}'], ['subcats', '{"prototype":["a"]}']]) {
    const b = rich(); b.kv[k] = JSON.parse(v); assert.throws(() => validateBook(b), undefined, k);
  }
  const b = rich(); tx(b, 'sp').split.paid = JSON.parse('{"__proto__":5}'); assert.throws(() => validateBook(b));
  const c = rich(); c.kv.goals[0] = JSON.parse('{"id":"g","target":5,"__proto__":{"a":1}}'); assert.throws(() => validateBook(c));
});
test('F4 reconcile refuses a hostile remote book', async () => {
  const b = book(), l = clone(b), r = clone(b); r.tx[0].amount = 2 ** 52;
  await assert.rejects(merge(b, l, r));
});
test('F4 the production sample book (all default-stored fields) still validates', async () => {
  const disk = new Map(); globalThis.localStorage ??= { getItem: k => disk.get(k) || null, setItem: (k, v) => disk.set(k, String(v)) };
  const { sampleData } = await import('../js/sample.js');
  const d = sampleData('2026-10-04', 1791072000000);
  assert.doesNotThrow(() => projectBook({ ...d, kv: { settings: { sample: true, friends: d.friends }, budgets: d.budgets, goals: d.goals } }));
});
