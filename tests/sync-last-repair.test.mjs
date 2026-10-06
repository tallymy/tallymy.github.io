import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { addDays, dueBillTxs, unmarkedPayments } from '../js/engine.js';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const { projectBook, reconcile, bookRevision } = await import('../js/book-sync/sync-core.mjs');

// The REAL postBills source (extracted from js/views/money.js) runs here with in-memory stand-ins for the store and the clock.
const src = readFileSync(new URL('../js/views/money.js', import.meta.url), 'utf8').match(/export async function postBills[\s\S]*?\n}\n/)[0].replace('export async function', 'async function');
const clone = x => structuredClone(x);
function device(recurring, tx, today) {
  const S = { accounts: [{ id: 'cash', name: 'Cash', kind: 'cash', opening: 0 }], tx: clone(tx), recurring: clone(recurring), kv: {} }, saves = [];
  const deps = { today: () => today, S, addDays, dueBillTxs, unmarkedPayments, jointIds: () => new Set(), defaultAccount: () => 'cash', saveTxs: async txs => { S.tx.push(...txs); }, deleteTxs: async () => {},
    saveBill: async (b, o) => { saves.push(b); S.recurring = S.recurring.map(r => (r.id === b.id ? clone(b) : r)); }, toast: () => {}, t: x => x, fmtRM: x => String(x) };
  const run = new Function(...Object.keys(deps), `${src}; return postBills;`)(...Object.values(deps));
  return { S, run, saves };
}
const mkBill = extra => ({ id: 'b1', name: 'Astro', amount: 9900, category: 'bills', accountId: 'cash', day: 5, key: 'astro', auto: true, start: '2026-08-05', ...extra });
const row = date => ({ id: `rec-b1-${date}`, type: 'expense', amount: 9900, date, accountId: 'cash', category: 'bills', merchant: 'Astro', note: '', source: 'recurring', bill: 'b1', createdAt: 1790000000000 });
const other = { id: 't1', type: 'expense', amount: 100, date: '2026-10-03', accountId: 'cash', category: 'dining', note: 'x' };
const book = d => projectBook({ accounts: clone(d.S.accounts).map(a => ({ currency: 'MYR', typed: false, ...a })), tx: clone(d.S.tx), recurring: clone(d.S.recurring), kv: { settings: { monthStart: 1, myName: 'Test' }, customCats: [], subcats: {}, budgets: { total: 0, byCat: {} } } });
const merge = async (b, l, r, today) => reconcile({ base: b, local: l, remote: r, bookId: 'book1', baseRevision: await bookRevision(b), today });

for (const future of ['2099-01-01', '2026-10-07']) {
  test(`a future mark (${future}) is repaired once, then stable, and the other side merges without DATES`, async () => {
    const d = device([mkBill({ last: future })], [other, row('2026-09-05')], '2026-10-05');
    await d.run(); const after = clone(d.S.recurring[0]);
    assert.equal(after.last, '2026-10-05');
    assert.equal(d.S.tx.filter(x => x.bill === 'b1').length, 2, 'the real due date 10-05 was posted once (09-05 existed)');
    assert.ok(d.S.tx.some(x => x.id === 'rec-b1-2026-10-05'));
    const n = d.S.tx.length, saves = d.saves.length; await d.run(); assert.equal(d.S.tx.length, n); assert.equal(d.saves.length, saves, 'second run writes nothing'); assert.deepEqual(d.S.recurring[0], after);
    const base = book(device([mkBill({ last: '2026-09-05' })], [other, row('2026-09-05')], '2026-10-05')), l = clone(base), r = book(d);
    assert.ok((await merge(base, l, r, '2026-10-05')).status);   // merges, no DATES refusal
  });
}

test('marks equal to today and to today + 1 are untouched', async () => {
  for (const last of ['2026-10-05', '2026-10-06']) {
    const d = device([mkBill({ last })], [other, row('2026-09-05'), row('2026-10-05')], '2026-10-05'); const before = clone(d.S.recurring[0]); await d.run();
    assert.equal(d.S.recurring[0].last, last); assert.equal(d.S.tx.length, 3); void before;
  }
});

test('clock was 3 days ahead, then corrected: no due date is lost and nothing posts twice', async () => {
  // While the clock was 3 days ahead (2026-10-08) the bill posted 10-05 and marked last 2026-10-08. Clock corrected to 2026-10-05.
  const d = device([mkBill({ last: '2026-10-08' })], [other, row('2026-09-05'), row('2026-10-05')], '2026-10-05');
  await d.run(); assert.equal(d.S.recurring[0].last, '2026-10-05'); assert.equal(d.S.tx.filter(x => x.bill === 'b1').length, 2);
  // Later, the real 11-05 arrives: it posts exactly once.
  const later = device(d.S.recurring, d.S.tx, '2026-11-05'); await later.run(); await later.run();
  assert.equal(later.S.tx.filter(x => x.id === 'rec-b1-2026-11-05').length, 1);
  // Bill whose posted rows were all in the future: the mark is dropped and catch-up decides (a due date already past is posted, not lost).
  const e = device([mkBill({ last: '2026-10-08' })], [other, row('2026-10-08')], '2026-10-05'); await e.run();
  assert.ok(e.S.tx.some(x => x.id === 'rec-b1-2026-10-05') || e.S.tx.some(x => x.date === '2026-10-08'), 'the due payment exists once');
});

test('deleting the newest posted row is the one documented case that can post it again', async () => {
  const d = device([mkBill({ last: '2099-01-01' })], [other, row('2026-09-05')], '2026-10-05'); await d.run();
  assert.ok(d.S.tx.some(x => x.id === 'rec-b1-2026-10-05'), 'catch-up posts the due 10-05 that the future mark was hiding');
});

for (const [name, bill, today, rows] of [['monthly day 31', mkBill({ day: 31, start: '2026-07-31', last: '2026-09-30' }), '2026-10-31', ['2026-07-31', '2026-08-31', '2026-09-30']], ['weekly', mkBill({ freq: 'weekly', start: '2026-09-01', last: '2026-10-05' }), '2026-10-06', ['2026-10-05']],
  ['yearly', mkBill({ freq: 'yearly', start: '2025-10-05', last: '2026-10-05' }), '2026-10-06', ['2025-10-05', '2026-10-05']], ['leap day', mkBill({ day: 29, start: '2028-01-29', last: '2028-02-28' }), '2028-02-29', ['2028-01-29']]]) {
  test(`${name} bill with an ordinary mark behaves exactly as before the repair`, async () => {
    const d = device([bill], rows.map(row), today); const n = d.S.tx.length; await d.run();
    assert.equal(d.S.recurring[0].last, today >= bill.last ? (bill.last > today ? bill.last : today) : bill.last);
    assert.ok(d.S.tx.length >= n);
    const ref = dueBillTxs([bill], today, rows.map(row)).length; assert.equal(d.S.tx.length - n, ref, 'same payments as the unrepaired path');
  });
}
