// Browser checks for the 1.13.10 UI fixes (headless Playwright Chromium; never the owner's Chrome):
//   1 Features card keeps its inner list open across module toggles   2 camera/+ centred for every tab count
//   3 goal sheet (Saved in, create account, RM 0 notice) and the tappable Home goal row   4 320 px, light/dark, en/ms/ta
// Run: node tests/e2e/release-1-13-10.e2e.mjs   (serves this tree on 127.0.0.1:8780)
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
await new Promise(r => server.listen(8780, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true });
const errors = [], log = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 320, height: 800 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await ctx.addInitScript(() => {   // the app shell (not the landing page) shows inside the Capacitor app: same stub as share-ui.e2e
    window.Capacitor = { isNativePlatform: () => true, Plugins: { App: { addListener: async () => ({ remove() {} }), getInfo: async () => ({ id: 'test', version: '1.13.0', build: '3' }) },
      TallyNative: { addListener: async () => ({ remove() {} }), takeShared: async () => ({ files: [] }), releaseShared: async () => {}, openExternal: async () => { throw Error('External launch prohibited'); } },
      Filesystem: { writeFile: async () => {}, appendFile: async () => {}, deleteFile: async () => {}, getUri: async o => ({ uri: 'content://test/' + o.path }) }, Share: { share: async () => {} } } };
  });
  const page = await ctx.newPage(); page.on('pageerror', e => errors.push(e.message)); if (process.env.DBG) { page.on('console', m => console.log('C', m.text())); page.on('requestfailed', r => console.log('F', r.url())); page.on('response', r => r.status() >= 400 && console.log('S', r.status(), r.url())); }
  await page.goto('http://127.0.0.1:8780/index.html');
  await page.waitForSelector('.welcome', { timeout: 15000 }).catch(async e => { console.log(await page.evaluate(() => document.body.innerHTML.slice(0, 600))); throw e; });
  const seed = (accounts, kv = {}) => page.evaluate(async ({ accounts, kv }) => {
    const st = await import('/js/state.js'), app = await import('/js/app.js');
    await st.replaceAll({ accounts, tx: [], recurring: [], kv: { ...kv, settings: { tourDone: true, seenVersion: '1.13.0', lang: 'en', noSpend: [st.today()] } } });
    app.go('home'); app.render();
  }, { accounts, kv });
  const env = (theme, lang) => page.evaluate(async ({ theme, lang }) => { await (await import('/js/i18n.js')).setLang(lang); document.documentElement.dataset.theme = theme; (await import('/js/app.js')).render(); }, { theme, lang });
  const noOverflow = async what => {
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, bad: [...document.querySelectorAll('.sheet *, #view .card *, .tabs *')].filter(e => e.getClientRects().length && e.getBoundingClientRect().right > innerWidth + 0.5).map(e => e.className || e.tagName).slice(0, 5) }));
    assert.ok(o.sw <= o.iw && !o.bad.length, `${what}: overflow ${JSON.stringify(o)}`);
  };
  const esc = async () => { await page.waitForFunction(() => document.activeElement?.closest('.sheet')); await page.keyboard.press('Escape'); await gone(); };
  const gone = () => page.waitForFunction(() => !document.querySelector('.sheet'));
  const bank = { id: 'bank', name: 'Test bank', kind: 'bank', opening: 10000, typed: true, createdAt: 1 };

  // ---- 2: the camera/+ centred, every module combination x widths
  await seed([bank]);
  for (const w of [320, 360, 390, 412]) {
    await page.setViewportSize({ width: w, height: 800 });
    for (const insights of [true, false]) for (const budgets of [true, false]) for (const bills of [true, false]) for (const receipts of [true, false]) {
      await page.evaluate(async m => { await (await import('/js/features.js')).setModules(m); (await import('/js/app.js')).render(); }, { insights, budgets, bills, receipts });
      const r = await page.evaluate(() => {
        const f = document.querySelector('.tabs .fab').getBoundingClientRect();
        return { fab: (f.left + f.right) / 2, mid: innerWidth / 2, pad: [...document.querySelectorAll('.tab.pad')].map(p => [p.getAttribute('aria-hidden'), p.tabIndex, p.textContent, p.matches('a,button')]) };
      });
      assert.ok(Math.abs(r.fab - r.mid) <= 1, `fab off centre at ${w}px ${JSON.stringify({ insights, budgets, bills, receipts })}: ${r.fab} vs ${r.mid}`);
      for (const p of r.pad) assert.deepEqual(p, ['true', -1, '', false]);
    }
    log.push(`centred at ${w}px: 16 module combinations`);
  }
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.evaluate(async () => { await (await import('/js/features.js')).setModules({ insights: false, budgets: false, bills: true }); (await import('/js/app.js')).render(); });
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.tab.pad')].filter(p => p.getClientRects().length).length), 0, 'no spacer in the desktop column');
  await page.evaluate(async () => { await (await import('/js/features.js')).setModules({ insights: true, budgets: true, bills: true, receipts: true }); });

  for (const [theme, lang] of [['light', 'en'], ['dark', 'ms'], ['dark', 'ta']]) {
    await page.setViewportSize({ width: 320, height: 800 });
    await seed([bank, { id: 'asb', name: 'ASB', kind: 'savings', opening: 0, typed: true, createdAt: 1 }, { id: 'big', name: 'Tabung Haji simpanan jangka panjang', kind: 'savings', opening: 250000, typed: true, createdAt: 1 }],
      { goals: [{ id: 'g1', name: 'Dana kecemasan untuk keluarga besar', target: 1000000, accountId: 'big', createdAt: 1 }, { id: 'g2', name: 'Phone', target: 5000, accountId: 'big', createdAt: 1 }, { id: 'g3', name: 'Trip', target: 90000, createdAt: 1 }] });
    await env(theme, lang);
    await page.evaluate(async () => { await (await import('/js/features.js')).setModules({ goals: true }); (await import('/js/app.js')).render(); });

    // ---- 3d: Home row opens the goal by keyboard; share stays its own button
    await noOverflow(`home ${theme}/${lang}`);
    assert.equal(await page.locator('.goalrow').count(), 3);
    await page.locator('.goalbtn').first().focus(); await page.keyboard.press('Enter');
    await page.locator('.sheet #g-name').waitFor();
    assert.match(await page.inputValue('#g-name'), /Dana kecemasan/);
    assert.equal(await page.inputValue('#g-acc'), 'big');
    await noOverflow(`goal sheet edit ${theme}/${lang}`);
    await esc();
    await page.locator('[data-act="goal-share"]').first().click(); await page.locator('.sheet').waitFor();
    await esc();

    // ---- 3a-c: a new goal: no silent account, notice, create an account from the sheet
    const open = () => page.evaluate(async () => (await import('/js/views/goals.js')).act['goal-edit']({ dataset: {} }));
    await open(); await page.locator('#g-acc').waitFor();
    assert.equal(await page.inputValue('#g-acc'), '', 'no account is preselected with several to choose from');
    const order = await page.evaluate(() => [...document.querySelectorAll('.sheet h2, .sheet input, .sheet select')].map(e => e.id || 'h2'));
    assert.deepEqual(order.slice(0, 3), ['h2', 'g-name', 'g-acc'], 'Saved in comes right after Name');
    await noOverflow(`goal sheet new ${theme}/${lang}`);
    await page.fill('#g-name', 'Holiday'); await page.fill('#g-amt', '500'); await page.fill('#g-by', '2027-06-01');
    await page.click('[data-x="save"]');
    await page.locator('[data-x="yes"]').waitFor(); await noOverflow(`notice ${theme}/${lang}`);
    await page.click('[data-x="no"]');
    await page.waitForFunction(() => document.querySelectorAll('.scrim:not(.out)').length === 1);
    assert.equal(await page.inputValue('#g-name'), 'Holiday');
    await page.click('[data-x="newacc"]'); await page.locator('#ac-name').waitFor();
    assert.equal(await page.inputValue('#ac-kind'), 'savings');
    await noOverflow(`account over goal ${theme}/${lang}`);
    await page.fill('#ac-name', 'Tabung baru'); await page.click('[data-act="acc-save"]');
    await page.waitForFunction(() => !document.querySelector('#ac-name') && document.querySelector('#g-acc'));
    assert.equal(await page.evaluate(() => document.querySelector('#g-acc').selectedOptions[0].textContent), 'Tabung baru', 'the new account is picked');
    assert.deepEqual(await page.evaluate(() => [document.querySelector('#g-name').value, document.querySelector('#g-amt').value, document.querySelector('#g-by').value]), ['Holiday', '500', '2027-06-01'], 'typed values kept');
    await page.click('[data-x="save"]');
    await page.locator('[data-x="yes"]').waitFor(); await page.click('[data-x="yes"]');
    await gone();
    assert.deepEqual(await page.evaluate(async () => { const st = await import('/js/state.js'), g = st.S.kv.goals.find(x => x.name === 'Holiday'); return [g?.accountId === st.S.accounts.find(a => a.name === 'Tabung baru')?.id, st.S.kv.goals.length]; }), [true, 4]);
    // an account with money: saved with no notice
    await open();
    await page.fill('#g-name', 'Rich'); await page.fill('#g-amt', '100'); await page.selectOption('#g-acc', 'big'); await page.click('[data-x="save"]');
    await gone();
    assert.equal(await page.evaluate(async () => (await import('/js/state.js')).S.kv.goals.length), 5, 'saved without a notice');
    // cancelling the account sheet returns to the goal sheet untouched
    await open();
    await page.fill('#g-name', 'Keep me'); await page.click('[data-x="newacc"]'); await page.locator('#ac-name').waitFor();
    await page.click('.sheet:has(#ac-name) [data-act="sheet-close"]'); await page.waitForFunction(() => !document.querySelector('#ac-name'));
    assert.equal(await page.inputValue('#g-name'), 'Keep me');
    await esc();

    // ---- 1: Features card keeps the inner list open through toggles
    await page.evaluate(() => (location.hash = '#/settings')); await page.waitForSelector('#s-features');
    for (const id of ['#s-features', '#s-features-one']) if (!(await page.evaluate(id => document.querySelector(id).open, id))) await page.click(`${id} > summary`);   // they stay as left (the point of the fix)
    const both = () => page.evaluate(() => document.querySelector('#s-features').open && document.querySelector('#s-features-one').open);
    assert.ok(await both());
    for (const k of ['afford', 'subcats']) {
      await page.locator(`[data-input="module"][data-k="${k}"]`).click({ force: true });
      await page.waitForFunction(k => document.activeElement?.dataset?.k === k && document.activeElement.checked === (k === 'afford' ? false : document.activeElement.checked), k, { timeout: 5000 });   // render() then focus: the toggle keeps it
      assert.ok(await both(), `still open after toggling ${k}`);
    }
    await noOverflow(`features ${theme}/${lang}`);
    await page.click('#s-features-one > summary'); await page.evaluate(() => (document.querySelector('#s-features').open = false));
    assert.equal(await page.evaluate(() => document.querySelector('#s-features-one').open), false, 'it can still be closed');
    await page.evaluate(() => (location.hash = '#/home'));
    log.push(`${theme}/${lang}: goals, features, overflow ok`);
  }
  assert.deepEqual(errors, []);
  console.log(log.join('\n'));
} finally { await browser.close(); server.close(); }
