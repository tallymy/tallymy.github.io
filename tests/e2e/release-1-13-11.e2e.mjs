// Browser check for 1.13.11: a red message in a sheet (goal sheet, account sheet) goes away as soon as a field is edited.
// Headless Playwright Chromium only. Run: node tests/e2e/release-1-13-11.e2e.mjs   (serves this tree on 127.0.0.1:8781)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../', import.meta.url));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname, f = resolve(root, '.' + (p === '/' ? '/index.html' : p));
    if (!f.startsWith(resolve(root) + sep)) throw Error();
    res.setHeader('Content-Type', mime[extname(f)] || 'application/octet-stream'); res.setHeader('Cache-Control', 'no-store'); res.end(await readFile(f));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(8781, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await ctx.addInitScript(() => {   // the app shell shows inside the Capacitor app: same stub as release-1-13-10
    window.Capacitor = { isNativePlatform: () => true, Plugins: { App: { addListener: async () => ({ remove() {} }), getInfo: async () => ({ id: 'test', version: '1.13.0', build: '3' }) },
      TallyNative: { addListener: async () => ({ remove() {} }), takeShared: async () => ({ files: [] }), releaseShared: async () => {}, openExternal: async () => { throw Error('External launch prohibited'); } },
      Filesystem: { writeFile: async () => {}, appendFile: async () => {}, deleteFile: async () => {}, getUri: async o => ({ uri: 'content://test/' + o.path }) }, Share: { share: async () => {} } } };
  });
  const page = await ctx.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:8781/index.html');
  await page.waitForSelector('.welcome', { timeout: 15000 });
  await page.evaluate(async () => {
    const st = await import('/js/state.js'), app = await import('/js/app.js');
    await st.replaceAll({ accounts: [{ id: 'bank', name: 'Test bank', kind: 'bank', opening: 10000, typed: true, createdAt: 1 }, { id: 'asb', name: 'ASB', kind: 'savings', opening: 5000, typed: true, createdAt: 1 }], tx: [], recurring: [], kv: { settings: { tourDone: true, seenVersion: '1.13.0', lang: 'en', noSpend: [st.today()] } } });
    await (await import('/js/features.js')).setModules({ goals: true });
    app.go('settings'); app.render();
  });
  const err = sel => page.locator(sel).textContent();
  const shown = async sel => { await page.waitForFunction(s => document.querySelector(s).textContent, sel); return err(sel); };   // Save is async: wait for the message
  const gone = () => page.waitForFunction(() => !document.querySelector('.sheet'));

  // goal sheet: empty target -> error; typing a valid target clears it
  await page.evaluate(async () => (await import('/js/views/goals.js')).act['goal-edit']({ dataset: {} }));
  await page.locator('#g-name').fill('Phone');
  await page.click('[data-x="save"]');
  assert.equal(await shown('#g-err'), 'Enter an amount, for example 12.50.');
  await page.locator('#g-amt').fill('12.50');
  assert.equal(await err('#g-err'), '', 'error gone after typing a valid target');
  // each other field clears it too (name error, then select / date)
  await page.locator('#g-name').fill(''); await page.click('[data-x="save"]');
  assert.equal(await shown('#g-err'), 'Give the goal a name.');
  await page.locator('#g-name').fill('P'); assert.equal(await err('#g-err'), '', 'name edit');
  await page.locator('#g-amt').fill(''); await page.click('[data-x="save"]');
  assert.ok(await shown('#g-err'));
  await page.selectOption('#g-acc', 'asb'); assert.equal(await err('#g-err'), '', 'account select');
  await page.click('[data-x="save"]'); assert.ok(await shown('#g-err'));
  await page.locator('#g-by').fill('2030-01-31'); assert.equal(await err('#g-err'), '', 'date edit');
  // still saves normally (account has money, so no RM 0 notice)
  await page.locator('#g-amt').fill('100'); await page.click('[data-x="save"]'); await gone();
  assert.equal(await page.evaluate(async () => (await import('/js/state.js')).S.kv.goals.length), 1);

  // account sheet (same class): empty name -> error; typing clears it
  await page.evaluate(async () => (await import('/js/views/setup.js')).act['acc-edit']({ dataset: {} }));
  await page.locator('#ac-name').fill(''); await page.click('[data-act="acc-save"]');
  assert.ok(await shown('#ac-err'), 'account error shows');
  await page.locator('#ac-name').fill('Wallet'); assert.equal(await err('#ac-err'), '', 'account error cleared');
  // split-bill: its 'must add up' message has no id, so typing in a paid field must NOT clear it; fixing the sum removes it
  await page.keyboard.press('Escape'); await gone();
  await page.evaluate(async () => {
    const tx = { id: 'sp1', type: 'expense', date: (await import('/js/state.js')).today(), amount: 10000, merchant: 'Cafe', accountId: 'bank', category: 'dining', createdAt: 1,
      split: { total: 10000, with: ['Ann', 'Bob'], who: [], paid: { Ann: 4000, Bob: 3000, '': 3000 } } };
    (await import('/js/views/splitbill.js')).openSplit(tx);
  });
  await page.locator('.sp-amt').first().waitFor();
  const sum = page.locator('.sp-body .err[role="alert"]');
  assert.equal(await sum.count(), 0, 'sums to the bill at first');
  await page.locator('.sp-amt[data-pa="Bob"]').fill('80.00');   // input event only: no redraw yet
  assert.equal(await sum.count(), 0, 'not shown before the field is left');
  await page.locator('.sp-amt[data-pa="Bob"]').blur(); await sum.waitFor();
  assert.match(await sum.textContent(), /must add up/);
  await page.locator('.sp-amt[data-pa="Bob"]').fill('81.00');   // typing while still wrong: message must stay
  assert.equal(await sum.count(), 1, 'message survives typing in a paid field');
  assert.match(await sum.textContent(), /must add up/);
  await page.locator('.sp-amt[data-pa="Bob"]').fill('30.00'); await page.locator('.sp-amt[data-pa="Bob"]').blur();
  await page.waitForFunction(() => !document.querySelector('.sp-body .err'));
  assert.deepEqual(errors, []);
  console.log('ok: stale sheet errors clear on edit (goal sheet, account sheet)');
} finally { await browser.close(); server.close(); }
