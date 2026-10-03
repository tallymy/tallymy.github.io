import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(fileURLToPath(import.meta.url));
let webRoot = process.env.TALLY_WEB_ROOT || (fs.existsSync(path.join(root, 'staged/js/state.js')) ? path.join(root, 'staged') : root);
while (!fs.existsSync(path.join(webRoot, 'js/state.js'))) {
  const parent = path.dirname(webRoot);
  if (parent === webRoot) throw Error('Could not locate app source; set TALLY_WEB_ROOT.');
  webRoot = parent;
}
const read = f => fs.readFileSync(path.join(webRoot, f), 'utf8');
const engine = await import(`data:text/javascript;base64,${Buffer.from(read('js/engine.js')).toString('base64')}`);
const state = read('js/state.js');
const fn = state.slice(state.indexOf('export function defaultAccount('), state.indexOf('/** The day budget months start')).replace('export ', '');
function harness(pref = undefined, scope = null) {
  const accounts = [{ id: 'cash', name: 'Cash', kind: 'cash', opening: 50000 }, { id: 'bank', name: 'Bank', kind: 'bank', opening: 50000 }, { id: 'sgd', name: 'SGD', kind: 'bank', currency: 'SGD', opening: 50000 }, { id: 'owed', kind: 'owed' }];
  const S = { accounts, tx: [], kv: { settings: { quickAccount: pref } } };
  const c = vm.createContext({ S, settings: () => S.kv.settings, scopedAccounts: () => scope ? accounts.filter(a => scope.includes(a.id)) : accounts, scopedTx: () => S.tx, rmTx: () => S.tx, today: () => '2026-10-04', owing: a => a.id === 'owed', balances: engine.balances, pickAccount: engine.pickAccount });
  vm.runInContext(`${fn}\nthis.choose = defaultAccount;`, c);
  return { S, choose: (kind = 'quick', options = {}) => c.choose(kind, { typedExpense: true, ...options }), rawChoose: c.choose };
}
test('repayment and other non-form quick callers do not inherit typed preference', () => {
  assert.equal(harness('sgd').rawChoose('quick'), harness().rawChoose('quick'));
  const money = read('js/views/money.js');
  assert.match(money, /defaultAccount\('quick', \{ amount: preset\.amount \|\| 0, typedExpense: !preset\.type \|\| preset\.type === 'expense' \}\)/);
  assert.equal((money.match(/typedExpense: draft\.type === 'expense'/g) || []).length, 2);
});
test('actual opening caller limits preference to plain/expense presets, preserves explicit account', () => {
  const line = read('js/views/money.js').split('\n').find(line => line.includes('draft = resume ? resume.draft :'));
  assert.ok(line, 'Production opening assignment must be present');
  function open(preset, preference = 'sgd', resume = null) {
    const c = vm.createContext({ preset, resume, uid: () => 't_new', defaultAccount: harness(preference).rawChoose, usualCategory: () => 'dining', today: () => '2026-10-04', nowTime: () => '12:00' });
    vm.runInContext(`let draft; ${line}\nthis.result = draft;`, c);
    return c.result;
  }
  assert.equal(open({}).accountId, 'sgd');
  assert.equal(open({ type: 'expense', amount: 1200 }).accountId, 'sgd');
  for (const type of ['income', 'transfer']) {
    assert.equal(open({ type, amount: 1200 }).accountId, open({ type, amount: 1200 }, null).accountId);
    assert.equal(open({ type, amount: 1200 }).accountId, 'cash');
    assert.equal(open({ type, accountId: 'bank' }).accountId, 'bank');
  }
  assert.equal(open({ accountId: 'bank' }).accountId, 'bank');
  assert.equal(open({}, 'sgd', { draft: { accountId: 'cash', type: 'expense' } }).accountId, 'cash');
});
test('automatic starts on existing everyday cash and follows shop history', () => {
  const h = harness(); assert.equal(h.choose(), 'cash');
  h.S.tx.push({ id: 't', type: 'expense', source: 'quick', accountId: 'bank', merchant: 'Shop', amount: 100, date: '2026-10-04', createdAt: 1 });
  assert.equal(h.choose('quick', { shop: 'Shop' }), 'bank');
});
test('explicit preference overrides inferred cash/history and recent foreign account', () => {
  const h = harness('bank');
  h.S.tx.push({ id: 't', type: 'expense', source: 'quick', accountId: 'sgd', amount: 100, date: '2026-10-04', createdAt: Date.now() });
  assert.equal(h.choose(), 'bank');
});
test('deleted, debt and out-of-view preferences fall back safely', () => {
  for (const id of ['deleted', 'owed']) assert.equal(harness(id).choose(), 'cash');
  assert.equal(harness('bank', ['cash']).choose(), 'cash');
});
test('foreign preference works and explicit currency uses matching account', () => {
  assert.equal(harness('sgd').choose(), 'sgd');
  assert.equal(harness('sgd').choose('quick', { currency: 'MYR' }), 'cash');
  assert.equal(harness('bank').choose('quick', { currency: 'SGD' }), 'sgd');
});
test('income, bills and receipt payment hints retain existing behavior', () => {
  for (const kind of ['income', 'bill', 'receipt']) {
    const options = kind === 'receipt' ? { pay: 'cash' } : {};
    assert.equal(harness('sgd').choose(kind, options), harness().choose(kind, options));
  }
});
test('settings select saves preference, resets automatic, and recovers failed storage', async () => {
  const setup = read('js/views/setup.js');
  assert.match(setup, /select data-input="quick-account"/);
  assert.match(setup, /S\.accounts\.filter\(a => !owing\(a\)\)\.map\(a => `<option/);
  const handler = setup.slice(setup.indexOf("  'quick-account':"), setup.indexOf("  'scan-shortcut':"));
  let saved, failure = false, warning = false;
  const c = vm.createContext({ S: { accounts: [{ id: 'bank' }] }, settings: () => ({ quickAccount: 'cash' }), owing: () => false, setSetting: async (k, v) => { if (failure) throw Error('quota'); saved = [k, v]; }, toast: () => { warning = true; }, t: s => s });
  vm.runInContext(`this.handler = ({${handler}})['quick-account'];`, c);
  await c.handler({ value: 'bank' }); assert.deepEqual(saved, ['quickAccount', 'bank']);
  await c.handler({ value: '' }); assert.deepEqual(saved, ['quickAccount', null]);
  failure = true; const el = { value: 'bank' }; await c.handler(el); assert.equal(el.value, 'cash'); assert.equal(warning, true);
  saved = null; await c.handler({ value: 'missing' }); assert.equal(saved, null);
});
test('backup carries valid preference and rejects malformed identifiers', () => {
  const io = read('js/io.js');
  const start = io.indexOf('const SETTINGS = {'), end = io.indexOf('/** The receipt photos an import may write:', start);
  const c = vm.createContext({ okId: id => typeof id === 'string' && /^[\w-]{1,60}$/.test(id) && !['constructor', '__proto__', 'prototype'].includes(id), isObj: x => x && typeof x === 'object' && !Array.isArray(x), cleanText: x => x });
  vm.runInContext(io.slice(start, end).replace('export const backupSettings', 'this.backupSettings'), c);
  const saved = c.backupSettings({ quickAccount: 'bank', lock: { pin: 'secret' } });
  assert.equal(saved.quickAccount, 'bank'); assert.equal(saved.lock, undefined);
  assert.equal(c.backupSettings(JSON.parse(JSON.stringify(saved))).quickAccount, 'bank');
  for (const id of [null, '', 'constructor', '../bank', 'x'.repeat(61)]) assert.equal(c.backupSettings({ quickAccount: id }).quickAccount, undefined);
});
test('all five locale files provide every added string', async () => {
  for (const language of ['ms', 'zh', 'zh-Hant', 'ja', 'ta']) {
    const dict = (await import(`data:text/javascript;base64,${Buffer.from(read(`js/i18n/${language}.js`)).toString('base64')}`)).default;
    for (const key of ['Default account for typed expenses', 'Choose automatically', 'Used when this account is in the current view. You can change it for each entry.']) assert.ok(dict[key], `${language}: ${key}`);
  }
});
