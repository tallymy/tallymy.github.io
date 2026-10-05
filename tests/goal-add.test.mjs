// "Add money" on a savings goal: an ordinary transfer INTO the goal's account (no new data, no new money writer).
import test from 'node:test';
import assert from 'node:assert/strict';

const disk = new Map();
globalThis.localStorage = { getItem: k => disk.get(k) ?? null, setItem: (k, v) => disk.set(k, String(v)) };
const { goalFrom, goalAddPreset, goalCanAdd, goalAddNote, linkGoal, goalsCard, goalsSettings } = await import('../js/views/goals.js');
const { load, setKv, saveAccount, saveTx, S, today } = await import('../js/state.js');
const { balances, goalProgress } = await import('../js/engine.js');

const ACC = [
  { id: 'cash', name: 'Cash', kind: 'cash', opening: 0 }, { id: 'card', name: 'Visa', kind: 'card', opening: 0 },
  { id: 'bank', name: 'Bank', kind: 'bank', opening: 0 }, { id: 'asb', name: 'ASB', kind: 'savings', opening: 0 },
  { id: 'sgd', name: 'SGD wallet', kind: 'bank', currency: 'SGD', opening: 0 }, { id: 'owed', name: 'Owed to you', kind: 'owedme', opening: 0 },
];
test('From: the preferred everyday account, never the goal account, a card or an owed account', () => {
  assert.equal(goalFrom(ACC, 'asb', 'bank'), 'bank');
  assert.equal(goalFrom(ACC, 'bank', 'bank'), 'cash', 'the goal account itself is out; next everyday one');
  assert.equal(goalFrom(ACC, 'asb', 'card'), 'cash', 'a card preference is ignored');
  assert.equal(goalFrom(ACC, 'asb', 'owed'), 'cash');
  assert.equal(goalFrom(ACC, 'asb', undefined), 'cash');
  assert.equal(goalFrom([ACC[1], ACC[3]], 'asb', 'card'), '', 'only a card to take it from: none');
});
test('From: the same currency as the goal account is preferred', () => {
  assert.equal(goalFrom(ACC, 'sgd', 'bank'), 'bank', 'no other SGD account: the preferred one');
  const two = [...ACC, { id: 'sgd2', name: 'SGD cash', kind: 'cash', currency: 'SGD', opening: 0 }];
  assert.equal(goalFrom(two, 'sgd', 'bank'), 'sgd2', 'SGD goal: the other SGD account beats the preferred RM bank');
  assert.equal(goalFrom(two, 'asb', 'sgd2'), 'cash', 'RM goal: an RM account beats a preferred SGD one');
});
test('preset: a transfer into the goal account, note "Goal: name" (<= 80), empty amount, no new fields', () => {
  const p = goalAddPreset({ id: 'g', name: 'New phone', target: 1, accountId: 'asb' }, ACC, 'bank');
  assert.deepEqual(p, { type: 'transfer', category: 'other', accountId: 'bank', toAccountId: 'asb', merchant: 'Goal: New phone' });
  assert.ok(goalAddPreset({ name: 'x'.repeat(200), accountId: 'asb' }, ACC, 'bank').merchant.length <= 80);
  assert.equal(goalAddPreset({ name: 'A\u0000B  C', accountId: 'asb' }, ACC, 'bank').merchant, 'Goal: A B C');
});
test('who gets the button: accounts that can hold a goal and are in scope; an unlinked goal always', () => {
  assert.equal(goalCanAdd({ accountId: 'asb' }, ACC, ACC), true);
  assert.equal(goalCanAdd({ accountId: 'card' }, ACC, ACC), false, 'a card owes, it does not hold');
  assert.equal(goalCanAdd({ accountId: 'owed' }, ACC, ACC), false);
  assert.equal(goalCanAdd({ accountId: 'asb' }, ACC, [ACC[0]]), false, 'out of the joint/business scope on screen');
  assert.equal(goalCanAdd({}, ACC, ACC), true, 'unlinked: it asks where the money is kept');
  assert.equal(goalCanAdd({ accountId: 'gone' }, ACC, ACC), true, 'a deleted account counts as unlinked');
});
test('the typed:false line is only for an account whose balance was never typed', () => {
  assert.equal(goalAddNote({ id: 'a', typed: false }), true);
  assert.equal(goalAddNote({ id: 'a', typed: true }), false);
  assert.equal(goalAddNote({ id: 'a' }), false);
  assert.equal(goalAddNote(undefined), false);
});
test('saving it: a normal transfer, the goal moves by exactly the amount, spending and the RM total do not', async () => {
  await load();
  for (const a of [{ id: 'bank', name: 'Bank', kind: 'bank', opening: 50000, typed: true, createdAt: 1 }, { id: 'asb', name: 'ASB', kind: 'savings', opening: 10000, typed: true, createdAt: 1 }, { id: 'card', name: 'Visa', kind: 'card', opening: 0, typed: true, createdAt: 1 }]) await saveAccount(a);
  const g = { id: 'g1', name: 'Phone', target: 100000, accountId: 'asb', createdAt: 1 };
  await setKv('goals', [g]);
  const before = goalProgress(g, balances(S.accounts, S.tx).by, today()), tot0 = balances(S.accounts, S.tx).total, spent0 = S.tx.filter(x => x.type === 'expense').length;
  const p = goalAddPreset(g, S.accounts, 'bank');
  await saveTx({ id: 't1', ...p, amount: 2550, date: today(), source: 'quick', createdAt: 5 });
  const after = goalProgress(g, balances(S.accounts, S.tx).by, today());
  assert.equal(after.have - before.have, 2550);
  assert.equal(balances(S.accounts, S.tx).by.bank, 50000 - 2550);
  assert.equal(balances(S.accounts, S.tx).total, tot0, 'a transfer between your own accounts does not change the total');
  assert.equal(S.tx.filter(x => x.type === 'expense').length, spent0);
  const row = S.tx.find(x => x.id === 't1');
  assert.equal(row.type, 'transfer'); assert.equal(row.accountId, 'bank'); assert.equal(row.toAccountId, 'asb'); assert.equal(row.merchant, 'Goal: Phone');
  // over the target is allowed: the bar caps at 100% and it is reached
  await saveTx({ id: 't2', ...p, amount: 200000, date: today(), source: 'quick', createdAt: 6 });
  const over = goalProgress(g, balances(S.accounts, S.tx).by, today());
  assert.equal(over.pct, 1); assert.equal(over.reached, true);
});
test('an unlinked goal: choosing where the money is kept persists accountId on that goal only', async () => {
  await load();
  await saveAccount({ id: 'asb', name: 'ASB', kind: 'savings', opening: 0, typed: true, createdAt: 1 });
  await setKv('goals', [{ id: 'a', name: 'A', target: 5, createdAt: 1 }, { id: 'b', name: 'B', target: 7, createdAt: 1 }]);
  assert.equal(await linkGoal('a', 'asb'), true);
  assert.deepEqual(S.kv.goals.map(g => [g.id, g.accountId, g.name, g.target]), [['a', 'asb', 'A', 5], ['b', undefined, 'B', 7]]);
  assert.equal(await linkGoal('nope', 'asb'), false, 'a goal deleted meanwhile is not recreated');
  assert.equal(S.kv.goals.length, 2);
  assert.equal(await linkGoal('b', 'missing'), false, 'an account that is gone is refused');
  assert.equal(S.kv.goals[1].accountId, undefined);
});
test('goal rows have an Add money button of their own (Home and Settings), not nested in another button', async () => {
  await load();
  await saveAccount({ id: 's', name: 'ASB', kind: 'savings', opening: 100, typed: true, createdAt: 1 });
  await setKv('goals', [{ id: 'g1', name: 'Phone', target: 100000, accountId: 's', createdAt: 1 }, { id: 'g2', name: 'Trip', target: 5000, createdAt: 1 }, { id: 'g3', name: 'Done', target: 50, accountId: 's', createdAt: 1 }]);
  const { setModules } = await import('../js/features.js'); await setModules({ goals: true });
  for (const html of [goalsCard(), goalsSettings()]) {
    assert.equal(html.match(/data-act="goal-add"/g)?.length, 3);
    assert.equal(html.match(/data-act="goal-edit"[^>]*data-id/g)?.length, 3, 'tap-to-edit stays');
    assert.doesNotMatch(html, /<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/, 'no button inside a button');
  }
  assert.match(goalsCard(), /data-act="goal-share"/, 'Share stays on a reached goal');
});
