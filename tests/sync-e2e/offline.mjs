// Gates-off offline cold-reload check: SW installs, context goes offline, reload still renders the app.
import { chromium } from 'playwright';
import { startServer, spki } from './serve.mjs';
const [root, name] = process.argv.slice(2);
const web = await startServer({ root, enableGates: false });
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--host-resolver-rules=MAP tallymy.github.io 127.0.0.1:' + web.port, '--ignore-certificate-errors-spki-list=' + await spki(), '--no-proxy-server'] });
const ctx = await browser.newContext(); const page = await ctx.newPage();
await page.goto('https://tallymy.github.io/index.html');
await page.waitForFunction(() => navigator.serviceWorker.getRegistration().then(r => r?.active?.state === 'activated'), null, { timeout: 90000 });
await page.waitForTimeout(3000); await page.goto("https://tallymy.github.io/index.html?x=1"); await page.waitForTimeout(2000); console.log("ctl1", await page.evaluate(() => !!navigator.serviceWorker.controller), await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r && [r.scope, r.active?.scriptURL])));
console.log("controlled:", await page.evaluate(() => !!navigator.serviceWorker.controller)); await web.close();
await page.reload(); await page.locator('#app .skel').waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
await page.goto('https://tallymy.github.io/index.html#/settings'); await page.waitForTimeout(3000);
console.log(name, 'offline ok:', await page.evaluate(() => ({ title: document.title, body: document.body.innerText.length, skel: !!document.querySelector('.skel'), settings: !!document.querySelector('[data-act="erase-all"]') })));
await browser.close();
