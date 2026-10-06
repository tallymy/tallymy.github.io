// F4 round 2: leftovers the real app produces (a colour/icon/budget/rule for a removed own category, a goal whose account was deleted)
// must not make a book unsyncable; hostile values still must. Real-app fixture runs js/state.js (fallback storage, as categories.test.mjs).
// Importers: none (test only). API: sync-core validateBook/projectBook/reconcile/bookRevision, state.js. User quote: "tolerate EXACTLY those".
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
const disk = new Map();
globalThis.localStorage = { getItem: k => disk.get(k) ?? null, setItem: (k, v) => disk.set(k, String(v)), removeItem: k => disk.delete(k) };
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const { S, load, saveTx, saveAccount, deleteAccount, setKv, addCategory, removeCategory } = await import('../js/state.js');
const { projectBook, validateBook, reconcile, bookRevision } = await import('../js/book-sync/sync-core.mjs');
const clone = x => structuredClone(x);
const merge = async (b, l, r) => reconcile({ base: b, local: l, remote: r, bookId: 'book1', baseRevision: await bookRevision(b) });

test('real app: delete an own category with colour, icon, budgets, rule, subcat, then Undo a palette change; delete a goal account', async () => {
  await load();
  await saveAccount({ id: 'a', name: 'Cash', kind: 'cash', opening: 0 });
  await saveAccount({ id: 'sv', name: 'Savings', kind: 'savings', opening: 0 });
  await setKv('goals', [{ id: 'g1', name: 'Trip', target: 100000, accountId: 'sv', createdAt: 1790000000000 }]);
  await addCategory('Cat food', '#123456');
  const mine = S.kv.customCats.find(c => c.name === 'Cat food').id;
  await saveTx({ id: 't1', date: '2026-09-02', type: 'expense', amount: 1200, accountId: 'a', category: mine });
  await setKv('catColors', { [mine]: '#abcdef' }); await setKv('catIcons', { [mine]: 'paw' });
  const before = { ...S.kv.catColors };   // what the palette Undo will put back
  await setKv('budgets', { total: 0, byCat: { [mine]: 500 }, joint: { total: 0, byCat: { [mine]: 5 }, updatedAt: 1 }, business: { total: 0, byCat: { [mine]: 7 } } });
  await setKv('rules', { 'CAT SHOP': mine }); await setKv('subcats', { [mine]: ['Dry', 'Wet'] }); await setKv('subRules', { 'cat shop': [mine, 'Dry'] });
  await removeCategory(mine);
  await setKv('catColors', { ...S.kv.catColors, ...before });          // palette Undo after the removal: orphan colour is back
  await setKv('catIcons', { ...S.kv.catIcons, [mine]: 'paw' });
  await deleteAccount('sv');                                             // empty account, goal still points at it
  assert.ok(S.kv.catColors[mine] && S.kv.goals[0].accountId === 'sv');
  const b = projectBook(S);                                              // threw before this fix
  assert.equal(b.kv.catColors[mine], undefined); assert.equal(b.kv.catIcons[mine], undefined);
  assert.equal(b.kv.goals[0].accountId, undefined);
  assert.deepEqual(b.kv.subcats[mine], ['Dry', 'Wet']);                  // restore keeps these; left alone
  assert.deepEqual(b.kv.subRules['cat shop'], [mine, 'Dry']);
  assert.equal(b.kv.rules['CAT SHOP'], 'other');
  assert.equal(await bookRevision(b), await bookRevision(validateBook(clone(b))));
  const dirty = clone(b);   // every orphan shape at once, as an older device or a merge could send them
  dirty.kv.catColors[mine] = '#abcdef'; dirty.kv.catIcons[mine] = 'paw'; dirty.kv.rules.OLD = mine; dirty.kv.goals[0].accountId = 'sv';
  dirty.kv.budgets.byCat[mine] = 5; dirty.kv.budgets.joint.byCat[mine] = 5; dirty.kv.budgets.business.byCat[mine] = 5;
  assert.equal(await bookRevision(dirty), await bookRevision(b));
});

const base = () => validateBook({ schema: 'tally.complete-book/1', accounts: [{ id: 'cash', name: 'Cash', kind: 'cash', opening: 0, typed: false, currency: 'MYR' }], tx: [], recurring: [], receipts: [],
  kv: { customCats: [{ id: 'c_x', name: 'X', color: '#112233' }], catColors: { c_x: '#aabbcc' }, budgets: { total: 0, byCat: { c_x: 10 } }, rules: {}, settings: {} } });

test('a removal crossing an edit: identical on both merge sides, no conflict, no orphan, stable afterwards', async () => {
  const b = base();
  const l = clone(b); l.kv.customCats = []; l.kv.catColors = {}; l.kv.budgets = { total: 0, byCat: {} };   // removeCategory on this device
  const r = clone(b); r.kv.catIcons = { c_x: 'paw' };                                                      // other device only gives it an icon
  const p = await merge(b, l, r), q = await merge(b, r, l);
  assert.equal(p.status, 'ready', JSON.stringify(p.conflicts)); assert.equal(q.status, 'ready');
  assert.equal(p.nextRevision, q.nextRevision);
  assert.deepEqual(p.candidate.kv.catIcons, {}); assert.deepEqual(p.candidate.kv.budgets.byCat, {}); assert.equal(p.candidate.kv.catColors.c_x, undefined);
  const again = await merge(p.candidate, p.candidate, p.candidate); assert.equal(again.nextRevision, p.nextRevision);
});
test('a remote book carrying orphans validates to the same book as one without', async () => {
  const clean = base(); clean.kv.catColors = {}; clean.kv.catIcons = {}; clean.kv.customCats = []; clean.kv.budgets.byCat = {};
  const dirty = clone(clean); dirty.kv.catColors = { c_x: '#aabbcc' }; dirty.kv.catIcons = { c_x: 'paw' }; dirty.kv.budgets.byCat = { c_x: 10 };
  assert.equal(await bookRevision(dirty), await bookRevision(clean));
});

const hostile = {
  'unknown non-own category colour': b => { b.kv.customCats = []; b.kv.catColors = { food: '#aabbcc' }; },
  'unknown non-own rule target': b => { b.kv.customCats = []; b.kv.rules = { A: 'food' }; },
  'orphan colour not a colour': b => { b.kv.customCats = []; b.kv.catColors = { c_x: 'red' }; },
  'orphan icon unknown': b => { b.kv.customCats = []; b.kv.catIcons = { c_x: 'nope' }; },
  'orphan budget fractional': b => { b.kv.customCats = []; b.kv.budgets.byCat = { c_x: 1.5 }; },
  'orphan budget overflow': b => { b.kv.customCats = []; b.kv.budgets.byCat = { c_x: 1e12 }; },
  'orphan budget negative': b => { b.kv.customCats = []; b.kv.budgets.byCat = { c_x: -1 }; },
  'orphan joint budget string': b => { b.kv.customCats = []; b.kv.budgets.joint = { total: 0, byCat: { c_x: '5' } }; },
  'orphan rule key too long': b => { b.kv.customCats = []; b.kv.rules = { ['A'.repeat(80)]: 'c_x' }; },
  'kept category colour invalid': b => { b.kv.catColors = { c_x: 'red' }; },
  'goal account id invalid': b => { b.kv.goals = [{ id: 'g', name: 'G', target: 5, accountId: 'bad id!', createdAt: 1 }]; },
  'goal account id proto': b => { b.kv.goals = [{ id: 'g', name: 'G', target: 5, accountId: '__proto__', createdAt: 1 }]; },
  'goal extra field': b => { b.kv.goals = [{ id: 'g', name: 'G', target: 5, accountId: 'gone', createdAt: 1, evil: 1 }]; },
  'goal target fractional': b => { b.kv.goals = [{ id: 'g', name: 'G', target: 5.5, accountId: 'gone', createdAt: 1 }]; },
};
for (const [name, mut] of Object.entries(hostile)) test(`still refused: ${name}`, () => { const b = clone(base()); mut(b); assert.throws(() => validateBook(b)); });
test('still refused: prototype keys at depth (JSON.parse own __proto__)', () => {
  for (const kv of ['{"catColors":{"__proto__":"#aabbcc"}}', '{"budgets":{"total":0,"byCat":{"__proto__":5}}}', '{"rules":{"constructor":"c_x"}}']) {
    const b = clone(base()); Object.assign(b.kv, JSON.parse(kv)); assert.throws(() => validateBook(b));
  }
});
