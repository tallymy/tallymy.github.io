// DataChannel-drop matrix for the commit/ACK/recovery path (harness only; nothing here ships, no source behaviour is changed).
// Two headless Playwright-Chromium contexts, real RTCDataChannel. A deterministic hook in an init script (test harness) closes the
// channel at a chosen message boundary: lost (never sent / never delivered) or after (delivered, then closed). Then both devices
// reconnect through the product UI (fresh pairing, "Check an unfinished sync" when anything is pending) and must converge.
//   node tests/sync-e2e/drop.mjs [seed] [filterRegex]      env: SW_BLOCK=1 COEP=1 as the pairing e2e
import { chromium } from 'playwright';
import http from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startServer, spki } from './serve.mjs';

const seed = Number(process.argv[2] || 20261005), only = process.argv[3] ? new RegExp(process.argv[3]) : null;
const rnd = (a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; })(seed);
const treeRoot = resolve(process.env.SYNC_TREE || 'D:/tally-sync-assembled'), qa = resolve('D:/tally-sync-assembled-harness/qa');
const origin = 'https://tallymy.github.io', PIN = '123456', roles = ['computer', 'phone'];
const RECOVERY_WAIT_MS = 20000;   // explicit bounded wait for each recovery step
let offer = null, answer = null, active = false;
const web = await startServer({ root: treeRoot, enableGates: true });
const nativeServer = http.createServer(async (req, res) => {
  if (req.headers.origin !== origin || req.method !== 'OPTIONS' && req.headers['x-tally-code'] !== PIN) { res.writeHead(403); res.end('{}'); return; }
  const h = { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-Tally-Code', 'Access-Control-Allow-Private-Network': 'true', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method === 'OPTIONS') { res.writeHead(204, h); res.end(); return; }
  let body = ''; for await (const b of req) body += b;
  if (!active) { res.writeHead(410, h); res.end('{}'); }
  else if (req.method === 'GET' && req.url === '/offer') { res.writeHead(200, h); res.end(JSON.stringify({ sdp: offer })); }
  else if (req.method === 'POST' && req.url === '/answer') { answer = JSON.parse(body).sdp; res.writeHead(200, h); res.end('{}'); }
  else { res.writeHead(404, h); res.end('{}'); }
});
await new Promise(r => nativeServer.listen(0, '127.0.0.1', r));
const address = 'http://127.0.0.1:' + nativeServer.address().port;
const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP tallymy.github.io 127.0.0.1:' + web.port, '--ignore-certificate-errors-spki-list=' + await spki(), '--no-proxy-server'] });

// ---- harness-only DataChannel hook (runs in the page; armed by page.evaluate(cfg)) ----
function installHook() {
  const S = globalThis.__drop = { cfg: null, fired: null, log: [] }, inSeq = new Map(), outSeq = new Map(), labels = new Map();
  const info = t => ({ type: /"type":"(\w+)"/.exec(t)?.[1], seq: Number(/"seq":(\d+)/.exec(t)?.[1]), method: /"method":"(\w+)"/.exec(t)?.[1] });
  function label(dir, p) {   // p: wire chunk. Returns 'req:method' | 'res:method' | null
    const k = dir + p.id;
    if (p.i === 0) {
      const m = info(p.text); let l = null;
      if (m.type === 'request') { (dir === 'send' ? outSeq : inSeq).set(m.seq, m.method); l = 'req:' + m.method; }
      else if (m.type === 'response') l = 'res:' + (dir === 'send' ? inSeq : outSeq).get(m.seq);
      labels.set(k, l);
    }
    return labels.get(k) ?? null;
  }
  const blip = ms => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); setTimeout(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); }, ms); };
  const fire = (ch, why) => { const c = S.cfg; if (!c || S.fired) return false; S.fired = { why, at: Date.now() }; if (c.action === 'blip') { blip(c.blipMs); return true; } setTimeout(() => { try { ch.close(); } catch {} }, c.delay); return true; };
  const hit = (dir, ch, p) => {
    const c = S.cfg; if (!c || S.fired || c.dir !== dir || !p || p.v !== 1) return null;
    const l = label(dir, p); if (l !== c.label) return null;
    const last = p.i === p.n - 1;
    if (c.mode === 'lost' && p.i === 0) return 'lost';
    if (c.mode === 'after' && last) return 'after';
    return null;
  };
  const send0 = RTCDataChannel.prototype.send, qs = new WeakMap();
  const send = function (d) {   // optional ordered jitter (harness only): 5-50 ms per message, ~2% an extra 100-300 ms
    const J = S.jitter; if (!J) return send0.call(this, d);
    const wait = J.min + J.r() * (J.max - J.min) + (J.r() < J.pSlow ? 100 + J.r() * 200 : 0);
    const q = (qs.get(this) || Promise.resolve()).then(() => new Promise(r => setTimeout(r, wait))).then(() => { try { send0.call(this, d); } catch {} }); qs.set(this, q);
  };
  RTCDataChannel.prototype.send = function (d) {
    let p = null; try { p = typeof d === 'string' ? JSON.parse(d) : null; } catch {}
    if (p?.v === 1 && S.cfg) label('send', p);
    const h = hit('send', this, p);
    if (h === 'lost') { fire(this, 'send-lost'); return; }
    const r = send.call(this, d); if (h === 'after') fire(this, 'send-after'); return r;
  };
  const add = RTCDataChannel.prototype.addEventListener;
  RTCDataChannel.prototype.addEventListener = function (t, f, o) {
    if (t === 'message' && !this.__h) {
      this.__h = 1;
      add.call(this, 'message', ev => {
        let p = null; try { p = typeof ev.data === 'string' ? JSON.parse(ev.data) : null; } catch {}
        if (p?.v === 1 && S.cfg) label('recv', p);
        const h = hit('recv', this, p);
        if (h === 'lost') { ev.stopImmediatePropagation(); fire(this, 'recv-lost'); }
        else if (h === 'after') fire(this, 'recv-after');
      });
    }
    return add.call(this, t, f, o);
  };
}

async function openRole(role) {
  const context = await browser.newContext(process.env.SW_BLOCK ? { serviceWorkers: 'block' } : {});
  await context.exposeFunction('__ownedNative', async (name, args) => {
    if (name === 'startLanPair') { offer = args.offer; answer = null; active = true; return { address, pin: PIN }; }
    if (name === 'lanPairStatus') return { active, answer };
    if (name === 'stopLanPair') { active = false; return {}; }
    if (name === 'takeShared') return { files: [] };
    if (name === 'scanShortcut') return { button: 'capture' };
    return { supported: false };
  });
  await context.addInitScript(installHook);
  if (role === 'phone') await context.addInitScript(() => { const plugin = new Proxy({}, { get: (_, name) => name === 'addListener' ? async () => ({ remove: async () => {} }) : async (args = {}) => __ownedNative(String(name), args) }); globalThis.Capacitor = { isNativePlatform: () => true, Plugins: { TallyNative: plugin } }; });
  const page = await context.newPage();
  if (process.env.DBG) page.on('console', m => { if (m.text().startsWith('CANCEL')) console.log(role, m.text().slice(0, 600)); });
  page.on('pageerror', e => page.__errs.push(e.message.slice(0, 200))); page.__errs = [];
  await page.goto(origin + '/404.html');
  await page.evaluate(async role => {
    const db = await import('/js/db.js'); await db.init();
    const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 20; const c = canvas.getContext('2d'); c.fillStyle = role === 'computer' ? '#123456' : '#abcdef'; c.fillRect(0, 0, 20, 20);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    await db.writeAtomic({ put: { accounts: [{ id: 'cash', name: role + ' Cash', kind: 'cash', currency: 'MYR', opening: 0, typed: false }], tx: [{ id: 'original', date: '2026-10-05', type: 'expense', amount: role === 'computer' ? 600 : 900, accountId: 'cash', category: 'dining', source: 'quick', receiptId: role + '-photo' }], receipts: [{ id: role + '-photo', blob }], kv: [{ key: 'settings', value: { lang: 'en', theme: 'light', gamify: false, seenVersion: '1.13.10', learnHidden: true, onboarded: true, tourDone: true, photoTipsSeen: true, features: { insights: true, receipts: true, afford: true, split: true } } }, { key: 'bookGeneration', value: role + '-generation' }, { key: 'rules', value: {} }] } });
  }, role);
  await page.goto(origin + '/index.html#/settings');
  await page.locator('[data-act="book-sync-open"]').waitFor({ timeout: 20000 });
  if (!process.env.SW_BLOCK && role === 'computer') { await page.waitForFunction(() => navigator.serviceWorker.getRegistration().then(r => r?.active?.state === 'activated'), null, { timeout: 90000 }); await page.reload(); await page.locator('[data-act="book-sync-open"]').waitFor({ timeout: 20000 }); await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 }); }
  const session = await browser.newBrowserCDPSession(), cdp = await context.newCDPSession(page), ti = await cdp.send('Target.getTargetInfo');
  for (const permission of ['localNetworkAccess', 'localNetwork', 'loopbackNetwork']) await session.send('Browser.grantPermissions', { permissions: [permission], origin, browserContextId: ti.targetInfo.browserContextId }).catch(() => {});
  return { context, page };
}

const act = a => '[data-main-sync="' + a + '"]';
const T = 20000;
async function pair(pages) {
  for (const r of ['phone', 'computer']) { await pages[r].locator('[data-act="book-sync-open"]').click(); await pages[r].locator('[data-sync-action="start"]').click(); }
  await pages.phone.waitForFunction(() => document.querySelector('[data-sync-field="address"]')?.value);
  await pages.computer.locator('[data-sync-field="address"]').fill(address); await pages.computer.locator('[data-sync-field="code"]').fill(PIN);
  await pages.computer.locator('[data-sync-action="connect"]').click();
  for (const r of roles) await pages[r].locator('[data-sync-action="approve"]:enabled').waitFor({ timeout: T });
  await pages.computer.locator('[data-sync-action="approve"]').click(); await pages.phone.locator('[data-sync-action="approve"]').click();
  for (const p of Object.values(pages)) await p.locator('[data-main-sync="grant"]:enabled').waitFor({ timeout: T });
  await pages.computer.locator(act('grant')).click(); await pages.phone.locator(act('grant')).click();
  for (const p of Object.values(pages)) await p.locator(act('inspect')).waitFor({ timeout: T });
}
const sheetText = p => p.evaluate(() => document.querySelector('.sync-sheet')?.innerText.replace(/\s+/g, ' ').trim() ?? null);
const dbState = p => p.evaluate(async () => {
  const db = await import('/js/db.js'), core = await import('/js/book-sync/sync-core.mjs'), kv = await db.getKv('offlineSync'), photos = {};
  for (const r of await db.all('receipts')) photos[r.id] = r.id.startsWith('q_syncp_') ? 'alias' : await core.sha256(new Uint8Array(await r.blob.arrayBuffer()));
  const tx = (await db.all('tx')).map(t => t.id + ':' + t.amount + ':' + (t.receiptId || '')).sort(), accounts = (await db.all('accounts')).map(a => a.id + ':' + a.name).sort();
  return { tx, accounts, photos, pending: kv?.pending ? kv.pending.status : null, baseRevision: kv?.baseRevision ?? null, lastAck: kv?.lastAck?.planId ?? null, gen: await db.getKv('bookGeneration') };
});
const ui = p => p.evaluate(() => ({ phase: document.querySelector('[data-main-sync-phase]')?.dataset.mainSyncPhase ?? null, view: (() => { try { return globalThis.__ownedRuntime.getPairingView().phase; } catch { return null; } })(), ctrl: (() => { try { return globalThis.__ownedRuntime.controller()?.state().phase ?? null; } catch { return null; } })() }));
const waitSheet = (p, text, ms = RECOVERY_WAIT_MS) => p.waitForFunction(t => document.querySelector('.sync-sheet')?.textContent.includes(t), text, { timeout: ms });
async function closeBoth(pages) { for (const p of Object.values(pages)) { for (let i = 0; i < 3; i++) { const b = p.locator('.sync-sheet [data-act="sheet-close"]').last(); if (await b.count()) await b.click().catch(() => {}); } await p.waitForFunction(() => !document.querySelector('.scrim:not(.out)'), null, { timeout: 5000 }).catch(() => {}); } }

// Normal initial/reconcile sync from the intro panel (both devices linked or not). Returns when both show ready.
async function normalSync(pages) {
  for (const r of roles) await pages[r].locator(act('inspect')).click();
  for (const r of roles) { await Promise.race([pages[r].locator('[data-main-sync="choose"][data-choice="computer"]').waitFor({ timeout: T }), pages[r].locator(act('backup')).waitFor({ timeout: T })]); }
  for (const r of roles) { const ch = pages[r].locator('[data-main-sync="choose"][data-choice="computer"]'); if (await ch.count()) await ch.click(); await pages[r].locator(act('backup')).click(); }
  for (const r of roles) await pages[r].locator(act('refresh')).click();
  for (const r of roles) await pages[r].locator(act('approve') + ':enabled').waitFor({ timeout: T });
  for (const r of roles) await pages[r].locator(act('approve')).click();
  await pages.computer.locator(act('refresh')).click();
  await pages.computer.locator(act('coordinate') + ':enabled').waitFor({ timeout: T });
}
async function recoverySync(pages, trail) {
  const phase = r => pages[r].evaluate(() => document.querySelector('[data-main-sync-phase]')?.dataset.mainSyncPhase ?? null);
  for (const r of roles) await pages[r].locator(act('recovery-inspect')).click();
  await Promise.all(roles.map(r => pages[r].waitForFunction(() => !document.querySelector('[data-main-sync][disabled]') && !document.querySelector('[aria-busy="true"]'), null, { timeout: T })));
  trail.push(['after recovery-inspect', await Promise.all(roles.map(r => sheetText(pages[r])))]);
  for (const r of roles) { const b = pages[r].locator(act('recovery-refresh') + ':enabled'); if (await b.count()) { await b.click(); await pages[r].waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: T }); } }
  const ph = await Promise.all(roles.map(phase)); trail.push(['phases after recovery-refresh', ph]);
  if (ph.every(p => p === 'intro')) { trail.push(['stale checkpoint discarded; normal sync']); await normalSync(pages); await pages.computer.locator(act('coordinate')).click(); return; }
  for (const r of roles) await pages[r].locator(act('recovery-approve') + ':enabled').waitFor({ timeout: T });
  for (const r of roles) await pages[r].locator(act('recovery-approve')).click();
  await pages.computer.locator(act('recovery-refresh')).click();
  await pages.computer.locator(act('recovery-coordinate') + ':enabled').waitFor({ timeout: T });
  await pages.computer.locator(act('recovery-coordinate')).click();
}

const stressArg = process.argv[3]?.startsWith('stress:') ? process.argv[3].split(':') : null;   // stress:<writes|hidden|jitter|all>:<runs>
async function stressRun(kind, i) {
  const res = { kind, i, view: [] }; let ctx = [];
  try {
    for (const r of roles) ctx.push(await openRole(r));
    const pages = { computer: ctx[0].page, phone: ctx[1].page };
    await pair(pages); await normalSync(pages);
    const seedJ = Math.floor(rnd() * 1e9), hiddenAt = Math.floor(rnd() * 500);
    for (const r of roles) await pages[r].evaluate(([k, sj, node]) => {
      let a = sj; globalThis.__drop.jitter = (k === 'jitter' || k === 'all') ? { min: 5, max: 50, pSlow: 0.02, r: () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; } } : null;
      if (k === 'writes' || k === 'all') { globalThis.__wr = setInterval(async () => { try { const db = await import('/js/db.js'); await db.writeAtomic({ put: { kv: [{ key: 'stressProbe', value: Date.now() }] } }); } catch {} }, 4); }
    }, [kind, seedJ]);
    await pages.computer.locator(act('coordinate')).click();
    if (kind === 'hidden' || kind === 'all') { await pages.phone.waitForTimeout(hiddenAt); await pages.phone.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); setTimeout(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); }, 300); }); res.hiddenAt = hiddenAt; }
    await Promise.all(roles.map(r => pages[r].waitForFunction(() => { const t = document.querySelector('.sync-sheet')?.textContent || ''; return !t.includes('Syncing the books') && !t.includes('Comparing'); }, null, { timeout: 20000 }).catch(() => null)));
    await pages.phone.waitForTimeout(1500);
    for (const r of roles) { await pages[r].evaluate(() => clearInterval(globalThis.__wr)); res.view.push(await pages[r].evaluate(() => { try { const v = __ownedRuntime.getPairingView(); return v.phase + '/' + v.errorCode; } catch (e) { return 'ERR'; } })); }
    res.ui = await Promise.all(roles.map(r => sheetText(pages[r]).then(t => (t || '').slice(0, 90))));
    res.db = await Promise.all(roles.map(r => dbState(pages[r]).then(s => s.pending + '/' + (s.lastAck ? 'acked' : 'noack'))));
    res.ok = res.ui.every(t => t.includes('up to date')) && res.db.every(d => d === 'null/acked');
  } catch (e) { res.error = e.message.split('\n')[0]; }
  for (const c of ctx) await c.context.close().catch(() => {});
  return res;
}
if (stressArg) {
  const out = []; for (let i = 0; i < Number(stressArg[2] || 10); i++) { const r = await stressRun(stressArg[1], i); out.push(r); console.log(stressArg[1], i, r.ok ? 'OK' : 'DROP', JSON.stringify(r.view), JSON.stringify(r.db), r.hiddenAt ?? '', r.error || ''); }
  await writeFile(qa + '/stress-' + stressArg[1] + '-' + seed + '.json', JSON.stringify(out, null, 2));
  console.log(stressArg[1], 'ok', out.filter(r => r.ok).length, '/', out.length);
  await browser.close(); await web.close(); await new Promise(r => nativeServer.close(r)); process.exit(0);
}
if (process.argv[3] === 'card') {   // Home + return: the Sync card must be back on the unchanged Settings route without navigating away
  const out = [];
  for (const role of roles) {
    const { context, page } = await openRole(role);
    const has = () => page.locator('[data-act="book-sync-open"]').count();
    const before = await has();
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(300); out.push({ role, duringHidden: await has() });
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(800);
    const after = await has(); out.push({ role, before, afterReturn: after, url: page.url().split('#')[1] });
    await context.close();
  }
  console.log(JSON.stringify(out)); const ok = out.filter(o => 'before' in o).every(o => o.before === 1 && o.afterReturn === 1); console.log(ok ? 'CARD OK' : 'CARD MISSING');
  await browser.close(); await web.close(); await new Promise(r => nativeServer.close(r)); process.exit(ok ? 0 : 1);
}
const MSGS = ['status', 'prepare', 'commit', 'ack', 'finish'].map(m => 'controller_' + m);
const points = [];
const BLIP = Number(process.env.BLIP || 0);   // BLIP=ms: instead of closing the channel, the page is hidden for that long (visibility blip) at the boundary
for (const m of MSGS) for (const kind of ['req', 'res']) for (const dir of ['send', 'recv']) for (const mode of ['lost', 'after']) if (!BLIP || mode === 'after') points.push({ label: kind + ':' + m, dir, mode, ...(BLIP ? { action: 'blip', blipMs: BLIP } : {}) });
for (let i = points.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [points[i], points[j]] = [points[j], points[i]]; }   // seeded order
for (const p of points) p.delay = p.mode === "lost" ? Math.floor(rnd() * 40) : 0;                                                                                      // seeded jitter before the close
const name = p => `${p.label} ${p.dir}-${p.mode}`;
const results = [];
for (const point of points.filter(p => !only || only.test(name(p)))) {
  const t0 = Date.now(), res = { point: name(point), delay: point.delay }, trail = []; let ctx = [];
  try {
    for (const r of roles) ctx.push(await openRole(r));
    const pages = { computer: ctx[0].page, phone: ctx[1].page };
    await pair(pages);
    await normalSync(pages);
    for (const p of Object.values(pages)) await p.evaluate(([c, slow]) => { globalThis.__drop.cfg = c; if (slow) globalThis.__drop.jitter = { min: slow, max: slow, pSlow: 0, r: () => 0 }; }, [point, Number(process.env.SLOW || 0)]);
    await pages.computer.locator(act('coordinate')).click();
    await Promise.race(roles.map(r => pages[r].waitForFunction(() => globalThis.__drop.fired, null, { timeout: 8000 }).catch(() => null)));
    const fired = (await Promise.all(roles.map(r => pages[r].evaluate(() => globalThis.__drop.fired)))).find(Boolean) || null;
    res.fired = fired?.why ?? null;
    // wait up to 15 s for the sheet to show either 'both up to date' (the drop hit nothing) or a settled non-syncing state on both
    const t1 = Date.now();
    await Promise.all(roles.map(r => pages[r].waitForFunction(() => { const t = document.querySelector('.sync-sheet')?.textContent || ''; return !t.includes('Syncing the books') && (t.includes('Offline') || t.includes('up to date') || t.includes('unfinished') || t.includes('could not finish') || t.includes('still needs')); }, null, { timeout: 15000 }).catch(() => null)));
    res.settleMs = Date.now() - t1;
    res.direct = (await Promise.all(roles.map(r => sheetText(pages[r])))).every(t => t?.includes('up to date')) && (await Promise.all(roles.map(r => dbState(pages[r])))).every(d => !d.pending && d.lastAck);
    res.reason = await Promise.all(roles.map(r => pages[r].evaluate(() => { try { const v = __ownedRuntime.getPairingView(); return v.phase + "/" + v.errorCode; } catch { return null; } })));
    res.ctrlErrs = await Promise.all(roles.map(r => pages[r].evaluate(() => globalThis.__ctrlErrs || null)));
    res.afterDrop = { ui: await Promise.all(roles.map(r => sheetText(pages[r]))), db: await Promise.all(roles.map(r => dbState(pages[r]).then(s => s.pending + '/' + (s.lastAck ? 'acked' : 'noack')))) };
    if (!res.fired) { res.verdict = 'NOT-FIRED (hook never matched; both sides ' + res.afterDrop.ui.join(' | ') + ')'; throw Object.assign(Error('nofire'), { soft: true }); }
    if (BLIP && res.direct) { res.verdict = 'DIRECT'; res.converged = true; throw Object.assign(new Error('direct'), { soft: true }); }
    // ---- reconnect: fresh pairing; recovery UI when anything is pending, otherwise a normal sync ----
    for (const p of Object.values(pages)) await p.evaluate(() => { globalThis.__drop.cfg = null; });
    await closeBoth(pages);
    for (const r of roles) { await pages[r].locator('a[href="#/settings"]').click(); await pages[r].locator('[data-act="book-sync-open"]').waitFor(); }
    const mid = await Promise.all(roles.map(r => dbState(pages[r])));
    res.pendingBeforeReconnect = mid.map(s => s.pending);
    const t2 = Date.now();
    await pair(pages);
    if (mid.some(s => s.pending)) {
      try { await recoverySync(pages, trail); } catch (e) { res.recoveryStepError = e.message.split('\n')[0]; res.recoveryUi = await Promise.all(roles.map(r => sheetText(pages[r]))); }
    } else { await normalSync(pages); await pages.computer.locator(act('coordinate')).click(); }
    await Promise.all(roles.map(r => waitSheet(pages[r], 'Both books are up to date.').catch(() => null)));
    res.recoveryMs = Date.now() - t2;
    const fin = await Promise.all(roles.map(r => dbState(pages[r])));
    res.final = fin.map(s => ({ tx: s.tx, photos: s.photos, pending: s.pending, ack: !!s.lastAck }));
    res.finalUi = await Promise.all(roles.map(r => sheetText(pages[r])));
    const same = JSON.stringify([fin[0].tx, fin[0].accounts, fin[0].photos]) === JSON.stringify([fin[1].tx, fin[1].accounts, fin[1].photos]);
    const exact = fin.every(s => s.tx.length === 1 && s.tx[0].startsWith('original:600:computer-photo') && Object.keys(s.photos).join() === 'computer-photo' && s.pending === null);
    const photoEq = fin[0].photos['computer-photo'] === fin[1].photos['computer-photo'] && !!fin[0].photos['computer-photo'];
    res.converged = same && exact && photoEq && fin.every(s => s.lastAck);
    // in-memory app view equals the database view (no stale UI after the drop)
    res.appViewMatchesDb = (await Promise.all(roles.map(r => pages[r].evaluate(async () => { const st = await import('/js/state.js'), db = await import('/js/db.js'); return JSON.stringify(st.S.tx.map(t => t.id + ':' + t.amount).sort()) === JSON.stringify((await db.all('tx')).map(t => t.id + ':' + t.amount).sort()); })))).every(Boolean);
    res.verdict = res.converged ? 'CONVERGED' : 'NOT-CONVERGED';
  } catch (e) { if (e.message === 'direct') { /* converged without any reconnect */ } else res.verdict ??= 'ERROR'; res.error = e.message.split('\n')[0].slice(0, 300); }
  res.trail = trail; res.ms = Date.now() - t0;
  for (const c of ctx) await c.context.close().catch(() => {});
  results.push(res);
  console.log(res.verdict.padEnd(14), name(point).padEnd(40), 'fired=' + res.fired, 'pend=' + JSON.stringify(res.pendingBeforeReconnect), res.error ? 'err=' + res.error : '', res.recoveryStepError ? 'recov=' + res.recoveryStepError : '', (res.ms / 1000).toFixed(1) + 's');
}
await mkdir(qa, { recursive: true });
await writeFile(qa + '/drop-matrix-' + seed + '.json', JSON.stringify({ seed, results }, null, 2));
const bad = results.filter(r => !['CONVERGED', 'DIRECT'].includes(r.verdict) || (BLIP && BLIP <= 8000 && !r.direct && /prepare|commit|ack|finish/.test(r.point)));
console.log(JSON.stringify({ seed, points: results.length, converged: results.length - bad.length, bad: bad.map(b => b.point) }));
await browser.close(); await web.close(); await new Promise(r => nativeServer.close(r));
process.exitCode = bad.length ? 1 : 0;
