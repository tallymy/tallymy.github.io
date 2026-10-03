import assert from 'node:assert/strict';

// Run against an already loaded Tally page. All external sharing/clipboard calls are stubs.
export async function verifyReminderDraft(page) {
  await page.evaluate(async () => {
    window.__reminderCalls = []; window.__reminderCopies = [];
    window.__reminderShare = navigator.share;
    window.__reminderClipboard = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.share = async payload => { window.__reminderCalls.push(payload); };
    navigator.clipboard.writeText = async text => { window.__reminderCopies.push(text); };
    window.__openReminder = (await import('/js/views/analytics.js')).openReminder;
    window.__openReminder({ name: 'Ali', sen: 1234 });
  });
  try {
    assert.doesNotMatch(await page.locator('#reminder-draft').inputValue(), /https?:|tallymy|Tally/i);
    await page.locator('#reminder-draft').fill('Ali, can you send RM12.34 tomorrow?');
    await page.locator('#reminder-share').click();
    assert.deepEqual(await page.evaluate(() => window.__reminderCalls), [{ text: 'Ali, can you send RM12.34 tomorrow?' }]);
    await page.evaluate(() => { navigator.share = async () => { throw new DOMException('Cancelled', 'AbortError'); }; });
    await page.locator('#reminder-share').click();
    assert.equal(await page.locator('#reminder-draft').inputValue(), 'Ali, can you send RM12.34 tomorrow?');
    assert.equal(await page.locator('#reminder-error').textContent(), '');
    await page.locator('#reminder-draft').fill('  \n ');
    assert.equal(await page.locator('#reminder-share').isDisabled(), true);
    await page.locator('#reminder-cancel').click();
    await page.locator('#reminder-draft').waitFor({ state: 'detached' });
    await page.evaluate(() => { navigator.share = undefined; window.__openReminder({ name: 'Ali', sen: 1234 }); });
    assert.equal(await page.locator('#reminder-copy').isVisible(), true);
    await page.locator('#reminder-draft').fill('Lunch share, thanks'); await page.locator('#reminder-copy').click();
    assert.deepEqual(await page.evaluate(() => window.__reminderCopies), ['Lunch share, thanks']);
    await page.locator('#reminder-cancel').click();
    await page.locator('#reminder-draft').waitFor({ state: 'detached' });
  } finally {
    await page.evaluate(() => {
      navigator.share = window.__reminderShare; navigator.clipboard.writeText = window.__reminderClipboard;
      delete window.__openReminder; delete window.__reminderShare; delete window.__reminderClipboard;
    });
  }
  return ['Reminder chooser receives only user-edited text', 'Chooser cancellation keeps draft', 'Whitespace draft disabled', 'No-share browser copies edited text', 'Draft cancel performs no external share'];
}
