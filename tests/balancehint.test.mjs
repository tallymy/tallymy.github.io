// The reminder on the entry sheet: an entry that may already be inside a balance typed in the last 3 days.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lateTypedHint, balances } from '../js/engine.js';

const at = (y, m, d) => new Date(y, m - 1, d, 12).getTime();   // noon, so the local day is the same everywhere
const bank = (made, extra = {}) => ({ id: 'b', kind: 'bank', typed: true, opening: 40400, createdAt: made, ...extra });
const TODAY = '2026-10-03';

test('typed today: an entry dated today may be inside the balance, an earlier day is already out of it', () => {
  const a = bank(at(2026, 10, 3));
  assert.equal(lateTypedHint(a, '2026-10-03', TODAY), true);
  assert.equal(lateTypedHint(a, '2026-10-02', TODAY), false, 'dated before the balance was typed: not counted again');
  assert.equal(lateTypedHint(a, '2026-09-20', TODAY), false);
});

test('only for a balance typed in the last 3 days', () => {
  assert.equal(lateTypedHint(bank(at(2026, 9, 30)), '2026-10-03', TODAY), true, '3 days ago');
  assert.equal(lateTypedHint(bank(at(2026, 9, 29)), '2026-10-03', TODAY), false, '4 days ago: normal spending by now');
});

test('no reminder where there is no typed balance to double count', () => {
  assert.equal(lateTypedHint(bank(at(2026, 10, 3), { typed: false }), TODAY, TODAY), false, 'a balance never given');
  assert.equal(lateTypedHint(bank(at(2026, 10, 3), { typed: undefined }), TODAY, TODAY), false, 'an app\'s history');
  assert.equal(lateTypedHint(bank(at(2026, 10, 3), { outside: true }), TODAY, TODAY), false);
  assert.equal(lateTypedHint(bank(at(2026, 10, 3), { kind: 'owedme' }), TODAY, TODAY), false, 'what friends owe');
  assert.equal(lateTypedHint(bank(0), TODAY, TODAY), false);
  assert.equal(lateTypedHint(undefined, TODAY, TODAY), false);
});

test('a phone clock that moved back: an account can not be made later than today', () => {
  assert.equal(lateTypedHint(bank(at(2026, 10, 9)), '2026-10-03', TODAY), true);
});

test('the sum the tester saw: RM 404 less three entries dated on or after the day it was typed', () => {
  const x = (id, amount) => ({ id, type: 'expense', date: '2026-10-03', amount, accountId: 'b' });
  const a = bank(at(2026, 10, 3), { opening: 40400 });
  assert.equal(balances([a], [x('1', 72000), x('2', 20000), x('3', 30000)]).by.b, -81600, 'RM 404 - RM 1,220 = -RM 816');
  assert.equal(lateTypedHint(a, '2026-10-03', TODAY), true, 'the sheet would have asked');
});
