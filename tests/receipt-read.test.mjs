import test from 'node:test';
import assert from 'node:assert/strict';
import { readSize, sections, mergeSections, validCorners, flattenPaper, enlarge } from '../js/receipt-image.js';
import { reading, layoutRows, annotate, acceptRetry, retryAreas, detectSections } from '../js/receipt-read.js';
const box = (text, y, mean = 0.95, x = 20, w = 400) => ({ text, mean, box: [[x, y], [x + w, y], [x + w, y + 20], [x, y + 20]] });
const receipt = (amount = '3.00', conf = 0.95) => [box('TEST CAFE', 10), box('03/10/2026', 50), box(`TEH AIS ${amount}`, 90, conf), box('TOTAL 3.00', 130)];
test('long receipts retain width and stay within the pixel budget', () => {
  const { width, height } = readSize(1800, 10000); assert.ok(width >= 1100); assert.ok(width * height <= 8.01e6);
  assert.deepEqual(readSize(4000, 3000), { width: 2000, height: 1500 });
});
test('sections cover every pixel, overlap at joins and cap the number of reads', () => {
  const s = sections(1200, 7300); assert.equal(s[0].y, 0); assert.equal(s.at(-1).y + s.at(-1).h, 7300);
  for (let n = 1; n < s.length; n++) assert.ok(s[n].y < s[n - 1].y + s[n - 1].h);
  assert.throws(() => sections(1000, 50000));
});
test('tile overlap deduplicates one line without dropping repeated products', () => {
  const out = mergeSections([{ area: { x: 0, y: 0 }, texts: [box('TEH AIS 3.00', 1900), box('TEH AIS 3.00', 1950)] }, { area: { x: 0, y: 1800 }, texts: [box('TEH AIS 3.00', 100, 0.99), box('TEH AIS 3.00', 150)] }]);
  assert.equal(out.length, 2); assert.equal(out[0].mean, 0.99);
});
test('section OCR runs sequentially, never concurrently', async () => {
  let active = 0, max = 0, calls = 0;
  const r = await detectSections(async () => { calls++; active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 2)); active--; return { texts: [] }; }, { width: 2, height: 4000, data: new Uint8ClampedArray(32000) });
  assert.equal(max, 1); assert.equal(calls, 3); assert.deepEqual(r.texts, []);
});
test('perspective selection rejects crossed, tiny, missing and non-finite corners', () => {
  assert.ok(validCorners([[0, 0], [1, 0], [1, 1], [0, 1]]));
  assert.equal(validCorners([[0, 0], [1, 1], [1, 0], [0, 1]]), false);
  assert.equal(validCorners([[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]]), false);
  assert.equal(validCorners([[NaN, 0]]), false);
});
test('projective warp maps selected corners and preserves all-white paper', () => {
  const raw = { width: 20, height: 30, data: new Uint8ClampedArray(20 * 30 * 4).fill(255) };
  raw.data[0] = 10; raw.data[(19 * 4)] = 20; raw.data[((29 * 20 + 19) * 4)] = 30; raw.data[(29 * 20 * 4)] = 40;
  const r = flattenPaper(raw, [[0, 0], [1, 0], [1, 1], [0, 1]]);
  assert.equal(r.data[0], 10); assert.equal(r.data[(r.width - 1) * 4], 20); assert.equal(r.data[(r.width * r.height - 1) * 4], 30); assert.equal(r.data[(r.height - 1) * r.width * 4], 40);
});
test('retry contrast preserves alpha and handles flat images and one-pixel crops', () => {
  const r = enlarge({ width: 1, height: 1, data: new Uint8ClampedArray([150, 150, 150, 255]) }, 2, true);
  assert.equal(r.data[0], 150); assert.ok([...r.data].every(Number.isFinite)); assert.equal(r.data[3], 255);
});
test('layout uses quantity/unit/line columns only when printed multiplication agrees', () => {
  const row = { text: '2 NASI LEMAK 6.00 12.00', words: ['2', 'NASI LEMAK', '6.00', '12.00'].map(text => ({ text, conf: 0.99 })) };
  assert.equal(layoutRows([row])[0].text, 'NASI LEMAK 12.00'); assert.equal(layoutRows([row])[0].quantity, 2);
  const bad = { ...row, words: row.words.map((w, n) => n === 3 ? { ...w, text: '13.00' } : w) }; assert.equal(layoutRows([bad])[0].text, row.text);
});
test('correcting an uncertain item may improve maths; a clear total cannot be rewritten to match', () => {
  assert.equal(acceptRetry(reading(receipt('8.00', 0.5)), reading(receipt('3.00', 0.98))), true);
  const changedTotal = receipt('8.00').map(b => b.text.includes('TOTAL') ? { ...b, text: 'TOTAL 8.00' } : b);
  assert.equal(acceptRetry(reading(receipt('8.00')), reading(changedTotal)), false);
});
test('matching arithmetic does not erase low-confidence money flags; repeated rows keep distinct crops', () => {
  const r = reading([box('TEST CAFE', 10), box('TEH AIS 3.00', 50, 0.6), box('TEH AIS 3.00', 90), box('TOTAL 6.00', 130)]);
  annotate(r, 180); assert.ok(r.receipt.check.ok); assert.ok(r.receipt.items[0].priceFlag); assert.equal(r.receipt.items[1].priceFlag, false);
  assert.notDeepEqual(r.receipt.items[0].crop, r.receipt.items[1].crop); assert.equal(retryAreas(r.lines, r.receipt, 500, 180).length, 1);
});
test('an account balance screen cannot become a guessed purchase', () => {
  const r = reading([box('ACCOUNT OVERVIEW', 10), box('Available balance RM 880.00', 50), box('Rewards points 1200', 90)]);
  assert.equal(r.receipt.notReceipt, true); assert.equal(r.receipt.total, null); assert.deepEqual(r.receipt.items, []);
});
