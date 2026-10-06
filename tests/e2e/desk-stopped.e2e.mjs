// Headless Playwright Chromium: the phone's "Use Tally on your computer" sheet must not keep showing the old address and joining code
// after the connection stops (native stopped event, Home/background, lock). Android signaling is simulated; not a device test.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../', import.meta.url));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname, target = resolve(root, '.' + (path === '/' ? '/index.html' : path));
    if (!target.startsWith(resolve(root) + sep)) throw Error();
    res.setHeader('Content-Type', mime[extname(target)] || 'application/octet-stream'); res.setHeader('Cache-Control', 'no-store'); res.end(await readFile(target));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const results = [], errors = [];
try {
  const context = await browser.newContext(); const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await context.exposeFunction('mockStart', () => ({ address: '192.168.1.77:40123', pin: '654321', active: true }));
  await context.exposeFunction('mockStatus', () => ({ active: true, answer: null }));
  await context.addInitScript(() => {
    window.__hidden = false; Object.defineProperty(document, 'hidden', { get: () => window.__hidden });
    window.__native = {};
    window.Capacitor = { isNativePlatform: () => true, Plugins: { App: { addListener: async () => ({ remove() {} }), getInfo: async () => ({ id: 'test', version: '1.13.0', build: '3' }) },
      TallyNative: { addListener: async (name, cb) => { window.__native[name] = cb; return { remove() {} }; }, takeShared: async () => ({ files: [] }), releaseShared: async () => {}, startLanPair: () => window.mockStart(), lanPairStatus: () => window.mockStatus(), stopLanPair: async () => ({}) } } };
  });
  await page.goto(base + '/index.html?app'); await page.locator('.welcome').waitFor();
  const text = () => page.locator('.sheet').first().textContent();
  const open = async () => {
    await page.evaluate(async () => { const ui = await import('/js/ui.js'); while (ui.sheetOpen()) ui.closeSheet(); (await import('/js/desk-host.js')).openDesk(); });
    await page.locator('#desk-start').click(); await page.waitForFunction(() => document.querySelector('.sheet')?.textContent.includes('654321'));
    const shown = await text(); assert.ok(shown.includes('192.168.1.77:40123') && shown.includes('654321'));
  };
  const stopped = async name => {
    await page.waitForFunction(() => document.querySelector('.sheet')?.textContent.includes('Connection stopped. Start again to connect.'));
    const shown = await text();
    assert.ok(!shown.includes('654321') && !shown.includes('192.168.1.77'), name + ': old code or address still visible');
    assert.equal(await page.locator('#desk-start').isEnabled(), true, name + ': Start must be enabled');
    assert.equal(await page.locator('.sheet [data-desk="approve"]').count(), 0);
    results.push(name);
  };
  // 1. native service reports it stopped (Android power key / Home)
  await open(); await page.evaluate(() => window.__native.deskStopped()); await stopped('native deskStopped event');
  // 2. Start works again from the neutral sheet, then the page goes to the background
  await page.locator('#desk-start').click(); await page.waitForFunction(() => document.querySelector('.sheet')?.textContent.includes('654321'));
  await page.evaluate(() => { window.__hidden = true; document.dispatchEvent(new Event('visibilitychange')); }); await stopped('visibilitychange hidden');
  // the stale text must also be absent after the app comes back
  await page.evaluate(() => { window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); }); await stopped('after returning to the app');
  // 3. pagehide
  await page.locator('#desk-start').click(); await page.waitForFunction(() => document.querySelector('.sheet')?.textContent.includes('654321'));
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); await stopped('pagehide');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ pass: results }, null, 1));
} finally { await browser.close(); server.close(); }
