// Home (balance, month, one banner, recent) and Insights (charts, habits, the insight feed).
import { S, today, nowLocal, nowTime, settings, setKv, setSetting, cat, booked, scopedAccounts, budgetsFor, inScope, startDay, thisMonth, cached, OLD_HOME, NEW_HOME, wipeSite, saveTx, keepToday, uid, defaultAccount, putAll } from '../state.js';
import { t, fmtDate, fmtMonth, monShort, cycleShort, getLang } from '../i18n.js';
import { esc, ICON, MASK, balHidden, eyeBtn, lineChart, pairBars, donut, openSheet, toast, countUp, replay, landing, $, confirmSheet, closeSheet, landed } from '../ui.js';
import { firstSpend, fmtRM, balances, monthOf, monthSpend, monthSpends, monthIncomes, addMonths, pace, cashFlow, balanceTrend, insights, habits, dueNudge, daysBetween, itemKey, cycleKey, cycleSpan, billStatus, newest, fmtAcct, offTotal, isFx, rateOf, belowSince, CATEGORIES, affordCheck, topCats, calcAmount, recurringCandidates, owing, openShares, validIso, affordMoney } from '../engine.js';
import { habitEvent, ics, googleUrl, safeId } from '../calendar.js';
import { download, okMs } from '../io.js';
import { render, go } from '../app.js';
import { txRow, catLabel, dot, openTxSheet, scopeSwitch, scopeChip, accName } from './money.js';
import { learnHome, streakHome } from './learn.js';
import { byUser } from '../learn.js';
import { dayOf, loggedDays } from '../gamify.js';
import { filledDays, panelOf, loadBook, bookState, WHO, frame, pastMonths } from '../comic.js';
import { on, setModules } from '../features.js';
import { ring, weekRecap, niceFinds, pickFind } from '../delight.js';
import { analyticsCards, forecastCard, tilesHtml, affordInputs, subHint, act as analyticsAct } from './analytics.js';
import { goalsCard, act as goalsAct } from './goals.js';
import { shareSheet, monthName } from '../share.js';
import { stickerCanvas, encode, fileName, canSave, wordOf } from '../sticker-export.js';

/** Fill an insight template: [English, ...values] where a value may be {cat}, {raw}, {date} or {list}. */
export function fill([tpl, ...vals]) {
  return t(tpl, ...vals.map(v => {
    if (v && typeof v === 'object') {
      if ('cat' in v) return v.cat === 'total' ? t('Monthly budget') : catLabel(v.cat);
      if ('raw' in v) return v.raw;
      if ('date' in v) return fmtDate(v.date);
      if ('list' in v) return v.list.map(([c, a]) => `${catLabel(c.cat)} ${a}`).join(', ');
    }
    return v;
  }));
}
/** One insight in the feed (a bill suggestion has Add). */
const feedItem = i => `<li class="banner ${i.level}">${i.level === 'warn' ? ICON.alert : i.kind === 'recurring' ? ICON.bell : ICON.chart}<span class="grow"><b>${esc(fill(i.title))}</b><small>${esc(fill(i.body))}</small></span>
        ${i.rec ? `<button class="btn small" data-act="go" data-to="budgets">${esc(t('Add'))}</button>` : ''}${i.cat && i.cat !== 'total' ? `<button class="btn small ghost" data-act="cat-show" data-c="${esc(i.cat)}">${esc(t('See'))}</button>` : ''}<button class="icon-btn" data-act="dismiss" data-id="${esc(i.id)}" aria-label="${esc(t('Dismiss'))}">${ICON.x}</button></li>`;
const habitText = h => t(h.days === 'weekend' ? '{0} on weekends around {1}' : '{0} on weekdays around {1}', catLabel(h.category), h.at);
const dismissed = () => S.kv.dismissed || [];
/** Home cards can be turned off in Settings (settings.homeHide: 'gap', 'nudge', 'bills', 'insight'). */
const MODULE_OF = { bills: 'bills', insight: 'insights', nudge: 'insights', stickers: 'stickers' };
const shown = id => !(settings().homeHide || []).includes(id) && (!MODULE_OF[id] || on(MODULE_OF[id]));
/** Days logged up to today (entries you made, and "nothing spent" check-ins): one sticker each. */
/** At the old address: Tally has moved; three steps, in order. Not dismissable: the data is safer at the new one. */
const movedCard = () => `<section class="card moved"><h2>${esc(t('Tally has moved to tallymy.github.io'))}</h2>
  <p>${esc(t('This old address shares its site with another app, so your data is safer at the new one. Move it in three steps:'))}</p>
  <ol><li><button class="btn small" data-act="backup">${esc(t('1. Back up here'))}</button></li>
  <li><a class="btn small ghost" href="${NEW_HOME}" target="_blank" rel="noopener">${esc(t('2. Open the new address and restore the backup'))}</a></li>
  <li><button class="btn small ghost danger" data-act="old-erase">${esc(t("3. Erase Tally's data here"))}</button></li></ol></section>`;
/** The answer and the sums behind it: the lowest day first (the verdict is on it), and how each sum was worked out. */
function affordHtml(r) {
  const head = { yes: [t('Yes, you can.'), 'af-yes'], tight: [t('You can, but it will be tight.'), 'af-tight'], no: [t('Not yet.'), 'af-no'] }[r.verdict];
  const amt = v => `${v < 0 ? '−' : ''}${esc(fmtRM(Math.abs(v)))}`, p = r.pace, list = xs => xs.map(x => `${x.name} ${fmtRM(x.amount)}`).join(', ');
  // A row; with `more`, it opens to show what it is made of.
  const row = (l, v, sub = '', more = '') => { const cells = `<span class="grow">${esc(l)}${sub ? `<small>${esc(sub)}</small>` : ''}</span><span class="num">${amt(v)}</span>`; return more ? `<li class="af-more"><details><summary>${cells}</summary>${more}</details></li>` : `<li>${cells}</li>`; };
  const legend = xs => `<ul class="slegend">${xs.map(([l, v]) => `<li><span class="grow">${esc(l)}</span><span class="num">${esc(fmtRM(v))}</span></li>`).join('')}</ul>`;
  const perDay = !p.days ? '' : p.days === 1 ? t("{0} a day, from today's entries", fmtRM(r.rate)) : t('{0} a day, from your last {1} days of entries', fmtRM(r.rate), p.days);
  // What was actually spent in the window (the headline is that at the same pace over 30 days).
  const spendMore = (p.cats.length ? `<p class="fine">${esc(p.days === 1 ? t('What you spent today') : t('What you spent in those {0} days', p.days))}</p>${legend(topCats(p.cats).map(c => [catLabel(c.category), c.amount]))}` : '')
    + (p.bills.length ? `<p class="fine">${esc(t('Bills, counted on their own: {0}', list(p.bills)))}</p>` : '')
    + (p.oneOffs.length ? `<p class="fine">${esc(t('Big one-off buys, not counted as usual: {0}', list(p.oneOffs)))}</p>` : '');
  const rows = [row(t('Money now'), r.balance), r.pay && row(t('Pay due {0}', fmtDate(r.payDate)), r.pay), r.earn && row(t('Usual income (your lowest month lately)'), r.earn),
    row(t('Bills due'), -r.upcoming, '', r.dues.length ? legend(r.dues.map(d => [`${d.name} · ${fmtDate(d.date)}`, d.amount])) : ''),
    row(t('Usual everyday spending'), -r.usual, perDay, spendMore), row(t('This buy'), -r.price)].filter(Boolean);
  const why = r.left >= 0 ? t('{0} left over the next 30 days, after this, your bills and your usual spending.', fmtRM(r.left)) : t('You would be {0} short over the next 30 days.', fmtRM(-r.left));
  // The verdict is on the lowest day: money that runs out before payday is short even if pay refills it. So it leads.
  const eve = r.pay && r.low.date === addDaysIso(r.payDate, -1), d = fmtDate(r.low.date);
  const low = r.low.bal < 0 ? (eve ? t('You may run short around {0}, the day before pay.', d) : t('You may run short around {0}.', d)) : eve ? t('Lowest: {0} on {1}, the day before pay', fmtRM(r.low.bal), d) : t('Lowest: {0} on {1}', fmtRM(r.low.bal), d);
  const lines = r.low.bal < r.left ? [low, r.pay && r.left >= 0 ? t('After pay, in 30 days: {0}', fmtRM(r.left)) : why] : [why];
  const save = r.verdict !== 'no' ? '' : r.months ? (r.months === 1 ? t('At your usual saving ({0} a month), you could buy it next month.', fmtRM(r.net)) : t('At your usual saving ({0} a month), you could buy it in {1} months.', fmtRM(r.net), r.months))
    : t('You usually spend what you earn, so saving for it means spending less first.');
  // Too little spending typed to trust: said before the answer, not after it.
  const thin = !r.thin ? '' : `<p class="warnbox">${ICON.alert}<span>${esc(r.early ? t('Only {0} days of spending are in so far, so some may be missing and this may look better than it is.', r.days) : t('The spending typed in looks low next to your pay, so some may be missing and this may look better than it is.'))}</span></p>`;
  return `${thin}<div class="afford ${head[1]}"><b>${esc(head[0])}</b>${lines.map(l => `<p>${esc(l)}</p>`).join('')}${r.over ? `<p>${esc(t("It takes you {0} over this month's budget.", fmtRM(r.over)))}</p>` : ''}${save ? `<p>${esc(save)}</p>` : ''}</div>
    <ul class="slegend af-rows">${rows.join('')}<li><b class="grow">${esc(t('Left'))}</b><b class="num">${amt(r.left)}</b></li></ul>
    ${r.savings ? `<p class="fine">${esc(t('Savings, not counted: {0}', balHidden() ? MASK : fmtRM(r.savings)))}</p>` : ''}
    <p class="fine">${esc(t('From your balance today, your bills (the ones you added and the ones Tally spotted) and your usual everyday spending. Big one-off buys are not counted as usual.'))} ${esc(t('A guide from your own entries, not financial advice.'))}</p>`;
}
/** When this person started with Tally: their first entry made here, else their first account. */
// A loop, not Math.min(...all): spreading 125k+ values throws. okMs: a bad time stored before the intake check.
const began = () => { const least = list => list.reduce((m, x) => { const v = okMs(x.createdAt); return v && v < m ? v : m; }, Infinity), m = least(S.tx); return m < Infinity ? m : least(S.accounts); };
// This month's sticker book (comic.js): loaded once, then drawn from memory; Home redraws when it arrives.
const books = new Map();
const bookOf = ym => { if (!books.has(ym)) { books.set(ym, null); loadBook(ym).then(b => { books.set(ym, b); render(); }).catch(console.error); } return books.get(ym); };
const filledIn = ym => filledDays({ tx: S.tx, noSpend: settings().noSpend || [], me: settings().myName || '', ym, today: today() });
const say = o => (typeof o === 'string' ? t(o) : o?.[getLang()] ?? o?.en ?? '');   // a book's own words, in the app's language
const stkSvg = (s, on = true, cls = 'stk') => `<svg class="${cls}${on ? '' : ' off'}" viewBox="0 0 64 64" aria-hidden="true">${s.svg}</svg>`;
/** The way to an earned sticker's Save sheet: an icon button (today's card) or the sticker itself (the book). */
const stkSaveBtn = (ym, day, cls, inner, name) => `<button class="${cls}" data-act="sticker-sheet" data-ym="${ym}" data-day="${day}" aria-label="${esc(name ? `${name} · ${t('Save sticker')}` : t('Save sticker'))}">${inner}</button>`;
let stkUrl = null;   // the open sticker sheet's picture, for the how-to's frames
/** One sticker as a WhatsApp-ready file (sticker-export.js): the picture as it will be saved, on the chat colour of the
 *  app's theme, [Save sticker], and "?" for how WhatsApp's own Create sticker adds it (a web app can't add stickers).
 *  Only for earned stickers checked for saving (book data share: true). The how-to opens by itself after the first save. */
async function stickerSheet(b) {
  const ym = b.dataset.ym, day = +b.dataset.day, book = bookOf(ym) || await loadBook(ym), filled = filledIn(ym);
  const s = book.stickers[panelOf(day, bookState({ ym, filled, today: today() }).n)];
  if (!filled.has(day) || !canSave(s)) return;
  let url = null;
  const el = openSheet(`<div class="sheethead"><h2 class="sh-title">${esc(say(s.name))}</h2><button class="icon-btn" data-act="sheet-close" aria-label="${esc(t('Close'))}">${ICON.x}</button></div>
    <div class="stk-swatch">${stkSvg(s, true, 'stk-prev')}</div>
    <div class="stk-row"><button class="btn wide busy" data-x="save" disabled>${ICON.download}${esc(t('Save sticker'))}</button><button class="icon-btn stk-help" data-act="sticker-howto" aria-label="${esc(t('How to add it to WhatsApp'))}">?</button></div>`,
  { label: say(s.name), stack: !!b.closest('.sheet'), onClose: () => { if (url) URL.revokeObjectURL(url); if (stkUrl === url) stkUrl = null; } });
  if (!el) return;
  const go = el.querySelector('[data-x="save"]');
  try {
    const blob = await encode((await stickerCanvas(s, wordOf(book.id, s.id))).c), file = new File([blob], fileName(blob.type), { type: blob.type });
    stkUrl = url = URL.createObjectURL(blob);
    el.querySelector('.stk-swatch').innerHTML = `<img class="stk-prev" src="${url}" alt="${esc(say(s.name))}">`;
    go.disabled = false; go.classList.remove('busy');
    go.addEventListener('click', async () => {
      download(file.name, file, file.type); toast(t('Sticker saved.'), { k: 'good', icon: 'check' });
      if (!settings().stickerHowto) { await setSetting('stickerHowto', true); howTo(url); }
    });
  } catch (e) { console.error(e); toast(t('The sticker could not be made. Try again.')); }
}
/** How the saved file becomes a WhatsApp sticker, in three drawn frames (a generic phone, never WhatsApp's own look):
 *  saved → open the sticker tray and tap Create → pick it. Moving frames loop; still with reduced motion. */
function howTo(url) {
  const stk = (x, y, s, cls = '') => url ? `<image class="${cls}" href="${url}" x="${x}" y="${y}" width="${s}" height="${s}"/>` : `<rect class="${cls}" x="${x + 3}" y="${y + 3}" width="${s - 6}" height="${s - 6}" rx="6" fill="var(--accent)"/>`;
  const phone = inner => `<svg viewBox="0 0 100 150" aria-hidden="true"><rect x="8" y="4" width="84" height="142" rx="12" fill="var(--panel2)" stroke="var(--line)" stroke-width="2"/>${inner}</svg>`;
  const tiles = (skip = -1) => [0, 1, 2, 3, 4, 5].filter(i => i !== skip).map(i => `<rect x="${18 + (i % 3) * 22}" y="${40 + Math.floor(i / 3) * 22}" width="18" height="18" rx="3" fill="var(--line)"/>`).join('');
  const frames = [
    [phone(`${tiles(0)}<rect x="18" y="40" width="18" height="18" rx="3" fill="var(--line)"/>${stk(16, 38, 22, 'drop')}`), t('Sticker saved.')],
    [phone(`<rect x="16" y="20" width="44" height="12" rx="6" fill="var(--line)"/><rect x="40" y="38" width="44" height="12" rx="6" fill="var(--line)"/>
      <rect x="14" y="70" width="72" height="50" rx="6" fill="var(--panel)"/>${[0, 1].map(i => `<rect x="${20 + i * 22}" y="78" width="18" height="18" rx="3" fill="var(--line)"/>`).join('')}
      <g class="pulse"><rect x="64" y="78" width="18" height="18" rx="3" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="3 2"/><path d="M73 82v10M68 87h10" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round"/></g>
      <rect x="14" y="126" width="72" height="12" rx="6" fill="var(--panel)"/><rect class="pulse" x="70" y="128" width="8" height="8" rx="2" fill="none" stroke="var(--accent)" stroke-width="1.6"/>`), t('In WhatsApp: stickers, then Create')],
    [phone(`${tiles(4)}${stk(38, 60, 22)}<circle class="pulse" cx="49" cy="71" r="14" fill="none" stroke="var(--accent)" stroke-width="2"/><circle class="tap" cx="58" cy="80" r="5" fill="var(--ink)" opacity=".5"/>`), t('Pick the saved sticker')],
  ];
  openSheet(`<div class="sheethead"><h2 class="sh-title">${esc(t('How to add it to WhatsApp'))}</h2><button class="icon-btn" data-act="sheet-close" aria-label="${esc(t('Close'))}">${ICON.x}</button></div>
    <ol class="howto">${frames.map(([svg, cap], i) => `<li><span class="howto-n" aria-hidden="true">${i + 1}</span>${svg}<span>${esc(cap)}</span></li>`).join('')}</ol>
    <p class="fine" style="text-align:center">${esc(t('WhatsApp does this step, not Tally.'))}</p>
    <div class="sheetfoot"><button class="btn ghost wide" data-act="sheet-close">${esc(t('Got it'))}</button></div>`, { label: t('How to add it to WhatsApp'), stack: true });
}
/** Today's sticker (and page of the story), once something is logged today, until dismissed: a small reward for the
 *  day, never a score to keep up. */
function stickerCard(tdy) {
  const ym = tdy.slice(0, 7), day = +tdy.slice(8, 10), filled = filledIn(ym);
  if (!shown('stickers') || dismissed().includes(`stk-${tdy}`) || !filled.has(day)) return '';
  const book = bookOf(ym); if (!book) return '';
  const st = bookState({ ym, filled, today: tdy }), s = book.stickers[panelOf(day, st.n)];
  return `<section class="card sticker"><button class="stk-go" data-act="stickers-open" data-jump="1">${stkSvg(s, true, 'stk pop')}<span class="grow"><b>${esc(t("Today's sticker: {0}", say(s.name)))}</b>
    <small>${esc(book.panels.length ? t("{0} of {1} this month, and today's page of the story.", st.got, st.n) : t('{0} of {1} this month. One for each day you log.', st.got, st.n))}</small></span></button>
    ${canSave(s) ? stkSaveBtn(ym, day, 'icon-btn', ICON.download) : ''}<button class="icon-btn" data-act="dismiss" data-id="stk-${tdy}" aria-label="${esc(t('Dismiss'))}">${ICON.x}</button><button class="link stk-off" data-act="stickers-off">${esc(t('Stop showing stickers'))}</button></section>`;
}
/** The way into the book on days without today's card (nothing logged yet, or the card dismissed): one small line. */
function stickerLink(tdy) {
  if (!shown('stickers')) return '';
  const ym = tdy.slice(0, 7), st = bookState({ ym, filled: filledIn(ym), today: tdy });
  return `<button class="link stk-link" data-act="stickers-open">${ICON.award}${esc(t('Sticker book · {0} of {1}', st.got, st.n))}</button>`;
}
/** A month's book: its stickers, the story so far (a locked page says how to open it), and the shelf of past months. */
function bookHtml(book, ym, filled, tdy) {
  const st = bookState({ ym, filled, today: tdy }), days = Array.from({ length: st.n }, (_, i) => i + 1);
  const panel = d => {
    const p = book.panels[panelOf(d, st.n)], end = d === st.n;
    if (!filled.has(d) || (end && !st.complete)) {
      const why = end ? t('Fill in every day to see how it ends.') : !st.over && d > +tdy.slice(8, 10) ? t('Opens on day {0}.', d) : st.open ? t('Log something for day {0} to open it.', d) : t('Missed. Next month is a new story.');
      return `<li class="panel locked"><span class="pday">${esc(t('Day {0}', d))}</span><span>${esc(why)}</span></li>`;
    }
    return `<li class="panel" id="pday-${ym}-${d}"><svg viewBox="0 0 320 200" role="img" aria-label="${esc(t('Day {0}', d))}">${frame(p.art, p.cam)}</svg>
      ${p.lines.map(l => `<p class="say">${l.who === 'narrator' ? '' : `<b>${esc(say(book.who?.[l.who] || WHO[l.who] || l.who))}</b> `}${esc(say(l.text))}</p>`).join('')}
      ${p.tip ? `<p class="tip">${ICON.sparkles || ''}${esc(say(p.tip))}</p>` : ''}</li>`;
  };
  // The latest page that's open (today's, once something is logged today), one tap away: nobody scrolls past 31 stickers.
  const latest = book.panels.length ? days.filter(d => filled.has(d) && !(d === st.n && !st.complete)).at(-1) : null, isToday = latest === +tdy.slice(8, 10) && tdy.slice(0, 7) === ym;
  const jump = latest ? `<button class="btn wide comic-jump" data-act="comic-jump" data-to="pday-${ym}-${latest}">${ICON.sparkles || ''}${esc(isToday ? t("Read today's page of the story") : t('Read the story'))}</button>` : '';
  const past = pastMonths({ today: tdy, first: began() < Infinity ? dayOf(began()).slice(0, 7) : ym, sample: settings().sample });
  // The book's shared drawings (cast, scenes, paint grain), once for all its panels. Not display:none: gradients and
  // filters inside a hidden-by-display svg stop painting in some browsers.
  return `${book.defs ? `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>${book.defs}</defs></svg>` : ''}<h2 class="sh-title">${esc(book.theme ? `${say(book.theme)} · ${fmtMonth(ym)}` : fmtMonth(ym))}</h2>
    <p class="sh-body">${esc(st.complete ? t('Every day of {0} is in. The whole story is yours.', fmtMonth(ym)) : st.grace ? t('{0} of {1} days. Missed days can still be filled in until {2}.', st.got, st.n, fmtDate(st.end)) : st.open ? t('{0} of {1} days. One for each day you log; fill in a missed day any time this month.', st.got, st.n) : t('{0} of {1} days.', st.got, st.n))}</p>
    ${jump}<ul class="stkgrid">${days.map(d => { const s = book.stickers[panelOf(d, st.n)], on = filled.has(d); const inner = `${stkSvg(s, on)}<span>${esc(on ? say(s.name) : String(d))}</span>`; return `<li>${on && canSave(s) ? stkSaveBtn(ym, d, 'stk-btn', inner, say(s.name)) : inner}</li>`; }).join('')}</ul>
    ${book.panels.length ? `<h3 class="comic-h">${esc(t('The story'))}</h3><ol class="comic">${days.map(panel).join('')}</ol><p class="fine">${esc(t('A work of fiction. Any resemblance to real people, shops, businesses or events is coincidental.'))}</p>` : ''}
    ${st.complete || st.over ? `<div class="book-reward">${st.complete && book.colours ? `<p><b>${esc(t('Your reward: the colours of {0}', fmtMonth(ym)))}</b></p><span class="apv" aria-hidden="true" style="background:${book.colours.dark[0]}"><i style="background:${book.colours.dark[2]}"></i><b style="background:${book.colours.accent}"></b></span><button class="btn small" data-act="set-app-palette" data-v="book-${ym}">${esc(t('Use these colours'))}</button>` : ''}<button class="btn small ghost" data-act="book-share" data-ym="${ym}">${esc(t('Share this month'))}</button></div>` : ''}
    ${past.length ? `<h3 class="comic-h">${esc(t('Past months'))}</h3><div class="chips">${past.map(m => `<button class="chip" data-act="stickers-open" data-ym="${m}">${esc(fmtMonth(m))} · ${filledIn(m).size}</button>`).join('')}</div>` : ''}
    <div class="sheetfoot"><button class="btn ghost wide" data-act="sheet-close">${esc(t('Close'))}</button></div>`;
}
const greeting = () => {
  const n = settings().myName, h = +nowTime().slice(0, 2);
  return !n ? '' : h < 12 ? t('Good morning, {0}', n) : h < 18 ? t('Good afternoon, {0}', n) : t('Good evening, {0}', n);
};
const dismiss = id => setKv('dismissed', [...dismissed().filter(x => x !== id), id].slice(-300));
/** Fewer entries than this: a new user's Home stays quiet (no missed-days, habit, insight, recap or find cards; one card at most). */
const NEW = 5;
/** The backup reminder has its own slot (it used to hide nudges for weeks). From 5 entries, or 3 days after starting. */
function backupBanner() {
  if (settings().sample) return '';   // nothing of theirs to lose yet
  const tdy = today(), last = S.kv.lastBackup, start = began();
  if (S.tx.length && (S.tx.length >= NEW || (start < Infinity && daysBetween(dayOf(start), tdy) >= 3)) && (!last || daysBetween(last.slice(0, 10), tdy) > 14) && !dismissed().includes(`backup-${tdy}`)) {
    // The first month it's a quiet reminder (orange on day 3 scared people off); after that, or once a backup is 2 weeks old, a warning.
    const calm = !last && start < Infinity && daysBetween(dayOf(start), tdy) < 30;
    return `<div class="banner ${calm ? 'info' : 'warn'}">${calm ? ICON.lock : ICON.alert}<span class="grow"><b>${esc(last ? t('Last backup {0} days ago', daysBetween(last.slice(0, 10), tdy)) : t('Not backed up yet'))}</b><small>${esc(t("Your Tally data is kept only in this browser's storage on this phone. Uninstalling Tally or clearing the browser's data for Tally deletes it; a backup file keeps it safe."))} <button class="link" data-act="storage-info">${esc(t('How your data is kept'))}</button></small></span>
      <span class="bactions"><button class="btn small" data-act="backup">${esc(t('Back up'))}</button><button class="btn small ghost" data-act="dismiss" data-id="backup-${tdy}">${esc(t('Later'))}</button></span></div>`;
  }
  return '';
}
/** The one other banner Home shows, most important first: a bill due, cash below zero, a daily reminder (once, on the
 *  3rd day with something logged), days not logged, a habit nudge, an insight. `fresh`: a new user, none of the last three. */
function banner(skip = null, fresh = false) {
  const tdy = today();
  if (settings().sample || OLD_HOME) return '';   // no nudges about made-up data; the old address has its moved card
  // A bill due (it outranks cash below zero: a missed bill costs more) in the next 3 days, or one that was due and isn't paid (it stays until paid or put off).
  const due = shown('bills') && S.recurring.filter(b => inScope(b)).map(b => ({ b, s: billStatus(b, tdy, S.tx) })).filter(({ b, s }) => s.date && !s.paid && s.days <= 3 && !dismissed().includes(`bill-${b.id}-${s.date}`)).sort((x, y) => x.s.days - y.s.days)[0];
  if (due) {
    const { b: bill, s } = due;
    return `<div class="banner ${s.days < 0 ? 'warn' : 'info'}">${ICON.bell}<span class="grow"><b>${esc(s.days < 0 ? t('{0} was due {1}', bill.name, fmtDate(s.date)) : t('{0} due {1}', bill.name, s.days === 0 ? t('today') : s.days === 1 ? t('tomorrow') : t('in {0} days', s.days)))}</b><small>${esc(fmtRM(bill.amount))}${bill.auto ? ` · ${esc(t('Adds itself on the day'))}` : ''}</small></span>
    <span class="bactions"><button class="btn small" data-act="bill-paid" data-id="${esc(bill.id)}" data-d="${esc(s.date)}">${esc(t('Mark as paid'))}</button><button class="btn small ghost" data-act="dismiss" data-id="bill-${esc(bill.id)}-${esc(s.date)}">${esc(t('Later'))}</button></span></div>`;
  }
  // A return window closing (2 days ahead) or a warranty ending (a month ahead), when the person asked to be reminded.
  const ends = on('reminders') && S.tx.filter(x => x.type === 'expense' && (x.returnBy || x.warranty)).flatMap(x => [x.returnBy && ['ret', x, x.returnBy, 2], x.warranty && ['war', x, x.warranty, 30]].filter(Boolean))
    .filter(([k, x, d, lead]) => d >= tdy && daysBetween(tdy, d) <= lead && !dismissed().includes(`${k}-${x.id}`)).sort((a, b) => a[2].localeCompare(b[2]))[0];
  if (ends) {
    const [k, x, d] = ends, shop = x.merchant || catLabel(x.category), when = d === tdy ? t('today') : fmtDate(d);
    return `<div class="banner info">${ICON.bell}<span class="grow"><b>${esc(k === 'ret' ? t('{0}: return or exchange by {1}', shop, when) : t('{0}: warranty ends {1}', shop, when))}</b><small>${esc(fmtRM(x.amount))} · ${esc(fmtDate(x.date))}</small></span>
    <span class="bactions"><button class="btn small" data-act="tx-open" data-id="${esc(x.id)}">${esc(t('Open'))}</button><button class="btn small ghost" data-act="dismiss" data-id="${k}-${esc(x.id)}">${esc(t('Got it'))}</button></span></div>`;
  }
  const bal = balances(S.accounts, booked(), tdy).by, cash = S.accounts.find(a => a.kind === 'cash' && a.typed !== false && bal[a.id] < 0 && !dismissed().includes(`cash-off-${a.id}`));   // a balance never given: Home says "not set", no alarm
  // Cash can't really be below zero: something wasn't added. Said once per time it goes below zero (on the day it is first
  // seen, or until Later), never for an account the user said not to. The fixes, most likely first.
  const ep = cash && `cash-${cash.id}-${belowSince(cash, booked())}`;
  if (cash && !dismissed().some(x => x.startsWith(`${ep}:`) && x !== `${ep}:${tdy}`)) return `<div class="banner warn" data-seen="${esc(`${ep}:${tdy}`)}">${ICON.wallet}<span class="grow"><b>${esc(t('{0} is below zero: {1}', cash.name, fmtRM(bal[cash.id])))}</b><small>${esc(t('What happened?'))}</small></span>
    <span class="bactions"><button class="btn small" data-act="acc-edit" data-id="${esc(cash.id)}">${esc(t('Correct the balance'))}</button><button class="btn small ghost" data-act="atm" data-to="${esc(cash.id)}">${esc(t('Add a cash withdrawal'))}</button>
      <button class="btn small ghost" data-act="cash-gift" data-to="${esc(cash.id)}">${esc(t('Family gave me cash'))}</button><button class="btn small ghost" data-act="dismiss" data-id="cash-off-${esc(cash.id)}">${esc(t("Don't warn for this account"))}</button>
      <button class="btn small ghost" data-act="dismiss" data-id="${esc(`${ep}:later`)}" aria-label="${esc(t('Later'))}">${ICON.x}</button></span></div>`;
  const days = new Set(S.tx.filter(x => byUser(x, settings().myName || '')).map(x => x.date)).size;
  if (days >= 3 && days <= 4 && !settings().remindAt && !dismissed().includes('remind-card')) return `<div class="banner info">${ICON.bell}<span class="grow"><b>${esc(t('Want a daily nudge at 21:00?'))}</b></span>
    <span class="bactions"><button class="btn small" data-act="remind-open">${esc(t('Daily reminder'))}</button><button class="btn small ghost" data-act="dismiss" data-id="remind-card" aria-label="${esc(t('Dismiss'))}">${ICON.x}</button></span></div>`;
  // Days away count from what was logged in Tally, never from an imported file's last row (the day someone quit their
  // old app), and never from before they started. New users get this one too: the first lapse is when a habit dies.
  const start = began(), own = booked().filter(x => byUser(x, settings().myName || ''));
  const lastDay = own.reduce((m, x) => (x.date > m ? x.date : m), start < Infinity ? dayOf(start) : ''), away = lastDay ? daysBetween(lastDay, tdy) : 0;
  if (shown('gap') && (own.length || S.tx.length >= 3) && away >= 3 && !dismissed().includes(`gap-${tdy}`)) return `<div class="banner info">${ICON.clock}<span class="grow"><b>${esc(t('Nothing logged since {0}', fmtDate(lastDay)))}</b><small>${esc(t('Add what you remember. A rough amount for the missing days is fine.'))}</small></span>
    <span class="bactions"><button class="btn small" data-act="gap-add" data-d="${esc(addDaysIso(lastDay, 1))}">${esc(t('Add a missed day'))}</button><button class="btn small ghost" data-act="remind-open">${ICON.bell}${esc(t('Daily reminder'))}</button><button class="btn small ghost" data-act="dismiss" data-id="gap-${tdy}">${esc(t('Not now'))}</button></span></div>`;
  if (fresh) return '';
  const nudge = shown('nudge') && dueNudge(cached(habits, booked(), tdy), booked(), nowLocal(), dismissed());
  if (nudge) return `<div class="banner info">${ICON.clock}<span class="grow"><b>${esc(t('Spent on {0}?', catLabel(nudge.category)))}</b><small>${esc(t('You usually do: {0}. Add it now so you don\'t forget.', habitText(nudge)))}</small></span>
    <span class="bactions"><button class="btn small" data-act="nudge-add" data-c="${esc(nudge.category)}" data-a="${nudge.amount}" data-at="${esc(nudge.at || '')}">${esc(t('Add {0}', fmtRM(nudge.amount)))}</button><button class="btn small ghost" data-act="dismiss" data-id="${esc(nudge.id)}">${esc(t('Not today'))}</button></span></div>`;
  const ins = shown('insight') && homeInsights().find(i => !dismissed().includes(i.id) && i.id !== skip);
  if (ins) return `<div class="banner ${ins.level}">${ins.level === 'warn' ? ICON.alert : ICON.chart}<span class="grow"><b>${esc(fill(ins.title))}</b><small>${esc(fill(ins.body))}</small></span>
    <span class="bactions"><button class="btn small ghost" data-act="go" data-to="insights">${esc(t('More'))}</button><button class="btn small ghost" data-act="dismiss" data-id="${esc(ins.id)}" aria-label="${esc(t('Dismiss'))}">${ICON.x}</button></span></div>`;
  return '';
}

/** The month ring: what's left of the budget (or this month against last), coloured by pace. Tap: Budgets. */
function ringHtml(rg, { spent, B, before, lastYm, sd, word }) {
  const pct = rg.mode === 'budget' ? Math.round(rg.frac * 100) : Math.round(spent / before * 100);
  const label = rg.mode === 'budget' ? `${spent > B ? t('Over by {0}', fmtRM(spent - B)) : t('{0} left', fmtRM(B - spent))} · ${word}` : t('{0}% of what you had spent by this point in {1}', pct, fmtMonth(lastYm, sd));
  return `<button class="ring ${rg.tone}" data-act="go" data-to="budgets" aria-label="${esc(label)}"><svg viewBox="0 0 44 44" aria-hidden="true"><circle class="track" cx="22" cy="22" r="19" pathLength="100"/>${rg.frac > 0 ? `<circle class="arc" cx="22" cy="22" r="19" pathLength="100" style="--f:${(rg.frac * 100).toFixed(1)}"/>` : ''}</svg>
    <span class="rtxt" aria-hidden="true"><b class="num">${pct}%</b><small>${esc(rg.mode === 'budget' ? t('left') : t('of {0}', cycleShort(lastYm, sd)))}</small></span></button>`;
}
/** Once a week: last week looked back on, from its first open until dismissed. Tap: Insights. */
function recapCard(r) {
  const id = `wk-${r.start}`, mx = Math.max(...r.days, 1);
  const good = r.good?.kind === 'cheapest' ? t('Cheapest {0} week in a month', catLabel(r.good.cat)) : r.good?.kind === 'less' ? t('{0} less than a usual week', fmtRM(r.good.by)) : '';
  return `<section class="card recap"><button class="recap-go" data-act="recap-go" data-id="${esc(id)}">
    <span class="lbl">${esc(t('Last week'))}</span>
    <span class="rrow"><span class="grow"><b class="num">${esc(fmtRM(r.total))}</b>${r.usual ? `<small>${esc(t('usual {0}', fmtRM(r.usual)))}</small>` : ''}</span>
      <span class="wbars" aria-hidden="true">${r.days.map(v => `<i style="--h:${Math.max(4, Math.round(v / mx * 100))}%"${v ? '' : ' class="nil"'}></i>`).join('')}</span></span>
    ${r.top ? `<span class="rtop">${dot(r.top.cat)}<span class="grow">${esc(catLabel(r.top.cat))}</span><span class="num">${esc(fmtRM(r.top.cents))}</span></span>` : ''}
    ${good ? `<span class="rgood">${ICON.sparkles}<span class="grow">${esc(good)}</span></span>` : ''}</button>
    <button class="icon-btn rx" data-act="dismiss" data-id="${esc(id)}" aria-label="${esc(t('Dismiss'))}">${ICON.x}</button></section>`;
}
/** Now and then (never more than once a day), one piece of good news from the data. */
function findCard(f, tdy) {
  const [text, sub] = f.kind === 'price' ? [fill(f.ins.title), fill(f.ins.body)] : f.kind === 'catdown' ? [t('{0} down {1}% on last month', catLabel(f.cat), f.pct), t('So far this month, against the same point last month.')]
    : f.kind === 'bill' ? [t('{0} paid on time', f.name), ''] : [t('Nothing spent yesterday'), ''];
  const to = f.kind === 'catdown' ? `data-act="cat-show" data-c="${esc(f.cat)}"` : `data-act="go" data-to="${f.kind === 'bill' ? 'budgets' : f.kind === 'nospend' ? 'badges' : 'insights'}"`;
  return `<div class="banner good find">${ICON.sparkles}<button class="grow find-go" ${to}><b>${esc(text)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</button><button class="icon-btn" data-act="dismiss" data-id="find-${esc(tdy)}" aria-label="${esc(t('Dismiss'))}">${ICON.x}</button></div>`;
}
// Worked out once per data change (state.js cached): these take the transactions first.
const insightsOf = (txs, o) => insights({ txs, ...o }), findsOf = (txs, o) => niceFinds({ txs, ...o });
const homeInsights = () => cached(insightsOf, booked(), { budgets: on('budgets') ? budgetsFor() : {}, today: today(), knownBills: S.recurring.map(b => b.key), startDay: startDay() });
/** Spent in `ym` up to the same day of it as today is into this month. */
const sameDayBefore = (txs, ym, sd, into, start) => monthSpend(txs.filter(x => cycleKey(x.date, sd) !== ym || daysBetween(start, x.date) <= into), ym, sd).total;
const trendOf = (txs, accts, end, sd) => balanceTrend(accts.filter(a => a.typed !== false), txs, end, 6, sd);   // a balance never given is not in the chart (as on Home)
/** Items bought in a month, by money: the five most. Codes and run-together OCR text are left out. */
function topItemsOf(txs, M, sd) {
  const items = {};
  for (const x of txs) if (x.type === 'expense' && cycleKey(x.date, sd) === M) for (const i of x.items || []) { const k = itemKey(i.name); if (!k || /\d{5,}/.test(i.name) || /[A-Za-z]{16,}/.test(i.name)) continue; (items[k] ||= { name: i.name, n: 0, v: 0 }); items[k].n++; items[k].v += i.cents; }
  return Object.values(items).sort((a, b) => b.v - a.v).slice(0, 5);
}
/** A receipt turning into categories: what "item by item" means, before anyone has to read the list below. */
export const demoCard = () => {
  const lines = [['SUSU TEPUNG 1KG', 'groceries', 2890], ['ROTI GANDUM', 'groceries', 450], ['SABUN BASUH 2.8KG', 'household', 3290], ['NASI LEMAK', 'dining', 600]];
  const by = {}; for (const [, c, v] of lines) by[c] = (by[c] || 0) + v;
  return `<div class="demo" aria-hidden="true"><div class="demo-r"><b>KEDAI RUNCIT JAYA</b>${lines.map(([n, , v]) => `<span><i>${n}</i><i>${(v / 100).toFixed(2)}</i></span>`).join('')}<span class="tot"><i>TOTAL</i><i>72.30</i></span></div>
    <div class="demo-a">${ICON.back}</div><ul class="demo-c">${Object.entries(by).map(([c, v]) => `<li>${dotFor(c)}<span class="grow">${esc(t(CATEGORIES.find(x => x.id === c).name))}</span><b>${esc(fmtRM(v))}</b></li>`).join('')}</ul></div>`;
};
const dotFor = c => `<span class="dot" style="background:${esc(CATEGORIES.find(x => x.id === c).color)}"></span>`;
/** Until the first receipt is saved: what a scan does, and the two ways to start one. */
const firstScan = () => `<section class="card firstscan"><div class="rowb"><h2>${esc(t('Scan your first receipt'))}</h2><button class="icon-btn" data-act="dismiss" data-id="first-scan" aria-label="${esc(t('Dismiss'))}">${ICON.x}</button></div>
  ${demoCard()}<p class="fine">${esc(t('Receipts are read on this phone and split into categories automatically.'))}</p>
  <div class="row2"><button class="btn" data-act="scan">${ICON.camera}${esc(t('Take a photo'))}</button><button class="btn ghost" data-act="scan-pick">${ICON.image}${esc(t('From gallery'))}</button></div></section>`;
/** Split bills still open, per friend (engine openShares): what they owe you, what you owe them. Hidden balance: masked. */
function oweCards(hide) {
  const { owedMe, iOwe } = cached(openShares, S.tx);
  const card = (title, list, act, label) => (list.length ? `<section class="card owe"><h2>${esc(title)}</h2><ul class="list">${list.map(f => `<li class="rowb"><span class="grow">${esc(f.name)}</span>
    <b class="num">${esc(hide ? MASK : fmtRM(f.sen))}</b><button class="btn small ghost" data-act="${act}" data-n="${esc(f.name)}">${esc(label)}</button></li>`).join('')}</ul></section>` : '');
  return card(t('Owed to you'), owedMe, 'owe-back', t('Paid back')) + card(t('You owe'), iOwe, 'owe-pay', t('Pay back'));
}
/** Paid back (a friend's share came in) or Pay back (mine went to them): a transfer out of Owed to you or into You owe,
 *  all of it or part. Paid back lands by default where their oldest open share was paid from. */
function repaySheet(kind, name) {
  const back = kind === 'owedme', f = openShares(S.tx)[back ? 'owedMe' : 'iOwe'].find(x => x.name === name), box = S.accounts.find(a => a.kind === kind);
  if (!f || !box) return;
  const accts = S.accounts.filter(a => !owing(a)), pick = back && accts.some(a => a.id === f.from) ? f.from : defaultAccount('quick'), tdy = today();
  const el = openSheet(`<h2 class="sh-title">${esc(back ? t('{0} paid you back', name) : t('Pay {0} back', name))}</h2>
    <label class="field amount"><span>${esc(t('Amount (RM)'))}</span><input id="rp-amt" inputmode="decimal" autocomplete="off" aria-describedby="rp-err" value="${(f.sen / 100).toFixed(2)}"></label>
    <div class="grid2 keep2"><label class="field"><span>${esc(back ? t('Into account') : t('From'))}</span><select id="rp-acc">${accts.map(a => `<option value="${esc(a.id)}"${a.id === pick ? ' selected' : ''}>${esc(accName(a.id))}</option>`).join('')}</select></label>
    <label class="field"><span>${esc(t('Date'))}</span><input id="rp-date" type="date" min="1990-01-01" max="${esc(tdy)}" value="${esc(tdy)}"></label></div>
    ${back ? `<label class="check"><input type="checkbox" id="rp-halal"> ${esc(t('Let the rest go — my treat'))}</label>` : ''}
    <p class="err" id="rp-err" role="alert"></p>
    <div class="row2"><button class="btn ghost" data-act="sheet-close">${esc(t('Cancel'))}</button><button class="btn" data-x="save">${esc(t('Save'))}</button></div>`, { label: back ? t('Paid back') : t('Pay back') });
  el.addEventListener('click', async e => {
    const b = e.target.closest('[data-x="save"]'); if (!b) return;
    const amount = el.querySelector('#rp-amt').value.trim() === '' ? 0 : calcAmount(el.querySelector('#rp-amt').value), date = el.querySelector('#rp-date').value, acc = el.querySelector('#rp-acc').value, err = m => { el.querySelector('#rp-err').textContent = m; };
    const halal = !!el.querySelector('#rp-halal')?.checked, rest = f.sen - (amount || 0);
    if (!(amount > 0) && !(halal && amount === 0)) return err(t('Enter an amount, for example 12.50.'));
    if (amount > f.sen) return err(t('At most {0}.', fmtRM(f.sen)));   // more back than is owed would be money from nowhere
    if (!validIso(date) || date > tdy) return err(t('Pick a date.'));
    b.disabled = true;
    const x = amount > 0 ? { id: uid('t'), type: 'transfer', date, amount, accountId: back ? box.id : acc, toAccountId: back ? acc : box.id, category: 'other', merchant: name, [back ? 'repaidBy' : 'repaidTo']: name, source: 'quick', createdAt: Date.now() } : null;
    if (x) { await saveTx(x); await keepToday(x); }
    // The rest let go: as if the friend paid it back and I spent it on them, so nothing stays open and it's my spending.
    if (halal && rest > 0) await putAll({ tx: [
      { id: uid('t'), type: 'transfer', date, amount: rest, accountId: box.id, toAccountId: acc, category: 'other', merchant: name, repaidBy: name, source: 'quick', createdAt: Date.now() },
      { id: uid('t'), type: 'expense', date, amount: rest, accountId: acc, category: 'other', merchant: name, note: t('My treat'), source: 'quick', createdAt: Date.now() },
    ], edit: true });
    closeSheet(); if (x) landed(x.id); render(); toast(t('Saved'), { icon: 'check' });
  });
}
let onScreen = null, drawn = null;   // the totals Home showed last, and the ones just drawn: a save counts from one to the other
export const homeView = {
  title: 'Home',
  /** A save just made lands here: its row flashes, the balance and month count to their new values, the ring moves. */
  after() {
    const seen = document.querySelector('.banner[data-seen]')?.dataset.seen;   // the cash warning, shown today: not again after today
    if (seen && !dismissed().includes(seen)) dismiss(seen).catch(console.error);
    const was = onScreen; onScreen = drawn;
    if (!landing.id || Date.now() - landing.at > 4000) return;
    const id = landing.id; landing.id = null;
    const row = document.querySelector(`.txrow[data-id="${CSS.escape(id)}"]`); if (row) row.dataset.new = '';
    if (!was) return;
    const big = $('.hero .big'), sp = $('.card.month .spent'), arc = $('.ring .arc');
    if (was.bal != null && drawn.bal != null && was.bal !== drawn.bal) { countUp(big, was.bal, drawn.bal); replay(big, 'land'); }
    if (was.spent !== drawn.spent) { countUp(sp, was.spent, drawn.spent); replay(sp, 'land'); }
    if (arc && was.frac != null && was.frac !== drawn.frac) {   // from where it was to where it is now (CSS transition)
      arc.style.setProperty('--f', (was.frac * 100).toFixed(1)); void arc.getBoundingClientRect();
      arc.closest('.ring').classList.add('moving'); requestAnimationFrame(() => arc.style.setProperty('--f', (drawn.frac * 100).toFixed(1)));
    }
  },
  render() {
    const tdy = today(), sd = startDay(), ym = thisMonth();
    const upToday = booked(), accts = scopedAccounts();
    // An account whose starting balance was never given (left blank at the start, or skipped after an import) and that is
    // now below zero isn't really negative: its balance is unknown. It stays out of the total; Home says so instead.
    const all = balances(accts, upToday), unset = accts.filter(a => a.typed === false);
    const used = new Set(upToday.flatMap(x => [x.accountId, x.toAccountId])), shownUnset = unset.filter(a => used.has(a.id));
    const bal = unset.length ? { ...balances(accts.filter(a => !unset.includes(a)), upToday), by: all.by } : all, sp = cached(monthSpend, upToday, ym, sd), spent = sp.total, B = on('budgets') ? budgetsFor().total : 0;
    const p = B ? pace(B, spent, tdy, { startDay: sd, amounts: sp.each.total, fixed: sp.fixed.total, first: cached(firstSpend, upToday) }) : null;
    const lastYm = addMonths(ym, -1), into = daysBetween(cycleSpan(ym, sd).start, tdy), lastStart = cycleSpan(lastYm, sd).start;
    const before = cached(sameDayBefore, upToday, lastYm, sd, into, lastStart), diff = spent - before;
    const recent = cached(newest, upToday, 8);
    const word = p && (spent > B ? t('Over budget') : p.over ? t('Heading over') : t('On track'));
    const rg = ring({ budget: B, spent, before, p });
    const hide = balHidden(), own = accts.filter(a => !owing(a));   // Owed to you and You owe count in the total; they show in their own cards
    drawn ={ bal: hide ? null : bal.total, spent, frac: rg?.frac };
    // Last week on the first days of a new one, else now and then a nice find (one delight card at a time).
    const fresh = S.tx.length < NEW, ws = settings().weekStart === 0 ? 0 : 1, rc = !fresh && shown('insight') && cached(weekRecap, upToday, tdy, ws);
    const recap = rc && !dismissed().includes(`wk-${rc.start}`) ? recapCard(rc) : '';
    const find = !fresh && !recap && shown('insight') && !dismissed().includes(`find-${tdy}`) && pickFind(cached(findsOf, upToday, { today: tdy, startDay: sd, noSpend: settings().noSpend || [], bills: S.recurring.filter(b => inScope(b)), ins: homeInsights() }), tdy);   // the price finds come from the insights the banner uses
    return `<header class="top"><h1 class="sr">${esc(t('Home'))}</h1><span class="grow">${greeting() ? `<b class="hi">${esc(greeting())}</b>` : ''}<small>${esc(fmtDate(tdy, { year: true }))}</small>${scopeChip()}</span><button class="btn ghost small setbtn" data-act="go" data-to="settings">${ICON.gear}<span>${esc(t('Settings'))}</span></button></header>
      ${OLD_HOME ? movedCard() : ''}${scopeSwitch()}${settings().sample ? `<section class="card sample"><p><b>${esc(t('You are looking at sample data.'))}</b> ${esc(t('Nothing here is yours. Try anything.'))}</p><button class="btn small" data-act="sample-end">${esc(t('Start for real'))}</button><button class="link" data-act="net-check">${esc(t('Check what Tally contacted'))}</button></section>` : ''}<div class="cols"><div class="col">
      <section class="hero">
        ${(n => (n ? `<span class="label balrow">${esc(t('Current balance'))} · ${esc(n === 1 ? t('1 account') : t('{0} accounts', n))}${eyeBtn(hide)}</span>
        <div class="big num">${esc(hide ? MASK : fmtRM(bal.total))}</div>` : `<span class="label">${esc(t('Spent this week'))}</span>
        <div class="big num">${esc(fmtRM(weekSpent(upToday, tdy)))}</div>`))(own.filter(a => !offTotal(a) && !unset.includes(a)).length)}
        ${shownUnset.length ? `<p class="fine">${esc(t('Balance not set: {0}', shownUnset.map(a => a.name).join(', ')))} <button class="link" data-act="acc-edit" data-id="${esc(shownUnset[0].id)}">${esc(t('Set it'))}</button></p>` : ''}
        <details class="accts"><summary>${esc(t('Accounts'))}</summary><ul>${own.map(a => `<li><span class="grow">${esc(a.name)}</span><span class="num">${unset.includes(a) ? esc(t('Not set')) : hide ? MASK : esc(fmtAcct(a, bal.by[a.id] ?? 0))}${!hide && isFx(a) && rateOf(a) ? `<small>≈ ${esc(fmtRM(Math.round((bal.by[a.id] ?? 0) * rateOf(a))))}</small>` : ''}</span></li>`).join('')}</ul>${own.length > 1 ? `<button class="btn small ghost" data-act="move-money">${ICON.transfer || ''}${esc(t('Move money between accounts'))}</button>` : ''}</details>
        ${on('afford') && S.tx.length ? `<button class="btn small ghost afford-btn" data-act="afford">${ICON.wallet}${esc(t('Can I afford it?'))}</button>` : ''}
        ${accts.some(offTotal) ? `<p class="fine">${esc(t('Not counted in this total: {0}', accts.filter(offTotal).map(a => a.name).join(', ')))}</p>` : ''}
      </section>
      <div class="addrow${on('receipts') ? '' : ' one'}"><button class="btn" data-act="tx-new">${ICON.plus}${esc(t('Type an amount'))}</button>${on('receipts') ? `<button class="btn ghost" data-act="scan">${ICON.camera}${esc(t('Scan a receipt'))}</button>` : ''}</div>
      ${stickerCard(tdy) || stickerLink(tdy)}
      ${!on('receipts') || S.tx.some(x => x.receiptId) || S.tx.length >= 3 || dismissed().includes('first-scan') ? '' : firstScan()}
      <section class="card month">
        <div class="rowb"><span>${esc(t('Spent in {0}', fmtMonth(ym, sd)))}</span>${p ? `<span class="pill ${rg.tone}">${esc(word)}</span>` : on('budgets') ? `<button class="link" data-act="go" data-to="budgets">${esc(t('Set a budget'))}</button>` : ''}</div>
        <div class="mrow">${rg ? ringHtml(rg, { spent, B, before, lastYm, sd, word }) : ''}<div class="grow">
        <div class="rowb"><b class="spent num">${esc(fmtRM(spent))}</b>${B ? `<span class="fine">${esc(t('of {0}', fmtRM(B)))}</span>` : ''}</div>
        ${before && diff ? `<p class="delta ${diff > 0 ? 'bad' : 'good'}">${esc(diff > 0 ? t('{0} more than this point in {1}', fmtRM(diff), fmtMonth(lastYm, sd)) : t('{0} less than this point in {1}', fmtRM(-diff), fmtMonth(lastYm, sd)))}</p>` : ''}
        </div></div>
      </section>
      ${oweCards(hide)}${goalsCard()}${recap}${find ? findCard(find, tdy) : ''}
      ${fresh ? [streakHome(), banner(null, true), backupBanner()].find(Boolean) || '' : [streakHome(), backupBanner(), banner(find?.kind === 'price' ? find.id : null)].join('')}
      ${S.tx.length >= 3 && on('learn') ? learnHome() : ''}
      </div><div class="col">
      <div class="rowb"><h2>${esc(t('Recent'))}</h2></div>
      ${recent.length ? `<ul class="list">${recent.map(txRow).join('')}</ul><button class="btn ghost wide" data-act="go" data-to="activity">${esc(t('See all'))}</button>` : `<p class="empty">${esc(t('Nothing yet. Scan your first receipt: Tally splits it into items and categories for you.'))}</p>`}
      </div></div>`;
  },
};

// ---- Insights --------------------------------------------------------------------------------------------------
let M = null; // month shown
let SPAN = 6; // months in the table
export const insightsView = {
  title: 'Insights',
  after() {   // opens at the newest months (this month in view, even one column at a time at big text); a shadow on the pinned column while months scroll under it
    const w = document.querySelector('.tablewrap'); if (!w) return;
    w.scrollLeft = w.scrollWidth;
    const mark = () => w.classList.toggle('scrolled', w.scrollLeft > 2);
    w.addEventListener('scroll', mark, { passive: true });
    mark();
  },
  render() {
    const tdy = today(), cur = thisMonth(), sd = startDay();
    if (!M || M > cur) M = cur;
    const all = booked(), now = cached(monthSpend, all, M, sd), prev = cached(monthSpend, all, addMonths(M, -1), sd);
    const parts = Object.entries(now.byCat).map(([c, v]) => ({ id: c, name: catLabel(c), color: cat(c).color, v })).sort((a, b) => b.v - a.v);
    const d = donut(parts, `${esc(fmtRM(now.total))}<small>${esc(t('spent'))}</small>`);
    const change = [...new Set([...Object.keys(now.byCat), ...Object.keys(prev.byCat)])].map(c => ({ c, d: (now.byCat[c] || 0) - (prev.byCat[c] || 0) })).filter(x => x.d).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 5);
    const flowRaw = cached(cashFlow, all, M, 6, sd);
    const flow = flowRaw.map(f => ({ label: cycleShort(f.ym, sd), a: f.income, b: f.expense }));
    const trendEnd = M === cur ? tdy : cycleSpan(M, sd).end;
    const trend = cached(trendOf, all, scopedAccounts(), trendEnd, sd);
    const topItems = cached(topItemsOf, all, M, sd);
    const all0 = cached(insightsOf, all, { budgets: budgetsFor(), today: tdy, knownBills: S.recurring.map(b => b.key), startDay: sd }).filter(i => !dismissed().includes(i.id));
    const feed = all0.filter(i => !i.rec), recs = all0.filter(i => i.rec).sort((a, b) => b.rec.months - a.rec.months);   // most months seen first
    const hs = cached(habits, all, tdy);
    const total = now.total || 1;
    // Six months side by side, like the spreadsheet many people are moving from.
    // Months side by side, like the spreadsheet many people are moving from. Leading months with nothing in them are dropped.
    let tMonths = Array.from({ length: SPAN }, (_, k) => addMonths(M, k - SPAN + 1));
    const spends = cached(monthSpends, all, tMonths, sd), ins = cached(monthIncomes, all, tMonths, sd);   // one pass for all the months
    while (tMonths.length > 1 && !spends[tMonths[0]].total && !ins[tMonths[0]]) tMonths = tMonths.slice(1);
    const tSpend = tMonths.map(m => spends[m]), tIn = tMonths.map(m => ins[m]);
    const catSum = c => tSpend.reduce((s, x) => s + (x.byCat[c] || 0), 0);
    const tCats = [...new Set(tSpend.flatMap(s => Object.keys(s.byCat)))].sort((a, b) => catSum(b) - catSum(a));
    const cell = v => (v ? esc(fmtRM(v, { plain: true })) : '<span class="nil">–</span>');
    const curCol = k => (tMonths[k] === M ? ' class="cur"' : '');
    return `<header class="top"><h1>${esc(t('Insights'))}</h1>${scopeChip()}
        <span class="monthnav"><button class="icon-btn" data-act="ins-month" data-d="-1" aria-label="${esc(t('Previous month'))}">${ICON.back}</button><b>${esc(fmtMonth(M, sd))}</b><button class="icon-btn flip" data-act="ins-month" data-d="1" ${M >= cur ? 'disabled' : ''} aria-label="${esc(t('Next month'))}">${ICON.back}</button></span></header>
      ${scopeSwitch()}${tilesHtml(M)}${M === cur ? subHint() : ''}${feed.length && M === cur ? `<ul class="feed">${feed.slice(0, 2).map(feedItem).join('')}</ul>${feed.length > 2 ? `<details class="card billsugg"><summary>${ICON.chart}${esc(t('{0} more insights', Math.min(6, feed.length) - 2))}</summary><ul class="feed">${feed.slice(2, 6).map(feedItem).join('')}</ul></details>` : ''}` : ''}
      ${M === cur ? forecastCard() : ''}
      <section class="card">
        <h2>${esc(t('Where the money went'))}</h2>
        ${now.total ? `<div class="donutrow">${d.html}<ul class="legend">${parts.map(p => { const cap = budgetsFor().byCat[p.id], of = cap ? p.v / cap : 0;   // its budget, when it has one
          return `<li><button class="link" data-act="cat-items" data-c="${esc(p.id)}" data-m="${M}">${dot(p.id)}<span class="grow">${esc(p.name)}${cap ? `<small class="bud ${of > 1 ? 'bad' : of > 0.85 ? 'warn' : 'good'}">${esc(t('{0}% of budget', Math.round(of * 100)))}</small>` : ''}</span><span class="num">${esc(fmtRM(p.v))}</span><span class="fine">${Math.round(p.v / total * 100)}%</span></button></li>`; }).join('')}</ul></div>
          <p class="fine">${esc(t('Tap a category to see what you bought in it.'))}</p>` : `<p class="empty">${esc(t('No spending in {0}.', fmtMonth(M, sd)))}</p>`}
      </section>
      ${recs.length && M === cur ? `<ul class="feed">${recs.slice(0, 2).map(feedItem).join('')}</ul>${recs.length > 2 ? `<details class="card billsugg"><summary>${ICON.bell}${esc(t('{0} more possible bills', recs.length - 2))}</summary><ul class="feed">${recs.slice(2).map(feedItem).join('')}</ul></details>` : ''}` : ''}
      ${analyticsCards(M)}
      ${change.length && prev.total ? `<section class="card"><h2>${esc(t('Compared with {0}', fmtMonth(addMonths(M, -1), sd)))}</h2><ul class="list">${change.map(x => `<li class="rowb">${dot(x.c)}<span class="grow">${esc(catLabel(x.c))}</span><span class="num ${x.d > 0 ? 'bad' : 'good'}">${x.d > 0 ? '▲' : '▼'} ${esc(fmtRM(Math.abs(x.d)))}</span></li>`).join('')}</ul></section>` : ''}
      ${tCats.length ? `<section class="card span2"><div class="rowb"><h2>${esc(t('Month by month'))} <span class="fine">RM</span></h2>
        <div class="segs mini" role="group" aria-label="${esc(t('Months shown'))}">${[6, 12].map(n => `<button class="seg${SPAN === n ? ' on' : ''}" data-act="ins-span" data-n="${n}" aria-pressed="${SPAN === n}">${esc(t('{0} months', n))}</button>`).join('')}</div></div>
        <div class="tablewrap" tabindex="0" role="region" aria-label="${esc(t('Spending by category and month'))}"><table class="mtable">
        <thead><tr><th scope="col">${esc(t('Category'))}</th>${tMonths.map((m, k) => `<th scope="col"${curCol(k)}>${esc(cycleShort(m, sd))}${m.slice(5) === '01' || k === 0 ? `<small>${m.slice(0, 4)}</small>` : ''}</th>`).join('')}</tr></thead>
        <tbody>${tCats.map(c => `<tr><th scope="row">${dot(c)}${esc(catLabel(c))}</th>${tSpend.map((s, k) => `<td${curCol(k)}>${s.byCat[c] ? `<button class="cellbtn" data-act="cat-show" data-c="${esc(c)}" data-m="${tMonths[k]}" aria-label="${esc(`${catLabel(c)} ${fmtMonth(tMonths[k], sd)}: ${fmtRM(s.byCat[c])}`)}">${cell(s.byCat[c])}</button>` : cell(0)}</td>`).join('')}</tr>`).join('')}</tbody>
        <tfoot><tr><th scope="row">${esc(t('Total spent'))}</th>${tSpend.map((s, k) => `<td${curCol(k)}>${cell(s.total)}</td>`).join('')}</tr>
          <tr class="inc"><th scope="row">${esc(t('Money in'))}</th>${tIn.map((v, k) => `<td${curCol(k)}>${cell(v)}</td>`).join('')}</tr>
          <tr class="net"><th scope="row">${esc(t('Net'))}</th>${tIn.map((v, k) => { const n = v - tSpend[k].total; return `<td${curCol(k)}><span class="${n < 0 ? 'bad' : 'good'}">${n ? esc(fmtRM(n, { plain: true })) : '–'}</span></td>`; }).join('')}</tr></tfoot></table></div></section>` : ''}
      <section class="card"><h2>${esc(t('Money in and out'))}</h2><p class="legendrow"><span class="key good"></span>${esc(t('Received'))} <span class="key bad"></span>${esc(t('Spent'))}</p>
        ${pairBars(flow, { names: [t('Received'), t('Spent')], label: t('Money in and out, last 6 months') })}
        <div class="sr"><table><caption>${esc(t('Money in and out'))}</caption><thead><tr><th scope="col">${esc(t('Month'))}</th><th scope="col">${esc(t('Received'))}</th><th scope="col">${esc(t('Spent'))}</th></tr></thead>${flowRaw.map(f => `<tr><th scope="row">${esc(fmtMonth(f.ym, sd))}</th><td>${esc(fmtRM(f.income))}</td><td>${esc(fmtRM(f.expense))}</td></tr>`).join('')}</table></div></section>
      <section class="card"><h2 class="balrow">${esc(t('Balance'))}${eyeBtn(balHidden())}</h2>${balHidden() ? `<p class="big num">${esc(MASK)}</p>` : lineChart(trend, { label: t('Balance over the last 6 months') })}</section>
      ${topItems.length ? `<section class="card"><h2>${esc(t('What you bought most'))}</h2><ul class="list">${topItems.map(i => `<li class="rowb"><span class="grow">${esc(i.name)}</span><span class="fine">${i.n}×</span><span class="num">${esc(fmtRM(i.v))}</span></li>`).join('')}</ul></section>` : ''}
      <section class="card"><h2>${esc(t('Your spending habits'))}</h2>
        ${hs.length ? `<ul class="list">${hs.map((h, n) => `<li class="rowb">${dot(h.category)}<span class="grow">${esc(habitText(h))}<small>${esc(t('{0} times in the last 4 weeks · usually {1}', h.count, fmtRM(h.amount)))}</small></span><button class="btn small ghost" data-act="habit-cal" data-n="${n}">${ICON.bell}${esc(t('Remind me'))}</button></li>`).join('')}</ul>
        <p class="fine">${esc(t('Tally nudges you on Home when a usual time passes with nothing added. Calendar reminders work even when Tally is closed.'))}</p>`
        : `<p class="fine">${esc(t('After a few weeks of adding spending (with times), Tally learns when you usually spend and reminds you to log it.'))}</p>`}</section>`;
  },
};

const habitEv = h => habitEvent({ ...h, title: t('Tally: did you spend on {0}?', catLabel(h.category)), details: t('Add it in Tally so your spending stays complete.') });
/** Spent since the start of this week (the week-start setting): Home's headline while no account balance is known. */
const weekSpent = (txs, tdy) => {
  const ws = settings().weekStart === 0 ? 0 : 1, from = addDaysIso(tdy, -((new Date(`${tdy}T00:00:00Z`).getUTCDay() - ws + 7) % 7));
  return txs.reduce((s, x) => s + (x.type === 'expense' && x.date >= from && x.date <= tdy ? x.amount : 0), 0);
};
const addDaysIso = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const act = {
  'bal-hide': async () => { await setSetting('hideBal', !settings().hideBal); render(); $('.eyebtn')?.focus(); },
  'stickers-open': async b => {
    const ym = b?.dataset?.ym || today().slice(0, 7), book = bookOf(ym) || await loadBook(ym), filled = filledIn(ym);
    // A complete month's colours are kept for Settings → App colours, whether or not they're used now.
    if (book.colours && bookState({ ym, filled, today: today() }).complete && !settings().bookPalettes?.[ym]) {
      const { dark, light, accent } = book.colours;
      await setSetting('bookPalettes', { ...(settings().bookPalettes || {}), [ym]: { dark, light, accent } });
    }
    const el = openSheet(bookHtml(book, ym, filled, today()), { label: t('Sticker book'), stack: !!b?.dataset?.ym });
    // From today's sticker card ("…and today's page of the story"): open on that page
    if (b?.dataset?.jump) requestAnimationFrame(() => el?.querySelector('.comic-jump')?.click());
    // A panel's slow camera move (comic.js frame, css .cam-drift) starts once the panel is mostly on screen, and runs once.
    const io = new IntersectionObserver(es => es.forEach(x => { if (x.isIntersecting) { x.target.querySelector('.cam-drift')?.classList.add('go'); io.unobserve(x.target); } }), { threshold: 0.6 });
    el?.querySelectorAll('.cam-drift').forEach(g => io.observe(g.closest('.panel')));
  },
  'sticker-sheet': b => stickerSheet(b),
  'sticker-howto': () => howTo(stkUrl),
  'comic-jump': b => document.getElementById(b.dataset.to)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }),
  // A finished month as a picture to share: its stickers (the missed days faint), how many days, no money at all.
  'book-share': async b => {
    const ym = b.dataset.ym, book = bookOf(ym) || await loadBook(ym), filled = filledIn(ym), st = bookState({ ym, filled, today: today() });
    // Only the days logged get their sticker: a missed day is drawn as an empty circle, never as its sticker.
    shareSheet('book', { ym, title: book.theme ? say(book.theme) : t('Sticker book'), label: fmtMonth(ym), long: monthName(ym).long, colours: book.colours, got: st.got, n: st.n,
      days: Array.from({ length: st.n }, (_, k) => ({ day: k + 1, svg: filled.has(k + 1) ? book.stickers[panelOf(k + 1, st.n)]?.svg : null })) });
  },
  ...analyticsAct,
  ...goalsAct,
  'move-money': () => openTxSheet({ type: 'transfer', category: 'other' }),
  'owe-back': b => repaySheet('owedme', b.dataset.n),
  'owe-pay': b => repaySheet('iowe', b.dataset.n),   // where people looked for it: under Accounts
  atm: b => { const bank = S.accounts.find(a => a.kind === 'bank') || S.accounts.find(a => a.id !== b.dataset.to); openTxSheet({ type: 'transfer', category: 'other', accountId: bank?.id, toAccountId: b.dataset.to, merchant: t('Cash withdrawal') }); },
  'cash-gift': b => openTxSheet({ type: 'income', category: 'family', accountId: b.dataset.to }),
  'gap-add': b => openTxSheet({ date: b.dataset.d, time: '' }),
  'scan-pick': () => document.getElementById('scan-input')?.click(),
  // Daily reminder: Settings has the card (#remind); this goes there and puts focus in it.
  'remind-open': async () => {
    if (!dismissed().includes('remind-card')) await dismiss('remind-card');
    go('settings');
    let n = 0; const find = () => { const r = document.getElementById('remind'); if (r) { r.scrollIntoView({ block: 'start' }); r.querySelector('button, input, select')?.focus({ preventScroll: true }); } else if (n++ < 15) setTimeout(find, 100); };
    setTimeout(find, 100);
  },
  'dismiss': async b => { await dismiss(b.dataset.id); render(); },
  'old-erase': async () => {
    if (!(await confirmSheet({ title: t("Erase Tally's data at this old address?"), body: t('Only do this after your backup is restored at tallymy.github.io. This deletes Tally\'s data, settings and offline files from this address; nothing of the other app.'), ok: t("Erase Tally's data here"), danger: true }))) return;
    await wipeSite(); location.replace(NEW_HOME);
  },
  'afford': () => {
    const { balance, savings, bills, counted } = affordInputs();   // the same money and bills as Insights' next 30 days
    const el = openSheet(`<div class="sheethead"><h2 class="sh-title">${esc(t('Can I afford it?'))}</h2><button class="icon-btn" data-act="sheet-close" aria-label="${esc(t('Close'))}">${ICON.x}</button></div>
      <label class="field"><span>${esc(t('Price (RM)'))}</span><input id="af-amt" inputmode="decimal" placeholder="0.00" autocomplete="off" autofocus></label>
      <div id="af-out" aria-live="polite">${counted ? '' : `<p class="warnbox">${esc(t('Set how much is in your accounts first: Tally needs a starting point.'))}</p>`}</div>`, { label: t('Can I afford it?') });
    if (!counted) return;
    el.querySelector('#af-amt').addEventListener('input', e => {
      const price = calcAmount(e.target.value), out = el.querySelector('#af-out');
      if (!(price > 0)) return (out.innerHTML = '');
      out.innerHTML = affordHtml({ ...affordCheck({ price, balance, txs: booked(), today: today(), startDay: startDay(), bills, budget: on('budgets') ? budgetsFor().total : 0 }), savings });
    });
  },
  'stickers-off': async () => { await setModules({ stickers: false }); render(); toast(t('Stickers are off. Turn them back on in Settings → Features.')); },
  'recap-go': async b => { await dismiss(b.dataset.id); go('insights'); },
  'nudge-add': b => openTxSheet({ category: b.dataset.c, amount: +b.dataset.a, ...(b.dataset.at ? { time: b.dataset.at } : {}) }),
  'ins-span': b => { SPAN = +b.dataset.n; render(); },
  'ins-month': b => { M = addMonths(M, +b.dataset.d); if (M > thisMonth()) M = thisMonth(); render(); },
  'habit-cal': b => {
    const h = habits(booked(), today())[+b.dataset.n]; if (!h) return;
    openSheet(`<h2 class="sh-title">${esc(t('Remind me to log it'))}</h2><p class="sh-body">${esc(t('Your calendar will remind you {0}.', habitText(h)))}</p>
      <a class="btn wide" href="${esc(googleUrl(habitEv(h)))}" target="_blank" rel="noopener">${esc(t('Add to Google Calendar'))}</a>
      <button class="btn ghost wide" data-act="habit-ics" data-n="${b.dataset.n}">${esc(t('Download calendar file (iPhone, Outlook)'))}</button>`, { label: t('Reminder') });
  },
  'habit-ics': b => {
    const h = habits(booked(), today())[+b.dataset.n]; if (!h) return;
    download(`tally-habit-${safeId(h.category)}.ics`, ics([habitEv(h)]), 'text/calendar');
    toast(t('Open the downloaded file to add the reminder.'));
  },
};
