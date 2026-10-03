import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../js/views/analytics.js', import.meta.url), 'utf8');
const reminder = source.slice(source.indexOf('export function openReminder('), source.indexOf('// ---- the next 30 days')).replace('export ', '');
function harness(share) {
  const controls = Object.fromEntries(['draft', 'share', 'copy', 'cancel', 'error'].map(name => [name, { hidden: false, disabled: false, value: '', textContent: '', addEventListener(event, fn) { this[event] = fn; } }]));
  const copies = [], messages = []; let closed = 0;
  const context = vm.createContext({
    navigator: { ...(share ? { share } : {}), clipboard: { writeText: async text => copies.push(text) } },
    t: (s, ...values) => s.replace(/\{(\d+)\}/g, (_, n) => values[n]), esc: s => s, fmtRM: sen => `RM ${(sen / 100).toFixed(2)}`, ICON: { share: '' },
    closeSheet: () => closed++, toast: message => messages.push(message),
    openSheet: html => {
      controls.draft.value = html.match(/<textarea[^>]*>(.*?)<\/textarea>/s)[1];
      controls.share.hidden = !share; controls.copy.hidden = !!share;
      return { querySelector: selector => controls[selector.replace('#reminder-', '')] };
    },
  });
  vm.runInContext(reminder, context); context.openReminder({ name: 'Ali', sen: 1234 });
  return { controls, copies, messages, closed: () => closed };
}
test('edited reminder goes to app chooser as text only, without Tally advertising', async () => {
  const shared = []; const h = harness(async payload => shared.push(payload));
  assert.equal(h.controls.draft.value, 'Hi Ali, a small reminder: RM 12.34 for the bill we split. Thanks!');
  assert.doesNotMatch(h.controls.draft.value, /https?:|Tally|tallymy/i);
  h.controls.draft.value = 'Ali, could you send RM12.34 tomorrow?'; await h.controls.share.onclick();
  assert.equal(shared[0].text, h.controls.draft.value); assert.deepEqual(Object.keys(shared[0]), ['text']);
});
test('cancelling chooser retains edited draft and permits retry without success claim', async () => {
  const h = harness(async () => { throw new DOMException('Cancelled', 'AbortError'); });
  h.controls.draft.value = 'My personal draft'; await h.controls.share.onclick();
  assert.equal(h.controls.draft.value, 'My personal draft'); assert.equal(h.controls.share.disabled, false);
  assert.equal(h.controls.error.textContent, ''); assert.deepEqual(h.messages, []);
});
test('empty or whitespace-only draft disables and refuses share/copy', async () => {
  let sent = 0; const h = harness(async () => sent++);
  h.controls.draft.value = ' \n '; h.controls.draft.input();
  assert.equal(h.controls.share.disabled, true); assert.equal(h.controls.copy.disabled, true);
  await h.controls.share.onclick(); await h.controls.copy.onclick(); assert.equal(sent, 0); assert.deepEqual(h.copies, []);
});
test('browser without sharing copies the edited message without redirecting to WhatsApp', async () => {
  const h = harness(); assert.equal(h.controls.share.hidden, true); assert.equal(h.controls.copy.hidden, false);
  h.controls.draft.value = 'Please send the lunch share'; await h.controls.copy.onclick();
  assert.deepEqual(h.copies, ['Please send the lunch share']); assert.match(h.messages[0], /^Copied/);
});
test('Cancel closes draft without sharing or copying', async () => {
  let sent = 0; const h = harness(async () => sent++); h.controls.cancel.onclick();
  assert.equal(h.closed(), 1); assert.equal(sent, 0); assert.deepEqual(h.copies, []);
});
test('sharing failure offers copy recovery and preserves draft', async () => {
  const h = harness(async () => { throw Error('No apps'); }); await h.controls.share.onclick();
  assert.equal(h.controls.copy.hidden, false); assert.match(h.controls.error.textContent, /Try copying/);
  assert.equal(h.controls.share.disabled, false);
});
