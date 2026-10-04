// Sample data has to look real: nothing below zero, receipts that add up, nothing dated after today, all marked sample.
// Every feature has something to show, and "Start for real" takes all of it away, never anything of the user's.
import test from 'node:test';
import assert from 'node:assert/strict';

console.warn = () => {};   // db.js logs each failed save
const disk = new Map();
globalThis.localStorage = { getItem: k => disk.get(k) ?? null, setItem: (k, v) => disk.set(k, String(v)) };
const { S, load, saveAccount, saveTx, setKv, replaceAll, settings } = await import('../js/state.js');
const { sampleData, startSample, endSample, sampleRows } = await import('../js/sample.js');
const { splitBill, ME } = await import('../js/views/splitbill.js');
const { balances, openShares, shareProgress, goalProgress, taxRelief, reliefGuess, monthSpend, billStatus, owing, subSplit, affordMoney, affordCheck } = await import('../js/engine.js');
const { categoryOf } = await import('../js/brands.js');
const { filledDays } = await import('../js/comic.js');

const sum = xs => xs.reduce((s, x) => s + x, 0);

test('sample data is believable and clearly marked, whatever the date', () => {
  for (const day of ['2026-01-01', '2026-03-01', '2026-09-29', '2028-02-29']) {
    const { accounts, tx, recurring, goals } = sampleData(day, Date.parse(`${day}T12:00:00Z`));
    const ids = new Set(accounts.map(a => a.id));
    assert.ok(tx.length > 50 && [...accounts, ...tx, ...recurring, ...goals].every(x => x.sample));
    assert.equal(new Set(tx.map(x => x.id)).size, tx.length, 'no id twice');
    assert.ok(tx.every(x => ids.has(x.accountId) && (!x.toAccountId || ids.has(x.toAccountId)) && x.date <= day && x.amount > 0));
    // A receipt adds up: its items with tax, service and rounding; a split bill's items are my share, extras spread in.
    assert.ok(tx.filter(x => x.items).every(x => sum(x.items.map(i => i.cents)) + (x.split ? 0 : (x.tax || 0) + (x.service || 0) + (x.rounding || 0)) === x.amount), day);
    const by = balances(accounts, tx).by;
    assert.ok(accounts.filter(a => !owing(a)).every(a => by[a.id] >= 0 && by[a.id] < 1500000), day);   // nothing below zero, nothing silly
    assert.ok(by[accounts.find(a => a.kind === 'owedme').id] > 0 && by[accounts.find(a => a.kind === 'iowe').id] < 0);
  }
});

test('the split bills are what "Save my share" makes, to the sen; one friend has paid part back', () => {
  const { tx } = sampleData('2026-10-15', Date.parse('2026-10-15T12:00:00Z'));
  const bills = tx.filter(x => x.split);
  assert.equal(bills.length, 2);
  for (const b of bills) {
    const people = [ME, ...b.split.with], shares = tx.filter(x => x.splitOf === b.id);
    const owe = splitBill(b.split.items, b.split.total, b.split.who.map(w => w.map(p => p || ME)), people);
    assert.equal(b.amount, owe[ME]);
    if (b.owedTo) assert.deepEqual([shares.length, b.owedTo, b.split.acc], [0, 'Hafiz', 's_tng'], 'a friend paid: I owe my share');
    else {
      assert.deepEqual(shares.map(x => [x.owedBy, x.amount]), b.split.with.map(f => [f, owe[f]]));
      assert.equal(b.amount + sum(shares.map(x => x.amount)), b.split.total, 'I paid: my share and theirs are the bill');
    }
  }
  const { owedMe, iOwe } = openShares(tx), dinner = bills.find(b => !b.owedTo), aisyah = tx.find(x => x.splitOf === dinner.id && x.owedBy === 'Aisyah').amount;
  assert.equal(owedMe.find(f => f.name === 'Aisyah').sen, aisyah - 2000, 'RM 20 of hers back');
  assert.equal(owedMe.some(f => f.name === 'Wei Ling'), false, 'Wei Ling has paid her full saved share');
  const progress=shareProgress(tx);
  assert.deepEqual(progress.owedMe.map(f=>[f.name,f.status]).sort(), [['Aisyah','partial'],['Wei Ling','settled']]);
  assert.equal(progress.iOwe.find(f=>f.name==='Hafiz').status,'unpaid');
  const paid=tx.find(x=>x.repaidBy==='Wei Ling');
  assert.equal(paid.amount,tx.find(x=>x.owedBy==='Wei Ling').amount);
  assert.equal(monthSpend(tx,'2026-10').total,monthSpend(tx.filter(x=>x.id!==paid.id),'2026-10').total,'settlement never changes spending');
  assert.deepEqual(iOwe.map(f => [f.name, f.sen]), [['Hafiz', bills.find(b => b.owedTo).amount]]);
});

test('every feature has something to show: a goal on its way, a budget, bills, reliefs, nothing-spent days, a sticker book', () => {
  const day = '2026-10-15', d = sampleData(day, Date.parse(`${day}T12:00:00Z`)), by = balances(d.accounts, d.tx).by;
  const p = goalProgress(d.goals[0], by, day);
  assert.ok(p.pct > 0 && p.pct < 1 && p.months > 0, 'partly reached, a date ahead');
  assert.equal(d.accounts.find(a => a.id === d.goals[0].accountId).kind, 'savings');
  assert.ok(d.budgets.total > 0 && d.budgets.byCat.dining && d.budgets.byCat.groceries);
  const spent = monthSpend(d.tx, '2026-10').total;
  assert.ok(spent > 0 && spent < d.budgets.total, 'half way through the month, within the budget');
  assert.ok(d.recurring.every(b => billStatus(b, day, d.tx).next > day && d.tx.filter(x => x.bill === b.id).length === 2), 'two paid, the next one ahead');
  assert.deepEqual(taxRelief(d.tx, 2026).filter(l => l.entries.length).map(l => l.id).sort(), ['donation', 'lifestyle', 'medical', 'sports', 'zakat']);
  assert.equal(d.noSpend.length, 2);
  assert.ok(d.noSpend.every(n => n < day && !d.tx.some(x => x.type === 'expense' && x.date === n)), 'nothing spent means nothing spent');
  assert.ok(filledDays({ tx: d.tx, noSpend: d.noSpend, ym: '2026-10', today: day }).size >= 10, 'most of October in the sticker book');
  assert.ok(d.tx.some(x => x.items?.some(i => i.cents < 0)) && d.tx.some(x => x.rounding), 'money off and rounding on a receipt');
});

test('sample mode starts only on an empty app, and "Start for real" removes all of it, never anything of the user\'s', async () => {
  // Someone with their own money: nothing changes.
  await load();
  await replaceAll({ accounts: [{ id: 'mine', name: 'CIMB', kind: 'bank', opening: 50000, createdAt: 1 }], tx: [], recurring: [], kv: {} });
  await saveTx({ id: 'kopi', type: 'expense', date: '2026-10-01', amount: 350, accountId: 'mine', category: 'dining', source: 'quick', createdAt: 1 });
  const before = JSON.stringify([S.accounts, S.tx, S.recurring, S.kv]);
  assert.equal(await startSample('2026-10-15', 'Cash'), false);
  assert.equal(JSON.stringify([S.accounts, S.tx, S.recurring, S.kv]), before);

  // An empty app: the sample, then what a visitor might add while looking around.
  await replaceAll({ accounts: [], tx: [], recurring: [], kv: {} });
  await setKv('settings', { lang: 'ms' });
  assert.equal(await startSample('2026-10-15', 'Tunai'), true);
  assert.ok(settings().sample && settings().onboarded && settings().noSpend.length === 2 && settings().friends.length === 3 && settings().lang === 'ms');
  assert.ok(S.recurring.length === 4 && S.kv.goals.length === 1 && S.kv.budgets.total > 0 && S.accounts.some(a => a.kind === 'owedme') && S.accounts.some(a => a.kind === 'iowe'));
  assert.equal(S.accounts.find(a => a.id === 's_cash').name, 'Tunai');
  await saveAccount({ id: 'mine', name: 'CIMB', kind: 'bank', opening: 50000, createdAt: 1 });
  await saveTx({ id: 'kopi', type: 'expense', date: '2026-10-15', amount: 350, accountId: 'mine', category: 'dining', source: 'quick', createdAt: 1 });
  await saveTx({ id: 'teh', type: 'expense', date: '2026-10-15', amount: 250, accountId: 's_cash', category: 'dining', source: 'quick', createdAt: 1 });
  assert.deepEqual(sampleRows().tx.filter(x => !x.sample).map(x => x.id), ['teh'], 'what "Start for real" asks about first');

  await endSample();
  assert.deepEqual(S.accounts.map(a => a.id), ['mine']);
  assert.deepEqual(S.tx.map(x => x.id), ['kopi']);
  assert.deepEqual([S.recurring, S.kv.goals, S.kv.budgets], [[], [], { total: 0, byCat: {} }]);
  assert.ok(!settings().sample && settings().onboarded && !('noSpend' in settings()) && !('friends' in settings()) && settings().lang === 'ms');
  await load();   // and it stays gone after a restart
  assert.deepEqual([S.accounts.length, S.tx.length, S.recurring.length, S.kv.goals.length], [1, 1, 0, 0]);

  // Only the sample, then Start for real: back to an empty app and the welcome screen.
  await replaceAll({ accounts: [], tx: [], recurring: [], kv: {} });
  await startSample('2026-10-15');
  await endSample();
  assert.deepEqual([S.accounts.length, S.tx.length, S.recurring.length, S.kv.goals.length, settings().onboarded], [0, 0, 0, 0, false]);
});

test('can I afford it, as Home asks it: RM 200 yes, RM 450 tight from the lowest day before payday (not the budget), RM 1,000 not yet', () => {
  for (const day of ['2026-01-01', '2026-03-01', '2026-10-17', '2026-11-11', '2028-02-29']) {
    const d = sampleData(day, Date.parse(`${day}T12:00:00Z`)), { balance } = affordMoney(d.accounts, d.tx);
    const a = price => affordCheck({ price, balance, txs: d.tx, today: day, bills: d.recurring, budget: d.budgets.total });
    const [small, mid, big] = [a(20000), a(45000), a(100000)];
    assert.equal(small.verdict, 'yes', day);
    assert.equal(mid.verdict, 'tight', day);
    assert.ok(mid.over === 0 && mid.low.bal > 0 && mid.low.date < mid.payDate && mid.left > mid.low.bal, `${day}: short of a week's spending only on the day before pay`);
    assert.equal(mid.left, balance + mid.pay - mid.upcoming - mid.usual - 45000);
    assert.ok(big.verdict === 'no' && big.months >= 1 && big.net > 0, day);
  }
  // The landing's example (start*.html, the "Can I afford it?" tile) is this one, on 17 Oct 2026.
  const d = sampleData('2026-10-17', Date.parse('2026-10-17T12:00:00Z')), { balance } = affordMoney(d.accounts, d.tx);
  const r = affordCheck({ price: 45000, balance, txs: d.tx, today: '2026-10-17', bills: d.recurring, budget: d.budgets.total });
  assert.deepEqual([r.verdict, r.payDate, r.low.date, r.low.bal, r.left], ['tight', '2026-10-28', '2026-10-27', 18226, 288726]);
});

test('the new features have something to show: the landing receipt, subcategories, the relief picker, zakat apart, and no real brands', () => {
  const day = '2026-10-17', d = sampleData(day, Date.parse(`${day}T12:00:00Z`));
  // The landing page's crumpled receipt, line for line, on 15 Oct.
  const slip = d.tx.find(x => x.merchant === 'Kedai Runcit Maju' && x.items.length === 5);
  assert.deepEqual([slip.date, slip.amount, slip.items.map(i => [i.name, i.cents, i.category])], ['2026-10-15', 5390,
    [['Beras 5kg', 2190, 'groceries'], ['Minyak masak 2kg', 1250, 'groceries'], ['Sabun basuh', 890, 'household'], ['Ubat batuk', 640, 'health'], ['Buku cerita', 420, 'education']]]);
  // Subcategories: Tally's own guesses from the shop's name, and some entries with none (the module is off until turned on).
  assert.deepEqual(subSplit(d.tx, 'dining', '2026-10').map(x => x.sub).sort(), ['', 'Café', 'Kopitiam', 'Mamak']);
  assert.ok(['Petrol', 'Pharmacy', 'Dental', 'Movies', 'Zakat', 'Donations'].every(s => d.tx.some(x => x.sub === s)));
  // The relief picker: one picked by hand that the words miss, one the words match but ruled out; zakat and donations apart.
  const R = Object.fromEntries(taxRelief(d.tx, 2026).map(l => [l.id, l]));
  const silat = d.tx.find(x => x.relief === 'sports'), jersey = d.tx.find(x => x.relief === 'none');
  assert.ok(reliefGuess(silat) === null && R.sports.entries.some(e => e.id === silat.id));
  assert.ok(reliefGuess(jersey) === 'sports' && !R.sports.entries.some(e => e.id === jersey.id));
  assert.ok(R.lifestyle.entries.some(e => e.id === slip.id && e.cents === 420), 'Buku cerita on the landing receipt');
  // The landing's relief card shows these figures.
  assert.deepEqual(['lifestyle', 'medical', 'sports', 'zakat', 'donation'].map(k => [R[k].total, R[k].entries.length]), [[32210, 4], [12000, 1], [12800, 3], [5000, 1], [3000, 1]]);
  // No real brands: no shop, item, account or bill is a chain Tally knows by name.
  const names = [...d.tx.flatMap(x => [x.merchant, ...(x.items || []).map(i => i.name)]), ...d.accounts.map(a => a.name), ...d.recurring.map(r => r.name)];
  assert.deepEqual(names.filter(n => n && categoryOf(n)), []);
  assert.ok(!/maybank|touch 'n go|asb|mydin|petronas|uniqlo|watsons|guardian|popular|madam kwan|gsc|sushi king|grab|netflix|unifi|panadol|strepsils|dettol|colgate/i.test(names.join(' ')));
});

test('paid on the second-last day: the payday month starts there every month, and the next pay is predicted from month-end', async () => {
  const E = await import('../js/engine.js');
  assert.deepEqual(E.cycleOf('2026-09-29', -2), { key: '2026-09', start: '2026-09-29', end: '2026-10-29' });   // Oct's second-last is the 30th
  assert.deepEqual(E.cycleOf('2027-02-26', -2), { key: '2027-01', start: '2027-01-30', end: '2027-02-26' });  // Feb's is the 27th
  assert.deepEqual(E.cycleOf('2026-10-31', -1), { key: '2026-10', start: '2026-10-31', end: '2026-11-29' });
  assert.equal(E.cycleKey('2026-09-28', -2), '2026-08');
  assert.equal(E.cycleOf('2026-09-29', 25).start, '2026-09-25');   // day numbers unchanged
  const pay = d => ({ id: d, date: d, type: 'income', category: 'salary', amount: 300000, accountId: 'b' });
  const a = (txs, today, startDay = 1) => E.affordCheck({ price: 100, balance: 0, txs, today, startDay });
  assert.equal(a([pay('2027-01-30'), pay('2027-02-27')], '2027-03-28').payDate, '2027-03-30');   // not 27 Mar, which has passed
  assert.equal(a([pay('2026-09-29')], '2026-10-02', -2).payDate, '2026-10-30');                  // one pay, the payday setting says
  assert.equal(a([pay('2026-08-25'), pay('2026-09-25')], '2026-09-29').payDate, '2026-10-25');    // same day number stays
  assert.equal(a([pay('2026-07-31'), pay('2026-08-31')], '2026-09-29').payDate, '2026-09-30');    // 31 Aug comes again on 30 Sep, not a 31 Sep that doesn't exist
});
