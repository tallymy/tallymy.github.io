// Splitting a bill: each person's share, tax and rounding spread first, always adding up to what was paid. Saved, the
// bill becomes my share and the friends' shares money owed (transfers): the paying account's balance never moves.
import test from 'node:test';
import assert from 'node:assert/strict';

let full = false;
console.warn = () => {};   // db.js logs each failed save
const disk = new Map();
globalThis.localStorage = { getItem: k => disk.get(k) ?? null, setItem: (k, v) => { if (full) throw new Error('QuotaExceededError'); disk.set(k, String(v)); } };
const { S, load, saveAccount, saveTx, replaceAll } = await import('../js/state.js');
const { splitBill, splitShares, saveSplit, linesOf, repayRows, ME } = await import('../js/views/splitbill.js');
const { balances, monthSpend, taxRelief, openShares, itemAmounts, leftOverPaybacks } = await import('../js/engine.js');
const { readBackup, makeBackup } = await import('../js/io.js');

const sum = xs => xs.reduce((s, x) => s + x, 0);
const TODAY = '2026-10-01';
/** A fresh phone with one bank account and this bill on it. */
async function fresh(bill, bank = {}) {
  await load();
  await replaceAll({ accounts: [{ id: 'bank', name: 'Maybank', kind: 'bank', opening: 50000, createdAt: Date.UTC(2026, 0, 1), ...bank }], tx: [], recurring: [], kv: {} });
  await saveTx({ id: 'bill', type: 'expense', date: '2026-09-15', time: '20:10', accountId: 'bank', category: 'dining', merchant: 'Kedai Makan', source: 'receipt', receiptId: 'photo1', createdAt: 1, ...bill });
}
const billRow = () => S.tx.find(x => x.id === 'bill');
const shares = () => S.tx.filter(x => x.splitOf === 'bill');

test('a split adds up to the bill: own items, shared items, and the SST spread over them', () => {
  const items = [{ name: 'Nasi lemak', cents: 1200 }, { name: 'Teh tarik', cents: 350 }, { name: 'Roti', cents: 300 }];
  const owe = splitBill(items, 1961, [['Ali'], ['Siti'], []], ['me', 'Ali', 'Siti']);   // 6% SST on 18.50 = 1.11
  assert.equal(Object.values(owe).reduce((a, b) => a + b, 0), 1961);
  assert.ok(owe.Ali > owe.Siti && owe.Siti > owe.me && owe.me > 0);
  assert.deepEqual(splitBill([{ name: 'Pizza', cents: 1000 }], 1000, [[]], ['a', 'b', 'c']), { a: 334, b: 333, c: 333 });   // the odd sen goes somewhere, never lost
});

test('each person\'s items add up to their share, to the sen', () => {
  const items = [{ cents: 1000 }, { cents: 1001 }, { cents: 333 }];
  const { owe, parts } = splitShares(items, 2599, [['a', 'b', 'c'], [], ['b']], ['a', 'b', 'c']);   // tax, service, rounding: 265 over 2334
  for (const p of ['a', 'b', 'c']) assert.equal(sum(parts[p]), owe[p]);
  assert.equal(sum(Object.values(owe)), 2599);
  assert.deepEqual([parts.a[2], parts.c[2]], [0, 0], 'only b had the third');
  assert.ok(Math.max(parts.a[0], parts.b[0], parts.c[0]) - Math.min(parts.a[0], parts.b[0], parts.c[0]) <= 1, 'a 3-way item: an odd sen at most');
});

// A receipt: RM 120.00 with tax, service and rounding. I had the nasi; Ali the chicken and a novel; three of us shared the
// durian (a 3-way split with remainders); the drinks were everyone's.
const RECEIPT = { amount: 12000, tax: 590, service: 983, rounding: -2, items: [
  { name: 'Nasi lemak', cents: 1850, category: 'dining' }, { name: 'Ayam goreng', cents: 3101, category: 'dining' },
  { name: 'Novel', cents: 2500, category: 'shopping' }, { name: 'Durian', cents: 2000, category: 'groceries', qty: 2, unit: 1000 },
  { name: 'Teh ais', cents: 978, category: 'dining' }] };
const PEOPLE = [ME, 'Ali', 'Siti'];
const WHO = [[ME], ['Ali'], ['Ali'], [ME, 'Ali', 'Siti'], []];

test('I paid: my share + friends\' shares = what was paid, and no account balance moves', async () => {
  await fresh(RECEIPT);
  const before = balances(S.accounts, S.tx);
  await saveSplit({ tx: billRow(), people: PEOPLE, who: WHO, today: TODAY });
  const b = billRow(), owed = shares(), after = balances(S.accounts, S.tx), box = S.accounts.find(a => a.kind === 'owedme');
  assert.equal(b.amount + sum(owed.map(x => x.amount)), 12000);
  assert.equal(sum(b.items.map(i => i.cents)), b.amount, 'my items add up to my share: nothing left to spread');
  assert.deepEqual(b.items.map(i => i.name), ['Nasi lemak', 'Durian', 'Teh ais'], 'items I had none of are left out');
  assert.ok(!('qty' in b.items[1]), 'a part of an item is not its quantity');
  assert.deepEqual([b.receiptId, b.date, b.time, b.accountId], ['photo1', '2026-09-15', '20:10', 'bank']);
  assert.deepEqual(b.split, { total: 12000, with: ['Ali', 'Siti'], who: [[''], ['Ali'], ['Ali'], ['', 'Ali', 'Siti'], []], items: RECEIPT.items });
  assert.deepEqual(owed.map(x => [x.owedBy, x.merchant, x.accountId, x.toAccountId, x.date]), [['Ali', 'Ali · Kedai Makan', 'bank', box.id, '2026-09-15'], ['Siti', 'Siti · Kedai Makan', 'bank', box.id, '2026-09-15']]);
  assert.equal(after.by.bank, before.by.bank, 'the bank paid 120 before and after');
  assert.equal(after.by[box.id], sum(owed.map(x => x.amount)));
  assert.equal(after.total, before.total + after.by[box.id], 'what friends owe counts in the total');
  assert.ok(!box.scope && !box.typed, 'never joint, no typed balance');
  assert.equal(monthSpend(S.tx, '2026-09').total, b.amount, 'spending is my share only');
  assert.deepEqual(openShares(S.tx).owedMe.map(f => [f.name, f.sen, f.from]), owed.map(x => [x.owedBy, x.amount, 'bank']));
});

test('spending counts only my share: RM 120 split four ways is RM 30, in the categories of my items', async () => {
  await fresh({ amount: 12000 });
  await saveSplit({ tx: billRow(), people: [ME, 'Ali', 'Siti', 'Wei'], who: [[]], today: TODAY });
  assert.equal(billRow().amount, 3000);
  assert.equal(monthSpend(S.tx, '2026-09').total, 3000);
  assert.ok(!billRow().items, 'a payment without items stays one');
  await fresh(RECEIPT);
  await saveSplit({ tx: billRow(), people: PEOPLE, who: WHO, today: TODAY });
  const m = monthSpend(S.tx, '2026-09');
  assert.deepEqual(Object.keys(m.byCat).sort(), ['dining', 'groceries'], 'the novel was Ali\'s: no shopping');
  assert.equal(sum(Object.values(m.byCat)), billRow().amount);
  assert.deepEqual(itemAmounts(billRow()).map(i => i.cents), billRow().items.map(i => i.cents));
});

test('LHDN reliefs see only my items', async () => {
  await fresh(RECEIPT);
  const novel = () => taxRelief(S.tx, 2026).find(r => r.id === 'lifestyle').total;
  assert.ok(novel() > 2500, 'before: the whole novel, with its tax');
  await saveSplit({ tx: billRow(), people: PEOPLE, who: WHO, today: TODAY });
  assert.equal(novel(), 0, 'Ali\'s novel is not my relief');
  await saveSplit({ tx: billRow(), people: PEOPLE, who: [[ME], ['Ali'], [ME], [ME, 'Ali', 'Siti'], []], today: TODAY });
  assert.equal(novel(), billRow().items.find(i => i.name === 'Novel').cents, 'mine: my part of it');
});

test('I had nothing: my share is 0, the friends owe all of it, and it still adds up', async () => {
  await fresh(RECEIPT);
  const before = balances(S.accounts, S.tx).by.bank;
  await saveSplit({ tx: billRow(), people: PEOPLE, who: [['Ali'], ['Ali'], ['Siti'], ['Ali', 'Siti'], ['Siti']], today: TODAY });
  assert.equal(billRow().amount, 0);
  assert.ok(!billRow().items);
  assert.equal(sum(shares().map(x => x.amount)), 12000);
  assert.equal(balances(S.accounts, S.tx).by.bank, before);
  assert.equal(monthSpend(S.tx, '2026-09').total, 0);
});

test('split again: the old shares go first, from what was really paid', async () => {
  await fresh(RECEIPT);
  await saveSplit({ tx: billRow(), people: PEOPLE, who: WHO, today: TODAY });
  const old = shares().map(x => x.id), bank = balances(S.accounts, S.tx).by.bank;
  await saveSplit({ tx: billRow(), people: [ME, 'Ali'], who: [[], [], [], [], []], today: TODAY });
  assert.ok(!shares().some(x => old.includes(x.id)));
  assert.deepEqual(shares().map(x => x.owedBy), ['Ali']);
  assert.equal(billRow().amount + shares()[0].amount, 12000);
  assert.ok(Math.abs(billRow().amount - 6000) <= 1, `halves, give or take the odd sen: ${billRow().amount}`);
  assert.equal(S.accounts.filter(a => a.kind === 'owedme').length, 1, 'one Owed to you account');
  assert.equal(balances(S.accounts, S.tx).by.bank, bank);
});

test('a friend paid: my share is owed to them, on You owe; paid back, nothing is open', async () => {
  await fresh(RECEIPT);
  const before = balances(S.accounts, S.tx).by.bank;
  await saveSplit({ tx: billRow(), people: PEOPLE, who: WHO, paidBy: 'Ali', today: TODAY });
  const b = billRow(), iowe = S.accounts.find(a => a.kind === 'iowe');
  assert.deepEqual([b.accountId, b.owedTo, b.split.acc], [iowe.id, 'Ali', 'bank']);
  assert.equal(shares().length, 0, 'what Siti owes Ali is theirs');
  assert.equal(balances(S.accounts, S.tx).by.bank, before + 12000, 'the bank never paid');
  assert.equal(balances(S.accounts, S.tx).by[iowe.id], -b.amount, 'a debt');
  assert.equal(monthSpend(S.tx, '2026-09').total, b.amount);
  assert.deepEqual(openShares(S.tx).iOwe.map(f => [f.name, f.sen]), [['Ali', b.amount]]);
  await saveTx({ id: 'pay', type: 'transfer', date: TODAY, amount: b.amount, accountId: 'bank', toAccountId: iowe.id, category: 'other', merchant: 'Ali', repaidTo: 'Ali' });
  assert.deepEqual(openShares(S.tx).iOwe, []);
  assert.equal(balances(S.accounts, S.tx).by[iowe.id], 0);
  // Split again as mine: back on the bank that the entry was first on.
  await saveSplit({ tx: billRow(), people: PEOPLE, who: WHO, today: TODAY });
  assert.equal(billRow().accountId, 'bank');
  assert.ok(!billRow().owedTo);
});

test('a balance typed today keeps its figure when a back-dated bill moves to You owe', async () => {
  await fresh(RECEIPT, { typed: true, createdAt: new Date('2026-09-30T12:00').getTime() });
  const before = balances(S.accounts, S.tx).by.bank;
  await saveSplit({ tx: billRow(), people: PEOPLE, who: WHO, today: TODAY });
  assert.equal(S.accounts.find(a => a.id === 'bank').opening, 50000, 'paid by me: nothing to move');
  await saveSplit({ tx: billRow(), people: PEOPLE, who: WHO, paidBy: 'Siti', today: TODAY });
  assert.equal(balances(S.accounts, S.tx).by.bank, before);
});

test('paid back: the oldest share first, and part of it leaves the rest open', () => {
  const tx = [
    { id: 'a', type: 'transfer', date: '2026-09-01', amount: 1000, accountId: 'cash', toAccountId: 'owed', owedBy: 'Ali' },
    { id: 'b', type: 'transfer', date: '2026-09-10', amount: 2500, accountId: 'bank', toAccountId: 'owed', owedBy: 'Ali' },
    { id: 'c', type: 'transfer', date: '2026-09-20', amount: 1200, accountId: 'owed', toAccountId: 'cash', repaidBy: 'Ali' },
  ];
  assert.deepEqual(openShares(tx).owedMe, [{ name: 'Ali', sen: 2300, from: 'bank', since: '2026-09-10' }]);
  assert.deepEqual(openShares(tx.slice(0, 2)).owedMe, [{ name: 'Ali', sen: 3500, from: 'cash', since: '2026-09-01' }]);
  assert.deepEqual(openShares([...tx, { id: 'd', type: 'transfer', date: '2026-09-21', amount: 2300, accountId: 'owed', toAccountId: 'bank', repaidBy: 'Ali' }]).owedMe, []);
});

test('saving a split is one write: when it fails, nothing changes', async () => {
  await fresh(RECEIPT);
  const was = JSON.stringify([S.accounts, S.tx]);
  full = true;
  await assert.rejects(saveSplit({ tx: billRow(), people: PEOPLE, who: WHO, today: TODAY }));
  full = false;
  await load();
  assert.equal(JSON.stringify([S.accounts, S.tx]), was);
});

test('backups keep splits, shares and the two accounts, and restore checks them', async () => {
  await fresh(RECEIPT);
  await saveSplit({ tx: billRow(), people: PEOPLE, who: WHO, today: TODAY });
  await saveSplit({ tx: { ...billRow() }, people: PEOPLE, who: [['Ali'], ['Ali'], ['Siti'], ['Ali'], ['Siti']], today: TODAY });   // my share 0
  const b = S.tx.find(x => x.id === 'bill');
  await saveTx({ id: 'debt', type: 'expense', date: '2026-09-16', amount: 800, accountId: 'bank', category: 'dining', merchant: 'Mamak' });
  await saveSplit({ tx: S.tx.find(x => x.id === 'debt'), people: [ME, 'Wei'], who: [[]], paidBy: 'Wei', today: TODAY });
  const back = readBackup(makeBackup({ accounts: S.accounts, tx: S.tx, recurring: [], kv: {} }));
  assert.deepEqual(back.accounts.map(a => a.kind).sort(), ['bank', 'iowe', 'owedme']);
  const lines = list => list?.map(({ name, cents, category }) => ({ name, cents, category }));   // a restore adds raw: '' to items
  const pick = x => ({ amount: x.amount, split: x.split && { ...x.split, items: lines(x.split.items) }, owedTo: x.owedTo, owedBy: x.owedBy, splitOf: x.splitOf, accountId: x.accountId, toAccountId: x.toAccountId, items: lines(x.items) });
  for (const x of S.tx) assert.deepEqual(pick(back.tx.find(y => y.id === x.id)), pick(x), x.id);
  assert.equal(back.tx.find(x => x.id === 'bill').amount, 0, 'a share of nothing is kept');
  assert.equal(b.split.total, 12000);
  // A file with odd names: cleaned like the split sheet's, prototype keys dropped, never joint, no amount 0 without a split.
  const evil = JSON.parse(makeBackup({ accounts: [{ id: 'o', name: 'X', kind: 'owedme', scope: 'joint', opening: 0 }, { id: 'k', name: 'K', kind: 'loanshark', opening: 0 }], recurring: [], kv: {}, tx: [
    { id: 't1', type: 'transfer', date: '2026-09-01', amount: 500, accountId: 'k', toAccountId: 'o', owedBy: '  Ali\u0000 bin   Abu Bakar al-Haj ', splitOf: 'bill' },
    { id: 't2', type: 'transfer', date: '2026-09-01', amount: 500, accountId: 'k', toAccountId: 'o', owedBy: '__proto__', repaidBy: 'constructor', splitOf: '__proto__' },
    { id: 't3', type: 'expense', date: '2026-09-01', amount: 0, accountId: 'k', category: 'dining' },
    { id: 't4', type: 'expense', date: '2026-09-01', amount: 0, accountId: 'k', category: 'dining', owedTo: 'Wei', split: { total: 900, with: ['Wei', '__proto__', 'constructor', 42], who: [['', 'Wei', '__proto__'], 'x'], acc: 'nope' } },
  ] }));
  const r = readBackup(JSON.stringify(evil));
  assert.deepEqual(r.accounts.map(a => [a.kind, a.scope]), [['owedme', undefined], ['cash', undefined]]);
  assert.equal(r.tx.find(x => x.id === 't1').owedBy, 'Ali bin Abu Bakar al');
  const t2 = r.tx.find(x => x.id === 't2');
  assert.ok(!('owedBy' in t2) && !('repaidBy' in t2) && !('splitOf' in t2));
  assert.ok(!r.tx.some(x => x.id === 't3'));
  assert.deepEqual(r.tx.find(x => x.id === 't4').split, { total: 900, with: ['Wei'], who: [['', 'Wei'], []] });
});

test('deleting a split bill takes off what was paid back for it, and only what nothing else still owes', () => {
  const share = (id, of, who, amount, date = '2026-09-15') => ({ id, type: 'transfer', splitOf: of, owedBy: who, amount, date, accountId: 'bank', toAccountId: 'owed' });
  const back = (id, who, amount, date, k = 'repaidBy') => ({ id, type: 'transfer', [k]: who, amount, date, accountId: 'owed', toAccountId: 'bank' });
  const tx = [
    { id: 'A', type: 'expense', amount: 5000, date: '2026-09-15' }, share('a1', 'A', 'Aisyah', 4675), share('a2', 'A', 'Wei', 4092),
    { id: 'B', type: 'expense', amount: 2000, date: '2026-09-20' }, share('b1', 'B', 'Aisyah', 3000, '2026-09-20'),
    back('r1', 'Aisyah', 2000, '2026-09-18'), back('r2', 'Aisyah', 5000, '2026-09-25'), back('r3', 'Wei', 2000, '2026-09-19'),
    back('r4', 'Hafiz', 900, '2026-09-19'),   // someone else's leftover: not this bill's business
    { id: 'C', type: 'expense', amount: 2563, owedTo: 'Hafiz', date: '2026-09-21' }, back('r5', 'Hafiz', 2563, '2026-09-22', 'repaidTo'),
  ];
  // Bill A goes: Aisyah still owes 30.00 (bill B) of the 70.00 she paid, so her newest payback shrinks to 10.00; Wei's goes.
  const a = leftOverPaybacks(tx, ['A', 'a1', 'a2']);
  assert.deepEqual(a.drop.map(x => x.id), ['r3']);
  assert.deepEqual(a.trim.map(x => [x.id, x.amount]), [['r2', 1000]]);
  // A bill a friend paid: what I paid them back for it goes, not the other side's paybacks under the same name.
  assert.deepEqual(leftOverPaybacks(tx, ['C']), { drop: [tx.find(x => x.id === 'r5')], trim: [] });
  // A duplicate bill: the payback still settles the one that's left, so nothing changes.
  const dup = [share('d1', 'X', 'Aisyah', 4675), share('d2', 'Y', 'Aisyah', 4675), back('r', 'Aisyah', 4675, '2026-09-20')];
  assert.deepEqual(leftOverPaybacks(dup, ['Y', 'd2']), { drop: [], trim: [] });
});

test('two payers: my overpayment is the only amount friends owe me', async () => {
  await fresh({ amount: 9000 });
  await saveSplit({ tx: billRow(), people: [ME, 'Ali', 'Siti'], who: [[]], paid: { [ME]: 6000, Ali: 3000 }, today: TODAY });
  assert.equal(balances(S.accounts, S.tx).by.bank, 44000);
  assert.deepEqual(openShares(S.tx).owedMe.map(x => [x.name, x.sen]), [['Siti', 3000]]);
  assert.equal(monthSpend(S.tx, '2026-09').total, 3000);
  const backup = readBackup(makeBackup({ accounts: S.accounts, tx: S.tx, recurring: [], kv: {} }));
  assert.deepEqual(backup.tx.find(x => x.id === 'bill').split.paid, { '': 6000, Ali: 3000 });
});

test('two payers: my partial payment reduces my debt and leaves the correct bank balance', async () => {
  await fresh({ amount: 9000 });
  await saveSplit({ tx: billRow(), people: [ME, 'Ali', 'Siti'], who: [[]], paid: { [ME]: 1000, Ali: 8000 }, today: TODAY });
  const b = billRow(), down = shares();
  assert.equal(b.amount, 3000);
  assert.equal(down.length, 1);
  assert.deepEqual([down[0].amount, down[0].repaidTo], [1000, 'Ali']);
  assert.equal(balances(S.accounts, S.tx).by.bank, 49000);
  assert.deepEqual(openShares(S.tx).iOwe.map(x => [x.name, x.sen]), [['Ali', 2000]]);
  assert.deepEqual(leftOverPaybacks(S.tx, [b.id, ...down.map(x => x.id)]), { drop: [], trim: [] });
  await saveSplit({ tx: b, people: [ME, 'Ali', 'Siti'], who: [[]], paidBy: ME, today: TODAY });
  assert.ok(!S.tx.some(x => x.repaidTo));
  assert.equal(balances(S.accounts, S.tx).by.bank, 41000);
});

test('tax line: assigning it charges that person, leaving it untapped spreads it by food cost', () => {
  const items = linesOf({ amount: 11000, items: [{ name: 'Mine', cents: 4000 }, { name: 'Ali', cents: 6000 }] });
  assert.equal(items[2].extra, true);
  assert.deepEqual(splitBill(items, 11000, [[ME], ['Ali'], []], [ME, 'Ali']), { [ME]: 4400, Ali: 6600 });
  assert.deepEqual(splitBill(items, 11000, [[ME], ['Ali'], [ME]], [ME, 'Ali']), { [ME]: 5000, Ali: 6000 });
});

test('my treat: partial repayment settles the full debt, counts the rest as spending, and keeps real cash correct', () => {
  const accounts = [{ id: 'bank', kind: 'bank', opening: 10000 }, { id: 'owed', kind: 'owedme', opening: 0 }];
  const debt = { id: 'debt', type: 'transfer', date: '2026-09-01', amount: 3000, accountId: 'bank', toAccountId: 'owed', owedBy: 'Ali' };
  const rows = repayRows({ kind: 'owedme', name: 'Ali', amount: 1000, total: 3000, boxId: 'owed', accountId: 'bank', date: TODAY, treat: true, accounts, txs: [debt], today: TODAY });
  const tx = [debt, ...rows.tx];
  assert.deepEqual(openShares(tx).owedMe, []);
  assert.equal(balances(accounts, tx).by.bank, 8000);
  assert.equal(balances(accounts, tx).by.owed, 0);
  assert.equal(monthSpend(tx, '2026-10').total, 2000);
  assert.throws(() => repayRows({ kind: 'iowe', name: 'Ali', amount: 1000, total: 3000, treat: true, date: TODAY, today: TODAY }));
});

test('my treat can forgive all of a debt; a normal payment cannot be zero or exceed the debt', () => {
  const options = { kind: 'owedme', name: 'Ali', total: 3000, boxId: 'owed', accountId: 'bank', date: TODAY, today: TODAY, accounts: [{ id: 'bank', kind: 'bank' }, { id: 'owed', kind: 'owedme' }], txs: [] };
  const r = repayRows({ ...options, amount: 0, treat: true });
  assert.deepEqual(r.tx.map(x => [x.type, x.amount]), [['transfer', 3000], ['expense', 3000]]);
  assert.throws(() => repayRows({ ...options, amount: 0 }));
  assert.throws(() => repayRows({ ...options, amount: 3001 }));
});

test('my treat writes all rows together: a failed save cannot leave the debt half settled', async () => {
  await fresh({ amount: 6000 });
  await saveSplit({ tx: billRow(), people: [ME, 'Ali'], who: [[]], today: TODAY });
  const { putAll } = await import('../js/state.js');
  const box = S.accounts.find(a => a.kind === 'owedme');
  const rows = repayRows({ kind: 'owedme', name: 'Ali', amount: 1000, total: 3000, boxId: box.id, accountId: 'bank', date: TODAY, treat: true, today: TODAY });
  const before = JSON.stringify([S.accounts, S.tx]); full = true;
  try { await assert.rejects(putAll(rows)); } finally { full = false; }
  await load(); assert.equal(JSON.stringify([S.accounts, S.tx]), before);
});
