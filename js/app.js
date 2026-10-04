// App shell: boot, hash routing, bottom nav, one delegated click/input handler, recovery screen on errors.
import { S, load, locked, settings, setSetting, onRemoteChange, onSaveFailed, storageMode, persistStorage, sweepPhotos, dropPhotos, today, repairCatNames, OLD_HOME, NEW_HOME, wipeSite } from './state.js';
import { gate, watch, sealPhotos } from './lock.js';
import { t, setLang, pickLang } from './i18n.js';
import { $, esc, ICON, toast, closeSheet, sheetOpen, own , settling } from './ui.js';
import * as home from './views/home.js';
import * as money from './views/money.js';
import * as learn from './views/learn.js';
import { flushFeedback } from './feedback.js';
import { onboarding, registerSW } from './tour.js';
import { startScan } from './camera.js';
import { applyLook, applySavedLook } from './colorpicker.js';
import { on } from './features.js';
import { sharedFiles, onShared, isNative } from './native.js';
import { syncReminderDay } from './state.js';
window.addEventListener('tally:scan-shortcut', () => {
  if (!document.getElementById('view')?.children.length || locked() || document.querySelector('.lock, .scrim:not(.out)')) return;
  ACT.scan();
});

applySavedLook();   // theme and accent before anything is drawn (the database copy is applied on every render)

export const APP_VERSION = '1.13.10';
export const MAKER = 'fir1412', CONTACT = 'fir1412dev@gmail.com';   // the developer, and the data user for feedback (privacy pages)
// Checking a receipt and Settings (with Welcome and imports) load the first time they are needed, not before Home
// shows. sw.js still caches them for offline use.
const LAZY = { review: () => import('./views/review.js'), setup: () => import('./views/setup.js') }, mods = {}, loading = {};
const VIEWS = { home: () => home.homeView, insights: () => home.insightsView, activity: () => money.activityView, budgets: () => money.budgetsView, review: () => mods.review?.reviewView, settings: () => mods.setup?.settingsView, welcome: () => mods.setup?.welcomeView, learn: () => learn.learnView, badges: () => learn.badgesView };
const LAZY_VIEW = { review: 'review', settings: 'setup', welcome: 'setup' };
const ACT = { ...home.act, ...money.act, ...learn.act };
const INPUT = { ...money.input, ...learn.input };
/** A lazy module, loaded once; its buttons and fields start working as it arrives. */
const need = name => (loading[name] ||= LAZY[name]().then(m => { mods[name] = m; Object.assign(ACT, m.act); Object.assign(INPUT, m.input); return m; }, e => { delete loading[name]; throw e; }));
const needAll = () => Promise.all(Object.keys(LAZY).map(need));

export const route = () => (location.hash.replace(/^#\/?/, '').split('?')[0] || 'home');
// Back like an app, not a web page. Home is the root and each history entry knows how far above it it is (state.depth).
// A tab opened from Home is one step up; switching between tabs replaces that step. Other screens (a receipt's review,
// Learn) and sheets go one step above the screen they came from. So back always leads towards Home, Home is never
// more than one back away from a tab, and back on Home leaves the app.
const TABS = new Set(['home', 'activity', 'insights', 'budgets', 'settings']);
const depth = () => history.state?.depth || 0;
export function go(r) {
  const s = settling(); if (s) return void s.then(() => go(r));   // a sheet just closed: its history step first
  const cur = route(), d = depth();
  const root = () => { if (route() !== 'home') { location.replace('#/home'); history.replaceState({ depth: 0 }, ''); } };   // the root was Welcome (first run): Home takes its place
  if (r === 'home') { if (d > 0) { addEventListener('popstate', root, { once: true }); history.go(-d); } else if (cur !== 'home') root(); else render(); return; }
  if (cur === r) return render();
  const tab = TABS.has(r) && TABS.has(cur) && cur !== 'home' && d === 1;
  if (tab) { location.replace(`#/${r}`); history.replaceState({ depth: 1 }, ''); return; }
  location.hash = `#/${r}`; history.replaceState({ depth: d + 1 }, '');
}
// Links to screens (the tab bar) go the same way.
document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="#/"]'); if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault(); go(a.getAttribute('href').slice(2) || 'home');
});
let renderedRoute = null;
function focusAfterRender(app, previous, routeChanged) {
  const heading = () => {
    const h = app.querySelector('#view h1');
    if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  };
  if (routeChanged) return heading();
  if (!previous) return;
  let next = previous.id ? app.querySelector(`#${CSS.escape(previous.id)}`) : null;
  if (!next && Object.keys(previous.data).length) next = [...app.querySelectorAll('[data-act], [data-input]')].find(el =>
    el.tagName === previous.tag && Object.entries(previous.data).every(([key, value]) => el.dataset[key] === value));
  if (!next && previous.href) next = [...app.querySelectorAll('a[href]')].find(el => el.getAttribute('href') === previous.href);
  if (next) {
    next.focus({ preventScroll: true });
    if (previous.selection && next.setSelectionRange) try { next.setSelectionRange(...previous.selection); } catch { /* non-text input */ }
  } else heading();
}

export function render() {
  let r = route();
  // Home-screen shortcuts (manifest): #/add opens the add sheet, #/scan the camera, both over Home.
  if ((r === 'add' || r === 'scan') && S.accounts.length) { const act = r === 'add' ? 'tx-new' : on('receipts') ? 'scan' : 'tx-new'; history.replaceState(history.state, '', '#/home'); r = 'home'; setTimeout(() => own(ACT, act)?.({ dataset: {} }), 0); }
  if (!own(VIEWS, r)) r = 'home';   // unknown routes (#/constructor too) show Home
  if (!S.accounts.length && !['welcome', 'settings'].includes(r)) { r = 'welcome'; history.replaceState(null, '', '#/welcome'); }
  if ((r === 'insights' && !on('insights')) || (r === 'budgets' && !on('budgets') && !on('bills'))) { r = 'home'; history.replaceState(history.state, '', '#/home'); }   // a module that is off
  const view = VIEWS[r]();
  applyLook(settings());
  const tabs = [['home', ICON.home, t('Home')], ['activity', ICON.list, t('Activity')], on('insights') && ['insights', ICON.chart, t('Insights')], (on('budgets') || on('bills')) && ['budgets', ICON.wallet, t(on('budgets') ? 'Budgets' : 'Bills')]].filter(Boolean);
  tabs.splice(Math.ceil(tabs.length / 2), 0, null);   // the camera (or +) in the middle, however many tabs are on
  if (tabs.length % 2 === 0) tabs.push(0);   // an odd number of tabs (3): an empty one on the short side keeps the camera at the centre
  const nav = r === 'welcome' ? '' : `<nav class="tabs" aria-label="${esc(t('Main'))}"><span class="brand" aria-hidden="true">Tally</span>${tabs.map(x => x === 0 ? '<span class="tab pad" aria-hidden="true"></span>' : x ? `<a href="#/${x[0]}" class="tab${r === x[0] ? ' on' : ''}"${r === x[0] ? ' aria-current="page"' : ''}>${x[1]}<span>${esc(x[2])}</span></a>`
    : on('receipts') ? `<button class="fab" data-act="scan" aria-label="${esc(t('Scan a receipt'))}">${ICON.camera}</button>` : `<button class="fab" data-act="tx-new" aria-label="${esc(t('Add'))}">${ICON.plus}</button>`).join('')}<a href="#/settings" class="tab desk${r === 'settings' ? ' on' : ''}">${ICON.gear}<span>${esc(t('Settings'))}</span></a></nav>`;
  const app = $('#app'), active = document.activeElement, routeChanged = renderedRoute !== r;
  const focused = !sheetOpen() && app.contains(active) ? {
    id: active.id, tag: active.tagName, data: { ...active.dataset }, href: active.getAttribute('href'),
    selection: typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null,
  } : null;
  if (!view) {   // its code is still loading: a moment's placeholder, then the screen
    app.innerHTML = `<main id="view" class="view-${r}"><div class="skel"><span class="sk-sr" role="status">Tally…</span><i class="sk-hero" aria-hidden="true"></i><i class="sk-row" aria-hidden="true"></i><i class="sk-row" aria-hidden="true"></i></div></main>${nav}`;   // the loading outline from index.html
    need(LAZY_VIEW[r]).then(() => render(), err => toast(t('Something went wrong: {0}', err.message || String(err)), { k: 'bad' }));
    return;
  }
  app.innerHTML = `<main id="view" class="view-${r}">${view.render()}</main>${nav}`;
  renderedRoute = r;
  view.after?.();
  learn.afterRender();   // Learn Tally missions and badges, checked a moment later
  document.title = `Tally · ${t(view.title || 'Home')}`;
  if (!sheetOpen()) focusAfterRender(app, focused, routeChanged);
}

// ---- events -------------------------------------------------------------------------------------------------------
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  let fn = own(ACT, b.dataset.act);
  if (!fn && Object.keys(mods).length < Object.keys(LAZY).length) { e.preventDefault(); await needAll().catch(console.error); fn = own(ACT, b.dataset.act); }   // Back up on Home: Settings' code first
  if (!fn) return;
  e.preventDefault();
  // Anything slower than 150 ms shows it is working on the button pressed (not once a sheet has opened over it).
  const slow = setTimeout(() => { if (b.isConnected && !b.closest('[inert], .scrim.out')) { b.classList.add('busy'); b.setAttribute('aria-busy', 'true'); } }, 150);
  try { await fn(b, e); learn.noticed(`act:${b.dataset.act}`); } catch (err) { console.error(err); if (b.isConnected) b.disabled = false; toast(t('Something went wrong: {0}', err.message || String(err)), { k: 'bad' }); }
  finally { clearTimeout(slow); b.classList.remove('busy'); b.removeAttribute('aria-busy'); }
});
// Typing fields report on 'input'; selects, checkboxes, dates and files on 'change' (each handler runs once).
const typing = el => el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'file', 'date', 'time', 'color'].includes(el.type));
for (const ev of ['input', 'change']) document.addEventListener(ev, e => {
  const el = e.target.closest('[data-input]');
  const fn = el && own(INPUT, el.dataset.input);
  if (fn && (ev === 'input') === typing(el)) { fn(el, e); learn.noticed(`input:${el.dataset.input}:${el.dataset.k || ''}`); }
});
// Screen change: entrance motion plays once (html[data-enter]), and browsers with View Transitions crossfade.
const entering = () => { const html = document.documentElement; html.dataset.enter = ''; clearTimeout(window.__enterT); window.__enterT = setTimeout(() => delete html.dataset.enter, 800); };
// Going straight back to the screen just left (back arrow or phone back) returns to the same scroll position.
let shown = route(), left = null;
export const cameFrom = () => left?.to === route() ? left.route : null;
let transition = null;
window.addEventListener('hashchange', () => {
  if (sheetOpen()) closeSheet();
  const r = route(), y = left && left.route === r && left.to === shown ? left.y : 0;
  left = { route: shown, y: window.scrollY, to: r };
  shown = r;
  // One crossfade at a time: a back pressed while the last screen was still arriving froze Chrome for 4 s (the transition
  // timed out waiting). A screen change during another's entrance or transition just switches, without the crossfade.
  const busy = transition || document.documentElement.dataset.enter !== undefined;
  entering();
  const run = () => { render(); window.scrollTo(0, y); };
  transition?.skipTransition?.();
  if (document.startViewTransition && !busy && !matchMedia('(prefers-reduced-motion: reduce)').matches) { transition = document.startViewTransition(run); transition.finished.finally(() => { transition = null; }); } else run();
});

// Global actions used by every view.
Object.assign(ACT, {
  scan: async () => {
    if (settings().photoTipsSeen) return startScan(scanned);
    await setSetting('photoTipsSeen', true);
    (await need('review')).photoTips({ thenScan: true });
  },
  go: b => go(b.dataset.to),
  back: b => (cameFrom() ? history.back() : go(b.dataset.to || 'home')),
});
export const scanned = async files => { (await need('review')).enqueue(files); go('review'); };
document.addEventListener('change', e => {
  if (e.target.id !== 'scan-input') return;
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) scanned(files);
});

// ---- boot ---------------------------------------------------------------------------------------------------------
function recovery(err) {
  document.body.innerHTML = `<main class="recover"><h1>${esc(t('Tally could not start'))}</h1><p>${esc(t('Your data is still on this phone. Reload to try again. If it keeps happening, back up first from Settings once it opens, or send us a note.'))}</p>
    <p class="fine">${esc(String(err?.message || err))}</p><button class="btn" id="reload">${esc(t('Reload'))}</button></main>`;
  document.getElementById('reload').addEventListener('click', () => location.reload());
}
window.addEventListener('error', e => { if (!document.getElementById('app')?.children.length) recovery(e.error || e.message); });
window.addEventListener('unhandledrejection', e => console.error(e.reason));

/** Files shared into Tally (Money Manager → Export → Share, Gallery, WhatsApp): photos go to the scanner, the rest to import. */
function openShared(files) {
  const photos = files.filter(f => f.type.startsWith('image/')), other = files.filter(f => !f.type.startsWith('image/'));
  if (other.length) setTimeout(async () => (await need('setup')).importFile(other[0]), 400);   // one import at a time
  else if (photos.length) return need('review').then(m => { m.enqueue(photos); history.replaceState(null, '', '#/review'); });
}
async function takeShared() {
  const direct = await sharedFiles();   // the Android app gets them straight from the phone's share sheet; none elsewhere
  if (direct.length) { history.replaceState(null, '', '#/home'); return openShared(direct); }
  if (!('caches' in window)) return;
  if (route() !== 'share') return caches.delete('tally-share').catch(() => {});   // shared files never wait past a start
  history.replaceState(null, '', '#/home');
  const c = await caches.open('tally-share'), keys = await c.keys();
  const files = [];
  for (const k of keys) { const r = await c.match(k); files.push(new File([await r.blob()], decodeURIComponent(r.headers.get('x-name') || 'shared'), { type: r.headers.get('x-type') || '' })); }
  await caches.delete('tally-share');
  return openShared(files);
}
export const refresh = () => { if (!sheetOpen()) render(); };
(async () => {
  // Never run inside another site's frame (clickjacking): GitHub Pages can't send frame-ancestors.
  if (window.top !== window.self) {
    $('#app').innerHTML = `<main class="recover"><h1>Tally can only run on its own page.</h1><p><a class="btn" href="${esc(location.href)}" target="_top" rel="noopener">Open Tally</a></p></main>`;
    return;
  }
  try { performance.setResourceTimingBufferSize?.(1000); } catch {}   // "Check it yourself" reads this record: keep more of it
  try {
    await load();
    if (OLD_HOME && !S.accounts.length && !S.tx.length && !settings().lock) { await wipeSite(); return location.replace(NEW_HOME); }   // nothing here to move: go to the new address
    await setLang(settings().lang || pickLang(navigator.languages || [navigator.language]));
    document.documentElement.style.fontSize = `${settings().textSize || 100}%`;
    await syncReminderDay();   // selected/default language is now available
    await gate();   // app lock: nothing is shown before the PIN
    if (settings().lock?.enc) { await load(); sealPhotos().catch(() => {}); }   // encrypted: the data could only be read once the PIN unlocked its key
    await repairCatNames().catch(() => {});   // "&#x1f35c; Food" from an older import: folded into Food
    onRemoteChange(async s => { if (s === 'erased') return location.reload();   // erased in another tab: nothing here may write the old data back
      await load(); if (locked()) { await gate(); await load(); } refresh(); });   // encrypted or re-keyed in another tab: ask here too
    setTimeout(() => sweepPhotos().catch(() => {}), 8000);   // photos of entries deleted before this start (after their Undo was over)
    // Photos kept only for a while (Settings → Privacy): older ones go, their entries stay. The day count is from today's date.
    if (settings().photoKeep > 0) setTimeout(() => { const d = new Date(`${today()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - settings().photoKeep); dropPhotos(d.toISOString().slice(0, 10)).catch(() => {}); }, 9000);
    onSaveFailed(() => toast(t('Could not save. Your phone may be out of space.'), { k: 'bad' }));
    if (storageMode() === 'localstorage') setTimeout(() => toast((isNative ? t('Local storage is limited. Keep a backup file and avoid adding receipt photos for now.') : t('Private browsing: data may be lost when you close this tab.')), { k: 'warn' }), 800);
    if (!location.hash && settings().start === 'activity') { history.replaceState(null, '', '#/activity'); shown = 'activity'; }   // start screen
    await takeShared();
    onShared(async files => { while (locked()) await new Promise(r => setTimeout(r, 500)); openShared(files); });   // shared while Tally is already open (Android app)
    if (!S.accounts.length) await need('setup');   // Welcome shows at once
    const resumed = S.kv.reviewDraft?.draft || S.kv.scanQueue?.length ? await (await need('review')).restoreDraft() : false;   // nothing to resume: its code can wait
    if (resumed === 'waiting') toast(t('A receipt is waiting for the reader. Open Scan when you are on Wi-Fi.'));
    else if (resumed) { history.replaceState(null, '', '#/review'); toast(resumed === 'items' ? t('Picked up the items you were adding') : t('Picked up the receipt you were checking')); }
    await money.postBills().catch(console.error);   // bills that add themselves, up to today
    watch(async () => { if (await money.postBills().catch(() => 0)) refresh(); await syncReminderDay(); });
    if (S.accounts.length) persistStorage().then(() => route() === 'settings' && refresh());
    if (isNative) setInterval(() => { if (document.visibilityState === 'visible') syncReminderDay().catch(() => {}); }, 60_000);   // midnight/clock changes while open
    entering(); render();   // opening the app plays the same entrance as a screen change (the month ring fills)
    if (!resumed) onboarding();
    flushFeedback().catch(() => {});
    registerSW(() => sheetOpen() || !!mods.review?.busy());
  } catch (err) { recovery(err); }
})();
