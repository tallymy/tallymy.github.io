// Goal rows and the transfer sheet at 320/360/390 px, text size 100/115/130%, en/ms/ta: a name wraps by word (never a letter a
// line), nothing overflows sideways, touch targets stay >= 44px, a segment label keeps clear of its edge. Headless Chromium only.
// Run: node tests/e2e/goal-row-scale.e2e.mjs   (serves this tree on 127.0.0.1:8795)
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
const ACCTS = [{ id: 'bank', name: 'Test bank', kind: 'bank', opening: 50000, typed: true, createdAt: 1 }, { id: 'asb', name: 'ASB', kind: 'savings', opening: 100, typed: true, createdAt: 1 }];
const GOALS = [{ id: 'g1', name: 'Phone', target: 5000, accountId: 'asb', createdAt: 1 }, { id: 'g2', name: 'Trip', target: 90000, accountId: 'asb', createdAt: 1 }, { id: 'g3', name: 'Dana kecemasan untuk keluarga besar', target: 1000000, accountId: 'asb', createdAt: 1 }];
try {
  for (const w of [320, 360, 390]) for (const lang of ['en', 'ms', 'ta']) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 800 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(() => {
      window.Capacitor = { isNativePlatform: () => true, Plugins: { App: { addListener: async () => ({ remove() {} }), getInfo: async () => ({ id: 'test', version: '1.13.0', build: '3' }) },
        TallyNative: { addListener: async () => ({ remove() {} }), takeShared: async () => ({ files: [] }), releaseShared: async () => {}, openExternal: async () => { throw Error('External launch prohibited'); } },
        Filesystem: { writeFile: async () => {}, appendFile: async () => {}, deleteFile: async () => {}, getUri: async o => ({ uri: 'content://test/' + o.path }) }, Share: { share: async () => {} } } };
    });
    const page = await ctx.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:8795/index.html'); await page.waitForSelector('.welcome', { timeout: 15000 });
    await page.evaluate(async ({ accounts, goals, lang }) => {
      const st = await import('/js/state.js'), app = await import('/js/app.js');
      await st.replaceAll({ accounts, tx: [], recurring: [], kv: { goals, settings: { tourDone: true, seenVersion: '1.13.12', lang, noSpend: [st.today()] } } });
      await (await import('/js/i18n.js')).setLang(lang); await (await import('/js/features.js')).setModules({ goals: true });
      app.go('home'); app.render();
    }, { accounts: ACCTS, goals: GOALS, lang });
    for (const scale of [100, 115, 130]) {
      const tag = `${w}px ${lang} ${scale}%`;
      await page.evaluate(s => { document.documentElement.style.fontSize = s + '%'; }, scale);
      await page.waitForTimeout(1200);
      const check = async what => {
        const o = await page.evaluate(() => {
          const bad = [...document.querySelectorAll('.sheet *, #view .goals *, #view .list *')].filter(e => e.getClientRects().length && e.getBoundingClientRect().right > innerWidth + 0.5).map(e => e.className || e.tagName).slice(0, 5);
          const names = [...document.querySelectorAll('.goalbtn b')].map(b => { const r = b.getBoundingClientRect(), lh = parseFloat(getComputedStyle(b).lineHeight) || parseFloat(getComputedStyle(b).fontSize) * 1.3; return { t: b.textContent, w: r.width, lines: Math.round(r.height / lh) }; });
          const small = [...document.querySelectorAll('[data-act="goal-add"], .goalact .icon-btn, .goalbtn, .txrow[data-act="goal-edit"]')].filter(e => e.getClientRects().length).map(e => e.getBoundingClientRect()).filter(r => r.height < 43.5 || r.width < 43.5).length;
          const segs = [...document.querySelectorAll('.sheet .seg')].map(s => { const rg = document.createRange(); rg.selectNodeContents(s); const a = rg.getBoundingClientRect(), b = s.getBoundingClientRect(); return { t: s.textContent, cw: s.clientWidth, tw: Math.round(a.width), clipped: s.scrollWidth > s.clientWidth + 1, gap: Math.min(a.left - b.left, b.right - a.right) }; });
          const wide = [...document.querySelectorAll('#view *')].filter(e => e.getClientRects().length && e.getBoundingClientRect().right > innerWidth + 0.5 && !e.closest('.goals, .list, .sheet')).map(e => e.closest('section,div.card')?.className).slice(0, 3); return { sw: document.documentElement.scrollWidth, iw: innerWidth, wide, bad, names, small, segs };
        });
        assert.ok(!o.bad.length, `${tag} ${what}: overflow ${JSON.stringify(o)}`);
        assert.equal(o.small, 0, `${tag} ${what}: touch target under 44px`);
        for (const n of o.names) assert.ok(n.lines <= Math.ceil(n.t.length / 5) && (n.t.length > 5 || n.lines <= 1), `${tag} ${what}: name "${n.t}" wraps badly ${JSON.stringify(n)}`);
        for (const s of o.segs) assert.ok(!s.clipped && s.gap >= 4, `${tag} ${what}: segment label too close to its edge ${JSON.stringify(s)}`);
      };
      await check('home');
      await page.locator('#view [data-act="goal-add"]').first().scrollIntoViewIfNeeded();
      await page.locator('#view [data-act="goal-add"]').first().click(); await page.locator('#tx-amt').waitFor(); await page.waitForTimeout(200);
      await check('transfer sheet');
      await page.waitForFunction(() => document.activeElement?.closest('.sheet')); await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.sheet'));
      await page.evaluate(async () => { const app = await import('/js/app.js'); app.go('settings'); app.render(); });
      await page.waitForTimeout(500);
      await page.locator('#view [data-act="goal-add"]').first().waitFor();
      await check('settings');
      await page.evaluate(async () => { const app = await import('/js/app.js'); app.go('home'); app.render(); });
      await page.waitForTimeout(400);
      log.push(`${tag} ok`);
    }
    await ctx.close();
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log(log.length + ' combinations ok'); console.log('goal-row-scale e2e: OK');
} finally { await browser.close(); server.close(); }
