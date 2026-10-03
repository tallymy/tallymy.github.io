// Two real browser contexts and WebRTC channels; Android signaling is simulated, not claimed as a device test.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../', import.meta.url));
let offer, answer, active = false;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (['/offer', '/answer'].includes(path)) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*'); res.setHeader('Access-Control-Allow-Headers', 'X-Tally-Code, Content-Type'); res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (!active || req.headers['x-tally-code'] !== '123456') { res.writeHead(401); return res.end('{}'); }
      if (path === '/answer') { let body = ''; for await (const chunk of req) body += chunk; answer = JSON.parse(body).sdp; }
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(path === '/offer' ? { sdp: offer } : {}));
    }
    const target = resolve(root, '.' + (path === '/' ? '/index.html' : path)); if (!target.startsWith(resolve(root) + sep)) throw Error();
    res.setHeader('Content-Type', mime[extname(target)] || 'application/octet-stream'); res.setHeader('Cache-Control', 'no-store'); res.end(await readFile(target));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const pcContext = await browser.newContext(), phoneContext = await browser.newContext();
const errors = [];
try {
  await phoneContext.exposeFunction('mockPairStart', ({ offer: value }) => { offer = value; answer = null; active = true; return { address: base.replace('http://', ''), pin: '123456', active: true }; });
  await phoneContext.exposeFunction('mockPairStatus', () => ({ active, answer }));
  await phoneContext.exposeFunction('mockPairStop', () => { active = false; });
  await phoneContext.addInitScript(() => {
    // Each context represents a separate device; switching test tabs must not background the simulated phone.
    Object.defineProperty(document, 'hidden', { get: () => false });
    window.Capacitor = { isNativePlatform: () => true, Plugins: { App: { addListener: async () => ({ remove() {} }), getInfo: async () => ({ id: 'test', version: '1.13.0', build: '3' }) }, TallyNative: { addListener: async () => ({ remove() {} }), takeShared: async () => ({ files: [] }), releaseShared: async () => {}, startLanPair: o => window.mockPairStart(o), lanPairStatus: () => window.mockPairStatus(), stopLanPair: () => window.mockPairStop() } } };
  });
  const phone = await phoneContext.newPage(), pc = await pcContext.newPage();
  for (const page of [phone, pc]) page.on('pageerror', e => errors.push(e.message));
  await phone.goto(base + '/index.html?app'); await phone.locator('.welcome').waitFor();
  await phone.evaluate(async () => {
    const st = await import('/js/state.js'), app = await import('/js/app.js');
    await st.replaceAll({ accounts: [{ id: 'bank', name: 'Private bank', kind: 'bank', opening: 10000, typed: false }], tx: [{ id: 'tea', type: 'expense', amount: 300, date: st.today(), accountId: 'bank', category: 'dining', merchant: 'Secret tea', note: '' }], recurring: [], kv: { settings: { tourDone: true, seenVersion: '1.13.0', lang: 'en' } } });
    const ui = await import('/js/ui.js'); while (ui.sheetOpen()) ui.closeSheet(); app.go('home'); app.render();
  });
  await pc.goto(base + '/connect.html');
  const pair = async () => {
    await phone.evaluate(async () => { const ui = await import('/js/ui.js'); while (ui.sheetOpen()) ui.closeSheet(); (await import('/js/desk-host.js')).openDesk(); });
    await phone.locator('#desk-start').click(); await phone.waitForFunction(() => document.body.textContent.includes('123456'));
    await pc.locator('#address').fill(base.replace('http://', '')); await pc.locator('#pin').fill('123456'); await pc.locator('#connect').click();
    await pc.locator('#approve').waitFor({ timeout: 30000 }); await phone.locator('[data-desk="approve"]').waitFor({ timeout: 30000 });
    const code = await pc.locator('.code').textContent(), phoneCode = await phone.locator('.desk-code').textContent(); assert.equal(code, phoneCode);
    assert.equal(await pc.locator('body').textContent().then(t => t.includes('Private bank')), false);
    await phone.locator('[data-desk="approve"]').click(); assert.equal(await pc.locator('body').textContent().then(t => t.includes('Secret tea')), false);
    await pc.locator('#approve').click(); await pc.locator('#entry').waitFor();
  };
  await pair(); console.log('PASS real WebRTC: no book before both approvals');
  await pc.locator('#amount').fill('15.00'); await pc.locator('#merchant').fill('Computer lunch'); await pc.locator('#save').click();
  await pc.getByText('Saved on your phone.', { exact: true }).waitFor({ timeout: 8000 }).catch(async error => {
    console.log('PC test screen:', await pc.locator('body').textContent());
    console.log('Phone test state:', await phone.evaluate(async () => { const st=await import('/js/state.js'), db=await import('/js/db.js'); return { accounts:st.S.accounts,settings:st.settings(),storedSettings:await db.get('kv','settings'),storedAccounts:await db.all('accounts'),tx:st.S.tx }; }));
    throw error;
  });
  assert.equal(await phone.evaluate(async () => (await import('/js/state.js')).S.tx.find(x => x.merchant === 'Computer lunch')?.amount), 1500);
  console.log('PASS PC save is committed to the phone book');
  await phone.evaluate(async () => { const st = await import('/js/state.js'); await st.saveTx({ ...st.S.tx.find(x => x.id === 'tea'), amount: 400, merchant: 'Phone tea' }); });
  await pc.locator('#entries').getByText('Phone tea', { exact: true }).waitFor(); console.log('PASS phone edits appear on the PC');
  await pc.locator('[data-edit="tea"]').click(); await pc.locator('#amount').fill('5.00');
  await phone.evaluate(async () => { const st = await import('/js/state.js'); await st.saveTx({ ...st.S.tx.find(x => x.id === 'tea'), amount: 600 }); });
  await pc.locator('#stale').waitFor({ state: 'visible' }); assert.equal(await pc.locator('#amount').inputValue(), '5.00'); await pc.locator('#save').click();
  await pc.getByText('The entry changed on your phone. Refresh and try again.', { exact: true }).waitFor();
  assert.equal(await phone.evaluate(async () => (await import('/js/state.js')).S.tx.find(x => x.id === 'tea').amount), 600);
  console.log('PASS simultaneous edits do not overwrite; typed form survives updates');
  await pc.locator('#refresh').click(); assert.equal(await pc.locator('#amount').inputValue(), '6.00');
  await pc.waitForTimeout(1500); await pc.locator('[data-edit="tea"]').click(); await pc.waitForTimeout(1500);
  await phone.locator('.desk-status').click(); await phone.locator('.scrim:not(.out) [data-desk="stop"]').click(); await pc.locator('#join').waitFor();
  assert.equal((await pc.locator('body').textContent()).includes('Private bank'), false); assert.equal((await pc.locator('body').textContent()).includes('Phone tea'), false);
  const storage = await pc.evaluate(async () => ({ keys: Object.keys(localStorage), session: Object.keys(sessionStorage), databases: (await indexedDB.databases()).map(x => x.name) }));
  assert.deepEqual(storage, { keys: [], session: [], databases: [] }); console.log('PASS disconnect clears the expense screen; no PC database or storage');
  await pair(); assert.equal(await pc.locator('#amount').inputValue(), '6.00'); console.log('PASS phone remembers the PC entry after fresh pairing');
  // Drop the acknowledgement after commit: the PC must warn to check the phone, never blindly retry.
  await phone.evaluate(() => { const send = RTCDataChannel.prototype.send; RTCDataChannel.prototype.send = function(data) { if (String(data).includes('result')) return; return send.call(this, data); }; });
  await pc.locator('#new').click(); await pc.locator('#amount').fill('2.00'); await pc.locator('#merchant').fill('Uncertain save'); await pc.locator('#save').click();
  await phone.waitForFunction(async () => (await import('/js/state.js')).S.tx.some(x => x.merchant === 'Uncertain save'));
  await phone.locator('.desk-status').click(); await phone.locator('.scrim:not(.out) [data-desk="stop"]').click();
  await pc.getByText('Connection lost while saving. Check your phone to see whether the change saved before trying again.', { exact: true }).waitFor();
  assert.equal(await phone.evaluate(async () => (await import('/js/state.js')).S.tx.filter(x => x.merchant === 'Uncertain save').length), 1);
  console.log('PASS interrupted acknowledgement: clear screen, accurate warning, no duplicate retry');
  await mkdir('D:/tally-android/verification/desk', { recursive: true }); await pc.screenshot({ path: 'D:/tally-android/verification/desk/disconnected.png', fullPage: true });
  assert.deepEqual(errors, []); console.log('PASS no uncaught browser errors');
} finally { await browser.close(); await new Promise(r => server.close(r)); }
