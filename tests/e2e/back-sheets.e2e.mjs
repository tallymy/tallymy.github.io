// Android Back and sheets: Back pops exactly one sheet layer (the top first); only with no sheet open does it leave the app;
// closing a sheet from code (Save, Cancel, script) leaves no orphan history step. Headless Playwright Chromium only.
// Run: node tests/e2e/back-sheets.e2e.mjs   (serves this tree on 127.0.0.1:8795)
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
await new Promise(r => server.listen(8795, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await ctx.addInitScript(() => {   // the app shell (not the landing page) shows inside the Capacitor app: same stub as the other e2e files
    window.Capacitor = { isNativePlatform: () => true, Plugins: { App: { addListener: async () => ({ remove() {} }), getInfo: async () => ({ id: 'test', version: '1.13.0', build: '3' }) },
      TallyNative: { addListener: async () => ({ remove() {} }), takeShared: async () => ({ files: [] }), releaseShared: async () => {}, openExternal: async () => { throw Error('External launch prohibited'); } },
      Filesystem: { writeFile: async () => {}, appendFile: async () => {}, deleteFile: async () => {}, getUri: async o => ({ uri: 'content://test/' + o.path }) }, Share: { share: async () => {} } } };
  });
  const page = await ctx.newPage(); page.on('pageerror', e => errors.push(e.message));
  const settle = () => page.waitForTimeout(350);
  const fresh = async () => {   // a new page in a new history: about:blank, then the app on Home
    await page.goto('about:blank');
    await page.goto('http://127.0.0.1:8795/index.html'); await page.waitForSelector('.welcome, .tabs', { timeout: 15000 });
    await page.evaluate(async () => {
      const st = await import('/js/state.js'), app = await import('/js/app.js');
      await st.replaceAll({ accounts: [{ id: 'bank', name: 'Bank', kind: 'bank', opening: 100, typed: true, createdAt: 1 }], tx: [], recurring: [], kv: { settings: { tourDone: true, seenVersion: '1.13.12', lang: 'en', noSpend: [st.today()] } } });
      app.go('home'); app.render();
    });
    await settle();
    await page.evaluate(async () => { window.__ui = await import('/js/ui.js'); window.__log = []; });
  };
  const open = (n, stack = false) => page.evaluate(({ n, stack }) => window.__ui.openSheet(`<h2 class="sh-title">S${n}</h2><button class="btn" data-act="sheet-close">x</button>`, { label: 'S' + n, stack, onClose: () => window.__log.push('close' + n) }) && 1, { n, stack });
  const shown = () => page.evaluate(() => [...document.querySelectorAll('.scrim:not(.out) .sh-title')].map(e => e.textContent));
  const url = () => page.url();
  const hist = () => page.evaluate(() => ({ len: history.length, depth: history.state?.depth || 0, sheet: !!history.state?.sheet }));
  const inApp = () => assert.match(url(), /127\.0\.0\.1:8795\/index\.html#?\/?/);
  const back = async () => { await page.evaluate(() => history.back()); await settle(); };
  const left = () => assert.equal(url(), 'about:blank', 'Back with no sheet leaves the app');

  // 1. a single sheet
  await fresh(); await open(1); await settle();
  assert.deepEqual(await shown(), ['S1']);
  await back(); assert.deepEqual(await shown(), []); inApp();
  await page.goBack(); await settle(); left();

  // 2. two stacked (goal sheet + create-account sheet)
  await fresh(); await open(1); await open(2, true); await settle();
  assert.deepEqual(await shown(), ['S1', 'S2']);
  await back(); assert.deepEqual(await shown(), ['S1'], 'Back closes only the top sheet'); inApp();
  await back(); assert.deepEqual(await shown(), [], 'the next Back closes the one below'); inApp();
  await page.goBack(); await settle(); left();

  // 3. three stacked, driven by page.goBack()
  await fresh(); await open(1); await open(2, true); await open(3, true); await settle();
  for (const want of [['S1', 'S2'], ['S1'], []]) { await page.goBack(); await settle(); assert.deepEqual(await shown(), want); inApp(); }
  await page.goBack(); await settle(); left();

  // 4. the top closed from code, then Back: closes the next, does not leave
  await fresh(); await open(1); await open(2, true); await settle();
  await page.evaluate(() => window.__ui.closeSheet()); await settle();
  assert.deepEqual(await shown(), ['S1']); inApp();
  await back(); assert.deepEqual(await shown(), []); inApp();
  await page.goBack(); await settle(); left();

  // 5. everything closed from code (Save closes all): no orphan history step, one Back leaves
  await fresh(); const h0 = await hist();
  await open(1); await open(2, true); await settle();
  await page.evaluate(() => { window.__ui.closeSheet(); window.__ui.closeSheet(); }); await settle();
  assert.deepEqual(await shown(), []);
  assert.deepEqual({ ...(await hist()), len: 0 }, { ...h0, len: 0 }, 'back on the same step (forward entries left behind are unreachable by Back)');
  await page.goBack(); await settle(); left();

  // 5b. a single sheet closed from code, same
  await fresh(); const h1 = await hist(); await open(1); await settle(); await page.evaluate(() => window.__ui.closeSheet()); await settle();
  assert.deepEqual({ ...(await hist()), len: 0 }, { ...h1, len: 0 }); await page.goBack(); await settle(); left();

  // 6. rapid double Back with two stacked sheets
  await fresh(); await open(1); await open(2, true); await settle();
  await page.evaluate(() => { history.back(); history.back(); }); await settle(); await settle();
  assert.deepEqual(await shown(), []); inApp();
  await page.goBack(); await settle(); left();

  // 7. close and open in the same tick (a sheet redrawn): no history change, Back still closes it once
  await fresh(); await open(1); await settle(); const h2 = await hist();
  await page.evaluate(() => { window.__ui.closeSheet(); window.__ui.openSheet('<h2 class="sh-title">S9</h2>', { label: 'S9' }); }); await settle();
  assert.deepEqual(await hist(), h2); assert.deepEqual(await shown(), ['S9']);
  await back(); assert.deepEqual(await shown(), []); inApp();
  await page.goBack(); await settle(); left();

  // 8. a non-stacked sheet opened over stacked ones replaces them all with one layer
  await fresh(); await open(1); await open(2, true); await open(5); await settle();
  assert.deepEqual(await shown(), ['S5']);
  await back(); assert.deepEqual(await shown(), []); inApp();
  await page.goBack(); await settle(); left();

  // 9. the real flow: goal sheet -> Create a savings account (stacked) -> Back, Back
  await fresh();
  await page.evaluate(async () => { await (await import('/js/features.js')).setModules({ goals: true }); await (await import('/js/views/goals.js')).act['goal-edit']({ dataset: {} }); }); await settle();
  await page.click('[data-x="newacc"]'); await page.locator('#ac-name').waitFor(); await settle();
  await back(); assert.equal(await page.locator('#ac-name').count(), 0, 'account sheet closed'); assert.equal(await page.locator('#g-name').count(), 1, 'goal sheet still open'); inApp();
  await back(); assert.equal(await page.locator('#g-name').count(), 0); inApp();
  await page.goBack(); await settle(); left();

  assert.deepEqual(errors, [], 'no page errors');
  console.log('back-sheets e2e: OK');
} finally { await browser.close(); server.close(); }
