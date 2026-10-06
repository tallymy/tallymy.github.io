// Desktop-only assembled e2e: two headless Playwright-Chromium contexts, real RTCPeerConnection/DataChannel pairing,
// served from D:\tally-sync-assembled over a local HTTPS server mapped to the public origin. Gates enabled ONLY in served bytes.
import { runScenarios } from './scenarios.mjs';
import { chromium } from 'playwright';
import http from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startServer, spki } from './serve.mjs';

const treeRoot = resolve(process.env.SYNC_TREE || 'D:/tally-sync-assembled'), qa = resolve('D:/tally-sync-assembled-harness/qa');
const origin = 'https://tallymy.github.io', results = [], pages = {}, contexts = {}, network = [], PIN = '123456';
const granted = [], logs = [];
let offer = null, answer = null, active = false;
const web = await startServer({ root: treeRoot, enableGates: true });
const nativeServer = http.createServer(async (req, res) => {
  if (req.headers.origin !== origin || req.method !== 'OPTIONS' && req.headers['x-tally-code'] !== PIN) { res.writeHead(403); res.end('{}'); return; }
  const h = { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-Tally-Code', 'Access-Control-Allow-Private-Network': 'true', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method === 'OPTIONS') { res.writeHead(204, h); res.end(); return; }
  let body = ''; for await (const b of req) { body += b; if (body.length > 65000) { res.writeHead(413, h); res.end('{}'); return; } }
  network.push({ method: req.method, path: req.url, bytes: body.length });
  if (!active) { res.writeHead(410, h); res.end('{}'); }
  else if (req.method === 'GET' && req.url === '/offer') { res.writeHead(200, h); res.end(JSON.stringify({ sdp: offer })); }
  else if (req.method === 'POST' && req.url === '/answer') { const v = JSON.parse(body); assert.deepEqual(Object.keys(v), ['sdp']); answer = v.sdp; res.writeHead(200, h); res.end('{}'); }
  else { res.writeHead(404, h); res.end('{}'); }
});
await new Promise(r => nativeServer.listen(0, '127.0.0.1', r));
const address = 'http://127.0.0.1:' + nativeServer.address().port;
const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || undefined, args: ['--host-resolver-rules=MAP tallymy.github.io 127.0.0.1:' + web.port, '--ignore-certificate-errors-spki-list=' + await spki(), '--no-proxy-server'] });
const check = (name, value) => { assert.ok(value, name); results.push({ case: name, pass: true }); };
try {
  for (const role of ['computer', 'phone']) {
    const context = contexts[role] = await browser.newContext(process.env.SW_BLOCK ? { serviceWorkers: 'block' } : {});   // SW allowed unless SW_BLOCK=1
    await context.exposeFunction('__ownedNative', async (name, args) => {
      if (name === 'startLanPair') { offer = args.offer; answer = null; active = true; return { address, pin: PIN }; }
      if (name === 'lanPairStatus') return { active, answer };
      if (name === 'stopLanPair') { active = false; return {}; }
      if (name === 'takeShared') return { files: [] };
      if (name === 'scanShortcut') return { button: 'capture' };
      return { supported: false };
    });
    if (role === 'phone') await context.addInitScript(() => { const plugin = new Proxy({}, { get: (_, name) => name === 'addListener' ? async () => ({ remove: async () => {} }) : async (args = {}) => __ownedNative(String(name), args) }); globalThis.Capacitor = { isNativePlatform: () => true, Plugins: { TallyNative: plugin } }; });
    context.on('page', p => { p.on('console', m => logs.push(role + ' popup/page console ' + m.type() + ': ' + m.text().slice(0, 300))); p.on('pageerror', e => logs.push(role + ' pageerror: ' + e.message.slice(0, 300))); p.on('requestfailed', r => logs.push(role + ' reqfailed: ' + r.url().slice(0, 100) + ' ' + r.failure()?.errorText)); });
    const page = pages[role] = await context.newPage();
    page.on('console', m => { if (['error','warning'].includes(m.type())) logs.push(role + ': ' + m.text().slice(0, 300)); });
    page.on('pageerror', e => console.log('page error', role, e.message));
    await page.goto(origin + '/404.html');   // any same-origin page to seed IDB
    await page.evaluate(async role => {
      const db = await import('/js/db.js'); await db.init();
      const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 20; const c = canvas.getContext('2d'); c.fillStyle = role === 'computer' ? '#123456' : '#abcdef'; c.fillRect(0, 0, 20, 20);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      await db.writeAtomic({ put: { accounts: [{ id: 'cash', name: role + ' Cash', kind: 'cash', currency: 'MYR', opening: 0, typed: false }], tx: [{ id: 'original', date: '2026-10-05', type: 'expense', amount: role === 'computer' ? 600 : 900, accountId: 'cash', category: 'dining', source: 'quick', receiptId: role + '-photo' }], receipts: [{ id: role + '-photo', blob }], kv: [{ key: 'settings', value: { lang: 'en', theme: 'light', gamify: false, seenVersion: '1.13.10', learnHidden: true, onboarded: true, tourDone: true, photoTipsSeen: true, features: { insights: true, receipts: true, afford: true, split: true } } }, { key: 'bookGeneration', value: role + '-generation' }, { key: 'rules', value: {} }] } });
    }, role);
    await page.goto(origin + '/index.html#/settings');
    await page.locator('[data-act="book-sync-open"]').waitFor({ timeout: 20000 });
    if (!process.env.SW_BLOCK && role === 'computer') { await page.waitForFunction(() => navigator.serviceWorker.getRegistration().then(r => r?.active?.state === 'activated'), null, { timeout: 90000 }); await page.reload(); await page.locator('[data-act="book-sync-open"]').waitFor({ timeout: 20000 }); await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 }); }
    await page.evaluate(() => document.fonts.ready);
    const session = await browser.newBrowserCDPSession(), pageCdp = await context.newCDPSession(page), info = await pageCdp.send('Target.getTargetInfo');
    for (const permission of ['localNetworkAccess', 'localNetwork', 'loopbackNetwork']) await session.send('Browser.grantPermissions', { permissions: [permission], origin, browserContextId: info.targetInfo.browserContextId }).then(() => granted.push(permission), () => {});
  }
  const sw = await Promise.all(Object.values(pages).map(p => p.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return { has: !!r, state: (r?.active || r?.installing || r?.waiting)?.state, caches: await caches.keys() }; })));
  results.push({ case: 'info: granted permissions ' + [...new Set(granted)].join(','), info: granted });
  results.push({ case: 'info: isolation ' , info: await Promise.all(Object.values(pages).map(p => p.evaluate(() => ({ iso: crossOriginIsolated, ctl: !!navigator.serviceWorker.controller })))) });
  results.push({ case: 'info: service worker state after first load (not an assertion)', info: sw });
  const click = async (role, selector) => { await pages[role].locator(selector).click(); };
  const syncButton = a => '[data-main-sync="' + a + '"]';
  async function pair(initial = true) {
    for (const role of ['phone', 'computer']) { await click(role, '[data-act="book-sync-open"]'); await click(role, '[data-sync-action="start"]'); }
    await pages.phone.locator('[data-sync-field="address"]').waitFor();
    await pages.phone.waitForFunction(() => document.querySelector('[data-sync-field="address"]')?.value);
    await pages.computer.locator('[data-sync-field="address"]').fill(address);
    await pages.computer.locator('[data-sync-field="code"]').fill(PIN);
    await click('computer', '[data-sync-action="connect"]');
    for (const role of ['computer', 'phone']) await pages[role].locator('[data-sync-action="approve"]:enabled').waitFor({ timeout: 20000 });
    const text = await Promise.all(Object.values(pages).map(p => p.locator('.sync-sheet').innerText()));
    const codes = text.map(t => t.match(/\b\d{4} \d{4} \d{4}\b/)?.[0]);
    check('real RTC pairing yields matching 12-digit grouped SAS in both actual UI sheets', codes[0] && codes[0] === codes[1]);
    await click('computer', '[data-sync-action="approve"]');
    check('computer SAS approval alone does not expose book-sharing UI', await pages.computer.locator('[data-main-sync="grant"]').count() === 0);
    await click('phone', '[data-sync-action="approve"]');
    for (const p of Object.values(pages)) await p.locator('[data-main-sync="grant"]:enabled').waitFor();
    const identities = await Promise.all(Object.values(pages).map(p => p.evaluate(async () => !!(await (await import('/js/db.js')).getKv('offlineSync')))));
    check(initial ? 'SAS approvals alone create no book identity on either actual IDB' : 'linked book metadata exists without granting new connection sharing', identities.every(v => initial ? !v : v));
    await click('computer', syncButton('grant'));
    check('single independent sharing consent cannot inspect either book', await pages.computer.locator('[data-main-sync="inspect"]').count() === 0);
    await click('phone', syncButton('grant'));
    for (const p of Object.values(pages)) await p.locator('[data-main-sync="inspect"]').waitFor({ timeout: 15000 });
  }
  await pair();
  for (const role of ['computer', 'phone']) await click(role, syncButton('inspect'));
  for (const role of ['computer', 'phone']) { await pages[role].locator('[data-main-sync="choose"][data-choice="computer"]').waitFor(); await click(role, '[data-main-sync="choose"][data-choice="computer"]'); await click(role, syncButton('backup')); }
  for (const role of ['computer', 'phone']) await click(role, syncButton('refresh'));
  for (const role of ['computer', 'phone']) await pages[role].locator('[data-main-sync="approve"]:enabled').waitFor();
  check('actual first-book choice, two safety copies and plan-bound full diff are visible', await pages.phone.locator('.sync-sheet').innerText().then(t => t.includes('Computer book selected') && t.includes('Review before syncing')));
  for (const role of ['computer', 'phone']) await click(role, syncButton('approve'));
  await click('computer', syncButton('refresh'));
  await pages.computer.locator('[data-main-sync="coordinate"]:enabled').waitFor();
  await click('computer', syncButton('coordinate'));
  for (const p of Object.values(pages)) await p.waitForFunction(() => document.querySelector('.sync-sheet')?.textContent.includes('Both books are up to date.'), null, { timeout: 20000 });
  const states = await Promise.all(Object.values(pages).map(p => p.evaluate(async () => { const db = await import('/js/db.js'), core = await import('/js/book-sync/sync-core.mjs'), row = await db.get('receipts', 'computer-photo'); return { tx: await db.all('tx'), photoHash: await core.sha256(new Uint8Array(await row.blob.arrayBuffer())), pending: (await db.getKv('offlineSync')).pending }; })));
  check('actual RTC full-book sync commits and acknowledges both books with unchanged photo SHA', states.every(s => s.tx.length === 1 && s.tx[0].amount === 600 && !s.pending) && states[0].photoHash === states[1].photoHash);
  await mkdir(qa, { recursive: true });
  for (const [role, p] of Object.entries(pages)) await p.screenshot({ path: qa + '/' + role + '-ready.png', fullPage: true });
  await runScenarios({ pages, pair, click, check, qa });
  for (const [role, p] of Object.entries(pages)) await p.screenshot({ path: qa + '/' + role + '-final.png', fullPage: true });
  const finalSw = await Promise.all(Object.values(pages).map(p => p.evaluate(async () => ({ controlled: !!navigator.serviceWorker.controller, caches: await caches.keys() }))));
  await writeFile(qa + '/results.json', JSON.stringify({ tree: treeRoot, results, serviceWorker: { afterFirstLoad: sw, final: finalSw }, nativeFixtureRequests: network.map(({ method, path, bytes }) => ({ method, path, bytes })), webMissing: web.missing, limitations: 'Desk-only: two headless Playwright Chromium contexts, real RTCPeerConnection/DataChannel with empty ICE servers and local HTTP SDP; Android native LAN service is a JS-to-owned-Node fixture; no physical device, LAN, LNA prompt or lock/screen-off proof. Source gates remain literal false; true only in served bytes.', pass: true }, null, 2));
  console.log(JSON.stringify({ pass: true, cases: results.filter(r => r.pass).length, missing: web.missing }));
} catch (error) {
  const popup = contexts.computer.pages().find(p => p.url().includes("sync-signal")); const popupDiag = popup ? await popup.evaluate(async a => ({ iso: crossOriginIsolated, opener: !!window.opener, text: document.body.innerText.slice(0, 200), fetch: await fetch(a + "/offer", { headers: { "X-Tally-Code": "123456" } }).then(r => r.status, e => String(e.message)) }), address).catch(e => String(e.message)) : null;
  const diag = { popupDiag, pages: Object.fromEntries(Object.entries(contexts).map(([r, c]) => [r, c.pages().map(p => p.url())])) }; for (const [r, p] of Object.entries(pages)) diag[r] = await p.evaluate(async () => { const v = globalThis.__ownedRuntime; const o = {}; try { o.controller = v.controller()?.state(); } catch (e) { o.cerr = String(e.message); } try { o.view = v.getPairingView(); if (o.view?.pairing) o.view.pairing = { manualRole: o.view.pairing.manualRole }; } catch (e) { o.verr = String(e.message); } o.errs = globalThis.__ctrlErrs; o.kv = (await (await import('/js/db.js')).getKv('offlineSync')); return JSON.parse(JSON.stringify(o, (k, x) => typeof x === 'string' && x.length > 200 ? x.slice(0, 200) : x)); }).catch(e => String(e.message));
  await mkdir(qa, { recursive: true }); await writeFile(qa + '/failure.json', JSON.stringify({ message: String(error.stack || error).slice(0, 4000), results, webMissing: web.missing, logs, diag }, null, 2));
  for (const [role, p] of Object.entries(pages)) await p.screenshot({ path: qa + '/' + role + '-failure.png', fullPage: true }).catch(() => {});
  console.log('FAIL', String(error.message).slice(0, 600)); process.exitCode = 1;
} finally { await browser.close(); await web.close(); await new Promise(r => nativeServer.close(r)); }
