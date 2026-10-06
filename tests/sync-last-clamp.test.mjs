import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { dueBillTxs } from '../js/engine.js';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const { projectBook, reconcile, bookRevision } = await import('../js/book-sync/sync-core.mjs');

// Round 4 rule: a REMOTE recurring.last later than the receiving device's today + 1 day is refused (code DATES, nothing merged, recoverable);
// genuine marks (<= today + 1) merge as the later of the two and are never lowered. The clock is injected (`today`).
const clone = x => structuredClone(x);
const acc = { id: 'cash', name: 'Cash', kind: 'cash', opening: 10000, typed: false, currency: 'MYR' };
const mkBill = extra => ({ id: 'b1', name: 'Astro', amount: 9900, category: 'bills', accountId: 'cash', day: 5, key: 'astro', auto: true, start: '2026-08-05', last: '2026-10-04', ...extra });
const posted = { id: 'rec-b1-2026-10-05', type: 'expense', amount: 9900, date: '2026-10-05', accountId: 'cash', category: 'bills', merchant: 'Astro', note: '', source: 'recurring', bill: 'b1', createdAt: 1790000000000 };
const state = (bill = mkBill(), tx = []) => ({ accounts: [clone(acc)], tx: [{ id: 't1', type: 'expense', amount: 100, date: '2026-10-03', accountId: 'cash', category: 'dining', note: 'x' }, ...tx], recurring: [bill], kv: { settings: { monthStart: 1, myName: 'Test' }, customCats: [], subcats: {}, budgets: { total: 0, byCat: {} } } });
const merge = async (b, l, r, today) => reconcile({ base: b, local: l, remote: r, bookId: 'book1', baseRevision: await bookRevision(b), today });
const refused = p => assert.rejects(p, e => e.code === 'DATES' && /bill dates look wrong/.test(e.message));

test('a hostile far-future last (2099) from the peer is refused, in a peer-only change and in a both-sided merge', async () => {
  const base = projectBook(state()), l = clone(base), r = clone(base);
  r.recurring[0].last = '2099-01-01';
  await refused(merge(base, l, r, '2026-10-05'));
  l.recurring[0].last = '2026-10-05'; await refused(merge(base, l, r, '2026-10-05'));
});

test('a peer last of 10-30 on 10-05 (skips a due date) is refused; today + 1 day is the limit', async () => {
  const base = projectBook(state()), l = clone(base), r = clone(base);
  r.recurring[0].last = '2026-10-30'; await refused(merge(base, l, r, '2026-10-05'));
  r.recurring[0].last = '2026-10-07'; await refused(merge(base, l, r, '2026-10-05'));
  r.recurring[0].last = '2026-10-06'; assert.equal((await merge(base, l, r, '2026-10-05')).status, 'ready');
});

test('legitimate marks on both sides merge to the later one, converge, and are never lowered', async () => {
  const base = projectBook(state()), l = clone(base), r = clone(base);
  l.recurring[0].last = '2026-10-05'; r.recurring[0].last = '2026-10-06';
  const a = await merge(base, l, r, '2026-10-06'), b = await merge(base, r, l, '2026-10-06');
  assert.equal(a.nextRevision, b.nextRevision); assert.equal(a.candidate.recurring[0].last, '2026-10-06');
});

test('deleting a posted row on one device and syncing does not make it post again', async () => {
  const base = projectBook(state(mkBill({ last: '2026-10-05' }), [posted])), l = clone(base), r = clone(base);
  l.tx = l.tx.filter(t => t.id !== posted.id);
  const a = await merge(base, l, r, '2026-10-06'), b = await merge(base, r, l, '2026-10-06');
  assert.equal(a.nextRevision, b.nextRevision);
  assert.ok(!a.candidate.tx.some(t => t.id === posted.id), 'the deletion is kept');
  assert.equal(a.candidate.recurring[0].last, '2026-10-05', 'the mark is not lowered');
  assert.equal(dueBillTxs(a.candidate.recurring, '2026-10-06', a.candidate.tx).length, 0, 'nothing reposts');
});

test('both devices converge when their clocks differ by a day', async () => {
  const base = projectBook(state()), l = clone(base), r = clone(base);
  l.recurring[0].last = '2026-10-05'; r.recurring[0].last = '2026-10-06';   // r's clock is a day ahead
  const onL = await merge(base, l, r, '2026-10-05'), onR = await merge(base, r, l, '2026-10-06');
  assert.equal(onL.nextRevision, onR.nextRevision); assert.equal(onL.candidate.recurring[0].last, '2026-10-06');
});

for (const [name, bill, today] of [['weekly', mkBill({ freq: 'weekly', start: '2026-09-01', last: '2026-10-05' }), '2026-10-06'], ['monthly day 31', mkBill({ day: 31, start: '2026-07-31', last: '2026-09-30' }), '2026-10-31'],
  ['yearly', mkBill({ freq: 'yearly', start: '2025-10-05', last: '2026-10-05' }), '2026-10-06'], ['leap day', mkBill({ day: 29, start: '2028-01-29', last: '2028-02-28' }), '2028-02-29']]) {
  test(`${name} bill: a mark up to today merges unchanged`, async () => {
    const base = projectBook(state(bill)), l = clone(base), r = clone(base);
    r.recurring[0].last = today; const a = await merge(base, l, r, today), b = await merge(base, r, l, today);
    assert.equal(a.status, 'ready'); assert.equal(a.nextRevision, b.nextRevision); assert.equal(a.candidate.recurring[0].last, today);
  });
}
