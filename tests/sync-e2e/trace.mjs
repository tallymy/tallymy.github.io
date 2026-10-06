// Gates-false boot trace: request + storage snapshot, run per tree, then diffed.
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { startServer, spki } from './serve.mjs';
const [root, name, swMode] = process.argv.slice(2);
const web = await startServer({ root, enableGates: false });
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--host-resolver-rules=MAP tallymy.github.io 127.0.0.1:' + web.port, '--ignore-certificate-errors-spki-list=' + await spki(), '--no-proxy-server'] });
const ctx = await browser.newContext(swMode === 'block' ? { serviceWorkers: 'block' } : {}); const page = await ctx.newPage();
const external = []; ctx.on('request', r => { if (!r.url().startsWith('https://tallymy.github.io')) external.push(r.method() + ' ' + r.url().split('?')[0]); });
await page.goto('https://tallymy.github.io/404.html');
await page.evaluate(async () => { const db = await import('/js/db.js'); await db.init(); await db.writeAtomic({ put: { accounts: [{ id: 'cash', name: 'Cash', kind: 'cash', currency: 'MYR', opening: 0, typed: false }], tx: [{ id: 'a', date: '2026-10-05', type: 'expense', amount: 600, accountId: 'cash', category: 'dining', source: 'quick' }], kv: [{ key: 'settings', value: { lang: 'en', seenVersion: '1.13.10', learnHidden: true, onboarded: true, tourDone: true, photoTipsSeen: true } }] } }); });
web.trace.length = 0;
await page.goto('https://tallymy.github.io/index.html#/settings');
await page.locator('.view-settings, [data-act="erase-all"], h1').first().waitFor({ timeout: 20000 });
await page.waitForTimeout(swMode === 'block' ? 3000 : 8000);
const hasSyncUi = await page.evaluate(() => ({ bookSyncOpen: !!document.querySelector('[data-act="book-sync-open"]'), savedSafety: !!document.querySelector('[data-act="saved-safety-open"]'), syncText: /Sync this book|Saved safety/i.test(document.body.innerText) }));
const storage = await page.evaluate(async () => {
  const out = { local: Object.keys(localStorage).sort(), session: Object.keys(sessionStorage).sort(), caches: {}, idb: {} };
  for (const k of await caches.keys()) out.caches[k] = (await (await caches.open(k)).keys()).length;
  const dbs = await indexedDB.databases(); for (const d of dbs) { out.idb[d.name] = await new Promise((res, rej) => { const rq = indexedDB.open(d.name); rq.onsuccess = async () => { const db = rq.result, o = {}; for (const s of [...db.objectStoreNames]) { o[s] = await new Promise(r => { const q = db.transaction(s).objectStore(s).getAllKeys(); q.onsuccess = () => r(q.result.map(String).sort()); }); } db.close(); res(o); }; rq.onerror = () => rej(rq.error); }); }
  return out;
});
await mkdir('D:/tally-sync-assembled-harness/qa', { recursive: true });
await writeFile(`D:/tally-sync-assembled-harness/qa/trace-${name}-${swMode}.json`, JSON.stringify({ requests: [...new Set(web.trace)].sort(), external, hasSyncUi, storage, missing: web.missing }, null, 1));
console.log(name, swMode, 'requests', new Set(web.trace).size, 'external', external.length, JSON.stringify(hasSyncUi));
await browser.close(); await web.close();
