import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { indexedDB } from './fixtures/idbshim.mjs';

let competitor = null;
globalThis.indexedDB = { open(name, version) {
  const request = indexedDB.open(name, version); let success;
  Object.defineProperty(request, 'onsuccess', { set(fn) { success = fn; }, get() { return () => {
    const connection = request.result, transact = connection.transaction.bind(connection);
    connection.transaction = (...args) => {
      if (competitor && args[1] === 'readwrite') {
        const { store, row, put } = competitor; competitor = null;
        const changes = put || { [store]: [row] }, earlier = transact(Object.keys(changes), 'readwrite');
        for (const [name, rows] of Object.entries(changes)) for (const value of rows) earlier.objectStore(name).put(value);
      }
      return transact(...args);
    }; success?.();
  }; } }); return request;
} };
const db = await import(`data:text/javascript;base64,${Buffer.from(await readFile(new URL('../js/db.js', import.meta.url), 'utf8')).toString('base64')}`);
await db.init();
const source = (await readFile(new URL('../js/views/splitbill.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
const io = await readFile(new URL('../js/io.js', import.meta.url), 'utf8');
const typed = io.slice(io.indexOf('export function typedShift('), io.indexOf('const ATM =')).replace('export ', '');
let engine;
try { engine = await readFile(new URL('../js/engine.js', import.meta.url), 'utf8'); }
catch { engine = await readFile(new URL('../../js/engine.js', import.meta.url), 'utf8'); }
const { isFx } = await import(`data:text/javascript;base64,${Buffer.from(engine).toString('base64')}`);
const allocate = engine.slice(engine.indexOf('export function allocate('), engine.indexOf('/** Where an expense')).replace('export ', '');
const old = { id: 'bill', accountId: 'cash', type: 'expense', amount: 1001, date: '2026-09-01', source: 'quick', merchant: 'Opened bill', createdAt: 1 };
const account = { id: 'cash', opening: 10000, typed: true, createdAt: new Date('2026-10-01T09:00:00').getTime() };
async function seed(txs = [old], accounts = [account]) {
  competitor = null;
  await db.writeAtomic({ clear: ['tx', 'accounts', 'kv'], put: { tx: txs, accounts, kv: [{ key: 'settings', value: {} }] } });
}
function harness(txs = [old], accounts = [account]) {
  const S = { tx: structuredClone(txs), accounts: structuredClone(accounts), kv: { settings: {} } }; let next = 0;
  const c = vm.createContext({ S, isFx, balHidden: () => false, structuredClone, getRecord: db.get, settings: () => S.kv.settings,
    bookGeneration: () => S.kv.bookGeneration, uid: prefix => `${prefix}${++next}`, todayIso: () => '2026-10-03', pad2: n => String(n).padStart(2, '0'),
    t: s => s, cat: () => ({ name: 'Other' }), validIso: d => /^\d{4}-\d{2}-\d{2}$/.test(d), console: { error() {} },
    putAll: async ({ accounts = [], tx = [], del = {}, expected = {} }) => {
      await db.writeAtomic({ del, put: { accounts, tx }, expected });
      S.tx = await db.all('tx'); S.accounts = await db.all('accounts');
    },
  });
  vm.runInContext(`${allocate}\n${typed}\n${source}\nthis.repaymentBase = repaymentBase;`, c);
  const guard = { expected: structuredClone(txs[0]), shares: structuredClone(txs.filter(x => x.splitOf === txs[0].id)), generation: undefined };
  return { c, S, guard, save: (options = {}) => c.saveSplit({ tx: old, people: ['__me', 'Ali'], who: [[]], ...options }, guard) };
}

test('PC edit while split sheet is open cannot be overwritten or split with old displayed totals', async () => {
  await seed(); const phone = harness(); const latest = { ...old, amount: 2000, merchant: 'PC latest' };
  await db.put('tx', latest); phone.S.tx = [latest];
  await assert.rejects(phone.save(), e => e.code === 'STALE');
  assert.deepEqual(await db.all('tx'), [latest]); assert.equal((await db.get('accounts', 'cash')).opening, 10000);
});
test('PC deletion cannot resurrect the opened bill or create its debts', async () => {
  await seed(); const phone = harness(); await db.del('tx', old.id);
  await assert.rejects(phone.save(), e => e.code === 'STALE');
  assert.deepEqual(await db.all('tx'), []); assert.equal((await db.all('accounts')).length, 1);
});
test('PC edit between split calculation and commit aborts bill, debts and account writes together', async () => {
  await seed(); const phone = harness(); competitor = { store: 'tx', row: { ...old, merchant: 'PC wins commit race', amount: 2000 } };
  await assert.rejects(phone.save(), e => e.code === 'STALE');
  assert.equal((await db.get('tx', old.id)).merchant, 'PC wins commit race');
  assert.equal((await db.all('tx')).length, 1); assert.deepEqual(await db.all('accounts'), [account]);
});
test('changed typed opening between calculation and commit is preserved', async () => {
  await seed(); const phone = harness(); competitor = { store: 'accounts', row: { ...account, opening: 50000 } };
  await assert.rejects(phone.save({ paidBy: 'Ali' }), e => e.code === 'STALE');
  assert.equal((await db.get('accounts', 'cash')).opening, 50000); assert.deepEqual(await db.all('tx'), [old]);
});
test('a dependent share changed after opening cannot be deleted by resplitting', async () => {
  const debt = { id: 'debt', splitOf: old.id, amount: 100, accountId: 'cash', toAccountId: 'owing', type: 'transfer' };
  await seed([old, debt]); const phone = harness([old, debt]); await db.put('tx', { ...debt, amount: 200 });
  await assert.rejects(phone.save(), e => e.code === 'STALE');
  assert.equal((await db.get('tx', 'debt')).amount, 200); assert.equal((await db.get('tx', old.id)).amount, 1001);
});
test('successful guarded split keeps odd sen allocation and paying-account balance unchanged', async () => {
  await seed(); const phone = harness(); await phone.save(); const rows = await db.all('tx');
  assert.equal(rows.find(x => x.id === old.id).amount, 501);
  assert.equal(rows.find(x => x.splitOf === old.id).amount, 500);
  assert.equal(rows.reduce((s, x) => s + x.amount, 0), old.amount);
  assert.equal((await db.get('accounts', 'cash')).opening, 10000);
});
test('successful friend-paid split commits typed opening correction and debt account atomically', async () => {
  await seed(); const phone = harness(); await phone.save({ paidBy: 'Ali' });
  const bill = await db.get('tx', old.id); assert.equal(bill.amount, 501); assert.equal(bill.owedTo, 'Ali');
  assert.equal((await db.get('accounts', bill.accountId)).kind, 'iowe');
  assert.equal((await db.get('accounts', 'cash')).opening, 8999);
});
test('replaced book refuses the old split form', async () => {
  await seed(); const phone = harness(); await db.put('kv', { key: 'bookGeneration', value: 'new-book' });
  await assert.rejects(phone.save(), e => e.code === 'STALE'); assert.deepEqual(await db.all('tx'), [old]);
});
test('unguarded direct API callers retain existing allocation behavior', async () => {
  await seed(); const phone = harness(); await phone.c.saveSplit({ tx: old, people: ['__me', 'Ali'], who: [[]] });
  assert.equal((await db.get('tx', old.id)).amount, 501);
});
test('stale Save my share keeps the split form and enables recovery instead of saving', async () => {
  await seed(); const phone = harness(); let click, closed = false, warning;
  Object.assign(phone.c, { esc: s => s, fmtDate: s => s, fmtRM: n => String(n), isFx: () => false,
    closeSheet: () => { closed = true; }, toast: message => { warning = message; },
    openSheet: () => ({ addEventListener(type, fn) { if (type === 'click') click = fn; }, querySelector() { return null; } }),
  });
  phone.c.openSplit(old); await db.del('tx', old.id);
  const button = { dataset: { x: 'save' }, disabled: false };
  await click({ target: { closest: selector => selector === '[data-x]' ? button : null } });
  assert.equal(button.disabled, false); assert.equal(closed, false);
  assert.match(warning, /Close this form and reopen/); assert.deepEqual(await db.all('tx'), []);
});

const owingAccount = { id: 'owing', kind: 'owedme', opening: 0 };
const owed = { id: 'owed', type: 'transfer', amount: 1000, accountId: 'cash', toAccountId: 'owing', owedBy: 'Ali', date: '2026-09-01' };
const repayment = { kind: 'owedme', name: 'Ali', amount: 500, total: 1000, boxId: 'owing', accountId: 'cash', date: '2026-09-15', today: '2026-10-03' };
function repayGuard(phone) { return { tx: phone.c.repaymentBase('owedme', 'Ali'), generation: undefined }; }
test('historical repayment cannot overwrite a concurrent PC row and typed balance adjustment', async () => {
  await seed([old, owed], [account, owingAccount]); const phone = harness([old, owed], [account, owingAccount]);
  const latest = { ...old, amount: 2500 }, latestAccount = { ...account, opening: 11499 };
  competitor = { put: { tx: [latest], accounts: [latestAccount] } };
  await assert.rejects(phone.c.saveRepayment(repayment, repayGuard(phone)), e => e.code === 'STALE');
  assert.deepEqual(await db.get('tx', old.id), latest); assert.deepEqual(await db.get('accounts', 'cash'), latestAccount);
  assert.equal((await db.all('tx')).length, 2);
});
test('successful historical repayment commits its transfer and typed adjustment together', async () => {
  await seed([old, owed], [account, owingAccount]); const phone = harness([old, owed], [account, owingAccount]);
  const rows = await phone.c.saveRepayment(repayment, repayGuard(phone));
  assert.equal(rows.tx[0].repaidBy, 'Ali'); assert.equal((await db.get('accounts', 'cash')).opening, 9500);
  assert.equal((await db.all('tx')).length, 3);
});
test('today repayment keeps typed opening unchanged', async () => {
  await seed([old, owed], [account, owingAccount]); const phone = harness([old, owed], [account, owingAccount]);
  await phone.c.saveRepayment({ ...repayment, date: '2026-10-03' }, repayGuard(phone));
  assert.equal((await db.get('accounts', 'cash')).opening, 10000); assert.equal((await db.all('tx')).length, 3);
});
test('changed or deleted debt row refuses the repayment without writing', async () => {
  await seed([old, owed], [account, owingAccount]); const phone = harness([old, owed], [account, owingAccount]);
  const guard = repayGuard(phone); await db.del('tx', owed.id);
  await assert.rejects(phone.c.saveRepayment(repayment, guard), e => e.code === 'STALE');
  assert.deepEqual(await db.all('tx'), [old]); assert.equal((await db.get('accounts', 'cash')).opening, 10000);
});
test('old repayment form cannot write into a replaced book', async () => {
  await seed([old, owed], [account, owingAccount]); const phone = harness([old, owed], [account, owingAccount]);
  await db.put('kv', { key: 'bookGeneration', value: 'replacement' });
  await assert.rejects(phone.c.saveRepayment(repayment, repayGuard(phone)), e => e.code === 'STALE');
  assert.equal((await db.all('tx')).length, 2);
});
test('unguarded repayment API retains legacy treat behavior', async () => {
  await seed([old, owed], [account, owingAccount]); const phone = harness([old, owed], [account, owingAccount]);
  const rows = await phone.c.saveRepayment({ ...repayment, treat: true });
  assert.equal(rows.tx.length, 3); assert.equal(rows.tx.filter(x => x.type === 'transfer').reduce((sum, x) => sum + x.amount, 0), 1000);
  assert.equal((await db.get('accounts', 'cash')).opening, 9500);
});
test('stale repayment UI preserves typed values and re-enables Save with reopen guidance', async () => {
  await seed([old, owed], [account, owingAccount]); const phone = harness([old, owed], [account, owingAccount]); let click, closed = false;
  const fields = { '#rp-amt': { value: '5.00' }, '#rp-date': { value: '2026-09-15' }, '#rp-acc': { value: 'cash' }, '#rp-err': { textContent: '' } };
  Object.assign(phone.c, { esc: s => s, fmtRM: n => String(n), accName: id => id, today: () => '2026-10-03', defaultAccount: () => 'cash', owing: a => a.kind === 'owedme',
    calcAmount: n => Number(n) * 100, openShares: () => ({ owedMe: [{ name: 'Ali', sen: 1000, from: 'cash' }], iOwe: [] }),
    closeSheet: () => { closed = true; }, openSheet: () => ({ addEventListener(type, fn) { if (type === 'click') click = fn; }, querySelector: id => fields[id] }),
  });
  const home = await readFile(new URL('../js/views/home.js', import.meta.url), 'utf8');
  vm.runInContext(home.slice(home.indexOf('function repaySheet('), home.indexOf('let onScreen =')), phone.c);
  phone.c.repaySheet('owedme', 'Ali'); await db.del('tx', owed.id); const button = { disabled: false };
  await click({ target: { closest: () => button } });
  assert.equal(button.disabled, false); assert.equal(closed, false); assert.equal(fields['#rp-amt'].value, '5.00');
  assert.match(fields['#rp-err'].textContent, /Close this form and reopen/); assert.equal((await db.all('tx')).length, 1);
});
