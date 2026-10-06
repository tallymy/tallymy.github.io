import { chromium } from 'playwright';
import { startServer, spki } from './serve.mjs';
const web = await startServer({ root: 'D:/tally-sync-assembled', enableGates: true });
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--host-resolver-rules=MAP tallymy.github.io 127.0.0.1:' + web.port, '--ignore-certificate-errors-spki-list=' + await spki(), '--no-proxy-server'] });
const ctx = await browser.newContext(); const page = await ctx.newPage();
await page.goto('https://tallymy.github.io/index.html');
await page.waitForFunction(() => navigator.serviceWorker.getRegistration().then(r => r?.active?.state === 'activated'), null, { timeout: 90000 });
await page.reload(); await page.waitForFunction(() => !!navigator.serviceWorker.controller); await page.waitForTimeout(1500); console.log('page iso after reload', await page.evaluate(() => crossOriginIsolated), await page.evaluate(() => performance.getEntriesByType('navigation')[0].serverTiming?.length));
for (const via of ['sw', 'nosw']) {
  const [pop] = await Promise.all([ctx.waitForEvent('page'), page.evaluate(v => { window.__w = open('/sync-signal.html?x=' + v); }, via)]);
  await pop.waitForLoadState();
  console.log(via, 'opener in popup:', await pop.evaluate(() => !!window.opener), 'iso', await pop.evaluate(() => crossOriginIsolated), 'pageIso', await page.evaluate(() => crossOriginIsolated), 'closed?', await page.evaluate(() => window.__w.closed));
  await pop.close();
}
await browser.close(); await web.close();
