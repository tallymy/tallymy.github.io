// Scan → review → save. Photos are read one at a time in a queue, so capture never waits on the screen.
// Only uncertain lines are flagged; the checksum says whether the items add up to the printed total.
import { S, cat, setKv, saveTx, savePhoto, deletePhotos, getPhoto, learn, expenseCats, today, nowTime, uid, defaultAccount, bookGeneration } from '../state.js';
import { t, fmtDate, fmtMonth, getLang } from '../i18n.js';
import { esc, ICON, toast, confirmSheet, openSheet, closeSheet, $, $$, landed, countUp, reduced, announce } from '../ui.js';
import { firstWord } from './learn.js';
import { subFor, learnSub, subsOf, fmtRM, fmtAcct, isFx, calcAmount, categorize, shopCategory, findDuplicate, validIso, addDays, addMonths, daysInMonth, itemKey, learnNames, owing } from '../engine.js';
import { checksum, parseItemLines } from '../parse.js';
import { on } from '../features.js';
import { readReceipt, loadOcr, ocrReady, ocrProgress, ocrSaved, OCR_BYTES, readPct, cancelOcr } from '../scan.js';
let saved = false; ocrSaved().then(v => { saved = v; }, () => {});   // already on this phone: starting it is not a download
import { render, go, scanned } from '../app.js';
import { accName } from './money.js';
import { startScan } from '../camera.js';
import { validCorners } from '../receipt-image.js';
import { isNative } from '../native.js';
import * as db from '../db.js';

// The first download's progress, drawn in place so the bar moves without redrawing the screen.
let dlPct = 0, dlText = '', dlSaid = 0;
const mb = n => (n / 1048576).toFixed(1);
ocrProgress((got, total) => {
  if (isNative || current?.status !== 'reading') return;
  dlPct = Math.round(got / total * 100); dlText = t('{0} of {1} MB', mb(got), mb(total));
  if (dlPct >= dlSaid + 25) { dlSaid = dlPct - dlPct % 25; announce(`${t('Downloading the receipt reader')}: ${dlSaid}%`); }   // every quarter, for screen readers
  const bar = document.getElementById('ocr-prog'), txt = document.getElementById('ocr-pct');
  if (bar) bar.value = dlPct; if (txt) txt.textContent = dlText;
});
// While a photo is read: what the reader is doing now, and a bar eased toward how long the last read took on this phone.
// ponytail: the bar is time-based (the worker can't report inside one detect); it never reaches the end until the read does.
let est = 5000;   // ms for one pass, learned from each read
const STAGES = { prep: () => t('Getting the photo ready…'), read: () => t('Finding the text…'), lines: () => t('Reading each line…'), turn: () => t('Turning the photo the right way up…'), straighten: () => t('Straightening the photo…'), zoom: () => t('Looking closer at the small print…') };
const stageNow = () => (current.stage === 'read' && performance.now() - current.t0 > current.est * 0.4 ? 'lines' : current.stage);
let ticker = 0;
function paintRead() {
  if (current?.status !== 'reading' || !current.t0) return clearInterval(ticker);
  const bar = document.getElementById('read-prog'), txt = document.getElementById('read-stage');
  if (bar) bar.value = readPct(performance.now() - current.t0, current.est); if (txt) txt.textContent = STAGES[stageNow()]();
}
function onStage(stage) {
  if (current?.status !== 'reading') return;
  const now = performance.now();
  current.stage = stage;
  if (stage === 'prep') { current.t0 = now; current.est = est; refresh(); clearInterval(ticker); ticker = setInterval(paintRead, 250); }
  else if (stage !== 'read') { current.extra = true; current.est = Math.max(current.est, now - current.t0 + est); }   // one more pass: about one more read
  paintRead();
}
const queue = [];     // files waiting to be read
let current = null;   // {id, file?, status: 'reading'|'ready'|'error', draft, photo, ms, error}
let reading = false;
let rereadPrevious = null;
let reviewEpoch = 0;
let revealCleanup = null;
const active = (epoch, generation) => epoch === reviewEpoch && generation === bookGeneration();
export function resetReview() {
  cancelOcr(); reviewEpoch++;
  rereadPrevious = null;
  if (current?.ticket) current.ticket.cancelled = true;
  for (const item of queue) if (item.ticket) item.ticket.cancelled = true;
  clearTimeout(persistT); clearInterval(ticker);
  revealCleanup?.(); revealCleanup = null;
  if (current?.thumb) URL.revokeObjectURL(current.thumb);
  current = null; queue.length = 0; reading = false;
}
document.addEventListener('tally:book-replaced', resetReview);

// The photo being read stays listed until its draft is saved: closing the app mid-read must not lose it.
const cancelled = () => Object.assign(new Error('Reading cancelled'), { name: 'AbortError', cancelled: true });
const generationGuard = generation => ({ kv: [{ id: 'bookGeneration', value: generation == null ? undefined : { key: 'bookGeneration', value: generation } }] });
async function reviewKv(key, value, epoch = reviewEpoch, generation = bookGeneration()) {
  if (!active(epoch, generation)) throw cancelled();
  await db.writeAtomic({ put: { kv: [{ key, value }] }, expected: generationGuard(generation),
    beforeWrite: () => { if (!active(epoch, generation)) throw cancelled(); } });
  if (active(epoch, generation)) S.kv[key] = value;
}
// Only queue/draft copies owned by this review; a stored entry always wins over cleanup.
async function dropReviewPhotos(ids, generation) {
  if (generation !== bookGeneration() || !ids.length) return;
  try {
    const rows = await db.all('tx');
    if (generation !== bookGeneration()) return;
    const referenced = new Set([...rows, ...S.tx].map(x => x.receiptId));
    if (current?.draft?.receiptId) referenced.add(current.draft.receiptId);
    if (rereadPrevious?.draft?.receiptId) referenced.add(rereadPrevious.draft.receiptId);
    const own = [...new Set(ids)].filter(id => id && !referenced.has(id));
    if (!own.length) return;
    await db.writeAtomic({ del: { receipts: own }, expected: { ...generationGuard(generation), tx: rows.map(value => ({ id: value.id, value })) }, expectedKeys: { tx: rows.map(x => x.id) },
      beforeWrite: () => { if (generation !== bookGeneration() || S.tx.some(x => own.includes(x.receiptId)) || own.includes(current?.draft?.receiptId) || own.includes(rereadPrevious?.draft?.receiptId)) throw cancelled(); } });
  } catch {} // A changed book or a newly referenced photo is left intact.
}
const queueIds = () => [...(['reading', 'error'].includes(current?.status) && !rereadPrevious ? [current.id] : []), ...queue.map(q => q.id)];
const saveQueue = (epoch = reviewEpoch, generation = bookGeneration(), ids = queueIds()) => reviewKv('scanQueue', ids, epoch, generation);
export async function enqueue(files) {
  const generation = bookGeneration();
  // Register the entire selection before storage can yield. Cancelling one must
  // not discard later files which have not reached their persistence turn yet.
  const batch = [...files].map(file => ({ id: uid('r'), file, status: 'waiting', ticket: { cancelled: false } }));
  queue.push(...batch);
  const owned = item => !item.ticket.cancelled && generation === bookGeneration() && (queue.includes(item) || current?.ticket === item.ticket);
  try {
    let unsaved = 0;
    for (const item of batch) {
      if (!owned(item)) continue;
      if (current?.ticket === item.ticket && current.status === 'ready') continue;
      const stored = await savePhoto(`q_${item.id}`, item.file, { generation });
      if (!owned(item) || current?.ticket === item.ticket && current.status === 'ready') { await dropReviewPhotos([`q_${item.id}`], generation); continue; }
      if (!stored) unsaved++;
    }
    if (!batch.some(owned)) return;
    if (unsaved) toast(t('Phone storage is full: close Tally now and these photos are lost. Free some space.'), { k: 'bad' });
    await saveQueue(reviewEpoch, generation);
  } catch (e) { if (!e?.cancelled && generation === bookGeneration() && batch.some(owned)) throw e; }
  finally { if (generation === bookGeneration() && batch.some(owned)) pump(); }
}
/** Cancel reader work, never a stored entry or the gallery original. */
export async function cancelReading(all = false) {
  if (!reading && !['reading', 'waiting'].includes(current?.status) && (current || !queue.length)) return;
  const generation = bookGeneration(), previous = rereadPrevious, abandoned = current || queue.shift();
  cancelOcr(); const epoch = ++reviewEpoch;
  clearTimeout(persistT); clearInterval(ticker); revealCleanup?.(); revealCleanup = null;
  const discard = [!previous && abandoned?.id ? `q_${abandoned.id}` : null];
  if (!previous && abandoned?.ticket) abandoned.ticket.cancelled = true;
  if (all) { for (const item of queue) if (item.ticket) item.ticket.cancelled = true; discard.push(...queue.map(x => `q_${x.id}`)); queue.length = 0; }
  for (const item of queue) { delete item.ahead; delete item.t0; delete item.stage; }
  if (!previous && abandoned?.thumb) URL.revokeObjectURL(abandoned.thumb);
  current = previous ? { ...previous, status: 'ready' } : null;
  rereadPrevious = null; reading = false;
  if (!previous && abandoned?.draft?.receiptId && !abandoned.existing) discard.push(abandoned.draft.receiptId);
  refresh();
  try {
    await reviewKv('reviewDraft', previous ? { draft: previous.draft, existing: !!previous.existing, manual: !!previous.manual, base: previous.base } : null, epoch, generation);
    await saveQueue(epoch, generation);
    await dropReviewPhotos(discard.filter(Boolean), generation);
  } catch (e) { if (!e?.cancelled && active(epoch, generation)) toast(t('Phone storage is full: close Tally now and these photos are lost. Free some space.'), { k: 'bad' }); }
  if (!active(epoch, generation)) return;
  if (current) { refresh(); if (!all) readAhead(); }
  else if (queue.length) pump(); else { announce(t('Cancel all')); go('home'); }
}
// While one receipt is checked, the next photo is already being read, so a pile of receipts goes one after another.
function readAhead() {
  const epoch = reviewEpoch, generation = bookGeneration();
  const n = queue[0];
  if (!n || n.ahead || !ocrReady()) return;
  n.t0 = performance.now();
  n.ahead = readReceipt(n.file, s => { if (!active(epoch, generation)) return; n.stage = s; if (current?.id === n.id) onStage(s); });
  n.ahead.catch(() => {});   // pump reports it when this photo's turn comes
}
async function pump() {
  const epoch = reviewEpoch, generation = bookGeneration();
  if (current?.status === 'ready') readAhead();
  if (reading || current?.status === 'ready' || current?.status === 'reading') return;
  const next = queue.shift();
  if (!next) { current = null; return; }
  const { ahead, t0, stage, ...rest } = next;   // the read-ahead's own fields; adopted below
  current = { ...rest, status: 'reading', thumb: URL.createObjectURL(next.file) };
  saveQueue().catch(() => {});
  reading = true; refresh(); announce(t('Reading…'));
  try {
    if (!ocrReady()) await loadOcr();
    if (!active(epoch, generation)) return;
    if (stage) { Object.assign(current, { t0, est, stage }); refresh(); clearInterval(ticker); ticker = setInterval(paintRead, 250); }   // read ahead, still going
    const { receipt, photo, ms, turns, tries } = await (ahead || readReceipt(next.file, s => { if (active(epoch, generation)) onStage(s); }));
    if (!active(epoch, generation)) return;
    est = ms / tries;
    const draft = toDraft(receipt);
    let createdPhoto;
    if (photo) { createdPhoto = draft.receiptId = uid('p'); if (!(await savePhoto(draft.receiptId, photo, { generation }))) delete draft.receiptId; }
    if (!active(epoch, generation)) { if (createdPhoto) await dropReviewPhotos([createdPhoto], generation); return; }
    try {
      await reviewKv('reviewDraft', { draft, existing: false }, epoch, generation);
      await saveQueue(epoch, generation, queue.map(x => x.id));
    } catch (error) { if (createdPhoto) await dropReviewPhotos([createdPhoto], generation); throw error; }
    if (!active(epoch, generation)) { if (createdPhoto) await dropReviewPhotos([createdPhoto], generation); return; }
    if (current?.thumb && photo) URL.revokeObjectURL(current.thumb);
    current = { ...current, status: 'ready', ms, turns, draft, reveal: true, ...(photo ? { thumb: URL.createObjectURL(photo) } : {}) };   // the upright photo, as it was read
    if (!document.querySelector('.view-review')) toast(t('Your receipt is read.'), { k: 'good', icon: 'check', undo: () => go('review'), undoLabel: t('Check it') });   // left while the reader downloaded
    const n = draft.items.length;
    announce([n === 1 ? t('1 item') : t('{0} items', n), draft.total != null && t('Total {0}', fmtRM(draft.total))].filter(Boolean).join(', '));

  } catch (e) {
    if (!active(epoch, generation) || e?.cancelled || e?.name === 'AbortError') return;
    console.error(e);
    current = { ...current, status: 'error', error: /not an image/.test(e.message) ? t('That file is not a photo. Pick a JPG or PNG of the receipt.') : /too big/.test(e.message) ? t('That photo is over 40 MB. Take a new one or send a smaller copy.') : /too many pixels/.test(e.message) ? t('That photo is over 50 megapixels. Take it in the normal camera mode, or send a smaller copy.') : /could not be downloaded|fetch|network|load failed/i.test(e.message) ? (isNative ? t('The receipt reader could not start. Close Tally and try again.') : t("The receipt reader isn't on this phone yet. It downloads once (about 30 MB, from Tally's own site); after that, scanning works offline. Connect and try again.")) : t('Could not read this photo: {0}', e.message) };
  }
  if (!active(epoch, generation)) return;
  if (current?.status === 'error') await saveQueue(epoch, generation);
  else await dropReviewPhotos([`q_${next.id}`], generation);   // read: the draft holds its own copy now; an unreadable one waits for Skip
  if (!active(epoch, generation)) return;
  reading = false; refresh();
  if (current?.status === 'ready') readAhead();
}
/** Photos being read or waiting (in memory only): an app update must not reload now. */
export const busy = () => reading || queue.length > 0;
const refresh = () => { if (location.hash.startsWith('#/review')) render(); };

// The receipt being checked is kept on the phone as it's edited, so a locked phone or a killed tab loses nothing.
let persistT;
function persist() {
  const epoch = reviewEpoch, generation = bookGeneration();
  clearTimeout(persistT);
  persistT = setTimeout(() => {
    if (!active(epoch, generation) || current?.status !== 'ready') return;
    if (current.manual && !current.draft.items.length) return reviewKv('reviewDraft', null, epoch, generation).catch(() => {});   // nothing typed yet: nothing to resume
    reviewKv('reviewDraft', { draft: current.draft, existing: !!current.existing, manual: !!current.manual, base: current.base }, epoch, generation).catch(() => {});
  }, 300);
}
function finish() { clearTimeout(persistT); if (current) current.unread = ''; if (current?.thumb) URL.revokeObjectURL(current.thumb); current = null; return reviewKv('reviewDraft', null); }
/** On start: reopen an unfinished review. Returns 'items' for typed items (no photo), 'receipt' for the rest, or false. */
export async function restoreDraft() {
  const epoch = reviewEpoch, generation = bookGeneration();
  if (current) return false;
  for (const id of S.kv.scanQueue || []) { const file = await getPhoto(`q_${id}`); if (!active(epoch, generation)) return false; if (file) queue.push({ id, file, status: 'waiting' }); }
  const saved = S.kv.reviewDraft;
  if (saved?.draft) {
    const blob = saved.draft.receiptId ? await getPhoto(saved.draft.receiptId) : null;
    if (!active(epoch, generation)) return false;
    current = { id: uid('r'), status: 'ready', existing: saved.existing, base: saved.base, manual: saved.manual, draft: saved.draft, thumb: blob ? URL.createObjectURL(blob) : null };
  } else if (queue.length) {
    // Photos left waiting while the reader was still downloading: read them now only if the reader is here. Otherwise don't
    // start a 30 MB download on every open (prepaid data); Scan offers to read them when the person chooses.
    const ready = ocrReady() || await ocrSaved(); if (!active(epoch, generation)) return false;
    if (ready) pump(); else return 'waiting';
  }
  return current?.draft && !current.draft.receiptId ? 'items' : !!current || queue.length > 0 ? 'receipt' : false;
}

const EXAMPLE = { en: 'Phone 1299\nFish 25, vegetables 8', ms: 'Telefon 1299\nIkan 25, sayur 8', zh: '手机 1299\n鱼 25，菜 8，猪肉 30' };
/** Parsed receipt → editable transaction draft, with categories guessed from the user's rules and shop words. */
const flagWhy = i => (!i.name ? t('No name read') : i.cents === 0 ? t('Price looks wrong') : t('Hard to read: check the name and price'));
function toDraft(r) {
  // The shop as read, then as this user renamed it before ("HEXTAR LUCKIN" → what they typed last time).
  const read = (r.merchant || '').slice(0, 80), merchant = (read && S.kv.shopNames?.[itemKey(read)]) || read;
  const meal = c => (r.meal && c === 'groceries' ? 'dining' : c);   // a restaurant bill: its dishes are dining
  // A shop Tally's own words don't know, but the shop list does (Parkson: shopping): its category for this receipt only,
  // never saved, and not when the user files things only their own way.
  const sk = 'SHOP ' + itemKey(merchant);
  const rules = r.shopCat && !S.kv.settings?.ownCats && !Object.hasOwn(S.kv.rules, sk) && shopCategory(merchant, S.kv.rules) === 'other' ? { ...S.kv.rules, [sk]: r.shopCat } : S.kv.rules;
  // Each item as read, then as this user renamed that same reading before ("WS B121 WET WIPES" → "WS BT21 WET WIPES").
  const items = r.items.map(i => {
    const raw = (i.name || '').slice(0, 80), fixed = raw && S.kv.itemNames?.[itemKey(raw)], name = fixed || raw;
    return { name, raw, cents: i.cents, category: meal(categorize(name, merchant, rules)), flag: !!i.priceFlag || (!fixed && !!i.flag), nameFlag: !fixed && !!i.nameFlag, priceFlag: !!i.priceFlag, ...(i.qty ? { qty: i.qty, unit: i.unit } : {}), ...(i.crop ? { crop: i.crop } : {}) };
  });
  items.forEach((i, n) => { if (i.cents < 0 && n > 0) i.category = items[n - 1].category; });   // money off belongs to the item it sits under
  const shop = shopCategory(merchant, rules), category = r.meal && ['other', 'groceries'].includes(shop) ? 'dining' : shop;
  return {
    id: uid('t'), type: 'expense', source: 'receipt', merchant, readName: read, returnDays: r.returnDays, warrantyMonths: r.warrantyMonths, date: r.date && r.date <= today() ? r.date : today(), dateFound: !!r.date, time: r.time || nowTime(),
    accountId: defaultAccount('receipt', { amount: r.total || 0, shop: merchant, category, pay: r.pay, currency: r.currency }), currency: r.currency, category, items,
    sub: on('subcats') ? subFor(category, merchant, items, S.kv.subRules) : '',   // guessed from the shop and the items, or learned
    total: r.total, totalGuessed: !!r.totalGuessed, notReceipt: !!r.notReceipt, tax: r.tax ?? 0, service: r.service ?? 0, rounding: r.rounding ?? 0, taxIncluded: !!r.taxIncluded,
    ...(r.refund ? { refund: true } : {}),
  };
}
/** Open an already-saved receipt transaction for item editing (from the transaction sheet). */
export function editExisting(tx, { manual = false, lines = '', base } = {}) {
  base = base === undefined ? S.tx.find(x => x.id === tx.id) : base;
  current = { id: uid('r'), status: 'ready', existing: !!base, base: base ? structuredClone(base) : null, manual, draft: { ...structuredClone(tx), dateFound: true, total: tx.amount, items: (tx.items || []).map(i => ({ ...i })) } };
  if (lines) addLines(lines);   // "鱼 25, 菜 8" typed where the amount goes
  persist();
  go('review');
}

const guessFor = (name, d) => { const c = categorize(name, d.merchant, S.kv.rules); return c === 'other' && d.category && d.category !== 'other' ? d.category : c; };
const itemsSum = d => d.items.reduce((s, i) => s + (i.cents || 0), 0);
/** What the printed total has beyond the items and their extras (tax not included, service, rounding): shown as its own line. */
const gapOf = d => (d.total == null ? 0 : d.total - itemsSum(d) - (d.service || 0) - (d.taxIncluded ? 0 : d.tax || 0) - (d.rounding || 0));
const gapCat = d => d.gapCat || (d.items.length ? mostSpent(d.items) : d.category);
const check = d => checksum({ items: d.items.map(i => ({ cents: i.cents || 0 })), total: d.total, tax: d.tax || null, service: d.service || null, rounding: d.rounding || null });

export const reviewView = {
  title: 'Review receipt',
  /** A receipt just read: once its items are on screen they come in one by one, categories sliding into place, while
   *  the total ticks up; then "adds up" pops. A tap or a key skips to the end; none of it with reduced motion. */
  after() {
    showStrips();
    if (!current?.reveal) return;
    current.reveal = false;
    const main = $('#view'), box = $('#rv-status'), d = current.draft;
    if (reduced() || !main || !box || !d.items.length || !('IntersectionObserver' in window)) return;
    const step = Math.round(Math.min(90, 900 / d.items.length)), dur = step * Math.min(d.items.length, 12) + 300;
    const final = box.innerHTML;
    box.innerHTML = `<p class="rv-tally num" aria-hidden="true">${esc(fmtRM(0))}</p>`;
    main.style.setProperty('--step', `${step}ms`); main.classList.add('reveal-wait');
    let done = false, timer = 0;
    const end = () => {
      if (done) return; done = true; clearTimeout(timer); io.disconnect();
      removeEventListener('click', end, true); removeEventListener('keydown', end, true);
      main.classList.remove('reveal', 'reveal-wait');
      if (!box.isConnected) return;
      box.innerHTML = final;
      if (d.total != null && check(d).ok) box.firstElementChild?.classList.add('pop');
    };
    revealCleanup = end;
    // On a phone the items are below the photo: the reveal waits until they are scrolled into view.
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting || done) return;
      io.disconnect(); main.classList.replace('reveal-wait', 'reveal');
      countUp(box.firstChild, 0, d.total ?? itemsSum(d), dur, x => x);   // steady, in time with the items
      timer = setTimeout(end, dur + 80);
    }, { threshold: 0.6 });
    io.observe(box);
    addEventListener('click', end, true); addEventListener('keydown', end, true);
  },
  render() {
    const waiting = queue.length;
    if (!current) return `<header class="top"><h1>${esc(t('Scan a receipt'))}</h1></header>
      <section class="card center">${ICON.camera}<p>${esc(t('Take a photo of a receipt, or pick one or more from your gallery. They are read on this phone and never uploaded.'))}</p>
      ${queue.length ? `<button class="btn wide" data-act="rv-readq">${esc(t(isNative ? 'Read the {0} waiting photos' : 'Read the {0} waiting (downloads the reader, about 30 MB)', queue.length))}</button>` : ''}
      ${queue.length ? `<div class="read-cancel"><button class="btn ghost" data-act="rv-cancel-one">${esc(t('Cancel this photo'))}</button><button class="btn ghost" data-act="rv-cancel-all">${esc(t('Cancel all'))}</button></div>` : ''}
      <button class="btn${queue.length ? ' ghost' : ''} wide" data-act="scan">${esc(t('Take or pick photos'))}</button><button class="btn ghost wide" data-act="tx-new">${esc(t('No receipt? Add by hand'))}</button>
      <button class="link" data-act="photo-tips">${ICON.camera}${esc(t('Tips for a clear photo'))}</button></section>`;
    if (current.status === 'reading' || current.status === 'waiting') return `<header class="top"><h1>${esc(t('Reading…'))}</h1></header>
      <div class="scanning">${current.thumb ? `<div class="receipt-thumb"><img src="${current.thumb}" alt=""><div class="scanline" aria-hidden="true"></div></div>` : ''}</div>
      <section class="card center" aria-busy="true">${current.t0 ? `<p id="read-stage">${esc(STAGES[stageNow()]())}</p><div class="dl"><progress id="read-prog" max="100" value="${readPct(performance.now() - current.t0, current.est)}" aria-label="${esc(t('Reading…'))}"></progress></div>`
        : `<p>${esc(isNative || ocrReady() || saved ? t('Starting the reader…') : t('Getting the reader ready (the first time downloads about 30 MB; after that it works offline).'))}</p>`}
      ${isNative || ocrReady() || saved ? '' : `<button class="btn ghost wide" data-act="go" data-to="home">${esc(t('Use Tally while it downloads'))}</button><div class="dl"><progress id="ocr-prog" max="100" value="${dlPct}" aria-label="${esc(t('Downloading the receipt reader'))}"></progress><span id="ocr-pct" class="fine num">${esc(dlText)}</span></div>`}
      <div class="read-cancel"><button class="btn ghost" data-act="rv-cancel-one">${esc(t('Cancel this photo'))}</button><button class="btn ghost" data-act="rv-cancel-all">${esc(t('Cancel all'))}</button></div>
      ${waiting ? `<p class="fine">${esc(t('{0} more waiting', waiting))}</p>` : ''}<button class="link" data-act="photo-tips">${ICON.camera}${esc(t('Tips for a clear photo'))}</button></section>`;
    if (current.status === 'error') return `<header class="top"><h1>${esc(t('Scan a receipt'))}</h1></header>
      <section class="card"><p class="err">${esc(current.error)}</p><button class="btn wide" data-act="rv-retry">${esc(t('Try again'))}</button><div class="row2"><button class="btn ghost" data-act="rv-skip">${esc(waiting ? t('Next receipt') : t('Close'))}</button><button class="btn" data-act="scan">${esc(t('Try another photo'))}</button></div></section>`;
    const d = current.draft, c = d.total != null ? check(d) : null, flagged = d.items.filter(i => i.flag).length;
    const old = !current.existing && d.date < addDays(today(), -60);
    const dup = !current.existing && d.total ? findDuplicate({ ...d, amount: d.total }, S.tx) : null;
    const catOpts = sel => expenseCats().map(x => `<option value="${esc(x.id)}"${sel === x.id ? ' selected' : ''}>${esc(t(x.name))}</option>`).join('');
    const acct = S.accounts.find(x => x.id === d.accountId), money = v => fmtAcct(acct, v);   // "SGD 16.98" on an SGD account
    const status = current.manual ? (d.items.length ? `<p class="okbox">${ICON.check}${esc(t('Total {0}', money(itemsSum(d))))}</p>` : `<p class="fine">${esc(t('Add each thing you bought with its price. The total adds itself up.'))}</p>`)
      : d.total == null ? `<div class="warnbox">${ICON.alert}<span class="grow">${esc(d.items.length ? t('No total found: the bottom of the receipt may be cut off. Type the total, or take the photo again.') : t('No total found. Type the total from the receipt.'))}<span class="bactions"><button class="btn small ghost" data-act="rv-retake">${ICON.camera}${esc(t('Retake'))}</button><button class="link tipsrow" data-act="photo-tips">${esc(t('Tips for a clear photo'))}</button></span></span></div>`
      : c.ok ? `<p class="okbox">${ICON.check}${esc(t('Items add up to the total {0}', money(d.total)))}</p>`
      : `<div class="warnbox">${ICON.alert}<span class="grow">${esc(t('Items add up to {0}, the receipt says {1}. Check the amber lines or add a missing item.', money(itemsSum(d) + (d.service || 0) + (d.taxIncluded ? 0 : d.tax || 0) + (d.rounding || 0)), money(d.total)))}${gapOf(d) > 0 ? `<button class="btn small ghost" data-act="rv-gapitem">${ICON.plus}${esc(t('Missed an item of {0}?', money(gapOf(d))))}</button>` : ''}</span></div>`;
    const gap = !current.manual && c && !c.ok && d.items.length ? gapOf(d) : 0;
    const gapLine = gap > 0 ? `<div class="gapline"><b class="grow">${esc(t('Not itemised'))}</b><span class="amt">${esc(fmtRM(gap))}</span>
      <select class="icat" data-input="rv-f" data-k="gapCat" aria-label="${esc(`${t('Not itemised')}: ${t('Category')}`)}">${catOpts(gapCat(d))}</select></div>` : '';
    const maths = [[t('Items'), itemsSum(d)], [t('Service'), d.service], [t('Tax'), d.taxIncluded ? 0 : d.tax], [t('Rounding'), d.rounding]].filter(([, v]) => v).map(([k, v]) => `${k} ${fmtRM(v, { plain: true })}`).join(' + ');
    return `<header class="top"><h1>${esc(current.manual || (current.existing && !d.receiptId) ? t('Your items') : t('Review receipt'))}</h1>${waiting ? `<span class="fine">${esc(t('{0} more waiting', waiting))}</span>` : ''}</header>
      ${d.notReceipt ? `<div class="warnbox">${ICON.alert}<span>${esc(t('This does not look like a receipt. Nothing has been saved.'))}<button class="btn ghost" data-act="tx-new">${esc(t('No receipt? Add by hand'))}</button></span></div>` : ''}
      ${old ? `<div class="warnbox">${ICON.clock}<span class="grow">${esc(t('This receipt is dated {0}. It will be filed under {1}, not this month.', fmtDate(d.date, { year: true }), fmtMonth(d.date.slice(0, 7))))}
        <button class="btn small ghost" data-act="rv-today">${esc(t("Use today's date"))}</button></span></div>` : ''}
      ${dup ? `<p class="warnbox">${ICON.alert}${esc(t('Looks like you already added this: {0} on {1}.', fmtRM(dup.amount), fmtDate(dup.date)))}</p>` : ''}
      <section class="card">
        <label class="field"><span>${esc(t('Shop'))}</span><input id="rv-merchant" maxlength="80" value="${esc(d.merchant)}" data-input="rv-f" data-k="merchant"></label>
        ${on('subcats') && !d.refund ? (() => { const c = d.items.length ? mostSpent(d.items) : d.category;   // a subcategory of what most of it was
          return `<div class="field"><span>${esc(t('Subcategory'))} · ${esc(t(cat(c).name))}</span><div class="chips subs" role="group" aria-label="${esc(t('Subcategory'))}">${subsOf(c, S.kv.subcats).map(n => `<button type="button" class="chip small${d.sub === n ? ' on' : ''}" aria-pressed="${d.sub === n}" data-act="rv-sub" data-s="${esc(n)}">${esc(t(n))}</button>`).join('')}</div></div>`; })() : ''}
        <div class="grid2"><label class="field"><span>${esc(t('Date'))}${d.dateFound ? '' : ` <em class="warn">${esc(t('(not found, check)'))}</em>`}</span><input id="rv-date" type="date" min="1990-01-01" value="${esc(d.date)}" max="${esc(today())}" data-input="rv-f" data-k="date"></label>
        <label class="field"><span>${esc(t('Paid from'))}</span><select id="rv-acc" data-input="rv-f" data-k="accountId">${S.accounts.filter(a => !owing(a) || a.id === d.accountId).map(a => `<option value="${esc(a.id)}"${d.accountId === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}<option value="+">${esc(t('+ Add an account…'))}</option></select></label></div>
        ${(() => { const a = S.accounts.find(x => x.id === d.accountId), cur = a?.currency || 'MYR';   // the receipt's money vs the account's: said, never silently mixed
          return d.currency && d.currency !== cur ? `<p class="warnbox">${ICON.alert}<span>${esc(t('This receipt is in {0}, but {1} is in {2}. Pick an account in {0}, or check the amount.', d.currency, a?.name || '', cur === 'MYR' ? 'RM' : cur))}</span></p>` : ''; })()}
        <label class="field big"><span>${esc(isFx(S.accounts.find(x => x.id === d.accountId)) ? t('Total ({0})', S.accounts.find(x => x.id === d.accountId).currency) : t('Total (RM)'))}${d.totalGuessed ? ` <em class="warn">${esc(t('(guessed, check)'))}</em>` : ''}</span><input id="rv-total" inputmode="decimal" aria-describedby="rv-status" value="${d.total != null ? (d.total / 100).toFixed(2) : ''}" data-input="rv-f" data-k="total"></label>
      </section>
      ${current.thumb ? `<figure class="receipt-thumb"><button class="thumb-btn" data-act="rv-zoom" aria-expanded="false" aria-label="${esc(t('Show the whole receipt'))}"><img src="${current.thumb}" alt="${esc(t('Receipt photo'))}"></button></figure>${!current.manual && !current.existing ? `<button class="btn ghost wide" data-act="rv-flatten">${esc(t('Fix the receipt corners'))}</button>` : ''}` : ''}
      <div id="rv-status">${status}${d.total != null && c && !c.ok && maths ? `<p class="maths">${esc(maths)} ≠ ${esc(fmtRM(d.total, { plain: true }))}</p>` : ''}</div>
      <div class="rowb"><h2>${esc(t('Items'))} <span class="fine">${esc(flagged ? t('{0} to check', flagged) : '')}</span></h2>${d.items.length > 2 ? `<button class="btn small ghost" data-act="rv-select" aria-pressed="${!!current.selecting}">${esc(current.selecting ? t('Done') : t('Select'))}</button>` : ''}</div>
      ${current.selecting ? `<div class="bulkbar"><span class="fine grow">${esc(t('{0} selected', current.picked?.size || 0))}</span><select id="rv-bulkcat" aria-label="${esc(t('Category'))}">${catOpts('')}</select><button class="btn small" data-act="rv-bulkcat">${esc(t('Set'))}</button></div>` : ''}
      <ul class="list items-edit${current.selecting ? ' selecting' : ''}">${d.items.map((i, n) => `<li class="${i.flag ? 'flag' : ''}" style="--i:${Math.min(n, 12)}"${i.flag ? ` data-why="${esc(flagWhy(i))}"` : ''}>${current.selecting ? `<input type="checkbox" class="ipick" data-input="rv-pick" data-n="${n}"${current.picked?.has(n) ? ' checked' : ''} aria-label="${esc(t('Select {0}', i.name || t('item')))}">` : ''}
        <input class="iname" value="${esc(i.name)}" maxlength="80" aria-label="${esc(t('Item name'))}" data-input="rv-item" data-n="${n}" data-k="name" placeholder="${esc(t('Item name'))}">
        <input class="iamt" inputmode="decimal" value="${(i.cents / 100).toFixed(2)}" aria-label="${esc(t('Price'))}" data-input="rv-item" data-n="${n}" data-k="cents">
        <select class="icat" aria-label="${esc(t('Category'))}" data-input="rv-item" data-n="${n}" data-k="category">${catOpts(i.category)}</select>
        <button class="icon-btn" data-act="rv-del" data-n="${n}" aria-label="${esc(t('Remove {0}', i.name || t('item')))}">${ICON.x}</button>
        ${i.flag && i.crop && current.thumb ? `<button class="rawbtn" style="grid-column:1/-1;width:100%" data-act="rv-crop" data-n="${n}" aria-label="${esc(t('Show this line on the receipt'))}"><canvas data-receipt-strip="${n}" style="width:100%;height:auto" role="img" aria-label="${esc(t('Receipt photo'))}"></canvas></button>` : ''}
        ${i.crop && current.thumb ? `<button class="raw rawbtn" data-act="rv-crop" data-n="${n}" aria-label="${esc(t('Show this line on the receipt'))}">${i.raw && i.raw !== i.name ? esc(i.raw) : ''} ${ICON.image}</button>` : i.raw && i.raw !== i.name ? `<small class="raw">${esc(i.raw)}</small>` : i.qty ? `<small class="raw">${esc(`${i.qty} × ${fmtRM(i.unit, { plain: true })}`)}</small>` : ''}</li>`).join('')}</ul>
      <div id="rv-gap">${gapLine}</div>
      <button class="btn ghost wide" data-act="rv-add">${ICON.plus}${esc(current.manual || (current.existing && !d.receiptId) ? t('Add an item') : t('Add a missing item'))}</button>
      <details class="typebox"${(current.manual && !d.items.length) || current.unread ? ' open' : ''}><summary>${esc(t('Type or paste several items'))}</summary>
        <label class="field"><span>${esc(t('One item per line with its price. Tally sorts each into a category; change any it gets wrong.'))}</span><textarea id="rv-lines" rows="4" placeholder="${esc(EXAMPLE[getLang()] || EXAMPLE.en)}">${esc(current.unread || '')}</textarea></label>
        <button class="btn ghost wide" data-act="rv-lines">${esc(t('Add these items'))}</button></details>
      ${d.items.length ? '' : `<label class="field"><span>${esc(t('Category'))}</span><select id="rv-cat" data-input="rv-f" data-k="category">${catOpts(d.category)}</select></label>`}
      ${on('reminders') ? remindHtml(d) : ''}
      ${current.manual ? '' : `<label class="check"><input type="checkbox" id="rv-refund" data-input="rv-refund"${d.refund ? ' checked' : ''}> ${esc(t('Refund: money back to this account'))}</label>`}
      <label class="check"><input type="checkbox" id="rv-learn" checked> ${esc(t('Remember my name and category changes for next time'))}</label>
      <div class="sticky rv-foot">${on('split') && !d.refund && !queue.length && !(current.existing && S.tx.find(x => x.id === d.id)?.split) ? `<button class="link rv-split" data-act="rv-save-split">${ICON.users}${esc(t('Save and split with friends'))}</button>` : ''}
        <div class="row2"><button class="btn ghost" data-act="rv-skip">${esc(current.existing ? t('Cancel') : t('Discard'))}</button><button class="btn" data-act="rv-save">${esc(flagged ? t('Save · {0} to check', flagged) : t('Save'))}</button></div></div>`;
  },
};

async function showStrips() {
  const receipt = current, canvases = [...document.querySelectorAll('[data-receipt-strip]')];
  if (!receipt?.thumb || !canvases.length) return;
  const img = new Image(); img.src = receipt.thumb; await img.decode().catch(() => {});
  if (current !== receipt || !img.naturalWidth) return;
  for (const c of canvases) {
    const item = receipt.draft.items[+c.dataset.receiptStrip]; if (!c.isConnected || !item?.crop) continue;
    const top = Math.max(0, item.crop.t), bottom = Math.min(1, item.crop.b);
    c.width = img.naturalWidth; c.height = Math.max(1, Math.round(img.naturalHeight * (bottom - top)));
    c.getContext('2d').drawImage(img, 0, top * img.naturalHeight, img.naturalWidth, c.height, 0, 0, c.width, c.height);
  }
}

async function fixCorners() {
  const epoch = reviewEpoch, generation = bookGeneration();
  const receipt = current; if (!receipt?.thumb || receipt.existing || reading) return;
  if (!(await confirmSheet({ title: t('Fix the receipt corners'), body: t('Reading again replaces changes you made to this receipt.'), ok: t('Continue') }))) return;
  if (!active(epoch, generation) || current !== receipt) return;
  const file = receipt.file || await getPhoto(receipt.draft.receiptId); if (!file) return;
  if (!active(epoch, generation) || current !== receipt) return;
  const url = URL.createObjectURL(file), image = new Image(); image.src = url;
  try { await image.decode(); } finally { URL.revokeObjectURL(url); }
  if (!active(epoch, generation) || current !== receipt) return;
  const canvas = document.createElement('canvas'), scale = Math.min(1, 900 / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
  canvas.style.cssText = 'width:100%;height:auto;touch-action:manipulation'; canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', t('Tap top left, top right, bottom right, then bottom left.'));
  let points = [], cursor = [0, 0];
  const sheet = openSheet(`<h2 class="sh-title">${esc(t('Fix the receipt corners'))}</h2><p>${esc(t('Tap top left, top right, bottom right, then bottom left.'))}</p><div class="corner-photo"></div><p class="fine" role="status" id="corner-count">0 / 4</p><p class="err" id="corner-error"></p><div class="row2"><button class="btn ghost" data-corner="reset">${esc(t('Reset'))}</button><button class="btn" data-corner="read" disabled>${esc(t('Read again'))}</button></div>`, { label: t('Fix the receipt corners'), stack: true });
  sheet.querySelector('.corner-photo').append(canvas);
  const paint = () => {
    const g = canvas.getContext('2d'); g.drawImage(image, 0, 0, canvas.width, canvas.height); g.strokeStyle = '#ffcc00'; g.fillStyle = '#ffcc00'; g.lineWidth = 3;
    if (points.length) { g.beginPath(); points.forEach(([x, y], n) => n ? g.lineTo(x * canvas.width, y * canvas.height) : g.moveTo(x * canvas.width, y * canvas.height)); if (points.length === 4) g.closePath(); g.stroke(); }
    points.forEach(([x, y], n) => { g.beginPath(); g.arc(x * canvas.width, y * canvas.height, 6, 0, Math.PI * 2); g.fill(); g.fillText(String(n + 1), x * canvas.width + 8, y * canvas.height + 12); });
    sheet.querySelector('#corner-count').textContent = `${points.length} / 4`; sheet.querySelector('[data-corner=read]').disabled = !validCorners(points);
  };
  const add = point => { if (points.length >= 4) return; points.push(point); paint(); if (points.length === 4 && !validCorners(points)) sheet.querySelector('#corner-error').textContent = t('Corners cross or are too close. Reset and try again.'); };
  canvas.addEventListener('click', e => { const b = canvas.getBoundingClientRect(); add([Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), Math.min(1, Math.max(0, (e.clientY - b.top) / b.height))]); });
  canvas.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(e.key)) return; e.preventDefault();
    if (e.key === 'Enter' || e.key === ' ') { add([...cursor]); cursor = [[0, 0], [1, 0], [1, 1], [0, 1]][points.length] || [0, 0]; }
    else { const n = /Left|Right/.test(e.key) ? 0 : 1; cursor[n] = Math.min(1, Math.max(0, cursor[n] + (/Right|Down/.test(e.key) ? 0.01 : -0.01))); }
  });
  sheet.addEventListener('click', async e => {
    const action = e.target.closest('[data-corner]')?.dataset.corner;
    if (action === 'reset') { points = []; cursor = [0, 0]; sheet.querySelector('#corner-error').textContent = ''; paint(); }
    if (action !== 'read' || !validCorners(points) || current !== receipt) return;
    const corners = points; closeSheet();
    cancelOcr(); for (const item of queue) { delete item.ahead; delete item.t0; delete item.stage; }
    rereadPrevious = { ...receipt, status: 'ready' };
    reading = true; current = { ...receipt, status: 'reading' }; refresh();
    let createdPhoto;
    try {
      const result = await readReceipt(file, s => { if (active(epoch, generation)) onStage(s); }, { corners });
      if (!active(epoch, generation)) return;
      const draft = toDraft(result.receipt); draft.accountId = receipt.draft.accountId;
      const oldPhoto = receipt.draft.receiptId;
      createdPhoto = draft.receiptId = uid('p');
      if (!(await savePhoto(draft.receiptId, result.photo, { generation }))) {
        if (oldPhoto) draft.receiptId = oldPhoto; else delete draft.receiptId;
      }
      if (!active(epoch, generation)) { await dropReviewPhotos([createdPhoto], generation); return; }
      await reviewKv('reviewDraft', { draft, existing: false }, epoch, generation);
      if (!active(epoch, generation)) { await dropReviewPhotos([createdPhoto], generation); return; }
      URL.revokeObjectURL(receipt.thumb); current = { ...receipt, status: 'ready', draft, thumb: URL.createObjectURL(result.photo) }; rereadPrevious = null;
      if (oldPhoto && oldPhoto !== draft.receiptId) await dropReviewPhotos([oldPhoto], generation);
    } catch (error) {
      if (active(epoch, generation)) { current = rereadPrevious || receipt; rereadPrevious = null; if (!error?.cancelled && error?.name !== 'AbortError') toast(t('Could not read this photo: {0}', error.message), { k: 'bad' }); }
      if (createdPhoto) await dropReviewPhotos([createdPhoto], generation);
    }
    finally { if (active(epoch, generation)) { reading = false; refresh(); } }
  });
  paint();
}

export const input = {
  'rv-remind': el => { const d = current?.draft; if (d) { d[el.dataset.k] = el.checked; persist(); } },
  'rv-pick': el => { const s = current.picked ||= new Set(), n = +el.dataset.n; if (el.checked) s.add(n); else s.delete(n); const c = $('.bulkbar .fine'); if (c) c.textContent = t('{0} selected', s.size); },
  'rv-refund': el => { const d = current?.draft; if (d) { d.refund = el.checked; if (el.checked) d.accountId = $('#rv-acc')?.value || d.accountId; persist(); } },
  'rv-sub': b => { const d = current?.draft; if (!d) return; d.sub = d.sub === b.dataset.s ? '' : b.dataset.s; persist(); render(); },   // tap again: none
  'rv-f': el => {
    const d = current?.draft; if (!d) return;
    const k = el.dataset.k;
    if (k === 'accountId' && el.value === '+') {   // paid by a card or wallet Tally doesn't have yet: add it, and it is picked
      el.value = d.accountId;
      document.addEventListener('tally:account-added', e => { if (current?.draft === d) { d.accountId = e.detail; persist(); refresh(); } }, { once: true });
      import('./setup.js').then(m => m.act['acc-edit']({ dataset: {} }));
      return;
    }
    persist();
    if (k === 'merchant' && current.manual) for (const i of d.items) if (!i.changed) i.category = categorize(i.name, el.value, S.kv.rules);
    if (k === 'total') { const v = calcAmount(el.value); d.total = v != null && v > 0 ? v : null; d.totalGuessed = false; el.setAttribute('aria-invalid', String(!!el.value.trim() && d.total == null)); updateStatus(); return; }
    d[k] = el.value;
    if (k === 'date') d.dateFound = true;
    if (k === 'accountId') refresh();   // the total's currency and the receipt-vs-account note follow the account
  },
  'rv-item': el => {
    const i = current?.draft?.items[+el.dataset.n]; if (!i) return;
    persist();
    if (el.dataset.k === 'cents') { const v = calcAmount(el.value); el.classList.toggle('bad', v == null); el.setAttribute('aria-invalid', String(v == null)); if (v != null) { i.cents = v; i.priceFlag = false; if (i.qty) i.unit = Math.round(v / i.qty); if (!i.nameFlag) unflag(i, el); } updateStatus(); }
    else if (el.dataset.k === 'category') { i.category = el.value; i.changed = true; }
    else {
      i.name = el.value.slice(0, 80); i.nameFlag = !i.name.trim(); if (!i.priceFlag && !i.nameFlag) unflag(i, el);
      // Sorted as it is typed ("Phone" → Electronics, "Ikan" → Groceries) until the user picks a category themselves.
      if (!i.changed) { i.category = guessFor(i.name, current.draft); const sel = el.closest('li')?.querySelector('.icat'); if (sel) sel.value = i.category; }
    }
  },
};
/** A line the user has fixed is no longer amber, and the "to check" counts go down with it. */
function unflag(i, el) {
  if (!i.flag) return;
  i.flag = false; el.closest('li')?.classList.remove('flag');
  const tmp = document.createElement('div'); tmp.innerHTML = reviewView.render();
  for (const sel of ['main h2 .fine', '[data-act="rv-save"]']) { const a = document.querySelector(sel), b = tmp.querySelector(sel.replace('main ', '')); if (a && b) a.textContent = b.textContent; }
}
function updateStatus() { // re-render only the status line (and the not-itemised line) so typing keeps focus
  const box = $('#rv-status'); if (!box) return;
  const tmp = document.createElement('div'); tmp.innerHTML = reviewView.render();
  box.innerHTML = tmp.querySelector('#rv-status').innerHTML;
  const gap = $('#rv-gap'); if (gap) gap.innerHTML = tmp.querySelector('#rv-gap')?.innerHTML || '';
}

const mostSpent = items => { const by = {}; for (const i of items) by[i.category] = (by[i.category] || 0) + i.cents; return Object.entries(by).sort((a, b) => b[1] - a[1])[0][0]; };
/** How to take a photo Tally reads well: small looping scenes, a few words each. Shown before the first scan, and from the scan screens. */
const paper = (x, y, w, h) => {
  let rows = ''; for (let r = y + 14; r < y + h - 11; r += 7) rows += `M${x + 5} ${r}h${Math.round(w * .5)}M${x + w - 11} ${r}h6`;
  return `<g class="tp-r"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2"/><path class="tp-ink" d="M${x + w / 2 - 8} ${y + 7}h16M${x + 5} ${y + h - 6}h${w - 10}"/><path d="${rows}"/></g>`;
};
const frame = '<path class="tp-frame" d="M38 14V6h8M74 6h8v8M82 66v8h-8M46 74h-8v-8"/>';
const TIP_ART = [
  `${paper(46, 10, 28, 60)}<g class="tp-snug">${frame}</g>`,
  `${paper(46, 10, 28, 60)}<ellipse class="tp-shadow" cx="68" cy="44" rx="22" ry="28"/><g class="tp-sun"><circle cx="18" cy="18" r="6"/><path d="M18 4v4M18 28v4M4 18h4M28 18h4M8 8l3 3M25 25l3 3M8 28l3-3M25 11l3-3"/></g>`,
  `${paper(46, 12, 28, 56)}<g class="tp-phone"><rect x="36" y="4" width="48" height="72" rx="7"/></g><rect class="tp-focus" x="52" y="32" width="16" height="16" rx="2"/>`,
  `<rect class="tp-table" width="120" height="80"/>${paper(46, 10, 28, 60)}<rect class="tp-edge" x="43" y="7" width="34" height="66" rx="3" pathLength="100"/>`,
  `<g class="tp-long">${paper(46, -30, 28, 140)}</g>${frame}`,
  `<g class="tp-fade">${paper(46, 10, 28, 60)}</g><g class="tp-clock"><circle cx="98" cy="18" r="9"/><path class="tp-hand" d="M98 18v-6"/></g>`,
];
// ✗ while a scene shows the mistake, ✓ once it reaches the good state (in time with it); "scan it soon" runs the other
// way, fresh to faded. Without motion only the ✓ shows.
const MARK_T = [[2.8], [3], [3], [3], [3], [3.6, true]];
const mark = ([s, rev]) => `<g class="tp-mark${rev ? ' rev' : ''}" style="--d:${s}s"><circle cx="106" cy="66" r="9"/><path class="tp-no" d="M102.5 62.5l7 7M109.5 62.5l-7 7"/><path class="tp-ok" d="M102 66.5l3 3 5.5-6.5"/></g>`;
/** The last day to return it, and the day the warranty ends, from the receipt's date and what it prints. */
const returnDate = d => addDays(d.date, d.returnDays);
const warrantyDate = d => { const ym = addMonths(d.date.slice(0, 7), d.warrantyMonths); return `${ym}-${String(Math.min(+d.date.slice(8, 10), daysInMonth(ym))).padStart(2, '0')}`; };   // 31 Aug + 6 months → 28 Feb, not 3 Mar
/** "Refund within 3 days", "1 year warranty" on the slip: a reminder, only if asked for (a grocery slip's window is noise). */
const remindHtml = d => [d.returnDays && ['ret', 'remindReturn', t('Remind me before the return window ends ({0})', fmtDate(returnDate(d)))],
  d.warrantyMonths && ['war', 'remindWarranty', t('Remind me before the warranty ends ({0})', fmtDate(warrantyDate(d), { year: true }))]]
  .filter(Boolean).map(([k, f, label]) => `<label class="check"><input type="checkbox" data-input="rv-remind" data-k="${f}"${d[f] ? ' checked' : ''}> ${esc(label)}</label>`).join('');
/** The purchase a refund slip is for: the latest spend at the same shop in the 120 days before, at least as big. */
function refundTarget(d) {
  const shop = (d.merchant || '').trim().toLowerCase(), from = addDays(d.date, -120);
  return shop ? S.tx.filter(x => x.type === 'expense' && (x.merchant || '').trim().toLowerCase() === shop && x.date >= from && x.date <= d.date && x.amount >= d.total)
    .sort((a, b) => b.date.localeCompare(a.date))[0]?.id : undefined;
}
export function photoTips({ thenScan = false } = {}) {
  const tips = [
    [t('Fit it all in'), t('Shop name to TOTAL, flat')],
    [t('Bright, no shadow'), t('No flash on shiny paper')],
    [t('Hold still'), t('Straight above, tap to focus')],
    [t('Dark background'), t('Pale receipt, dark table')],
    [t('Long receipt?'), t('Step back until it fits')],
    [t('Scan it soon'), t('Receipts fade in weeks')],
  ];
  // Title with a close button and the action stay pinned while the scenes scroll between them (small phones).
  const el = openSheet(`<div class="sheethead"><h2 class="sh-title">${esc(t('Tips for a clear photo'))}</h2><button class="icon-btn" data-x="ok" aria-label="${esc(t('Close'))}">${ICON.x}</button></div>
    <ol class="tips">${tips.map(([h, b], i) => `<li><svg viewBox="0 0 120 80" aria-hidden="true"><rect class="tp-bg" width="120" height="80"/>${TIP_ART[i]}${mark(MARK_T[i])}</svg><b>${esc(h)}</b><span>${esc(b)}</span></li>`).join('')}</ol>
    <div class="sheetfoot">${thenScan ? `<p class="fine">${ICON.lock}${esc(t('The camera opens only on this screen. Photos are read on this phone and never uploaded.'))}</p>
      <button class="btn wide" data-x="scan">${ICON.camera}${esc(t('Take a photo'))}</button>
      <div class="row2"><button class="btn ghost" data-x="pick">${ICON.image}${esc(t('From gallery'))}</button><button class="btn ghost" data-x="type">${ICON.plus}${esc(t('No receipt? Type it'))}</button></div>` : `<button class="btn wide" data-x="ok">${esc(t('Got it'))}</button>`}</div>`, { label: t('Tips for a clear photo') });
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x === 'scan') startScan(scanned);
    else if (b.dataset.x === 'pick') { closeSheet(); document.getElementById('scan-input')?.click(); }   // no camera needed
    else if (b.dataset.x === 'type') { closeSheet(); import('./money.js').then(m => m.openTxSheet()); }   // cash, pasar, no receipt
    else closeSheet();
  });
}
/** Typed lines ("Fish 25, vegetables 8") → items on the receipt being checked. Returns how many. */
/** Typed item lines into the draft ("Eggs 2x6.20"); lines Tally could not read stay in the box to fix. */
function addLines(text) {
  const d = current.draft, { items: lines, skipped } = parseItemLines(text);
  for (const { name, ...price } of lines) d.items.push({ name, raw: '', ...price, category: guessFor(name, d), flag: false });
  if (lines.length && current.manual) { d.total = itemsSum(d); d.totalGuessed = false; }
  current.unread = skipped.join('\n');
  return { n: lines.length, skipped };
}
export const act = {
  'rv-cancel-one': () => cancelReading(false),
  'rv-cancel-all': () => cancelReading(true),
  'rv-flatten': fixCorners,
  'rv-readq': () => { pump(); render(); },
  'photo-tips': () => photoTips(),
  // Retake: this reading is let go (it can't be fixed by typing), and the camera opens for a new photo of the same receipt.
  'rv-retake': async () => {
    const d = current?.draft;
    if (d?.receiptId && !current.existing && !S.tx.some(x => x.receiptId === d.receiptId)) await deletePhotos([d.receiptId]);
    await finish(); render();
    startScan(scanned);
  },
  'rv-skip': async () => {
    const d = current?.draft;
    if (d?.receiptId && !current.existing && !S.tx.some(x => x.receiptId === d.receiptId)) await deletePhotos([d.receiptId]);   // a discarded scan leaves no photo behind
    if (current?.status === 'error') await deletePhotos([`q_${current.id}`]);   // the unreadable photo, now that the user let it go
    await finish();
    if (queue.length) pump(); else go('home');
  },
  'rv-retry': async () => {   // the photo was kept: read it again (the reader may have been offline)
    const file = await getPhoto(`q_${current.id}`); if (!file) return toast(t('That photo is no longer on this phone.'), { k: 'warn' });
    queue.unshift({ id: current.id, file, status: 'waiting' }); current = null; pump();
  },
  'rv-zoom': b => { const open = b.closest('figure').classList.toggle('zoom'); b.setAttribute('aria-expanded', open); },
  'rv-today': () => { current.draft.date = today(); current.draft.dateFound = true; persist(); render(); },
  'rv-lines': () => {
    const { n, skipped } = addLines($('#rv-lines').value);
    if (!n) return toast(t('Write each item with its price, like "Phone 1299".'), { k: 'warn' });
    persist(); render();
    if (skipped.length) toast(t('Added {0}. Could not read: {1}. Add a price, like "Phone 1299".', n === 1 ? t('1 item') : t('{0} items', n), skipped.join(', ')), { k: 'warn' });
    else toast(n === 1 ? t('Added 1 item') : t('Added {0} items', n), { k: 'good', icon: 'check' });
  },
  // The line on the photo an item was read from, with a line above and below for context.
  'rv-crop': async b => {
    const i = current.draft.items[+b.dataset.n]; if (!i?.crop || !current.thumb) return;
    const img = new Image(); img.src = current.thumb; await img.decode().catch(() => {});
    const pad = (i.crop.b - i.crop.t) * 1.2, top = Math.max(0, i.crop.t - pad), h = Math.min(1, i.crop.b + pad) - top;
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = Math.max(1, Math.round(img.naturalHeight * h));
    c.getContext('2d').drawImage(img, 0, top * img.naturalHeight, img.naturalWidth, c.height, 0, 0, c.width, c.height);
    const el = openSheet(`<h2 class="sh-title">${esc(i.name || i.raw)}</h2><p class="fine mono">${esc(i.raw || '')}</p><div class="cropview"></div><label class="field"><span>${esc(t('Item name'))}</span><input class="crop-name" maxlength="80" value="${esc(i.name)}"></label><label class="field"><span>${esc(t('Price'))}</span><input class="crop-price" inputmode="decimal" value="${(i.cents / 100).toFixed(2)}"></label><p class="err crop-error" id="crop-err" role="alert"></p><button class="btn wide" data-fix-line>${esc(t('Save'))}</button>`, { label: t('Show this line on the receipt'), stack: true });
    c.setAttribute('role', 'img'); c.setAttribute('aria-label', t('Receipt photo')); el.querySelector('.cropview').append(c);
    el.querySelector('[data-fix-line]').addEventListener('click', () => {
      const value = calcAmount(el.querySelector('.crop-price').value), name = el.querySelector('.crop-name').value.trim();
      if (value == null || !name) { el.querySelector('.crop-error').textContent = t('Check the name and price.'); return; }
      i.name = name; i.cents = value; i.priceFlag = false; i.nameFlag = false; i.flag = false; if (!i.changed) i.category = guessFor(name, current.draft);
      if (i.qty) i.unit = Math.round(value / i.qty); closeSheet(); persist(); refresh();
    });
  },
  'rv-gapitem': () => { const d = current.draft; d.items.push({ name: '', raw: '', cents: gapOf(d), category: gapCat(d), flag: true }); persist(); render(); $$('.iname').at(-1)?.focus(); },   // the gap as an item: only its name to type
  // Many items at once (a 40-line grocery receipt): tick them, pick one category.
  'rv-select': () => { current.selecting = !current.selecting; current.picked = new Set(); render(); },
  'rv-bulkcat': () => { const c = $('#rv-bulkcat')?.value, d = current.draft; if (!c || !current.picked?.size) return; for (const n of current.picked) if (d.items[n]) { d.items[n].category = c; d.items[n].changed = true; } current.selecting = false; persist(); render(); toast(t('Category set for {0} items', current.picked.size), { icon: 'check' }); },
  'rv-add': () => { current.draft.items.push({ name: '', raw: '', cents: 0, category: current.draft.category, flag: true }); persist(); render(); $$('.iname').at(-1)?.focus(); },
  'rv-del': b => { current.draft.items.splice(+b.dataset.n, 1); persist(); render(); },
  // Save and split: the same save, then the split sheet on the saved receipt with its items ready to tap.
  'rv-save-split': b => act['rv-save'](b, 'split'),
  'rv-save': async (b, how) => {   // how: 'split' from Save and split (actions also get the click event)
    const epoch = reviewEpoch, generation = bookGeneration();
    const split = how === 'split';
    if (!current?.draft) return;
    const d = current.draft;
    if (d.notReceipt) return toast(t('This does not look like a receipt. Nothing has been saved.'), { k: 'warn' });
    if (current.manual && d.items.length) d.total = itemsSum(d);
    if (!d.total || d.total <= 0) { toast(t('Type the total from the receipt first.'), { k: 'warn' }); $('#rv-total')?.focus(); return; }
    if (!validIso(d.date)) { toast(t('Pick a date.'), { k: 'warn' }); return; }
    if (d.totalGuessed && !(await confirmSheet({ title: t('Is {0} the total?', fmtRM(d.total)), body: t('Tally guessed this total. Check it against the receipt.'), ok: t('Yes, save') }))) { $('#rv-total')?.focus(); return; }
    if (!d.dateFound && !(await confirmSheet({ title: t('Use today as the date?'), body: t('No date was found on the receipt.'), ok: t('Yes, save') }))) { $('#rv-date')?.focus(); return; }
    const gap = !current.manual && d.items.length && !check(d).ok ? gapOf(d) : 0;   // more on the receipt than the items: its own line
    if (gap < 0 && !(await confirmSheet({ title: t('Items do not add up'), body: t('The difference is spread across the items by size, so your categories stay close. Save anyway?'), ok: t('Save anyway') }))) return;
    b.disabled = true;
    if (!active(epoch, generation)) return;
    const learnIt = $('#rv-learn')?.checked;
    const items = d.items.filter(i => i.name || i.cents).map(({ name, raw, cents, category, qty, unit }) => ({ name: name || raw || t('Item'), raw, cents, category, ...(qty ? { qty, unit } : {}) }));
    if (gap > 0) items.push({ name: t('Not itemised'), raw: '', cents: gap, category: gapCat(d) });
    // Editing an entry keeps what the review doesn't show: who added it (a spouse's stays theirs), its bill, its source.
    const was = current.existing ? current.base || {} : {};
    const spentOn = items.length ? mostSpent(items) : d.category;   // a refund lowers spending there instead
    const tx = { ...was, id: d.id, date: d.date, time: d.time, type: d.refund ? 'income' : 'expense', amount: d.total, accountId: d.accountId, merchant: (d.merchant || '').trim(), note: d.note || '',
      category: d.refund ? 'refund' : spentOn, ...(d.refund ? { cat: spentOn, refundOf: d.refundOf || refundTarget(d) } : { cat: undefined }), ...(d.remindReturn && d.returnDays ? { returnBy: returnDate(d) } : {}), ...(d.remindWarranty && d.warrantyMonths ? { warranty: warrantyDate(d) } : {}), items, tax: d.tax || 0, service: d.service || 0, rounding: d.rounding || 0, source: was.source || 'receipt', createdAt: d.createdAt || Date.now(), ...(d.receiptId ? { receiptId: d.receiptId } : {}) };
    if (on('subcats') && !d.refund) { if (d.sub) tx.sub = d.sub; else delete tx.sub; }   // off: an edit keeps what it had
    if (current.existing && !current.base) { b.disabled = false; return toast(t('The entry changed on your phone. Refresh and try again.') + ' ' + t('Close this form and reopen the entry before saving.'), { k: 'warn' }); }
    try { await saveTx(tx, { expected: current.existing ? current.base : null }); }
    catch (error) {
      if (error?.code !== 'STALE') throw error;
      b.disabled = false;
      return toast(t('The entry changed on your phone. Refresh and try again.') + ' ' + t('Close this form and reopen the entry before saving.'), { k: 'warn' });
    }
    if (!active(epoch, generation)) return;
    { const L = on('subcats') && learnSub(S.kv.subRules, tx); if (L) await setKv('subRules', L); }   // this shop's subcategory, next time
    // Guarded save committed any typed opening adjustment with the row.
    clearTimeout(persistT); await setKv('reviewDraft', null);   // saved: nothing to resume, even if the tab dies now
    if (learnIt && d.readName && tx.merchant && tx.merchant !== d.readName && itemKey(d.readName))   // remember the name they gave this shop
      await setKv('shopNames', Object.fromEntries([...Object.entries(S.kv.shopNames || {}), [itemKey(d.readName), tx.merchant.slice(0, 80)]].slice(-500)));
    const names = learnIt && learnNames(S.kv.itemNames, d.items);   // and the names they gave items the reader got wrong
    if (names) await setKv('itemNames', names);
    if (learnIt) for (const i of d.items.filter(x => x.changed)) await learn(i.name || i.raw, i.category);
    landed(tx.id);
    const first = !current.existing && firstWord(tx.receiptId ? 'receipt' : 'entry');
    toast(first || (tx.date.slice(0, 7) === today().slice(0, 7) ? t('Saved {0} at {1}', fmtAcct(S.accounts.find(a => a.id === tx.accountId), tx.amount), tx.merchant || accName(tx.accountId)) : t('Saved {0} under {1}', fmtAcct(S.accounts.find(a => a.id === tx.accountId), tx.amount), fmtMonth(tx.date.slice(0, 7)))), { icon: 'check', ...(first ? { k: 'good', cheer: true } : {}) });
    await finish();
    if (split) {   // Home first (going back through history closes sheets as it lands), then the split on top of it
      go('home');
      for (let i = 0; i < 40 && !/^#\/home$|^$/.test(location.hash); i++) await new Promise(r => setTimeout(r, 50));
      await new Promise(r => setTimeout(r, 150));
      const saved = S.tx.find(x => x.id === tx.id); if (saved) (await import('./splitbill.js')).openSplit(saved);
      return;
    }
    if (queue.length) { pump(); render(); } else go('home');
  },
};
