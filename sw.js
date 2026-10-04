// Offline cache (adapted from we go gim). Bump VERSION whenever app files change.
const VERSION = 'tally-v76';
const CORE = [
  './', './index.html', './privacy.html', './privacy.ms.html', './privacy.zh.html', './privacy.zh-Hant.html', './privacy.ja.html', './terms.html', './terms.ms.html', './terms.zh.html', './terms.zh-Hant.html', './terms.ja.html', './licences.html', './build.txt', './manifest.webmanifest', './css/app.css', './icons/icon.svg',
  './js/app.js', './js/state.js', './js/db.js', './js/engine.js', './js/cpi.js', './js/ui.js', './js/io.js', './js/i18n.js', './js/parse.js', './js/brands.js', './js/shops.js', './js/comic.js', './js/first.js', './js/native.js', './js/books/cast.js', './js/books/10.js', './js/books/11.js', './js/books/12.js',
  './js/receipt-image.js', './js/receipt-read.js', './js/desk-protocol.js', './js/desk-pair.js', './js/desk-wire.js', './js/desk-host.js', './js/desk-client.js', './css/desk.css', './connect.html', './img/website-preview.png', './js/align.js', './js/scan.js', './js/ocr-worker.js', './js/calendar.js', './js/mmimport.js', './js/money2time.js', './js/expenseiq.js', './js/expenseiq-compat.js', './js/statement.js', './js/presets.js', './js/feedback.js', './js/tour.js', './js/lock.js', './js/camera.js', './js/camcheck.js', './js/colorpicker.js', './js/learn.js', './js/gamify.js', './js/delight.js', './js/stickers.js', './js/features.js', './js/caticons.js', './js/sample.js', './js/share.js', './js/share-art.js', './js/sticker-export.js',
  './js/views/home.js', './js/views/money.js', './js/views/review.js', './js/views/setup.js', './js/views/learn.js', './js/views/analytics.js', './js/views/splitbill.js', './js/views/goals.js', './js/i18n/ms.js', './js/i18n/zh.js', './js/i18n/zh-Hant.js', './js/i18n/ja.js', './js/i18n/ta.js',
];
// The OCR engine, models and sql.js (~45 MB) rarely change: their own cache survives app updates.
// Bump ASSETS if one of them changes.
const ASSETS = 'tally-assets-v1';
const BRAND = ['./fonts/instrument-sans-latin.woff2', './fonts/instrument-serif-italic-latin.woff2', './fonts/jetbrains-mono-500-latin.woff2'];
const HOLD = 'tally-hold';   // there when the user chose "Ask before updating": a new version waits for their OK
const isAsset = url => /\/(vendor|models|fonts)\//.test(url.pathname);
const corePaths = new Set(CORE.map(path => new URL(path, self.registration.scope).pathname));
const cacheable = (url, res) => res.ok && !(
  /\.(?:js|css|json|webmanifest|svg)$/.test(url.pathname) &&
  /text\/html/i.test(res.headers.get('content-type') || '')
);

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const files = await Promise.all(CORE.map(async path => {
      const url = new URL(path, self.registration.scope);
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (!cacheable(url, res)) throw new Error(`Invalid app file: ${url.pathname}`);
      return [url, res];
    }));
    const cache = await caches.open(VERSION), assets = await caches.open(ASSETS);
    // The share pictures' fonts (~74 KB): fetched once, so a first share made offline still has them.
    await Promise.all(BRAND.map(async p => (await assets.match(p)) || assets.add(p).catch(() => {})));
    await Promise.all(files.map(([url, res]) => cache.put(url, res)));
    if (!(await caches.has(HOLD))) await self.skipWaiting();
  })().catch(error => { console.error('Tally offline update failed', error); throw error; }));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('tally-') && ![VERSION, ASSETS, HOLD, 'tally-share'].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'skip') self.skipWaiting(); });   // "Update now"
const keyFor = url => url.origin + url.pathname;
// Cross-origin isolation lets the receipt reader use several cores (SharedArrayBuffer). GitHub Pages can't send these
// headers, so every answer from Tally's own site gets them here. credentialless: the feedback form's no-cors post still works.
const iso = res => {
  if (!res || !res.status || res.type === 'opaqueredirect') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin'); h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
};
const saving = new Map();   // asset path → the cache write in progress
const SHARED = 'tally-share';   // files shared into Tally, waiting for the page to pick them up
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/share')) {
    // Only the phone's share sheet ("none") or Tally itself may send files in: another website's form can't plant a
    // file for Tally to open. At most 20 files and 200 MB, kept as plain bytes (the type rides in a header).
    const site = req.headers.get('sec-fetch-site');
    if (site && site !== 'none' && site !== 'same-origin') { e.respondWith(Response.redirect('./', 303)); return; }
    e.respondWith((async () => {
      let room = 200 * 1024 * 1024;
      const files = (await req.formData()).getAll('files').filter(f => typeof f !== 'string').slice(0, 20).filter(f => (room -= f.size) >= 0);
      await caches.delete(SHARED);
      const c = await caches.open(SHARED);
      await Promise.all(files.map((f, i) => c.put(`./shared/${i}`, new Response(f, { headers: { 'content-type': 'application/octet-stream', 'x-type': f.type || '', 'x-name': encodeURIComponent(f.name || `file-${i}`) } }))));
      return Response.redirect('./#/share', 303);
    })());
    return;
  }
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google Sheets and calendar links go straight to the network
  if (isAsset(url)) {
    // One download per file: a second request while the first is still being saved (the reader worker starting right
    // after the page fetched the 10 MB model) waits for that save and is answered from the cache.
    e.respondWith(caches.open(ASSETS).then(async c => {
      const hit = await c.match(req, { ignoreSearch: true }) || (saving.has(url.pathname) && await saving.get(url.pathname) && await c.match(req, { ignoreSearch: true }));
      if (hit) return hit;
      const res = await fetch(req);
      if (cacheable(url, res) && !saving.has(url.pathname)) {
        const done = c.put(req, res.clone()).then(() => true, () => false);
        saving.set(url.pathname, done); done.then(() => saving.delete(url.pathname));
      }
      return res;
    }).then(iso));
    return;
  }
  const key = keyFor(url), shell = req.mode === 'navigate';
  // Only a page load may fall back to the app shell: a script answered with index.html would leave the app stuck.
  // Only the app's own cache answers: never the shared files or another cache under this origin.
  const fromCache = () => caches.open(VERSION).then(c => c.match(key).then(r => r || (shell ? c.match(new URL('./index.html', self.registration.scope).href) : undefined)));
  if (!shell && corePaths.has(url.pathname)) {
    e.respondWith(fromCache().then(hit => hit || fetch(req).then(res => {
      if (cacheable(url, res)) caches.open(VERSION).then(c => c.put(key, res.clone()));
      return res;
    })).then(iso));
    return;
  }
  e.respondWith(new Promise(resolve => {
    resolve = (done => r => done(iso(r)))(resolve);
    let settled = false;
    const timer = shell ? setTimeout(() => { fromCache().then(r => { if (!settled && r) { settled = true; resolve(r); } }); }, 3000) : null;
    fetch(req, { cache: 'no-cache' }).then(res => {
      if (cacheable(url, res)) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(key, copy)); }
      clearTimeout(timer);
      if (!settled) { settled = true; resolve(res); }
    }).catch(() => {
      clearTimeout(timer);
      fromCache().then(r => { if (!settled) { settled = true; resolve(r || Response.error()); } });
    });
  }));
});
