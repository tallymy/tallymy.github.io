// Other money apps' exports, recognised with no column matching. Synthetic files only (tests/fixtures): the same
// month in every app: salary into Maybank, RM 100 Maybank → TNG and RM 200 Maybank → Cash, three purchases, a refund,
// and where the app has them a starting balance / balance correction of RM 1,000 on Maybank.
process.env.TZ = 'Asia/Kuala_Lumpur';   // Spendee writes UTC; the phone reads it as local time
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as IO from '../js/io.js';
import { detectPreset } from '../js/presets.js';
import { readRealbyte } from '../js/mmimport.js';
import { xlsx, realbyteRows, moneyLoverOldRows, sqlJs, realbyteDb } from './fixtures/make.mjs';

const fixture = f => readFileSync(new URL(`./fixtures/${f}`, import.meta.url));
/** A file through the same steps as the import sheet: header row, preset, the accounts it names, transactions. */
function run(rows, name) {
  const h = IO.headerRow(rows), header = rows[h], body = rows.slice(h + 1), preset = detectPreset(header, name);
  assert.ok(preset, `${name}: not recognised (${header.join(' | ')})`);
  const { names, blanks } = IO.accountNames(body, preset.map, { preset, header });
  const accounts = Object.fromEntries(names.map(n => [n.toLowerCase(), n.toLowerCase()]));
  const res = IO.rowsToTx(body, preset.map, { accountId: 'default', accounts, preset, header, now: 1 });
  const bal = { ...res.opening };
  for (const t of res.txs) {
    const d = t.type === 'income' ? t.amount : -t.amount;
    bal[t.accountId] = (bal[t.accountId] || 0) + d;
    if (t.type === 'transfer') bal[t.toAccountId] = (bal[t.toAccountId] || 0) + t.amount;
  }
  return { preset, names, blanks, bal, ...res, sum: k => res.txs.filter(t => t.type === k).reduce((s, t) => s + t.amount, 0), find: m => res.txs.find(t => t.merchant === m) };
}
const csv = f => IO.parseCSV(IO.decodeBytes(fixture(f)));

const SAME = { maybank: 311460, tng: 7000, cash: 20750 };
const APPS = [
  ['moneylover.csv', 'moneylover', { opening: 0 }],
  ['spendee.csv', 'spendee', { opening: 0 }],
  ['wallet.csv', 'wallet', { opening: 0 }],
  ['monefy.csv', 'monefy', { opening: 0 }],
  ['ynab_register.csv', 'ynab', { opening: 100000 }],
  ['cashew.csv', 'cashew', { opening: 100000 }],
  ['bluecoins.csv', 'bluecoins', { opening: 0 }],
  ['onemoney.csv', 'onemoney', { opening: 0 }],
  ['onemoney_utc.csv', 'onemoney', { opening: 0 }],   // newer export: income is From category → To account (no "Salary" account)
  ['toshl.csv', 'toshl', { opening: 100000 }],
  ['andromoney.csv', 'andromoney', { opening: 100000 }],
];
for (const [file, id, { opening }] of APPS) test(`${id}: recognised; accounts, transfers, income, spending and balances come across`, () => {
  const r = run(csv(file), file);
  assert.equal(r.preset.id, id);
  assert.deepEqual(r.names.map(n => n.toLowerCase()).sort(), ['cash', 'maybank', 'tng']);
  assert.equal(r.blanks, false);
  assert.equal(r.skipped.length, 0, JSON.stringify(r.skipped));
  assert.equal(r.transfers, 2);
  assert.equal(r.loose, 0);
  assert.deepEqual(r.txs.filter(t => t.type === 'transfer').map(t => [t.accountId, t.toAccountId, t.amount]).sort(), [['maybank', 'cash', 20000], ['maybank', 'tng', 10000]]);
  assert.equal(r.sum('expense'), 12790);
  assert.equal(r.sum('income'), 352000);
  assert.deepEqual(r.bal, { ...SAME, maybank: SAME.maybank + opening });
  assert.equal(r.txs.length, 7);
  const pay = r.txs.find(t => t.type === 'income' && t.amount === 350000), lunch = r.txs.find(t => t.amount === 1250);
  assert.deepEqual([pay.date, pay.category, pay.accountId], ['2026-09-01', ['ynab', 'bluecoins'].includes(id) ? 'income' : 'salary', 'maybank']);   // YNAB: Ready to Assign; Bluecoins: source parent Employment (child Salary stays)
  assert.deepEqual([lunch.date, lunch.category, lunch.accountId], ['2026-09-03', 'dining', 'cash']);
  if (id === 'bluecoins') { assert.equal(pay.sub, 'Salary'); assert.equal(lunch.sub, 'Restaurant'); }
  assert.match(`${lunch.merchant} ${lunch.note}`, /Nasi lemak/);
  assert.equal(r.txs.find(t => t.amount === 2000).category, 'income');
  assert.equal(r.txs.find(t => t.amount === 3000).category, 'transport');
});

test('dates and times as each app writes them', () => {
  // Spendee: UTC → Malaysian time, across midnight
  const s = run(csv('spendee.csv'), 'spendee.csv');
  assert.deepEqual([s.find('Nasi lemak').date, s.find('Nasi lemak').time], ['2026-09-03', '12:40']);
  assert.deepEqual([s.find('Refund').date, s.find('Refund').time], ['2026-09-21', '01:30']);
  // AndroMoney: yyyyMMdd and a Time column without leading zeros; Wallet and Cashew: date-time cells
  const a = run(csv('andromoney.csv'), 'andromoney.csv');
  assert.deepEqual([a.find('Plus').time, a.find('Mamak Ali').time, a.find('Mamak Ali').note], ['08:30', '12:40', 'Nasi lemak']);
  assert.equal(run(csv('wallet.csv'), 'w').find('Tesco').time, '18:00');
  assert.equal(run(csv('cashew.csv'), 'c').find('Nasi lemak').time, '12:40');
  // 1Money writes MM/dd/yy: with no day above 12 in the file to tell, 09/05/26 is still 5 September
  const one = csv('onemoney.csv').filter(r => !/^09\/(1|2)/.test(r[0]));
  assert.deepEqual(run(one, 'o').txs.map(t => t.date), ['2026-09-01', '2026-09-03', '2026-09-02', '2026-09-05']);
});

test('categories: the app\'s defaults land in Tally\'s, and an empty payee falls back to the note', () => {
  assert.equal(run(csv('moneylover.csv'), 'm').find('Tesco').category, 'household');   // Houseware
  const m = run(csv('monefy.csv'), 'm');
  assert.equal(m.find('Tesco').category, 'groceries');   // Monefy "Food" is groceries, "Eating out" dining
  const food = run([...csv('monefy.csv').slice(0, 1), ['03/09/2026', 'Cash', 'Food', '-12.50', 'MYR', '-12.50', 'MYR', 'KFC']], 'm').find('KFC');
  assert.equal(food.category, 'dining');   // "Food" at KFC is a meal
  const paid = run([...csv('monefy.csv').slice(0, 1), ['01/09/2026', 'Maybank', 'Gifts', '50', 'MYR', '50', 'MYR', 'Angpau']], 'm').txs[0];
  assert.equal(paid.type, 'income');   // a file with only money in is still money in
  const w = run(csv('wallet.csv'), 'w');
  assert.deepEqual([w.find('Mamak Ali').category, w.find('Mamak Ali').note, w.find('Acme Sdn Bhd').category], ['dining', 'Nasi lemak', 'salary']);
  const y = run(csv('ynab_register.csv'), 'y');
  assert.deepEqual([y.find('Tesco').category, y.find('Acme Sdn Bhd').category, y.find('Acme Sdn Bhd').note], ['groceries', 'income', 'September pay']);
  assert.equal(run(csv('cashew.csv'), 'c').find('Toll').category, 'transport');   // Transit
});

test('Money Lover and Realbyte Excel exports', async () => {
  const ml = run(await IO.fileToRows('x.xlsx', await xlsx(moneyLoverOldRows)), 'MoneyLover.xlsx');
  assert.equal(ml.preset.id, 'moneylover');
  assert.deepEqual(ml.bal, SAME);
  assert.equal(ml.find('Nasi lemak').time, '12:40');
  const rb = run(await IO.fileToRows('x.xlsx', await xlsx(realbyteRows)), 'Money Manager.xlsx');
  assert.equal(rb.preset.id, 'realbyte');
  assert.equal(rb.transfers, 2);
  assert.deepEqual(rb.bal, { ...SAME, maybank: SAME.maybank + 100000 });
  assert.equal(rb.adjustments, 1);
  assert.deepEqual([rb.find('Nasi lemak').date, rb.find('Nasi lemak').time, rb.find('Nasi lemak').note, rb.find('Tesco').category], ['2026-09-03', '12:40', 'Mamak Ali', 'household']);
});

test('a transfer half whose other account is not in the file stays money in or out, worded so it pairs later', () => {
  const rows = csv('spendee.csv').filter(r => r[1] !== 'TNG');
  const r = run(rows, 'spendee.csv');
  assert.equal(r.transfers, 1);
  assert.equal(r.loose, 1);
  const out = r.txs.find(t => t.type === 'expense' && t.amount === 10000);
  assert.deepEqual([out.category, out.merchant, out.note], ['other', 'Reload', 'Transfer']);
});

test('the mapping sheet keeps transfer and correction rows out of the category list', () => {
  const rows = csv('ynab_register.csv'), header = rows[0], preset = detectPreset(header);
  const cats = new Set(rows.slice(1).filter(r => IO.isMoneyRow(r, preset.map, { preset, header })).map(r => r[preset.map.category]));
  assert.deepEqual([...cats].sort(), ['Dining Out', 'Groceries', 'Ready to Assign', 'Transportation']);
  const one = csv('onemoney.csv'), p1 = detectPreset(one[0]);
  assert.ok(!one.slice(1).filter(r => IO.isMoneyRow(r, p1.map, { preset: p1, header: one[0] })).some(r => r[3] === 'TNG'));
});

test('not every sheet is an app export; Mobills is read; AndroMoney Big5 text is decoded', () => {
  assert.equal(detectPreset(['Date', 'Category', 'Amount', 'Note']), null);
  assert.equal(detectPreset(['Transaction Date', 'Description', 'Debit', 'Credit', 'Balance']), null);
  const mb = run(IO.parseCSV(IO.decodeBytes(fixture('mobills.csv'))), 'mobills.csv');
  assert.deepEqual([mb.preset.id, mb.sum('income'), mb.sum('expense')], ['mobills', 350000, 9790]);
  const big5 = new Uint8Array([...new TextEncoder().encode('AndroMoney\n'), 0xa4, 0xa4, 0xa4, 0xe5]);
  assert.equal(IO.decodeBytes(big5), 'AndroMoney\n中文');
  assert.equal(IO.fileDate('20260928'), '2026-09-28');
});

test('Money Manager (Realbyte) .mmbak: bare or zipped; transfers once, corrections into opening balances, categories kept', async () => {
  const SQL = await sqlJs(), bytes = realbyteDb(SQL);
  for (const buf of [bytes, new Uint8Array(await IO.zipStore([{ name: 'backup.mmbak', data: bytes }]).arrayBuffer())]) {
    const mm = await readRealbyte(buf, SQL, { now: 1 });
    assert.deepEqual(mm.accounts.map(a => [a.name, a.opening]), [['Maybank', 100000], ['TNG', 0], ['Cash', -500]]);
    assert.equal(mm.transfers, 2);
    assert.equal(mm.adjustments, 2);
    assert.equal(mm.tx.length, 8);   // 6 entries + 2 transfers; the mirror halves and the deleted row left out
    const by = m => mm.tx.find(t => t.merchant === m), cat = id => mm.customCats.find(c => c.id === id)?.name || id;
    assert.deepEqual([by('Reload').type, by('Reload').accountId, by('Reload').toAccountId], ['transfer', 'rb_a-bank', 'rb_a-tng']);
    assert.deepEqual([by('Nasi lemak').date, by('Nasi lemak').time, cat(by('Nasi lemak').category)], ['2026-09-03', '12:40', 'Food']);   // Breakfast, under Food: their category keeps its name
    assert.deepEqual([by('Refund').type, by('Refund').category, by('September pay').category], ['income', 'income', 'salary']);
    assert.deepEqual([cat(by('Musang King').category), cat(by('Toll').category), by('Tesco').category], ['Durian Trips', 'Transportation', 'household']);   // exactly Tally's name: Tally's
    assert.deepEqual(mm.customCats.map(c => c.name), ['Food', 'Transportation', 'Durian Trips']);
    const bal = Object.fromEntries(mm.accounts.map(a => [a.id, a.opening]));
    for (const t of mm.tx) { bal[t.accountId] += t.type === 'income' ? t.amount : -t.amount; if (t.type === 'transfer') bal[t.toAccountId] += t.amount; }
    assert.deepEqual(bal, { 'rb_a-bank': 411460, 'rb_a-tng': 7000, 'rb_a-cash': 19450 });
  }
  await assert.rejects(readRealbyte(new Uint8Array(await IO.zipStore([{ name: 'x.txt', data: new Uint8Array(200) }]).arrayBuffer()), SQL), /no database inside/);
});

test("Tally reads its own CSV export back: transfers, times, categories", () => {
  const acc = [{ id: 'a', name: 'Cash' }, { id: 'b', name: 'Maybank' }];
  const tx = [{ date: '2026-09-01', time: '12:30', type: 'expense', amount: 1250, accountId: 'a', category: 'dining', merchant: 'Mamak' },
    { date: '2026-09-02', type: 'transfer', amount: 10000, accountId: 'b', toAccountId: 'a', category: 'other' },
    { date: '2026-09-03', type: 'income', amount: 350000, accountId: 'b', category: 'salary', merchant: 'Acme' }];
  const r = run(IO.parseCSV(IO.toCSV(tx, acc).replace(/^﻿/, '')), 'tally-export.csv');
  assert.equal(r.preset.id, 'tally');
  assert.deepEqual(r.txs.map(t => [t.type, t.amount, t.category, t.time || '']).sort(), [['expense', 1250, 'dining', '12:30'], ['income', 350000, 'salary', ''], ['transfer', 10000, 'other', '']]);
  assert.deepEqual(r.bal, { cash: -1250 + 10000, maybank: 350000 - 10000 });
});

test('Money Lover: loans are not bills, Exclude Report rows are corrections', () => {
  const h = ['ID', 'Note', 'Amount', 'Category', 'Account', 'Currency', 'Date', 'Event', 'Exclude Report'];
  const r = run([h, ['1', 'Lent Wei Ming', '-300', 'Loan', 'Cash', 'MYR', '03/05/2026', '', 'FALSE'], ['2', 'Fix', '-23.45', 'Others', 'Cash', 'MYR', '31/08/2026', '', 'TRUE'], ['3', 'Wei Ming paid back', '300', 'Debt Collection', 'Cash', 'MYR', '02/06/2026', '', 'FALSE']], 'MoneyLover.csv');
  assert.deepEqual(r.txs.map(t => [t.type, t.category]), [['expense', 'other'], ['income', 'income']]);
  assert.equal(r.opening.cash, -2345);   // the excluded row moves the opening balance instead
});

test('Excel (.xlsx) and QIF exports read back: transfers, items, income, both accounts', async () => {
  const acc = [{ id: 'a', name: 'Cash', kind: 'cash' }, { id: 'b', name: 'Maybank', kind: 'bank' }];
  const tx = [{ date: '2026-09-01', time: '12:30', type: 'expense', amount: 1060, accountId: 'a', category: 'groceries', merchant: 'Mydin <&>', note: 'line\nbreak', items: [{ name: 'Milo', cents: 700, category: 'groceries' }, { name: 'Sabun', cents: 300, category: 'household' }] },
    { date: '2026-09-02', type: 'transfer', amount: 10000, accountId: 'b', toAccountId: 'a', category: 'other' },
    { date: '2026-09-13', type: 'income', amount: 350000, accountId: 'b', category: 'salary', merchant: 'Acme' }];
  const buf = async blob => new Uint8Array(await blob.arrayBuffer());
  const x = run(await IO.fileToRows('tally.xlsx', await buf(IO.toXlsx(IO.txRows(tx, acc)))), 'tally.xlsx');
  assert.equal(x.preset.id, 'tally');
  assert.deepEqual(x.bal, { cash: -1060 + 10000, maybank: 350000 - 10000 });
  const qif = IO.toQIF(tx, acc);
  assert.match(qif, /!Account\nNCash\nTCash\n\^\n!Type:Cash\nD09\/01\/2026\nT-10\.60\nPMydin <&>\nMline break\nLGroceries\nSGroceries\nEMilo\n\$-7\.42/);
  const q = run(await IO.fileToRows('tally.qif', new TextEncoder().encode(qif)), 'tally.qif');
  assert.equal(q.preset.id, 'qif');
  assert.deepEqual(q.txs.filter(t => t.type === 'transfer').map(t => t.amount), [10000]);   // both halves, one transfer
  assert.deepEqual(q.bal, { cash: -1060 + 10000, maybank: 350000 - 10000 });
  assert.equal(q.txs.find(t => t.type === 'income').date, '2026-09-13');   // month first
});

test('OFX bank downloads (SGML and XML) import with signed amounts and ISO dates', async () => {
  const sgml = 'OFXHEADER:100\nDATA:OFXSGML\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>MYR<BANKACCTFROM><BANKID>MBB<ACCTID>5140123<ACCTTYPE>SAVINGS</BANKACCTFROM><BANKTRANLIST>\n<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260903120000[+8:MYT]<TRNAMT>-45.20<FITID>1<NAME>PETRONAS CHERAS<MEMO>POS</STMTTRN>\n<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260925<TRNAMT>3500.00<FITID>2<NAME>SALARY ACME</STMTTRN>\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>';
  const q = run(await IO.fileToRows('bank.ofx', new TextEncoder().encode(sgml)), 'bank.ofx');
  assert.equal(q.preset.id, 'qif');
  assert.deepEqual(q.txs.map(t => [t.date, t.type, t.amount, t.merchant]).sort(), [['2026-09-03', 'expense', 4520, 'Petronas Cheras'], ['2026-09-25', 'income', 350000, 'Salary Acme']]);
  const xml = '<?xml version="1.0"?><?OFX OFXHEADER="200"?><OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CCACCTFROM><ACCTID>4111</ACCTID></CCACCTFROM><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260910</DTPOSTED><TRNAMT>-12.90</TRNAMT><NAME>TEALIVE</NAME></STMTTRN></BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>';
  assert.deepEqual(IO.ofxToRows(xml).slice(1), [['2026-09-10', '-12.90', 'TEALIVE', '', '', '4111']]);
});
