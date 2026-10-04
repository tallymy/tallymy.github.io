// Synthetic files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as IO from '../js/io.js';

test('money-app CSV export: columns guessed, type column wins, categories mapped', () => {
  const csv = 'Date,Category,Amount,Income/Expense,Note\n28/09/2026,Food & Drinks,12.90,Expense,Nasi lemak\n27/09/2026,Salary,3500.00,Income,September pay\n26/09/2026,Transportation,50,Expense,Petronas';
  const [head, ...rows] = IO.parseCSV(csv);
  const map = IO.guessMapping(head);
  assert.deepEqual(map, { date: 0, type: 3, category: 1, note: 4, amount: 2 });
  const { txs, skipped } = IO.rowsToTx(rows, map, { accountId: 'cash', now: 1 });
  assert.equal(skipped.length, 0);
  assert.deepEqual(txs.map(t => [t.date, t.type, t.amount, t.category, t.merchant]), [
    ['2026-09-28', 'expense', 1290, 'dining', 'Nasi lemak'],
    ['2026-09-27', 'income', 350000, 'salary', 'September pay'],
    ['2026-09-26', 'expense', 5000, 'transport', 'Petronas'],
  ]);
});

test('bank statement: debit/credit columns, semicolons, bad rows skipped with a reason', () => {
  const csv = 'Transaction Date;Description;Debit;Credit;Balance\n01-09-2026;DUITNOW TO ALI;150.00;;1000.00\n02-09-2026;SALARY SEPT;;4,200.00;5200.00\n31-02-2026;BAD DATE;1.00;;\n03-09-2026;NO AMOUNT;;;';
  const [head, ...rows] = IO.parseCSV(csv);
  const map = IO.guessMapping(head);
  assert.equal(map.debit, 2); assert.equal(map.credit, 3); assert.equal(map.merchant, 1);
  const { txs, skipped } = IO.rowsToTx(rows, map, { accountId: 'bank', source: 'statement' });
  assert.deepEqual(txs.map(t => [t.type, t.amount]), [['expense', 15000], ['income', 420000]]);
  assert.deepEqual(skipped.map(s => s.why), ['date', 'amount']);
});

test('Chinese headers and signed amounts', () => {
  const [head, ...rows] = IO.parseCSV('日期,类别,金额,备注\n2026/9/28,餐饮,-18.50,午餐\n2026年9月27日,工资,3000,九月');
  const { txs } = IO.rowsToTx(rows, IO.guessMapping(head), { accountId: 'a' });
  assert.deepEqual(txs.map(t => [t.date, t.type, t.amount, t.category]), [['2026-09-28', 'expense', 1850, 'dining'], ['2026-09-27', 'income', 300000, 'salary']]);
});

test('fileDate formats', () => {
  assert.equal(IO.fileDate('46293'), '2026-09-28'); // Excel serial
  assert.equal(IO.fileDate('28 Sep 2026'), '2026-09-28');
  assert.equal(IO.fileDate('28 Mac 2026'), '2026-03-28');
  assert.equal(IO.fileDate('13/13/2026'), null);
  assert.equal(IO.fileDate('hello'), null);
});

// A tiny .xlsx built by hand: shared strings, an inline string, a number and an Excel date serial.
async function makeXlsx() {
  const enc = s => new TextEncoder().encode(s);
  const files = [
    ['xl/sharedStrings.xml', enc('<sst><si><t>Date</t></si><si><t>Amount</t></si><si><t>Note</t></si><si><r><t>Kopi </t></r><r><t>O &amp; roti</t></r></si></sst>'), 0],
    ['xl/worksheets/sheet1.xml', enc('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2"><v>46293</v></c><c r="B2"><v>-6.5</v></c><c r="C2" t="s"><v>3</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>27/09/2026</t></is></c><c r="C3" t="inlineStr"><is><t>no amount</t></is></c></row></sheetData></worksheet>'), 8],
  ];
  return zipOf(files);
}
/** [name, bytes, method (0 stored, 8 deflated), declared size?] → zip bytes. */
async function zipOf(files) {
  const enc = s => new TextEncoder().encode(s);
  const deflate = async u8 => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  files = files.map(([name, data, method = 0, size]) => [name, typeof data === 'string' ? enc(data) : data, method, size]);
  const parts = [], central = [];
  let off = 0;
  for (const [name, raw, method, declared = raw.length] of files) {
    const data = method === 8 ? await deflate(raw) : raw;
    const n = enc(name), h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint32(14, IO.crc32(raw), true); h.setUint32(14, IO.crc32(raw), true); h.setUint16(8, method, true); h.setUint32(18, data.length, true); h.setUint32(22, declared, true); h.setUint16(26, n.length, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint32(16, IO.crc32(raw), true); c.setUint32(16, IO.crc32(raw), true); c.setUint16(10, method, true); c.setUint32(20, data.length, true); c.setUint32(24, declared, true); c.setUint16(28, n.length, true); c.setUint32(42, off, true);
    parts.push(new Uint8Array(h.buffer), n, data); central.push(new Uint8Array(c.buffer), n);
    off += 30 + n.length + data.length;
  }
  const cdSize = central.reduce((s, x) => s + x.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  return new Uint8Array(await new Blob([...parts, ...central, new Uint8Array(e.buffer)]).arrayBuffer());
}

test('xlsx: read without a library, routed by content not name', async () => {
  const rows = await IO.fileToRows('whatever.csv', (await makeXlsx()).buffer);
  assert.deepEqual([...rows], [['Date', 'Amount', 'Note'], ['46293', '-6.5', 'Kopi O & roti'], ['27/09/2026', '', 'no amount']]);
  const { txs, skipped } = IO.rowsToTx(rows.slice(1), IO.guessMapping(rows[0]), { accountId: 'a' });
  assert.deepEqual(txs.map(t => [t.date, t.amount, t.merchant]), [['2026-09-28', 650, 'Kopi O & roti']]);
  assert.equal(skipped.length, 1);
  await assert.rejects(IO.fileToRows('x.xls', new Uint8Array([0xd0, 0xcf, 0x11]).buffer), /\.xls/);
});

test('Google Sheets link → CSV export URL', () => {
  assert.equal(IO.sheetCsvUrl('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=42'),
    'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/export?format=csv&gid=42');
  assert.equal(IO.sheetCsvUrl('https://evil.example/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz'), null);
  assert.equal(IO.sheetCsvUrl('javascript:alert(1)'), null);
});

test('CSV export is formula-safe with a BOM and one row per receipt item', () => {
  const csv = IO.toCSV([
    { date: '2026-09-28', type: 'expense', amount: 2000, accountId: 'a', merchant: '=HYPERLINK("x")', category: 'dining', items: [{ name: '@SUM(1)', cents: 1500, category: 'dining' }, { name: 'Air', cents: 500, category: 'groceries' }] },
  ], [{ id: 'a', name: 'Cash' }]);
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.slice(1).split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[1].includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(lines[1].includes("'@SUM(1)"));
});

test('backup round trip; hostile or broken entries dropped; merge keeps local', () => {
  const good = { accounts: [{ id: 'a', name: 'Cash', kind: 'cash', opening: 1000 }], tx: [{ id: 't1', date: '2026-09-01', type: 'expense', amount: 500, accountId: 'a', category: 'dining', items: [{ name: 'Teh', cents: 500, category: 'dining', qty: 2, unit: 250 }] }], recurring: [], kv: { budgets: { total: 100000, byCat: { dining: 30000, hacked: 5 } }, rules: { TEH: 'dining' } } };
  const back = IO.readBackup(IO.makeBackup(good));
  assert.equal(back.tx.length, 1);
  assert.deepEqual([back.tx[0].items[0].qty, back.tx[0].items[0].unit], [2, 250]);   // "Teh 2x2.50" keeps its quantity
  assert.deepEqual(back.kv.budgets.byCat, { dining: 30000 });
  const evil = JSON.parse(IO.makeBackup(good));
  evil.tx.push({ id: 'x', date: '2026-02-30', type: 'expense', amount: 1, accountId: 'a' }, { id: 'y', date: '2026-09-01', type: 'expense', amount: -5, accountId: 'a' },
    { id: 'z', date: '2026-09-01', type: 'expense', amount: 1e15, accountId: 'a' }, { id: 'w', date: '2026-09-01', type: 'transfer', amount: 5, accountId: 'a', toAccountId: 'nope' },
    { id: 'n', date: '2026-09-01', type: 'expense', amount: 5, accountId: 'a', merchant: '<img src=x onerror=alert(1)>‮' });
  const r = IO.readBackup(JSON.stringify(evil));
  assert.deepEqual(r.tx.map(t => t.id), ['t1', 'n']);
  assert.equal(r.dropped, 4);
  assert.ok(!/‮/.test(r.tx[1].merchant)); // hidden bidi character removed (HTML is escaped at render)
  assert.throws(() => IO.readBackup('{"app":"other"}'), /not a Tally backup/);
  assert.throws(() => IO.readBackup('nope'), /not valid JSON/);
  const merged = IO.mergeBackup({ accounts: good.accounts, tx: [{ ...good.tx[0], note: 'local edit' }], recurring: [], kv: { rules: { TEH: 'groceries' } } }, back);
  assert.equal(merged.tx.length, 1);
  assert.equal(merged.tx[0].note, 'local edit');
  assert.equal(merged.kv.rules.TEH, 'groceries');
});

test('statement Balance column gives a new account its opening balance, oldest-first or newest-first', () => {
  const rows = [['Date', 'Description', 'Debit', 'Credit', 'Balance'], ['01/09/2026', 'CARD PURCHASE NASI LEMAK ANTARABANGSA', '59.53', '', '4,140.47'], ['03/09/2026', 'JOMPAY PETRONAS', '202.69', '', '3,937.78'], ['05/09/2026', 'SALARY', '', '3,000.00', '6,937.78'], ['09/10/2026', 'FPX TNB', '100.00', '', '6,837.78']];
  const map = IO.guessMapping(rows[0]);
  assert.equal(map.balance, 4);
  const { txs } = IO.rowsToTx(rows.slice(1), map, { accountId: 'a' });
  assert.equal(txs[0].merchant, 'Nasi Lemak Antarabangsa');   // shouting bank text reads as a name
  assert.equal(IO.openingFromBalance(rows.slice(1), map, txs, '2026-09-29'), 420000);   // 4,140.47 + 59.53
  const desc = [rows[0], ...rows.slice(1).reverse()];
  assert.equal(IO.openingFromBalance(desc.slice(1), map, IO.rowsToTx(desc.slice(1), map, { accountId: 'a' }).txs, '2026-09-29'), 420000);
  assert.equal(IO.openingFromBalance(rows.slice(1), { ...map, balance: undefined }, txs, '2026-09-29'), null);
  assert.equal(IO.cleanDesc('DUITNOW QR TNB'), 'TNB');
});

test('title rows above the header are skipped', () => {
  const rows = IO.parseCSV('Family Budget 2026,,,\nPrepared by Priya,,,\n,,,\nDate,Category,Amount (RM),Notes\n01/07/2026,Bills,159.73,Unifi\n');
  assert.equal(IO.headerRow(rows), 2);   // the blank row is dropped by the parser
  assert.equal(IO.headerRow([['Date', 'Amount'], ['01/07/2026', '5.00']]), 0);
});

test('photo backup zip: written stored, read back byte for byte', async () => {
  const photo = new Uint8Array(5000).map((_, i) => (i * 31) & 255);
  const blob = IO.zipStore([{ name: IO.BACKUP_JSON, data: new TextEncoder().encode('{"app":"tally"}') }, { name: 'photos/p_1.jpg', data: photo }]);
  const out = await IO.unzip(await blob.arrayBuffer(), () => true);
  assert.equal(new TextDecoder().decode(out[IO.BACKUP_JSON]), '{"app":"tally"}');
  assert.deepEqual([...out['photos/p_1.jpg']], [...photo]);
});

test('CSV export: an itemised receipt with SST adds up to what was paid', () => {
  const tx = [{ id: 't', date: '2026-09-01', type: 'expense', amount: 1060, accountId: 'a', category: 'groceries', merchant: 'Mydin', items: [{ name: 'Milo', cents: 700, category: 'groceries' }, { name: 'Sabun', cents: 300, category: 'household' }] }];
  const rows = IO.toCSV(tx, [{ id: 'a', name: 'Cash' }]).replace(/^\uFEFF/, '').trim().split(/\r?\n/).slice(1);
  assert.equal(rows.reduce((s, r) => s + Math.round(parseFloat(r.split(',')[2]) * 100), 0), 1060);
});

test('zip: one inflate budget per file, declared sizes held, entries capped, repeats read once, broken offsets refused', async () => {
  const enc = s => new TextEncoder().encode(s), zeros = new Uint8Array(400_000);
  const two = await zipOf([['a', zeros, 8], ['b', zeros, 8]]);
  assert.equal((await IO.unzip(two, () => true)).b.length, 400_000);
  await assert.rejects(IO.unzip(two, () => true, { budget: 500_000 }), /too big/);   // a bomb spread over many entries
  await assert.rejects(IO.unzip(await zipOf([['a', zeros, 8, 1000]]), () => true), /too big/);   // inflates past its declared size
  await assert.rejects(IO.unzip(await zipOf([['s', zeros, 0]]), () => true, { budget: 1000 }), /too big/);
  const many = await zipOf(['1', '2', '3', '4', '5'].map(n => [`photos/${n}.jpg`, enc(n), 0]));
  assert.equal(Object.keys(await IO.unzip(many, () => true, { entries: 3 })).length, 3);
  const dup = await IO.unzip(await zipOf([['a', enc('first'), 0], ['a', enc('second'), 8], ['__proto__', enc('x'), 0]]), () => true);
  assert.equal(new TextDecoder().decode(dup.a), 'first');
  assert.equal(new TextDecoder().decode(dup.__proto__), 'x');
  assert.equal({}.length, undefined);
  const broken = [new Uint8Array([1, 2, 3]), enc('PK\x05\x06 not really a zip at all, just text'), two.slice(0, 60), two.slice(two.length - 22)];
  const far = two.slice(); new DataView(far.buffer).setUint32(far.length - 22 + 16, 0xffffff00, true); broken.push(far);   // central directory past the end
  const local = two.slice(), cd = new DataView(local.buffer).getUint32(local.length - 22 + 16, true); new DataView(local.buffer).setUint32(cd + 42, 0xfffff000, true); broken.push(local);
  for (const b of broken) await assert.rejects(IO.unzip(b, () => true), /bad zip/);
});

test('backup: reserved ids and keys dropped, only valid custom categories count, Object.prototype untouched', () => {
  const r = IO.readBackup(`{"app":"tally","v":1,
    "accounts":[{"id":"a","name":"Cash"},{"id":"__proto__"},{"id":"constructor"},{"id":"prototype"}],
    "tx":[{"id":"constructor","date":"2026-09-01","type":"expense","amount":5,"accountId":"a"},
      {"id":"t1","date":"2026-09-01","type":"expense","amount":5,"accountId":"a","category":"constructor"},
      {"id":"t2","date":"2026-09-01","type":"expense","amount":5,"accountId":"a","category":"c_ok","receiptId":"__proto__"},
      {"id":"t3","date":"2026-09-01","type":"expense","amount":5,"accountId":"a","category":"<b>x</b>"}],
    "kv":{"customCats":[{"id":"c_ok","name":"Ok"},{"id":"constructor","name":"x"},{"id":"<b>x</b>","name":"x"}],
      "rules":{"__proto__":{"polluted":1},"constructor":"dining","prototype":"dining","TEH":"constructor","KOPI":"c_ok"},
      "budgets":{"total":1,"byCat":{"__proto__":5,"constructor":5,"c_ok":7}}}}`);
  assert.deepEqual(r.accounts.map(a => a.id), ['a']);
  assert.deepEqual(r.tx.map(t => [t.id, t.category, t.receiptId]), [['t1', 'other', undefined], ['t2', 'c_ok', undefined], ['t3', 'other', undefined]]);
  assert.deepEqual(r.kv.customCats.map(c => c.id), ['c_ok']);
  assert.deepEqual(Object.entries(r.kv.rules), [['TEH', 'other'], ['KOPI', 'c_ok']]);
  assert.deepEqual(r.kv.budgets.byCat, { c_ok: 7 });
  const local = JSON.parse('{"accounts":[],"tx":[],"recurring":[],"kv":{"rules":{"__proto__":{"polluted":1}},"budgets":{"__proto__":{"polluted":1}}}}');
  const merged = IO.mergeBackup(local, r);
  assert.equal(merged.kv.rules.KOPI, 'c_ok');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  for (const [key, max] of [['accounts', 200], ['tx', 200_000], ['recurring', 500]]) {
    const backup = { app: 'tally', v: 1, [key]: Array.from({ length: max + 1 }, () => ({})) };
    assert.throws(() => IO.readBackup(JSON.stringify(backup)), /Nothing was restored/);
  }
  // A backup from before the 50-category cap restores (the first 50 kept) rather than being refused whole.
  assert.ok(IO.readBackup(JSON.stringify({ app: 'tally', v: 1, kv: { customCats: Array.from({ length: 51 }, (_, i) => ({ id: `c_${i}`, name: `C${i}` })) } })).kv.customCats.length <= 50);
  assert.throws(() => IO.readBackup(' '.repeat(IO.LIMITS.backupJson + 1)), /too big/);
});

test('CSV rejects over 50,000 rows instead of silently importing a prefix', () => {
  const text = 'a,b\n'.repeat(IO.LIMITS.rows + 1);
  assert.throws(() => IO.parseCSV(text), /Split it into smaller files/);
  assert.equal(IO.parseCSV('a,b\n'.repeat(IO.LIMITS.rows)).length, IO.LIMITS.rows);
});

test('a fetched body is refused past its cap, by Content-Length or while streaming', async () => {
  await assert.rejects(IO.readCapped(new Response('x', { headers: { 'content-length': '999999' } }), 100), /too big/);
  await assert.rejects(IO.readCapped(new Response('x'.repeat(1000)), 100), /too big/);
  assert.equal(new TextDecoder().decode(await IO.readCapped(new Response('hello'), 100)), 'hello');
});

// ---- wallets, several tabs, account columns, transfers between own accounts -----------------------------------------
const ws = rows => `<worksheet><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => (v === '' ? '' : typeof v === 'number' ? `<c r="${'ABCDEF'[j]}${i + 1}"><v>${v}</v></c>` : `<c r="${'ABCDEF'[j]}${i + 1}" t="inlineStr"><is><t>${v}</t></is></c>`)).join('')}</row>`).join('')}</sheetData></worksheet>`;
test('xlsx with a tab per year: every tab with the same header is read in tab order, a Pivot tab is skipped', async () => {
  const head = ['Date', 'Item', 'Category', 'Amount', 'Paid by', 'Remarks'];
  const zip = await zipOf([
    ['xl/workbook.xml', '<workbook><sheets><sheet name="2024" sheetId="1" r:id="rId3"/><sheet name="Pivot" sheetId="4" r:id="rId1"/><sheet name="2025" sheetId="2" r:id="rId2"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', ws([['SUM of Amount', '2024', '2025'], ['Parents', 800, 300]])],
    ['xl/worksheets/sheet2.xml', ws([['Mei Ling - Expenses 2025'], head, [45700, 'Wet market', 'Groceries', 80.75, 'TNG', ''], [45701, 'Allowance for Mum', 'Parents', 300, 'Card', '妈妈']])],
    ['xl/worksheets/sheet3.xml', ws([['Mei Ling - Expenses 2024'], head, [45300, 'Nasi lemak', 'Food & Beverage', 6.5, 'Cash', ''], [45301, 'Dad birthday dinner', 'Parents', 500, 'Card', '']])],
  ]);
  const rows = await IO.fileToRows('meiling.xlsx', zip.buffer);
  assert.deepEqual(rows.tabs, { read: ['2024', '2025'], skipped: [{ name: 'Pivot', why: 'columns' }] });
  const h = IO.headerRow(rows), map = IO.guessMapping(rows[h]);
  assert.deepEqual(map, { date: 0, merchant: 1, category: 2, amount: 3, account: 4, note: 5 });
  const { txs } = IO.rowsToTx(rows.slice(h + 1), map, { accountId: 'fallback', accounts: { cash: 'a_cash', card: 'a_card', tng: 'a_tng' }, customCats: [{ id: 'c_par', name: 'Parents' }], catMap: { 'Food & Beverage': 'dining' } });
  assert.deepEqual(txs.map(t => [t.date, t.amount, t.accountId, t.category, t.merchant]), [
    ['2024-01-09', 650, 'a_cash', 'dining', 'Nasi lemak'], ['2024-01-10', 50000, 'a_card', 'c_par', 'Dad birthday dinner'],
    ['2025-02-12', 8075, 'a_tng', 'groceries', 'Wet market'], ['2025-02-13', 30000, 'a_card', 'c_par', 'Allowance for Mum'],
  ]);
});

test('xlsx parsing is linear: a 400 KB sheet of unclosed "<row " (and other junk) parses fast', () => {
  for (const junk of ['<row '.repeat(80_000), '<row><c r="A1"><v>1'.repeat(20_000), '<c<c<c'.repeat(70_000), `<row>${'<c r="A1"/>'.repeat(40_000)}</row>`]) {
    const t0 = performance.now();
    IO.sheetRows(junk, []);
    assert.ok(performance.now() - t0 < 500, `${junk.slice(0, 12)}… took ${Math.round(performance.now() - t0)} ms`);
  }
  assert.deepEqual(IO.sheetRows('<row r="1"><c r="B1" t="s"><v>0</v></c><col/><c r="C1"><v>2.5</v></c></row>', ['Teh']), [['', 'Teh', '2.5']]);
});

test("Touch 'n Go export: Wallet Balance and Transaction Type mapped; reloads are money in; time kept", () => {
  const [head, ...rows] = IO.parseCSV('Date,Status,Transaction Type,Reference,Description,Details,Amount (RM),Wallet Balance\n01/09/2026 02:14,Success,Payment,TNG1,7-Eleven Jln Hospital,eWallet Balance,RM8.60,RM3.80\n01/09/2026 07:52,Success,Reload,TNG2,Reload via Maybank,Maybank2u,RM100.00,RM103.80\n02/09/2026 23:40,Success,DuitNow QR,TNG3,Nasi Kerabu Kak Nab,eWallet Balance,RM7.50,RM96.30');
  const map = IO.guessMapping(head);
  assert.deepEqual(map, { date: 0, balance: 7, type: 2, merchant: 4, note: 5, amount: 6 });
  const { txs } = IO.rowsToTx(rows, map, { accountId: 'w' });
  assert.deepEqual(txs.map(t => [t.time, t.type, t.amount, t.category, t.merchant]), [
    ['02:14', 'expense', 860, 'groceries', '7-Eleven Jln Hospital'], ['07:52', 'income', 10000, 'income', 'Reload via Maybank'], ['23:40', 'expense', 750, 'dining', 'Nasi Kerabu Kak Nab']]);
  assert.equal(IO.openingFromBalance(rows, map, txs, '2026-09-29'), 1240);
  // Type words alone (no balance column), and a DR/CR column next to an unsigned amount.
  const dir = words => IO.rowsToTx(words.map(w => ['01/09/2026', '5.00', w]), { date: 0, amount: 1, type: 2 }, { accountId: 'a' }).txs.map(t => t.type[0]).join('');
  assert.equal(dir(['Top up', 'Cash in', 'Tambah nilai', 'Receive', 'Payment', 'Purchase', 'Transfer', 'CR', 'DR', 'C', 'D', 'Refund']), 'iiiieeieieie');   // a lone Transfer row is a transfer half with no other side: money out, listed after the rest
  assert.deepEqual(IO.guessMapping(['Date', 'Description', 'Amount', 'DR/CR', 'Balance']), { date: 0, balance: 4, type: 3, merchant: 1, amount: 2 });
});

test('the running balance decides direction for unsigned amounts, oldest-first or newest-first', () => {
  const up = [['01/08/2026', 'Opening', '', '100.00'], ['02/08/2026', 'Shop', '30.00', '70.00'], ['03/08/2026', 'Salary', '500.00', '570.00'], ['04/08/2026', 'Kopi', '5.00', '565.00']];
  const map = { date: 0, merchant: 1, amount: 2, balance: 3 };
  assert.deepEqual(IO.rowsToTx(up, map, { accountId: 'a' }).txs.map(t => t.type), ['expense', 'income', 'expense']);
  assert.deepEqual(IO.rowsToTx([...up].reverse(), map, { accountId: 'a' }).txs.map(t => t.type), ['expense', 'income', 'expense']);
});

test('headers: exact names first, Income/Expense and Outflow/Inflow columns, Price, Item and Catatan as the description', () => {
  assert.deepEqual(IO.guessMapping(['Account', 'Flag', 'Date', 'Payee', 'Category Group/Category', 'Category Group', 'Category', 'Memo', 'Outflow', 'Inflow', 'Cleared']), { date: 2, debit: 8, credit: 9, category: 6, merchant: 3, note: 7, account: 0 });
  assert.deepEqual(IO.guessMapping(['Date', 'Description', 'Income', 'Expense', 'Balance']), { date: 0, balance: 4, debit: 3, credit: 2, merchant: 1 });
  assert.deepEqual(IO.guessMapping(['Date', 'Item', 'Category', 'Price']), { date: 0, category: 2, merchant: 1, amount: 3 });
  assert.deepEqual(IO.guessMapping(['Tarikh', 'Kategori', 'Jumlah (RM)', 'Catatan']), { date: 0, category: 1, merchant: 3, amount: 2 });
  for (const h of ['Paid by', 'Payment method', 'Bayar guna', '付款方式', 'Account']) assert.equal(IO.guessMapping(['Date', 'Amount', h]).account, 2, h);
  assert.equal(IO.mapCategory('Barang Dapur'), 'groceries');
  assert.equal(IO.mapCategory('Petrol'), 'transport');
  assert.equal(IO.mapCategory('Groceries', {}, '', [{ id: 'c_1', name: 'Groceries' }]), 'c_1'); // the user's own category first
});

test('US-locale sheets: month first when the column says so', () => {
  const rows = [['7/4/2026', '1'], ['7/13/2026', '2'], ['9/18/2026', '3']];
  assert.equal(IO.dateOrder(rows, 0), true);
  assert.deepEqual(IO.rowsToTx(rows, { date: 0, amount: 1 }, { accountId: 'a' }).txs.map(t => t.date), ['2026-07-04', '2026-07-13', '2026-09-18']);
  assert.equal(IO.dateOrder([['13/7/2026'], ['4/7/2026']], 0), false);
  assert.equal(IO.fileDate('4/7/2026'), '2026-07-04');
});

test('descriptions: time, status and a repeated type word stripped; names trimmed after the 80-character cut', () => {
  assert.equal(IO.cleanDesc('07:52 Success Payment 7-Eleven Jln Hospital'), '7-Eleven Jln Hospital');
  assert.equal(IO.cleanDesc('13:07:21 Payment - Shopee Order'), 'Shopee Order');
  assert.equal(IO.cleanDesc('Berjaya DuitNow QR Nasi Kerabu'), 'Nasi Kerabu');
  assert.equal(IO.cleanDesc('Reload Reload via Maybank'), 'Reload via Maybank');
  assert.equal(IO.cleanDesc('Pending Grab Car'), 'Grab Car');
  const { txs } = IO.rowsToTx([['01/09/2026', '5', `${'x'.repeat(79)} yz`]], { date: 0, amount: 1, merchant: 2 }, { accountId: 'a' });
  assert.equal(txs[0].merchant, 'x'.repeat(79));
});

test('already here: same account only; the other side of a recorded transfer counts once', () => {
  const bank = { id: 'm1', date: '2026-09-01', type: 'expense', amount: 10000, accountId: 'mb', source: 'statement', merchant: 'Transfer to TNG' };
  const reload = { id: 'i1', date: '2026-09-01', type: 'income', amount: 10000, accountId: 'tng', source: 'import', merchant: 'Reload via Maybank' };
  assert.equal(IO.splitDups([bank], [reload]).fresh.length, 1);                                         // other account: new
  assert.equal(IO.splitDups([{ ...reload, id: 'x', source: 'statement' }], [reload]).dups.length, 1);   // CSV, then PDF, of one wallet
  const tr = IO.asTransfer([bank, reload]);
  assert.deepEqual([tr.id, tr.type, tr.accountId, tr.toAccountId], ['m1', 'transfer', 'mb', 'tng']);
  const again = { ...reload, id: 's9', source: 'statement' }, second = { ...again, id: 's10', date: '2026-09-02' };
  assert.deepEqual(IO.splitDups([tr], [again, second]), { fresh: [second], dups: [again] });            // one transfer stands for one row
});

test('pairTransfers: bank out + wallet in, same amount within a day, worded like a top-up; nothing else', () => {
  const tx = (id, date, type, amount, accountId, merchant) => ({ id, date, type, amount, accountId, merchant, category: type === 'income' ? 'income' : 'other' });
  const bank = [tx('b1', '2026-09-01', 'expense', 10000, 'mb', 'Transfer TO TNG Digital SDN BHD Reload'), tx('b2', '2026-09-08', 'expense', 5000, 'mb', 'Transfer TO TNG Digital'),
    tx('b3', '2026-09-02', 'expense', 35000, 'mb', 'Siti Aminah Sewa Bilik'), tx('b4', '2026-09-10', 'expense', 2000, 'mb', 'Transfer to Ali')];
  const wallet = [tx('w1', '2026-09-01', 'income', 10000, 'tng', 'Reload via Maybank'), tx('w2', '2026-09-09', 'income', 5000, 'tng', 'Reload via Maybank'),
    tx('w3', '2026-09-02', 'income', 35000, 'tng', 'Refund'), tx('w4', '2026-09-13', 'income', 2000, 'tng', 'Reload'), tx('w5', '2026-09-01', 'income', 10000, 'mb', 'Reload')];
  assert.deepEqual(IO.pairTransfers([...bank, ...wallet], wallet).map(([o, i]) => `${o.id}>${i.id}`), ['b1>w1', 'b2>w2']);
  assert.deepEqual(IO.pairTransfers([...bank, ...wallet], []), []);                                    // only pairs touching the import
  assert.equal(IO.pairTransfers([...bank, { ...wallet[0], category: 'salary' }], bank).length, 0);
});

test('backup keeps bills that add themselves and their payments, with bounded fields', () => {
  const back = IO.readBackup(IO.makeBackup({ accounts: [{ id: 'a', name: 'Bank', kind: 'bank', opening: 0 }],
    tx: [{ id: 'rec-b1-2026-09-05', date: '2026-09-05', type: 'expense', amount: 12900, accountId: 'a', category: 'bills', source: 'recurring', bill: 'b1' }],
    recurring: [{ id: 'b1', name: 'Astro', amount: 12900, day: 31, accountId: 'a', category: 'bills', freq: 'yearly', auto: true, count: 12, start: '2026-01-31', until: 'soon', last: '2026-09-29' }, { id: 'b2', name: 'X', amount: 1, day: 5, freq: 'hourly', auto: 'yes', count: 1e9 }], kv: {} }));
  assert.deepEqual([back.tx[0].source, back.tx[0].bill], ['recurring', 'b1']);
  const [r1, r2] = back.recurring;
  assert.deepEqual([r1.day, r1.freq, r1.auto, r1.count, r1.start, r1.until, r1.last], [31, 'yearly', true, 12, '2026-01-31', undefined, '2026-09-29']);
  assert.deepEqual([r2.freq, r2.auto, r2.count], [undefined, false, undefined]);
});

test('receipt photo names sort by date, say the shop and amount, and never clash or escape their folder', async () => {
  const { receiptName, csvLine } = await import('../js/io.js');
  const taken = new Set(), tx = { date: '2025-01-01', merchant: 'Good Timing: Food/Village', amount: 380 };
  assert.equal(receiptName(tx, taken), '2025-01-01 Good Timing Food Village RM3.80.jpg');
  assert.equal(receiptName(tx, taken), '2025-01-01 Good Timing Food Village RM3.80 (2).jpg');
  assert.equal(receiptName({ ...tx, merchant: '' }, taken, 'Medical/../x'), 'Medical .. x/2025-01-01 Receipt RM3.80.jpg');
  assert.equal(csvLine(['=HYPERLINK()', 'a,b']), `'=HYPERLINK(),"a,b"`);
});

test('an ATM withdrawal on a bank statement moves money to Cash; it is not spending', () => {
  const acc = [{ id: 'b', kind: 'bank', name: 'Maybank' }, { id: 'c', kind: 'cash', name: 'Cash' }];
  const r = IO.reloadTransfers([{ id: 'x', type: 'expense', accountId: 'b', amount: 10000, merchant: 'ATM Withdrawal MBB Cheras' }, { id: 'y', type: 'expense', accountId: 'b', amount: 500, merchant: 'Kedai ATMosphere' }], acc, '');
  assert.deepEqual(r.map(x => [x.id, x.type, x.accountId, x.toAccountId]), [['x', 'transfer', 'b', 'c']]);
});

test('password-protected backups: sealed, opened with the password, refused with a wrong one or a changed file', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ app: 'tally', tx: [{ id: 't', amount: 1250 }] }));
  const sealed = await IO.sealBackup(bytes, 'kopi-o-kosong');
  assert.ok(IO.isSealed(sealed) && !sealed.includes('1250'));
  assert.deepEqual(await IO.openBackup(sealed, 'kopi-o-kosong'), bytes);
  await assert.rejects(IO.openBackup(sealed, 'teh-o'), /Wrong password/);
  const o = JSON.parse(sealed); o.data = o.data.slice(0, -4) + 'AAAA';
  await assert.rejects(IO.openBackup(JSON.stringify(o), 'kopi-o-kosong'), /Wrong password/);
});
