// Browser check for 1.13.12: "Add money" on a savings goal (Home card and Settings > Accounts) opens the ordinary transfer
// sheet into the goal's account. 320 and 390 px, English / Malay / Tamil, light and dark. Headless Playwright Chromium only.
// Run: node tests/e2e/release-1-13-12.e2e.mjs   (serves this tree on 127.0.0.1:8795)
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
const errors = [], log = [];
const stub = () => {   // the app shell shows inside the Capacitor app: same stub as the other e2e files
  window.Capacitor = { isNativePlatform: () => true, Plugins: { App: { addListener: async () => ({ remove() {} }), getInfo: async () => ({ id: 'test', version: '1.13.0', build: '3' }) },
    TallyNative: { addListener: async () => ({ remove() {} }), takeShared: async () => ({ files: [] }), releaseShared: async () => {}, openExternal: async () => { throw Error('External launch prohibited'); } },
    Filesystem: { writeFile: async () => {}, appendFile: async () => {}, deleteFile: async () => {}, getUri: async o => ({ uri: 'content://test/' + o.path }) }, Share: { share: async () => {} } } };
};
const ACCTS = [
  { id: 'bank', name: 'Test bank', kind: 'bank', opening: 50000, typed: true, createdAt: 1 },
  { id: 'card', name: 'Visa', kind: 'card', opening: 0, typed: true, createdAt: 1 },
  { id: 'asb', name: 'Tabung Haji simpanan jangka panjang', kind: 'savings', opening: 10000, typed: true, createdAt: 1 },
  { id: 'new', name: 'Wang baru', kind: 'savings', opening: 0, typed: false, createdAt: 1 },
];
const GOALS = [
  { id: 'g1', name: 'Dana kecemasan untuk keluarga besar', target: 100000, accountId: 'asb', createdAt: 1 },
  { id: 'g2', name: 'Trip', target: 90000, createdAt: 1 },
  { id: 'g3', name: 'Laptop', target: 5000, accountId: 'new', createdAt: 1 },
];
try {
  for (const w of [320, 390]) for (const [theme, lang] of [['light', 'en'], ['dark', 'ms'], ['dark', 'ta'], ['light', 'ta']]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 800 }, reducedMotion: 'reduce', serviceWorkers: 'block', colorScheme: theme });
    await ctx.addInitScript(stub);
    const page = await ctx.newPage(); page.on('pageerror', e => errors.push(e.message));
    const tag = `${w}px ${theme}/${lang}`;
    await page.goto('http://127.0.0.1:8795/index.html');
    await page.waitForSelector('.welcome', { timeout: 15000 });
    await page.evaluate(async ({ accounts, goals, theme, lang }) => {
      const st = await import('/js/state.js'), app = await import('/js/app.js');
      await st.replaceAll({ accounts, tx: [], recurring: [], kv: { goals, settings: { tourDone: true, seenVersion: '1.13.12', lang, noSpend: [st.today()] } } });
      await (await import('/js/i18n.js')).setLang(lang); document.documentElement.dataset.theme = theme;
      await (await import('/js/features.js')).setModules({ goals: true });
      app.go('home'); app.render();
    }, { accounts: ACCTS, goals: GOALS, theme, lang });
    await page.waitForTimeout(1200);   // Home redraws once more when its sticker book has loaded
    const gone = () => page.waitForFunction(() => !document.querySelector('.sheet'));
    const noOverflow = async what => {
      const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, bad: [...document.querySelectorAll('.sheet *, #view .card *, #view .list *')].filter(e => e.getClientRects().length && e.getBoundingClientRect().right > innerWidth + 0.5).map(e => e.className || e.tagName).slice(0, 5) }));
      assert.ok(o.sw <= o.iw && !o.bad.length, `${tag} ${what}: overflow ${JSON.stringify(o)}`);
    };
    const S = () => page.evaluate(async () => { const st = await import('/js/state.js'), en = await import('/js/engine.js'); return { tx: st.S.tx, goals: st.S.kv.goals, by: en.balances(st.S.accounts, st.S.tx).by, today: st.today() }; });
    const tFor = (k, ...a) => page.evaluate(async ({ k, a }) => (await import('/js/i18n.js')).t(k, ...a), { k, a });
    const esc = async () => { await page.waitForFunction(() => document.activeElement?.closest('.sheet')); await page.keyboard.press('Escape'); await gone(); };
    const sheetOpen = sel => page.locator(sel).waitFor();

    // ---- Home card: a button on every row, 44px, no overflow; the row still opens the goal
    const addLabel = await tFor('Add money');
    await noOverflow('home');
    const btns = page.locator('#view .goals [data-act="goal-add"]');
    assert.equal(await btns.count(), 3);
    for (let i = 0; i < 3; i++) { await btns.nth(i).scrollIntoViewIfNeeded(); const bb = await btns.nth(i).boundingBox(); assert.ok(bb, `${tag} button ${i} not visible`); assert.ok(bb.height >= 43.5 && bb.width >= 43.5, `${tag} touch target ${JSON.stringify(bb)}`); assert.match(await btns.nth(i).textContent(), new RegExp(addLabel)); }
    await page.locator('#view .goalbtn').first().click(); await sheetOpen('#g-name'); await esc();

    // ---- keyboard: focus the first button, Enter -> the transfer sheet, To = the goal's account, From = the bank, note, amount empty and focused
    await btns.first().focus(); await page.keyboard.press('Enter');
    await sheetOpen('#tx-amt');
    await page.waitForFunction(() => document.activeElement?.id === 'tx-amt', null, { timeout: 3000 }).catch(() => {});   // the sheet focuses its field a moment after opening
    const f = await page.evaluate(() => ({ to: document.querySelector('#tx-to').value, from: document.querySelector('#tx-acc').value, note: document.querySelector('#tx-merchant').value, amt: document.querySelector('#tx-amt').value, date: document.querySelector('#tx-date').value, active: document.activeElement.id, type: document.querySelector('.seg.on').dataset.type }));
    assert.equal(f.type, 'transfer'); assert.equal(f.to, 'asb'); assert.equal(f.from, 'bank'); assert.equal(f.amt, ''); assert.equal(f.active, 'tx-amt', 'amount focused');
    assert.equal(f.note, (await tFor('Goal: {0}', GOALS[0].name)).slice(0, 80)); assert.equal(f.date, (await S()).today);
    assert.equal(await page.locator('#toast:not(:empty)').count(), 0, 'typed account: no extra line');
    await noOverflow('transfer sheet');
    // empty amount: the existing validation, then typing clears it (id-scoped listener)
    await page.click('[data-act="tx-save"]');
    await page.waitForFunction(() => document.querySelector('#tx-err').textContent);
    await page.fill('#tx-amt', '25.50'); assert.equal(await page.locator('#tx-err').textContent(), '');
    const before = await S();
    await page.click('[data-act="tx-save"]'); await gone();
    const after = await S();
    assert.equal(after.tx.length, 1); const x = after.tx[0];
    assert.deepEqual([x.type, x.accountId, x.toAccountId, x.amount, x.date], ['transfer', 'bank', 'asb', 2550, before.today]);
    assert.equal(x.merchant, f.note);
    assert.equal(after.by.asb - before.by.asb, 2550); assert.equal(before.by.bank - after.by.bank, 2550);
    assert.equal(after.tx.filter(y => y.type === 'expense').length, 0, 'not spending');
    log.push(`${tag}: home flow ok`);

    // ---- unlinked goal: asks where the money is kept; error id'd and cleared on edit; persists accountId; then the transfer sheet
    await page.locator('#view .goals [data-act="goal-add"][data-id="g2"]').click(); await sheetOpen('#gw-acc');
    assert.equal(await page.locator('.sheet .sh-title').textContent(), await tFor('Where is this money kept?'));
    assert.equal(await page.locator('.sheet [data-x="newacc"]').count(), 1);
    assert.equal(await page.locator('#gw-acc option', { hasText: 'Visa' }).count(), 0, 'cards are not offered');
    await noOverflow('where sheet');
    await page.click('[data-x="go"]');
    await page.waitForFunction(() => document.querySelector('#gw-err').textContent);
    await page.selectOption('#gw-acc', 'asb'); assert.equal(await page.locator('#gw-err').textContent(), '', 'stale error cleared');
    await page.click('[data-x="go"]');
    await sheetOpen('#tx-amt');
    assert.equal(await page.inputValue('#tx-to'), 'asb');
    assert.equal((await S()).goals.find(g => g.id === 'g2').accountId, 'asb', 'accountId persisted on the goal');
    await esc();

    // ---- typed:false account: one line says progress counts only later entries
    await page.locator('#view .goals [data-act="goal-add"][data-id="g3"]').click(); await sheetOpen('#tx-amt');
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent);
    assert.equal((await page.locator('#toast').textContent()).trim(), await tFor("This goal counts only money added after you set this account's balance."));
    await esc();

    // ---- over the target is allowed: the bar caps and the goal is reached
    await page.evaluate(async () => { const st = await import('/js/state.js'); await st.saveTx({ id: 'big', type: 'transfer', accountId: 'bank', toAccountId: 'asb', amount: 45000, date: st.today(), category: 'other', source: 'quick', createdAt: 9 }); (await import('/js/app.js')).render(); });
    await page.locator('#view .goals [data-act="goal-add"][data-id="g1"]').click(); await sheetOpen('#tx-amt');
    await page.fill('#tx-amt', '900'); await page.click('[data-act="tx-save"]'); await gone();
    assert.equal(await page.locator('#view .goals .meter i').first().evaluate(e => e.style.width), '100%');
    assert.equal(await page.locator('#view .goals [data-act="goal-share"]').count() >= 1, true, 'reached goal can be shared');
    await noOverflow('home after');

    // ---- Settings > Accounts list
    await page.evaluate(async () => { const app = await import('/js/app.js'); app.go('settings'); app.render(); });
    await page.locator('#view [data-act="goal-add"]').first().waitFor();
    const sbtn = page.locator('#view [data-act="goal-add"]');
    assert.equal(await sbtn.count(), 3);
    for (let i = 0; i < 3; i++) { await sbtn.nth(i).scrollIntoViewIfNeeded(); const bb = await sbtn.nth(i).boundingBox(); assert.ok(bb.height >= 43.5, `${tag} settings target ${JSON.stringify(bb)}`); }
    await noOverflow('settings');
    await sbtn.first().focus(); await page.keyboard.press('Enter'); await sheetOpen('#tx-amt');
    assert.equal(await page.inputValue('#tx-to'), 'asb');
    await esc();
    await page.locator('#view [data-act="goal-edit"][data-id="g1"]').click(); await sheetOpen('#g-name'); await esc();
    log.push(`${tag}: unlinked, typed:false, over target, Settings ok`);
    await ctx.close();
  }

  // ---- create a savings account from the "where is this money kept" sheet: it comes back selected and the goal is linked
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(stub);
    const page = await ctx.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:8795/index.html'); await page.waitForSelector('.welcome', { timeout: 15000 });
    await page.evaluate(async () => {
      const st = await import('/js/state.js'), app = await import('/js/app.js');
      await st.replaceAll({ accounts: [{ id: 'bank', name: 'Bank', kind: 'bank', opening: 50000, typed: true, createdAt: 1 }, { id: 'cash', name: 'Cash', kind: 'cash', opening: 1000, typed: true, createdAt: 1 }], tx: [], recurring: [], kv: { goals: [{ id: 'g2', name: 'Trip', target: 90000, createdAt: 1 }], settings: { tourDone: true, seenVersion: '1.13.12', lang: 'en', noSpend: [st.today()] } } });
      await (await import('/js/features.js')).setModules({ goals: true }); app.go('home'); app.render();
    });
    const gone = () => page.waitForFunction(() => !document.querySelector('.sheet'));
    await page.locator('[data-act="goal-add"]').click(); await page.locator('#gw-acc').waitFor();
    await page.click('[data-x="newacc"]'); await page.locator('#ac-name').waitFor();
    await page.fill('#ac-name', 'Tabung baru'); await page.click('[data-act="acc-save"]');
    await page.waitForFunction(() => !document.querySelector('#ac-name') && document.querySelector('#gw-acc'));
    const picked = await page.evaluate(() => document.querySelector('#gw-acc').selectedOptions[0].textContent);
    assert.equal(picked, 'Tabung baru');
    await page.click('[data-x="go"]'); await page.locator('#tx-amt').waitFor();
    const to = await page.inputValue('#tx-to'), id = await page.evaluate(async () => (await import('/js/state.js')).S.kv.goals[0].accountId);
    assert.equal(to, id); assert.ok(id && id !== 'bank' && id !== 'cash');
    assert.equal(await page.inputValue('#tx-acc'), 'cash', 'From = what defaultAccount() gives (cash when nothing is typed yet)');
    await page.fill('#tx-amt', '10'); await page.click('[data-act="tx-save"]'); await gone();
    assert.equal(await page.evaluate(async () => { const s = (await import('/js/state.js')).S; return s.tx[0].toAccountId === s.kv.goals[0].accountId && s.tx[0].type === 'transfer'; }), true);
    log.push('create-account path ok');
    await ctx.close();
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log(log.join('\n')); console.log('release-1-13-12 e2e: OK');
} finally { await browser.close(); server.close(); }
