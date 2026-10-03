import test from 'node:test';
import assert from 'node:assert/strict';
import { receiptCases, receiptLines } from './receipt-synthetic.mjs';
import { parseReceipt } from '../js/parse.js';
for (const c of receiptCases().filter(x => !x.negative && !x.columns)) test(`generated ground truth: ${c.id}`, () => {
  const parsed = parseReceipt(receiptLines(c).join('\n'));
  assert.equal(parsed.total, c.total); assert.equal(parsed.date, c.date);
  assert.equal(parsed.items.length, c.items.length);
  assert.deepEqual(parsed.items.map(i => i.cents), c.items.map(i => i.cents));
  assert.ok(parsed.check.ok);
});
