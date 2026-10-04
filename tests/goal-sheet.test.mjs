// Savings-goal sheet: which account it starts on, when saving warns that the bar will sit at RM 0, and the tappable Home row.
import test from 'node:test';
import assert from 'node:assert/strict';

const disk = new Map();
globalThis.localStorage = { getItem: k => disk.get(k) ?? null, setItem: (k, v) => disk.set(k, String(v)) };
const { goalAccounts, goalPick, goalNotice, goalsCard } = await import('../js/views/goals.js');
const { load, setKv, saveAccount } = await import('../js/state.js');

const A = [{ id: 'c', name: 'Visa', kind: 'card', opening: 0 }, { id: 'b', name: 'Bank', kind: 'bank', opening: 0 }, { id: 's', name: 'ASB', kind: 'savings', opening: 0 }];
test('accounts that can hold a goal: no card, savings first', () => assert.deepEqual(goalAccounts(A).map(a => a.id), ['s', 'b']));
test('a new goal never guesses an account unless only one could hold it; an old one keeps its own', () => {
  assert.equal(goalPick({}, goalAccounts(A)), '', 'two choices: none picked');
  assert.equal(goalPick({}, goalAccounts([A[1]])), 'b', 'one choice: nothing to choose between');
  assert.equal(goalPick({}, []), '');
  assert.equal(goalPick({ id: 'g', accountId: 'b' }, goalAccounts(A)), 'b');
  assert.equal(goalPick({ id: 'g' }, goalAccounts(A)), '', 'an unlinked goal stays unlinked');
});
test('notice: none picked, empty, never-typed balance; none for an account with money', () => {
  assert.equal(goalNotice('', A, {}), 'none');
  assert.equal(goalNotice('s', A, { s: 0 }), 'empty');
  assert.equal(goalNotice('s', A, {}), 'empty');
  assert.equal(goalNotice('s', A, { s: -5 }), 'empty');
  assert.equal(goalNotice('gone', A, { gone: 900 }), 'empty', 'a deleted account');
  assert.equal(goalNotice('s', [{ ...A[2], typed: false }], { s: 900 }), 'empty', 'balance never given');
  assert.equal(goalNotice('s', A, { s: 100 }), null);
});
test('Home goal row opens the goal; the share button is its own button, not inside it', async () => {
  await load();
  await saveAccount({ id: 's', name: 'ASB', kind: 'savings', opening: 100000, typed: true, createdAt: 1 });
  await setKv('goals', [{ id: 'g1', name: 'Phone', target: 100000, accountId: 's', createdAt: 1 }, { id: 'g2', name: 'Trip', target: 5000, accountId: 's', createdAt: 1 }]);
  const html = goalsCard();
  assert.equal(html.match(/data-act="goal-edit"/g)?.length, 2);
  assert.match(html, /<button class="goalbtn"[^>]*data-id="g2"/);
  assert.equal(html.match(/data-act="goal-share"/g)?.length, 2, 'both are reached (RM 1,000 in the account)');
  for (const row of html.split('<li ').slice(1)) {
    const open = row.indexOf('class="goalbtn"'), close = row.indexOf('</button>', open), share = row.indexOf('data-act="goal-share"');
    assert.ok(share > close, 'share sits after the row button closes');
  }
});
