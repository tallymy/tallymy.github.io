// Activity (every transaction, searchable), the add/edit sheet, and Budgets (limits, pace, bills).
import { S, jointIds, saveTx, keepToday, saveAccount, addCategory, incomeCats, cat, expenseCats, allCats, today, nowTime, uid, setKv, saveBill, deleteBill, getPhoto, learn, booked, scope, hasJoint, scopedTx, scopedAccounts, inScope, budgetsFor, setSetting, defaultAccount, saveTxs, deleteTxs, startDay, thisMonth, cached , scopes } from '../state.js';
import { t, fmtDate, fmtMonth, monShort, getLang, langTag } from '../i18n.js';
import { esc, ICON, openSheet, closeSheet, confirmSheet, toast, lineChart, $, landed, announce } from '../ui.js';
import { firstWord } from './learn.js';
import { RELIEFS, reliefGuess, firstSpend, subsOf, subFor, learnSub, fmtRM, unmarkedPayments, parseAmount, itemKey, categorize, addMonths, monthOf, monthSpend, monthSpends, byDate, leftOverPaybacks, pace, validIso, findDuplicate, recurringCandidates, billKey, INCOME_CATEGORIES, calcAmount, cycleKey, cycleSpan, addDays, billDates, billStatus, dueBillTxs, tooLarge, isFx, fmtAcct, owing, lateTypedHint } from '../engine.js';
import { billEvent, ics, googleUrl, safeId } from '../calendar.js';
import { download, receiptName, zipStore, toCSV } from '../io.js';
import { catIcon } from '../caticons.js';
import { on } from '../features.js';
import { onColor } from '../colorpicker.js';
import { render, go } from '../app.js';

export const accName = id => { const a = S.accounts.find(x => x.id === id); return !a ? t('Deleted account') : owing(a) ? t(a.name) : a.name; };   // Owed to you, You owe: in the app's language
const accOf = id => S.accounts.find(a => a.id === id);
/** "Amount (RM)", or the account's own currency: "Amount (SGD)". */
const amtLabel = (id, key = 'Amount ({0})') => { const a = accOf(id); return isFx(a) ? t(key, a.currency) : key === 'Amount ({0})' ? t('Amount (RM)') : t(key, 'RM'); };
export const catLabel = id => t(cat(id).name);
export const dot = c => `<span class="dot" style="background:${esc(cat(c).color)}" aria-hidden="true"></span>`;
/** A category's icon on its colour: entries, category chips and Settings. `c`: a category or its id. */
export const badge = c => { const k = typeof c === 'string' ? cat(c) : c; return `<span class="cbadge" style="--c:${esc(k.color)};--on:${onColor(k.color)}" aria-hidden="true">${catIcon(k)}</span>`; };
const scopeName = sc => ({ me: t('Me'), joint: t('Joint'), business: t('Business'), all: t('All') })[sc];
/** Me · Joint · All, on Home, Activity, Insights and Budgets once a joint account exists (Budgets: Me · Joint, see budScope). */
export const scopeSwitch = (sc = scope(), keys = [...scopes(), 'all']) => (scopes().length > 1 ? `<div class="segs scope" role="group" aria-label="${esc(t('Whose money'))}">${keys.map(k => `<button class="seg${sc === k ? ' on' : ''}" data-act="scope" data-s="${k}" aria-pressed="${sc === k}">${esc(scopeName(k))}</button>`).join('')}</div>` : '');
/** In a screen's header: whose money it shows when that isn't all of it, so a switch made on another screen is no surprise.
 *  A tap shows all again (on Budgets, a label: budgets are set for Me or Joint). */
export const scopeChip = (sc = scope(), label = false) => (scopes().length === 1 || sc === 'all' ? ''
  : label ? `<span class="pill scopechip">${esc(t('Viewing: {0}', scopeName(sc)))}</span>`
  : `<button class="chip on scopechip" data-act="scope" data-s="all" aria-label="${esc(t('Viewing: {0}. Show all', scopeName(sc)))}">${esc(t('Viewing: {0}', scopeName(sc)))}${ICON.x}</button>`);
/** Budgets are set for Me or for Joint: with All chosen elsewhere, Budgets shows Me (where the fields can be changed). */
const budScope = () => (['joint', 'business'].includes(scope()) ? scope() : 'me');
/** One transaction row (used by Home and Activity). */
export function txRow(x) {
  const cats = x.items?.length ? [...new Set(x.items.map(i => i.category))] : [x.category];
  const title = x.merchant || (x.type === 'transfer' ? t('Transfer') : catLabel(x.category));
  const back = x.type === 'expense' && cached(refundedIds, S.tx).has(x.id) ? ` · ${esc(t('Refunded'))}` : '';
  const sub = x.type === 'transfer' ? `${esc(accName(x.accountId))} → ${esc(accName(x.toAccountId))}` : `${cats.slice(0, 3).map(c => esc(catLabel(c))).join(' · ')}${x.sub && on('subcats') ? ` › ${esc(t(x.sub))}` : ''}${cats.length > 3 ? ` +${cats.length - 3}` : ''} · ${esc(accName(x.accountId))}`;
  const sign = x.type === 'income' ? '+' : x.type === 'transfer' ? '' : '−';
  return `<li><button class="txrow" data-act="tx-open" data-id="${esc(x.id)}">${x.type === 'transfer' ? '<span class="cbadge tbadge" aria-hidden="true">' + ICON.swap + '</span>' : badge(cats[0])}<span class="grow"><b>${esc(title)}</b><small>${sub}${back}${x.receiptId ? ` · ${ICON.receipt.replace('<svg', '<svg class="clip"')}<span class="sr">${esc(t('has photo'))}</span>` : x.items?.length ? ` · ${esc(t('items'))}` : ''}${x.by ? ` · ${esc(x.by)}` : ''}</small></span>
    <span class="amt ${x.type}">${sign}${esc(x.type === 'transfer' || x.fx != null ? fmtAcct(accOf(x.accountId), x.fx ?? x.amount) : fmtRM(x.amount))}</span></button></li>`;
}

// ---- Activity ------------------------------------------------------------------------------------------------------
const F = { q: '', month: '', acc: '', cat: '', photo: false, ids: null, idsLabel: '', limit: 200 };
/** Newest first (date, then time, then the last added): sorted once per data change, not on every keystroke. */
const latestFirst = txs => [...txs].sort((a, b) => byDate(b.date, a.date) || byDate(b.time || '', a.time || '') || b.createdAt - a.createdAt);
const cycleKeys = (txs, sd) => [...new Set(txs.map(x => cycleKey(x.date, sd)))].sort().reverse();
function matches(x) {
  if (F.month && (F.month.startsWith('y') ? x.date.slice(0, 4) !== F.month.slice(1) : cycleKey(x.date, startDay()) !== F.month)) return false;   // "y2026": the whole year
  if (F.acc && x.accountId !== F.acc && x.toAccountId !== F.acc) return false;
  if (F.cat && x.category !== F.cat && !(x.items || []).some(i => i.category === F.cat)) return false;
  if (F.photo && !x.receiptId) return false;
  if (F.ids && !F.ids.includes(x.id)) return false;
  if (!F.q) return true;
  const q = F.q.toLowerCase(), sen = /\d/.test(q) ? parseAmount(q) : null;   // "28.5", "RM28.50": an amount
  if (sen != null && (x.amount === sen || (x.items || []).some(i => i.cents === sen))) return true;
  return [x.merchant, x.note, catLabel(x.category), ...(x.items || []).map(i => i.name)].some(s => String(s || '').toLowerCase().includes(q));
}
export const activityView = {
  title: 'Activity',
  render() {
    const list = cached(latestFirst, scopedTx()).filter(matches);
    const sd = startDay(), months = cached(cycleKeys, scopedTx(), sd);
    const shown = list.slice(0, F.limit);
    const photos = (F.q || F.month || F.acc || F.cat || F.photo || F.ids) && new Set(list.map(x => x.receiptId).filter(Boolean)).size;   // a search ("panadol", "klinik") or a filter picks which to download
    // Only what was searched for: "diapers" this year is the diaper lines of each receipt, not the whole receipts.
    const q = F.q.toLowerCase(), hit = i => (!F.cat || i.category === F.cat) && (!q || String(i.name || '').toLowerCase().includes(q));
    const tdy = today(), spent = list.filter(x => x.type === 'expense' && x.date <= tdy).reduce((s, x) => s + ((F.cat || q) && x.items?.some(hit) ? x.items.filter(hit).reduce((a, i) => a + i.cents, 0) : x.amount), 0);
    let html = '', day = '';
    for (const x of shown) {
      if (x.date !== day) { if (day) html += '</ul>'; day = x.date; html += `<h3 class="day">${x.date > tdy ? `<span class="pill">${esc(t('Upcoming'))}</span> ` : ''}${esc(fmtDate(x.date, { year: x.date.slice(0, 4) !== tdy.slice(0, 4) }))}</h3><ul class="list">`; }
      html += txRow(x);
    }
    if (day) html += '</ul>';
    return `<header class="top"><h1>${esc(t('Activity'))}</h1>${scopeChip()}<button class="btn" data-act="tx-new">${ICON.plus}${esc(t('Add'))}</button></header>
      ${scopeSwitch()}<div class="filters">
        <label class="search">${ICON.search}<input id="act-q" type="search" data-input="act-q" value="${esc(F.q)}" placeholder="${esc(t('Search shops, items, notes'))}" aria-label="${esc(t('Search'))}"></label>
        <select id="act-month" data-input="act-f" data-k="month" aria-label="${esc(t('Month'))}"><option value="">${esc(t('Month'))}</option>${[...new Set(months.map(m => m.slice(0, 4)))].map(y => `<option value="y${y}"${F.month === `y${y}` ? ' selected' : ''}>${esc(t('All of {0}', y))}</option>`).join('')}${months.map(m => `<option value="${m}"${F.month === m ? ' selected' : ''}>${esc(fmtMonth(m, sd))}</option>`).join('')}</select>
        <select id="act-acc" data-input="act-f" data-k="acc" aria-label="${esc(t('Account'))}"><option value="">${esc(t('Account'))}</option>${scopedAccounts().map(a => `<option value="${esc(a.id)}"${F.acc === a.id ? ' selected' : ''}>${esc(accName(a.id))}</option>`).join('')}</select>
        <select id="act-cat" data-input="act-f" data-k="cat" aria-label="${esc(t('Category'))}"><option value="">${esc(t('Category'))}</option>${allCats().map(c => `<option value="${esc(c.id)}"${F.cat === c.id ? ' selected' : ''}>${esc(t(c.name))}</option>`).join('')}</select>
      </div>
      <div class="chips"><button class="chip${F.photo ? ' on' : ''}" data-act="act-photo" aria-pressed="${F.photo}">${ICON.receipt}${esc(t('With receipt photo'))}</button>${F.ids ? `<button class="chip on" data-act="act-ids" aria-label="${esc(t('Show all, not just {0}', F.idsLabel))}">${esc(F.idsLabel)}${ICON.x}</button>` : ''}</div>
      <p class="fine" id="act-sum">${esc(list.length === 1 ? t('1 transaction · {0} spent', fmtRM(spent)) : t('{0} transactions · {1} spent', list.length, fmtRM(spent)))}</p>
      ${photos ? `<button class="btn ghost" data-act="act-dl">${ICON.download}${esc(photos === 1 ? t('Download 1 receipt photo') : t('Download {0} receipt photos', photos))}</button>` : ''}
      <div id="act-list">${list.length ? html : `<p class="empty">${esc(S.tx.length ? t('Nothing matches. Try another search or filter.') : t('No transactions yet. Scan a receipt or tap Add.'))}</p>`}
      ${list.length > F.limit ? `<button class="btn ghost wide" data-act="act-more">${esc(t('Show more'))}</button>` : ''}</div>`;
  },
};
let qTimer;
/** Activity after a filter change: drawn again, and the count said (screen readers). */
const refilter = () => { render(); announce($('#act-sum')?.textContent || ''); };
let budT, budFirst = false, budRevision = 0;
const anyBudget = b => [b, b.joint, b.business].some(x => x && (x.total || Object.keys(x.byCat || {}).length));
/** Words and prices in the amount ("鱼 25, 菜 8"): several things bought, better typed as items. */
const hasWords = v => /\p{L}/u.test(v) && /\d/.test(v);
export const input = {
  // A refund linked to its purchase goes back to that purchase's category.
  'tx-refof': el => { const x = S.tx.find(y => y.id === el.value), c = x && (x.items?.[0]?.category || x.category); if (c && $('#tx-refcat')?.querySelector(`option[value="${CSS.escape(c)}"]`)) $('#tx-refcat').value = c; },
  // Picking an earlier day takes the reminder away: that is what it asks for.
  'tx-date': el => { const h = $('#tx-hint'); if (h) h.hidden = !lateTypedHint(S.accounts.find(a => a.id === ($('#tx-acc')?.value || draft?.accountId)), el.value, today()); },
  'tx-acc': () => { accPicked = true; reopen(); },   // the amount's currency, and "Received" between two currencies
  // The split button is always there (a number keypad has no letters); it lights up when words are typed.
  'tx-amt': el => { const b = $('#tx-words'); if (b) b.classList.toggle('ghost', !hasWords(el.value)); el.removeAttribute('aria-invalid'); },
  'act-q': el => { F.q = el.value; clearTimeout(qTimer); qTimer = setTimeout(() => { const pos = el.selectionStart; refilter(); const q = $('#act-q'); q.focus(); q.setSelectionRange(pos, pos); }, 250); },
  // Typing a name picks the category it had before (until one is tapped): "Grab to office" → Transport.
  'tx-name': el => {
    // The account this shop was paid from before (a toll on TNG), unless one was picked by hand.
    if (draft && !accPicked && draft.type !== 'transfer' && S.tx.length) { const id = defaultAccount(draft.type === 'income' ? 'income' : 'quick', { shop: el.value, amount: draft.amount || 0 }), sel = $('#tx-acc'); if (id && sel && sel.value !== id) { sel.value = id; draft.accountId = id; } }
    if (!draft || catPicked || draft.type === 'transfer' || draft.items?.length) return;
    const c = guessCategory(el.value, draft.type), sheet = el.closest('.sheet');
    if (!c || c === draft.category || !sheet?.querySelector(`[data-act="tx-cat"][data-c="${CSS.escape(c)}"]`)) return;
    draft.category = c;
    for (const chip of sheet.querySelectorAll('[data-act="tx-cat"]')) { const on = chip.dataset.c === c; chip.classList.toggle('on', on); chip.setAttribute('aria-pressed', on); }
  },
  'act-f': el => { F[el.dataset.k] = el.value; F.limit = 200; refilter(); },
  'bud': el => {
    const revision = ++budRevision, err = document.getElementById(`be-${el.dataset.cat}`);
    el.parentElement.classList.remove('saved');
    const v = el.value.trim() === '' ? 0 : calcAmount(el.value);
    el.classList.toggle('bad', v == null || v < 0);
    el.setAttribute('aria-invalid', String(v == null || v < 0));
    if (err) err.textContent = v == null || v < 0 ? amtErr(el.value) : '';
    if (v == null || v < 0) return;
    if (!anyBudget(S.kv.budgets)) budFirst = true;   // the very first budget gets a warm word once typing stops
    const all = structuredClone(S.kv.budgets), sc = budScope(), b = sc === 'me' ? all : (all[sc] ||= { total: 0, byCat: {} });
    if (el.dataset.cat === 'total') b.total = v; else if (v) b.byCat[el.dataset.cat] = v; else delete b.byCat[el.dataset.cat];
    if (b !== all) b.updatedAt = Date.now();   // joint budgets merge by newest edit
    // Keep typing in place; show the saved tick only once storage confirms the write.
    clearTimeout(budT);
    setKv('budgets', all).then(() => {
      if (revision !== budRevision || !el.isConnected) return;
      budT = setTimeout(() => {
      if (revision !== budRevision || !el.isConnected) return;
      const tmp = document.createElement('div'); tmp.innerHTML = budgetsView.render();
      for (const id of ['bs-total', `bs-${el.dataset.cat}`]) { const a = document.getElementById(id), b2 = tmp.querySelector(`#${CSS.escape(id)}`); if (a && b2) a.innerHTML = b2.innerHTML; }
      el.parentElement.classList.remove('saved'); void el.parentElement.offsetWidth; el.parentElement.classList.add('saved');
      if (budFirst && anyBudget(S.kv.budgets)) { budFirst = false; const w = firstWord('budget'); if (w) toast(w, { k: 'good', icon: 'check', cheer: true }); }
      }, 350);
    }).catch(() => {
      if (revision !== budRevision || !el.isConnected) return;
      el.classList.add('bad'); el.setAttribute('aria-invalid', 'true');
      if (err) err.textContent = t('Could not save. Your phone may be out of space.');
    });
  },
};
/** Show one category's spending: Home, Insights and Budgets link here. */
export function showCategory(c, month = thisMonth()) { Object.assign(F, { q: '', acc: '', cat: c, month, ids: null, limit: 200 }); go('activity'); }
/** Activity showing just these entries (from Insights: the payments behind a tax relief line), named by a chip that clears it. */
/** Receipt photos to keep or hand in (a tax claim, an expense claim): one photo as itself, several in a zip with their list.
 *  `rows`: [{tx, dir?}], `csv`: the list that goes with them (default: the entries, as the CSV export writes them). */
export async function downloadReceipts(rows, zipName, csv) {
  rows = rows.filter(r => r.tx.receiptId);
  const files = [], taken = new Set(); let missing = 0;
  for (const { tx, dir } of rows) { const p = await getPhoto(tx.receiptId); if (p) files.push({ name: receiptName(tx, taken, dir), data: new Uint8Array(await p.arrayBuffer()) }); else missing++; }
  if (missing) toast(t('{0} photos are not on this phone, so they are not in the file.', missing), { k: 'warn' });
  if (!files.length) return;
  if (files.length === 1 && !csv) return download(files[0].name.split('/').pop(), new Blob([files[0].data], { type: 'image/jpeg' }), 'image/jpeg');
  files.push({ name: 'receipts.csv', data: new TextEncoder().encode(csv ?? toCSV(rows.map(r => r.tx), S.accounts, catLabel)) });
  download(`${zipName.replace(/[\\/:*?"<>|]+/g, ' ').trim()}.zip`, zipStore(files), 'application/zip');
}
export function showIds(ids, label) { Object.assign(F, { q: '', acc: '', cat: '', month: '', photo: false, ids, idsLabel: label, limit: 200 }); go('activity'); }

/** Purchases a refund can be for: the last 120 days' spending, this shop's first, newest first (and the linked one, however old). */
function refundPicker(d) {
  const from = addDays(today(), -120), shop = (d.merchant || '').toLowerCase(), mine = x => (x.merchant || '').toLowerCase() === shop && !!shop;
  const list = S.tx.filter(x => x.type === 'expense' && (x.date >= from || x.id === d.refundOf)).sort((a, b) => mine(b) - mine(a) || byDate(b.date, a.date)).slice(0, 40);
  return `<label class="field"><span>${esc(t('Refund of'))}</span><select id="tx-refof" data-input="tx-refof"><option value="">${esc(t('Not linked to a purchase'))}</option>${list.map(x => `<option value="${esc(x.id)}"${d.refundOf === x.id ? ' selected' : ''}>${esc(`${fmtDate(x.date)} · ${x.merchant || catLabel(x.category)} · ${fmtRM(x.amount)}`)}</option>`).join('')}</select></label>`;
}
/** On a purchase: the money that came back for it. */
function refundsOf(d) {
  const back = d.type === 'expense' ? S.tx.filter(x => x.refundOf === d.id) : [];
  return back.length ? `<p class="okbox">${ICON.check}<span>${back.map(x => esc(t('Refunded {0} on {1}', fmtRM(x.amount), fmtDate(x.date)))).join(' · ')}</span></p>` : '';
}
const refundedIds = txs => new Set(txs.map(x => x.refundOf).filter(Boolean));
/** The kind of money in used most recently (refunds aside); Salary for a first one. */
const lastIncomeCat = () => S.tx.reduce((b, x) => (x.type === 'income' && x.category !== 'refund' && (!b || (x.createdAt || 0) > (b.createdAt || 0)) ? x : b), null)?.category || 'salary';
// ---- add / edit sheet ------------------------------------------------------------------------------------------------
let draft = null; // the transaction being edited; its id is fixed when the sheet opens, so saving twice can't duplicate
function sheetHtml() {
  const d = draft, isNew = !S.tx.some(x => x.id === d.id);
  const to = d.toAccountId || S.accounts.find(a => a.id !== d.accountId && !owing(a))?.id, twoCur = d.type === 'transfer' && (accOf(d.accountId)?.currency || 'MYR') !== (accOf(to)?.currency || 'MYR');
  const cats = d.type === 'income' ? incomeCats() : expenseCats();
  const seg = ['expense', 'income', 'transfer'].map(k => `<button type="button" class="seg${d.type === k ? ' on' : ''}" data-act="tx-type" data-type="${k}" aria-pressed="${d.type === k}">${esc(t({ expense: 'Spent', income: 'Received', transfer: 'Transfer' }[k]))}</button>`).join('');
  // Owed to you and You owe only as the entry's own account (a friend's share, a bill a friend paid): kept, never offered.
  const accOpts = sel => S.accounts.filter(a => !owing(a) || a.id === sel).map(a => `<option value="${esc(a.id)}"${sel === a.id ? ' selected' : ''}>${esc(accName(a.id))}</option>`).join('');
  // A day other than today (a missed day, a bill's due date) is named in the title, so it can't be missed,
  const day = isNew && d.date !== today() ? `${new Intl.DateTimeFormat(langTag(), { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${d.date}T00:00:00Z`))} ${fmtDate(d.date)}` : '';
  // and its date sits right under the amount, not down where the keyboard and the sum bar cover it.
  const hintAcc = S.accounts.find(a => a.id === d.accountId);
  const when = `<div class="grid2 keep2">
      <label class="field"><span>${esc(t('Date'))}</span><input id="tx-date" data-input="tx-date" type="date" min="1990-01-01" value="${esc(d.date)}" max="${esc(today())}"></label>
      <label class="field"><span>${esc(t('Time'))}</span><input id="tx-time" inputmode="numeric" maxlength="5" autocomplete="off" placeholder="13:40" value="${esc(d.time || '')}"></label>
    </div>${isNew && d.type !== 'transfer' ? `<p class="fine" id="tx-hint"${lateTypedHint(hintAcc, d.date, today()) ? '' : ' hidden'}>${esc(t("Did this happen before you typed this account's balance? Pick that day so it isn't counted twice."))}</p>` : ''}`;
  return `<h2 class="sh-title">${esc(!isNew ? t('Edit') : day ? t('Add for {0}', day) : t('Add'))}</h2>
    <div class="segs" role="group" aria-label="${esc(t('Type'))}">${seg}</div>
    <label class="field amount"><span>${esc(amtLabel(d.accountId))}</span><input id="tx-amt" data-input="tx-amt" inputmode="decimal" autocomplete="off" aria-describedby="tx-err" value="${d.amount ? (d.amount / 100).toFixed(2) : ''}" ${d.items?.length || d.split ? 'readonly' : isNew ? 'autofocus' : ''} placeholder="0.00"></label>
    ${d.type === 'expense' && !d.items?.length && !d.split ? `<button class="btn small ghost wide" id="tx-words" data-act="tx-split">${ICON.list}${esc(t('Several items? Split them'))}</button>` : ''}
    ${d.split ? `<p class="fine sp-note">${ICON.users}<span>${esc(t('Your share of {0} · split with {1}', fmtRM(d.split.total), d.split.with.join(', ')))}${d.owedTo ? ` · ${esc(t('{0} paid', d.owedTo))}` : ''}</span></p>` : ''}
    <p class="err" id="tx-err" role="alert"></p>
    ${day ? when : ''}
    ${d.type === 'transfer' ? '' : `<div class="chips cats" role="group" aria-label="${esc(t('Category'))}"><button type="button" class="chip newcat" data-act="tx-newcat">${ICON.plus}${esc(t('New'))}</button>${cats.map(c => `<button type="button" class="chip${d.category === c.id ? ' on' : ''}" aria-pressed="${d.category === c.id}" tabindex="${d.category === c.id || (!cats.some(x => x.id === d.category) && c === cats[0]) ? 0 : -1}" data-act="tx-cat" data-c="${esc(c.id)}">${badge(c)}${esc(t(c.name))}</button>`).join('')}</div>`}
    ${on('subcats') && d.type !== 'transfer' && d.category && !d.items?.length ? `<div class="chips subs" role="group" aria-label="${esc(t('Subcategory'))}">${subsOf(d.category, S.kv.subcats).map(n => `<button type="button" class="chip small${d.sub === n ? ' on' : ''}" aria-pressed="${d.sub === n}" data-act="tx-sub" data-s="${esc(n)}">${esc(t(n))}</button>`).join('')}<button type="button" class="chip small newcat" data-act="tx-newsub">${ICON.plus}${esc(t('New'))}</button></div>` : ''}
    ${d.type === 'income' && d.category === 'refund' ? `<label class="field"><span>${esc(t('Money back for'))}</span><select id="tx-refcat">${expenseCats().map(c => `<option value="${esc(c.id)}"${(d.cat || 'other') === c.id ? ' selected' : ''}>${esc(t(c.name))}</option>`).join('')}</select><small>${esc(t('Your spending there goes down by this amount.'))}</small></label>${refundPicker(d)}` : ''}
    <div class="${d.type === 'transfer' ? 'grid2' : ''}">
      <label class="field"><span>${esc(d.type === 'transfer' ? t('From') : t('Account'))}</span><select id="tx-acc" data-input="tx-acc">${accOpts(d.accountId)}</select></label>
      ${d.type === 'transfer' ? `<label class="field"><span>${esc(t('To'))}</span><select id="tx-to" data-input="tx-acc">${accOpts(to)}</select></label>` : ''}
    </div>
    ${twoCur ? `<label class="field"><span>${esc(amtLabel(to, 'Received ({0})'))}</span><input id="tx-toamt" inputmode="decimal" autocomplete="off" value="${d.toAmount ? (d.toAmount / 100).toFixed(2) : ''}" placeholder="0.00"><small>${esc(t('What arrived, after the exchange. Tally uses it as the rate for this currency.'))}</small></label>` : ''}
    ${day ? '' : when}
    <label class="field"><span>${esc(d.type === 'income' ? t('From (who paid you)') : t('Shop or note'))}</span><input id="tx-merchant" maxlength="80" value="${esc(d.merchant || '')}" autocomplete="off" list="tx-names" data-input="tx-name"></label>
    <datalist id="tx-names">${pastNames(d.type).map(n => `<option value="${esc(n)}">`).join('')}</datalist>
    ${d.items?.length ? `<details class="items"><summary>${esc(d.receiptId ? (d.items.length === 1 ? t('1 item from the receipt') : t('{0} items from the receipt', d.items.length)) : d.items.length === 1 ? t('1 item') : t('{0} items', d.items.length))}</summary><ul>${d.items.map(i => `<li>${dot(i.category)}<span class="grow">${esc(i.name || t('(no name)'))}</span><span class="amt">${esc(fmtRM(i.cents))}</span></li>`).join('')}</ul>
      <button class="btn ghost small" data-act="tx-items">${esc(t('Edit items'))}</button></details>` : ''}
    ${refundsOf(d)}
    ${d.type === 'expense' && on('taxrelief') ? reliefPick(d) : ''}
    ${d.type === 'expense' && on('reminders') ? `<details class="more"${d.returnBy || d.warranty ? ' open' : ''}><summary>${esc(t('Return or warranty reminder'))}</summary><div class="row2"><label class="field"><span>${esc(t('Return by'))}</span><input id="tx-return" type="date" value="${esc(d.returnBy || '')}"></label><label class="field"><span>${esc(t('Warranty until'))}</span><input id="tx-warranty" type="date" value="${esc(d.warranty || '')}"></label></div><small class="fine">${esc(t('Home reminds you 2 days before the return window ends and a month before the warranty does.'))}</small></details>` : ''}
    ${d.receiptId ? `<button class="btn ghost small" data-act="tx-photo">${ICON.receipt}${esc(t('Show receipt photo'))}</button>` : ''}
    ${!isNew && d.type === 'expense' && on('split') ? `<button class="btn ghost small" data-act="tx-splitf">${ICON.users}${esc(t('Split with friends'))}</button>` : ''}
    ${!isNew && d.type !== 'transfer' ? `<button class="btn ghost small" data-act="tx-again">${ICON.plus}${esc(t('Add again today'))}</button>` : ''}
    <div class="row2 sheetfoot">${isNew ? `<button class="btn ghost" data-act="sheet-close">${esc(t('Cancel'))}</button>` : `<button class="btn ghost danger" data-act="tx-del">${ICON.trash}${esc(t('Delete'))}</button>`}<button class="btn" data-act="tx-save">${esc(t('Save'))}</button></div>`;
}
/** Shop and note names typed before (imports too), most used first, for the name field's suggestions. */
const pastNames = type => { const n = new Map(); for (const x of S.tx) if (x.type === type && x.merchant) n.set(x.merchant, (n.get(x.merchant) || 0) + 1); return [...n].sort((a, b) => b[1] - a[1]).slice(0, 300).map(([k]) => k); };
/**
 * The category a name was filed under before: a remembered rule first, then the category most used with the same name
 * in any row (imports too), then with the same first words ("Rent, room @ Bayan Lepas" ~ "Rent room"), then item words.
 */
export function guessCategory(name, type = 'expense') {
  const k = itemKey(name); if (!k) return null;
  if (type === 'expense' && Object.hasOwn(S.kv.rules, k)) return S.kv.rules[k];
  for (const key of [itemKey, billKey]) {
    const want = key(name); if (!want) continue;
    const n = {}; for (const x of S.tx) if (x.type === type && x.category && x.merchant && key(x.merchant) === want) n[x.category] = (n[x.category] || 0) + 1;
    const best = Object.entries(n).sort((a, b) => b[1] - a[1])[0]; if (best) return best[0];
  }
  // The typed name is often the shop ("Mydin", "Petronas", "Pasar raya"): its words and its shop both count.
  return type === 'expense' ? categorize(name, name, S.kv.rules) : null;
}
/** What's wrong with a typed amount: over RM 100 million, or not an amount. */
const amtErr = v => (tooLarge(v) ? t('That amount is too large (RM 100 million at most).') : t('Enter an amount, for example 12.50.'));
/** A transfer between RM and another currency sets that currency's rate: what the person actually got. */
async function rateFrom(x) {
  const a = accOf(x.accountId), b = accOf(x.toAccountId);
  if (!x.toAmount || !a || !b || isFx(a) === isFx(b)) return;
  const [fx, rm, units] = isFx(a) ? [a, x.toAmount, x.amount] : [b, x.amount, x.toAmount];
  await saveAccount({ ...fx, rate: +(rm / units).toFixed(4) });
}
let catPicked = false;   // a category tapped in the sheet is never changed by typing the name
let accPicked = false;   // nor an account picked by hand by switching Spent / Received
/** "1340", "13.40", "9:05" → "13:40" / "09:05"; anything else → no time. */
export const hhmmIn = v => { const m = String(v ?? '').trim().match(/^([01]?\d|2[0-3])[:.\s]?([0-5]\d)$/); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : undefined; };
function readForm() {
  if ($('#tx-relief')) { const v = $('#tx-relief').value; if (v) draft.relief = v; else delete draft.relief; }
  draft.amount = draft.items?.length || draft.split ? draft.amount : calcAmount($('#tx-amt')?.value);
  draft.accountId = $('#tx-acc')?.value || draft.accountId;
  if (draft.type === 'transfer') draft.toAccountId = $('#tx-to')?.value; else delete draft.toAccountId;
  if ($('#tx-refcat') && draft.category === 'refund') draft.cat = $('#tx-refcat').value; else if (draft.category !== 'refund') delete draft.cat;
  if ($('#tx-refof')?.value && draft.category === 'refund') draft.refundOf = $('#tx-refof').value; else delete draft.refundOf;
  if ($('#tx-toamt')) draft.toAmount = calcAmount($('#tx-toamt').value); else delete draft.toAmount;   // only between two currencies
  draft.date = $('#tx-date')?.value || draft.date;
  for (const [id, k] of [['#tx-return', 'returnBy'], ['#tx-warranty', 'warranty']]) if ($(id)) { const v = $(id).value; if (validIso(v)) draft[k] = v; else delete draft[k]; }
  draft.time = hhmmIn($('#tx-time')?.value);
  draft.merchant = ($('#tx-merchant')?.value || '').trim().slice(0, 80);
}
/** Tax relief for this payment: Tally's guess from its words (Automatic), none, or one picked by hand, so a relief it
 *  missed can be added and a wrong one taken off. */
function reliefPick(d) {
  const g = reliefGuess({ ...d, relief: undefined }), name = id => t(RELIEFS.find(r => r.id === id).name);
  return `<label class="field"><span>${esc(t('Tax relief'))}</span><select id="tx-relief"><option value="">${esc(g ? t('Automatic: {0}', name(g)) : t('Automatic: none found'))}</option><option value="none"${d.relief === 'none' ? ' selected' : ''}>${esc(t('Not a tax relief'))}</option>${RELIEFS.map(r => `<option value="${r.id}"${d.relief === r.id ? ' selected' : ''}>${esc(t(r.name))}</option>`).join('')}</select></label>`;
}
/** The chosen category in the middle of its row, where the row scrolls sideways (phones). */
function catInView(sh) {
  const c = sh?.querySelector('.cats .chip.on'), box = c?.parentElement;
  if (box && box.scrollWidth > box.clientWidth) box.scrollLeft += c.getBoundingClientRect().left - box.getBoundingClientRect().left - (box.clientWidth - c.offsetWidth) / 2;
}
function reopen() {
  const typed = $('#tx-amt')?.value;   // words typed as the amount stay put (and keep their Split offer)
  readForm();
  const sh = document.querySelector('.scrim:not(.out) .sheet');
  if (!sh) return catInView(openSheet(sheetHtml(), { label: t('Transaction') }));
  const focus = document.activeElement?.id;   // redraw in place: no second sheet, nothing typed goes astray
  sh.innerHTML = `<div class="grab" aria-hidden="true"></div>${sheetHtml()}`; catInView(sh);
  const amt = $('#tx-amt'); if (amt && !amt.readOnly && typed && hasWords(typed)) { amt.value = typed; input['tx-amt'](amt); }
  if (focus) document.getElementById(focus)?.focus({ preventScroll: true });
}
/** The expense category used most (by entries), so a new entry starts on it. */
const usualCategory = () => {
  if (S.kv.settings?.ownCats) return 'other';   // "Only my categories": nothing is picked for them
  const n = {}; for (const x of S.tx) if (x.type === 'expense' && !x.bill && x.source !== 'recurring') n[x.category] = (n[x.category] || 0) + 1;
  return Object.entries(n).sort((a, b) => b[1] - a[1]).map(([c]) => c).find(c => expenseCats().some(e => e.id === c)) || (S.kv.settings?.ownCats ? 'other' : 'dining');
};
/** Open the add sheet, optionally prefilled ({type, category, amount} from a nudge or bill). */
/** A new entry closed without Save (phone back, a tap outside): the next plain Add within 15 minutes picks it up. */
let unsaved = null;
export function openTxSheet(preset = {}) {
  const resume = !Object.keys(preset).length && unsaved && Date.now() - unsaved.at < 15 * 60e3 ? unsaved : null;
  unsaved = null;
  draft = resume ? resume.draft : { id: uid('t'), type: 'expense', amount: 0, accountId: defaultAccount('quick', { amount: preset.amount || 0 }), category: usualCategory(), date: today(), time: nowTime(), merchant: '', source: 'quick', ...preset };
  catPicked = resume ? resume.cat : !!preset.category; accPicked = resume ? resume.acc : !!preset.accountId;
  catInView(openSheet(sheetHtml(), { label: t('Add'), onClose: () => {
    if (S.tx.some(x => x.id === draft.id)) return;   // saved
    try { readForm(); } catch { /* the sheet is already gone */ }
    if (draft.amount > 0 || draft.merchant) unsaved = { draft: structuredClone(draft), cat: catPicked, acc: accPicked, at: Date.now() };
  } }));
  if (resume) toast(t('Picked up what you were typing'), { undo: () => { closeSheet(); unsaved = null; openTxSheet({ type: 'expense' }); }, undoLabel: t('Start over') });
}

// ---- Budgets ----------------------------------------------------------------------------------------------------------
/** A screen's parts marked <!--key-->…<!--/key--> are left out while that module is off. */
const modular = html => html.replace(/<!--(\w+)-->([\s\S]*?)<!--\/\1-->/g, (m, k, part) => (on(k) ? part : ''));
export const budgetsView = {
  title: 'Budgets',
  render() {
    const sd = startDay(), ym = thisMonth(), tdy = today(), sc = budScope();
    const txs = sc === scope() ? booked() : S.tx.filter(x => x.date <= tdy && inScope(x, sc)), now = cached(monthSpend, txs, ym, sd), B = budgetsFor(sc);
    const bar = (spent, budget, c) => {
      if (!budget) return `<span class="fine">${esc(t('{0} spent', fmtRM(spent)))}</span>`;
      const p = pace(budget, spent, tdy, { startDay: sd, amounts: now.each[c], fixed: now.fixed[c], first: cached(firstSpend, txs) }), pct = Math.min(100, Math.round(spent / budget * 100));
      const state = spent > budget ? 'bad' : p.over ? 'warn' : 'good';
      const word = spent > budget ? t('Over by {0}', fmtRM(spent - budget)) : p.over ? t('Heading over: about {0} by month end', fmtRM(p.projected)) : t('{0} left', fmtRM(budget - spent));
      return `<div class="meter ${state}" aria-hidden="true"><i style="width:${pct}%"></i></div><span class="fine ${state}">${esc(fmtRM(spent))} / ${esc(fmtRM(budget))} · ${esc(word)}</span>`;
    };
    // Cumulative spend this month vs the budget line.
    let run = 0; const series = [], byDay = {};
    for (const x of txs) if (x.type === 'expense') byDay[x.date] = (byDay[x.date] || 0) + x.amount;
    for (let iso = cycleSpan(ym, sd).start; iso <= tdy; iso = addDays(iso, 1)) { run += byDay[iso] || 0; series.push({ date: iso, v: run }); }
    const cand = cached(recurringCandidates, txs, S.recurring.map(b => b.key).filter(Boolean)).filter(r => !S.kv.dismissed.includes(`bill-sugg-${r.key}`));
    // Categories with spending or a limit first (most spent on top); the rest fold away.
    const spentOn = c => now.byCat[c.id] || 0, cats = [...expenseCats()].sort((a, b) => spentOn(b) - spentOn(a));
    const active = cats.filter(c => spentOn(c) || B.byCat[c.id]), idle = cats.filter(c => !spentOn(c) && !B.byCat[c.id]);
    const row = c => `<li><div class="brow"><button class="link" data-act="cat-show" data-c="${esc(c.id)}">${dot(c.id)}${esc(t(c.name))}</button>
        <span class="rmin"><input inputmode="decimal" data-input="bud" data-cat="${esc(c.id)}" aria-label="${esc(t('Budget for {0} (RM)', t(c.name)))}" aria-describedby="be-${esc(c.id)}" value="${B.byCat[c.id] ? (B.byCat[c.id] / 100).toFixed(2) : ''}"></span></div><p class="err bud-err" id="be-${esc(c.id)}" role="alert"></p><div id="bs-${esc(c.id)}">${bar(spentOn(c), B.byCat[c.id] || 0, c.id)}</div></li>`;
    const bills = S.recurring.filter(b => inScope(b, sc));
    // No budget yet: what the last 3 full months cost (the median), to the nearest RM 50.
    const firstYm = txs.reduce((m, x) => (x.type === 'expense' && (!m || x.date < m) ? x.date : m), '') && cycleKey(txs.reduce((m, x) => (x.type === 'expense' && (!m || x.date < m) ? x.date : m), ''), sd);
    const pastYm = [1, 2, 3].map(k => addMonths(ym, -k)).filter(m => m > firstYm), spends = cached(monthSpends, txs, pastYm, sd), past = pastYm.map(m => spends[m].total).filter(Boolean).sort((a, b) => a - b);
    const avg = past.length ? Math.max(5000, Math.round(past[Math.floor(past.length / 2)] / 5000) * 5000) : 0;   // median: one big month doesn't set the bar
    // Modules: the budget part and the bills part each show only when their module is on (Settings → Features).
    return modular(`<header class="top"><h1>${esc(t(on('budgets') ? 'Budgets' : 'Bills'))}</h1>${scopeChip(sc, true)}<span class="fine">${esc(fmtMonth(ym, sd))}</span></header>
      ${scopeSwitch(sc, scopes())}
<!--budgets-->      <section class="card"><label class="field"><span>${esc(sc === 'joint' ? t('Joint monthly budget (RM)') : t('Monthly budget (RM)'))}</span><span class="rmin"><input inputmode="decimal" data-input="bud" data-cat="total" aria-describedby="be-total" value="${B.total ? (B.total / 100).toFixed(2) : ''}" placeholder="${esc(avg ? (avg / 100).toFixed(0) : t('e.g. 2500'))}"></span></label><p class="err bud-err" id="be-total" role="alert"></p>
        ${avg && !B.total ? `<p class="fine">${esc(t('You spent about {0} a month lately.', fmtRM(avg)))} <button class="link" data-act="bud-use" data-v="${avg}">${esc(t('Use {0}', fmtRM(avg)))}</button></p>` : ''}<div id="bs-total">${bar(now.total, B.total, 'total')}
        ${B.total ? lineChart(series, { goal: B.total, label: t('Spending this month against the budget') }) : ''}</div></section>
      <h2>${esc(t('By category'))}</h2><p class="fine">${esc(t('Set a limit for the categories you want to watch. Leave the rest empty.'))}</p>
      <ul class="list budgets">${active.map(row).join('')}</ul>
      ${idle.length ? `<details class="more-cats"><summary>${esc(idle.length === 1 ? t('1 more category') : t('{0} more categories', idle.length))}</summary><ul class="list budgets">${idle.map(row).join('')}</ul></details>` : ''}
<!--/budgets--><!--bills-->      <h2 id="bills">${esc(t('Regular bills'))}</h2>
      <ul class="list">${bills.map(b => { const s = billStatus(b, tdy, S.tx); return `<li class="bill"><span class="grow"><b>${esc(b.name)}</b><small>${esc(billLine(b, s))}</small>
        ${s.paid ? `<span class="bstat"><span class="pill good">${esc(b.freq === 'weekly' ? t('Paid this week') : t('Paid for {0}', b.freq === 'yearly' ? s.date.slice(0, 4) : monShort(+s.date.slice(5, 7))))}</span></span>`
          : s.date ? `<span class="bstat"><button class="btn small${s.days < 0 ? '' : ' ghost'}" data-act="bill-paid" data-id="${esc(b.id)}" data-d="${esc(s.date)}">${esc(t('Mark as paid'))}</button></span>` : ''}</span><button class="btn small ghost" data-act="bill-cal" data-id="${esc(b.id)}" aria-label="${esc(t('Add a reminder to my calendar'))}">${ICON.bell}</button><button class="btn small ghost" data-act="bill-edit" data-id="${esc(b.id)}" aria-label="${esc(t('Edit'))}">…</button></li>`; }).join('') || `<li class="empty">${esc(t('No bills yet.'))}</li>`}</ul>
      ${cand.map(r => `<div class="card suggest">${ICON.bell}<span class="grow">${esc(t('{0} looks like a monthly bill ({1})', r.merchant, fmtRM(r.amount)))}</span><button class="btn small" data-act="bill-add-suggested" data-key="${esc(r.key)}">${esc(t('Add'))}</button><button class="icon-btn" data-act="dismiss" data-id="bill-sugg-${esc(r.key)}" aria-label="${esc(t('Not a bill'))}">${ICON.x}</button></div>`).join('')}
      <button class="btn ghost wide" data-act="bill-edit">${ICON.plus}${esc(t('Add a bill'))}</button><!--/bills-->`);
  },
};
const billLine = (b, s) => [fmtRM(b.amount), b.freq === 'weekly' ? t('every week') : b.freq === 'yearly' ? t('every year') : t('every month on day {0}', b.day || 1),
  s.date && !s.paid && s.days <= 0 ? (s.days < 0 ? t('overdue since {0}', fmtDate(s.date)) : t('due {0}', fmtDate(s.date))) : s.next ? t('next {0}', fmtDate(s.next)) : s.date ? t('finished') : '', b.auto ? t('adds itself') : ''].filter(Boolean).join(' · ');
function billSheet(b) {
  // The next payment to come (an overdue one stays), and how many are left of an instalment.
  const tdy = today(), s = billStatus(b, tdy, S.tx), next = (s.date && !s.paid ? s.date : s.next) || b.start || tdy;
  const left = b.count ? billDates(b, '9999-12-31').filter(d => d >= next).length : '';
  const freqs = [['monthly', t('Every month')], ['weekly', t('Every week')], ['yearly', t('Every year')]];
  openSheet(`<h2 class="sh-title">${esc(b.id ? t('Edit bill') : t('Add a bill'))}</h2>
    <label class="field"><span>${esc(t('Name'))}</span><input id="b-name" maxlength="60" value="${esc(b.name || '')}" autofocus></label>
    <div class="grid2"><label class="field"><span>${esc(t('Amount (RM)'))}</span><input id="b-amt" inputmode="decimal" aria-describedby="b-err" value="${b.amount ? (b.amount / 100).toFixed(2) : ''}"></label>
    <label class="field"><span>${esc(t('How often'))}</span><select id="b-freq">${freqs.map(([k, n]) => `<option value="${k}"${(b.freq || 'monthly') === k ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label></div>
    <label class="field"><span>${esc(t('Next payment'))}</span><input id="b-date" type="date" min="1990-01-01" value="${esc(next)}"></label>
    <label class="check"><input type="checkbox" id="b-auto"${(b.id ? b.auto : true) ? ' checked' : ''}> ${esc(t('Add it automatically on the day'))}</label>
    <div class="grid2"><label class="field"><span>${esc(t('Category'))}</span><select id="b-cat">${expenseCats().map(c => `<option value="${esc(c.id)}"${(b.category || 'bills') === c.id ? ' selected' : ''}>${esc(t(c.name))}</option>`).join('')}</select></label>
    <label class="field"><span>${esc(t('Account'))}</span><select id="b-acc">${S.accounts.filter(a => !owing(a)).map(a => `<option value="${esc(a.id)}"${b.accountId === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label></div>
    <details class="more"${left || b.until ? ' open' : ''}><summary>${esc(t('Instalments or an end date'))}</summary>
      <div class="grid2"><label class="field"><span>${esc(t('Payments left (instalments)'))}</span><input id="b-count" type="number" inputmode="numeric" min="1" max="600" value="${left}" placeholder="${esc(t('No end'))}"></label>
      <label class="field"><span>${esc(t('Or ends on (optional)'))}</span><input id="b-until" type="date" min="1990-01-01" value="${esc(b.until || '')}"></label></div>
      <p class="fine">${esc(t('Tally adds the payment the next time you open it on or after the day, and tells you. A bill counts as paid once anything with its name is added that month, whatever the amount.'))}</p></details>
    <p class="err" id="b-err" role="alert"></p>
    <div class="row2">${b.id ? `<button class="btn ghost danger" data-act="bill-del" data-id="${esc(b.id)}">${esc(t('Delete'))}</button>` : `<button class="btn ghost" data-act="sheet-close">${esc(t('Cancel'))}</button>`}<button class="btn" data-act="bill-save" data-id="${esc(b.id || '')}" data-key="${esc(b.key || '')}">${esc(t('Save'))}</button></div>`, { label: t('Bill') });
}
/** Calendar reminder: monthly from calendar.js; a weekly or yearly bill repeats from its next date; instalments stop. */
const billEv = x => {
  const e = billEvent({ id: x.id, day: x.day, title: t('Pay {0}', x.name), details: t('Tally reminder') });
  const next = billStatus(x, today(), []).next, ymd = d => d.replaceAll('-', '');
  if (next && (x.freq === 'weekly' || x.freq === 'yearly')) Object.assign(e, { start: `${ymd(next)}T090000`, end: `${ymd(next)}T093000`, rrule: `FREQ=${x.freq.toUpperCase()}` });
  if (x.until) e.rrule += `;UNTIL=${ymd(x.until)}T235959`;
  else if (x.count && next) e.rrule += `;COUNT=${billDates(x, '9999-12-31').filter(d => d >= next).length}`;
  return e;
};
/** On open and on coming back: add the payments of bills set to add themselves. Undo removes them; they aren't added again. */
export async function postBills() {
  const tdy = today();
  if (!S.accounts.length) return 0;
  // A joint payment deleted here (or by the partner) is never posted again; a personal bill's always is.
  const txs = unmarkedPayments(dueBillTxs(S.recurring, tdy, S.tx), S.kv.jointGone || {}, jointIds()).map(x => (S.accounts.some(a => a.id === x.accountId) ? x : { ...x, accountId: defaultAccount('bill') }));
  if (txs.length) await saveTxs(txs);
  for (const r of S.recurring) if (r.auto && !(r.last >= tdy)) await saveBill({ ...r, last: tdy }, { edited: false });
  if (txs.length) toast(txs.length === 1 ? t('Added {0} {1}', txs[0].merchant, fmtRM(txs[0].amount)) : t('Added {0} regular payments: {1}', txs.length, [...new Set(txs.map(x => x.merchant))].join(', ')), { icon: 'check', undo: async () => { await deleteTxs(txs.map(x => x.id)); render(); } });
  return txs.length;
}

// ---- actions ---------------------------------------------------------------------------------------------------------------
export const act = {
  'act-more': () => { F.limit += 200; render(); },
  'bud-use': b => { const el = $('[data-cat="total"]'); el.value = (b.dataset.v / 100).toFixed(2); input.bud(el); b.parentElement.remove(); },
  'scope': async b => { await setSetting('scope', b.dataset.s); F.acc = ''; render(); },
  'tx-new': () => openTxSheet(),
  'sheet-close': () => closeSheet(),
  'cat-show': b => showCategory(b.dataset.c, b.dataset.m || undefined),
  'tx-open': b => { const x = S.tx.find(y => y.id === b.dataset.id); if (!x) return; draft = structuredClone(x); catPicked = accPicked = true; catInView(openSheet(sheetHtml(), { label: t('Transaction') })); },
  'tx-splitf': async () => { const x = S.tx.find(y => y.id === draft.id); if (!x) return; closeSheet(); (await import('./splitbill.js')).openSplit(x); },
  'tx-type': b => {
    readForm(); draft.type = b.dataset.type;
    if (!accPicked && draft.type !== 'transfer') { const id = defaultAccount(draft.type === 'income' ? 'income' : 'quick', { amount: draft.amount || 0 }), sel = $('#tx-acc'); if (id && sel) sel.value = id; }   // money in lands where income usually does
    // Money in starts on the kind used last (a rider's payout, a stall's sales, a pension), not always Salary.
    if (draft.type === 'income' && !incomeCats().some(c => c.id === draft.category)) draft.category = lastIncomeCat();
    if (draft.type === 'expense' && incomeCats().some(c => c.id === draft.category)) draft.category = 'other';
    reopen(); 
  },
  // A category of their own, made right here: named, picked, and back to the entry with nothing typed lost.
  'tx-newcat': () => {
    readForm();
    const income = draft.type === 'income', el = openSheet(`<h2 class="sh-title">${esc(income ? t('New kind of money in') : t('New category'))}</h2>
      <label class="field"><span>${esc(t('Name'))}</span><input id="nc-name" maxlength="40" autocomplete="off" placeholder="${esc(income ? t('e.g. Side business, Rental') : t('e.g. Kids, Pets, Remittance'))}" autofocus></label>
      <div class="row2"><button class="btn ghost" data-x="no">${esc(t('Cancel'))}</button><button class="btn" data-x="ok">${esc(t('Add'))}</button></div>`, { label: t('Category'), stack: true });
    const done = async ok => {
      const name = el.querySelector('#nc-name').value.trim();
      if (ok && !name) return el.querySelector('#nc-name').focus();
      if (ok) { let c; try { c = await addCategory(name, undefined, income ? 'income' : 'expense'); } catch (e) { return toast(t(e.message), { k: 'warn' }); } draft.category = c.id; catPicked = true; if (draft.items?.length) draft.items.forEach(i => { i.category = c.id; }); }
      closeSheet(); reopen();
    };
    el.addEventListener('click', e => { const x = e.target.closest('[data-x]')?.dataset.x; if (x) done(x === 'ok'); });
    el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); done(true); } });
  },
  'tx-sub': b => { readForm(); draft.sub = draft.sub === b.dataset.s ? undefined : b.dataset.s; reopen(); },   // tap again: none
  'tx-newsub': () => {
    readForm();
    const el = openSheet(`<h2 class="sh-title">${esc(t('New subcategory'))}</h2>
      <label class="field"><span>${esc(t('Name'))}</span><input id="ns-name" maxlength="30" autocomplete="off" placeholder="${esc(t('e.g. Kopitiam, Toll, Pharmacy'))}" autofocus></label>
      <div class="row2"><button class="btn ghost" data-x="no">${esc(t('Cancel'))}</button><button class="btn" data-x="ok">${esc(t('Add'))}</button></div>`, { label: t('Subcategory'), stack: true });
    const done = async ok => {
      const name = el.querySelector('#ns-name').value.trim().slice(0, 30);
      if (ok && !name) return el.querySelector('#ns-name').focus();
      if (ok) { const c = draft.category, own = S.kv.subcats || {}; if (!subsOf(c, own).includes(name)) await setKv('subcats', { ...own, [c]: [...(own[c] || []), name].slice(-30) }); draft.sub = name; }
      closeSheet(); reopen();
    };
    el.addEventListener('click', e => { const x = e.target.closest('[data-x]')?.dataset.x; if (x) done(x === 'ok'); });
    el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); done(true); } });
  },
  'tx-cat': b => { readForm(); catPicked = true; if (b.dataset.c !== draft.category) draft.sub = on('subcats') ? subFor(b.dataset.c, draft.merchant, [], S.kv.subRules) || undefined : undefined; draft.category = b.dataset.c; if (draft.items?.length) draft.items.forEach(i => { i.category = b.dataset.c; }); reopen(); },
  // Several things in one payment (a phone and fish at the mall): list them and each is sorted into its category.
  'tx-split': async () => {
    const typed = $('#tx-amt')?.value || '';   // "鱼 25, 菜 8" typed as the amount: those become the items
    readForm(); closeSheet(); const { editExisting } = await import('./review.js'); editExisting({ ...draft, items: [] }, { manual: true, lines: hasWords(typed) ? typed : '' });
  },
  'tx-items': async () => { readForm(); closeSheet(); const { editExisting } = await import('./review.js'); editExisting(draft); },
  'tx-photo': async () => {
    const blob = await getPhoto(draft.receiptId);
    if (!blob) return toast(t('The photo is not on this phone (it may have been restored from a backup without photos).'));
    const url = URL.createObjectURL(blob);
    openSheet(`<img class="photo" src="${url}" alt="${esc(t('Receipt photo'))}"><div class="sheetfoot"><button class="btn ghost" data-act="tx-photo-dl">${ICON.download}${esc(t('Save photo'))}</button><button class="btn" data-act="sheet-close">${esc(t('Close'))}</button></div>`, { label: t('Receipt photo'), onClose: () => URL.revokeObjectURL(url) });
  },
  'tx-save': async b => {
    readForm();
    const err = m => { $('#tx-err').textContent = m; };
    if (!(draft.amount > 0 || (draft.split && draft.amount === 0))) { $('#tx-amt')?.setAttribute('aria-invalid', 'true'); $('#tx-amt')?.focus(); return err(amtErr($('#tx-amt')?.value)); }
    if (!validIso(draft.date)) return err(t('Pick a date.'));
    if (draft.date > today() && !draft.bill) return err(t("That date hasn't come yet. Pick today or an earlier day."));
    if (draft.type === 'transfer' && (!draft.toAccountId || draft.toAccountId === draft.accountId)) return err(t('Pick two different accounts.'));
    if ($('#tx-toamt') && !(draft.toAmount > 0)) { $('#tx-toamt').focus(); return err(t('Enter the amount that arrived.')); }
    const isNew = !S.tx.some(x => x.id === draft.id);
    if (isNew && draft.type === 'expense') {
      const dup = findDuplicate(draft, S.tx);
      if (dup && !(await confirmSheet({ title: t('Already added?'), body: t('{0} for {1} on {2} is already here.', dup.merchant || catLabel(dup.category), fmtRM(dup.amount), fmtDate(dup.date)), ok: t('Add anyway') }))) return;
    }
    b.disabled = true;
    const x = { ...draft, createdAt: draft.createdAt || Date.now() }, was = S.tx.find(y => y.id === x.id);
    await saveTx(x);
    { const L = on('subcats') && learnSub(S.kv.subRules, x); if (L) await setKv('subRules', L); }   // this shop's subcategory, next time
    if (was) await keepToday(was, -1);   // an edit: the old version's move out, the new one's in
    await keepToday(x);   // an old receipt doesn't change the balance typed today
    await rateFrom(x);
    if (x.merchant && x.type === 'expense' && !x.items?.length) await learn(x.merchant, x.category);
    closeSheet(); landed(x.id); render();
    const first = isNew && firstWord('entry');
    toast(first || (isNew ? t('Added {0}', fmtAcct(accOf(x.accountId), x.amount)) : t('Saved')), { icon: 'check', ...(first ? { k: 'good', cheer: true } : {}) });
  },
  'tx-again': () => { readForm(); const { type, amount, category, accountId, merchant } = draft; closeSheet(); setTimeout(() => openTxSheet({ type, amount, category, accountId, merchant }), 220); },
  'tx-del': async () => {
    // A split bill goes with its friends' shares (what they owe for it), in the same write.
    const shares = S.tx.filter(y => y.splitOf === draft.id), owed = shares.reduce((s, y) => s + y.amount, 0);
    // Paid back for this bill and nothing left to settle: that payback goes too (or shrinks to what another bill still owes).
    const { drop, trim } = leftOverPaybacks(S.tx, [draft.id, ...shares.map(y => y.id)]), was = trim.map(y => S.tx.find(z => z.id === y.id));
    const paid = drop.reduce((s, y) => s + y.amount, 0) + was.reduce((s, y, i) => s + y.amount - trim[i].amount, 0);
    if (!(await confirmSheet({ title: t('Delete this?'), body: `${draft.merchant || catLabel(draft.category)} · ${fmtAcct(accOf(draft.accountId), draft.amount)}${shares.length ? `. ${t("Your friends' shares ({0} owed to you) are deleted too.", fmtRM(owed))}` : ''}${paid ? ` ${t('What was paid back for it ({0}) is taken off too.', fmtRM(paid))}` : ''}`, ok: t('Delete'), danger: true }))) return;
    const gone = [S.tx.find(y => y.id === draft.id), ...shares, ...drop].filter(Boolean), undo = await deleteTxs(gone.map(y => y.id));
    if (trim.length) await saveTxs(trim);
    for (const x of [...gone, ...was]) await keepToday(x, -1);   // a back-dated entry moved the starting balance when it came in: move it back
    for (const x of trim) await keepToday(x);
    closeSheet(); render();
    toast(t('Deleted'), { undo: async () => { await undo(); if (was.length) await saveTxs(was); for (const x of trim) await keepToday(x, -1); for (const x of [...gone, ...was]) await keepToday(x); render(); } });
  },
  'bill-edit': b => billSheet(S.recurring.find(x => x.id === b.dataset.id) || { accountId: defaultAccount('bill'), category: 'bills' }),
  'tx-photo-dl': () => downloadReceipts([{ tx: draft }]),
  'act-dl': () => {
    const list = cached(latestFirst, scopedTx()).filter(matches), what = F.ids ? F.idsLabel : F.q || (F.month && (F.month.startsWith('y') ? F.month.slice(1) : fmtMonth(F.month, startDay()))) || '';
    return downloadReceipts(list.map(tx => ({ tx })), `tally-receipts ${what || today()}`.trim());
  },
  'act-photo': () => { F.photo = !F.photo; F.limit = 200; refilter(); },
  'act-ids': () => { F.ids = null; refilter(); },
  'bill-add-suggested': b => { const r = recurringCandidates(S.tx).find(x => x.key === b.dataset.key); if (r) billSheet({ name: r.merchant, amount: r.amount, day: r.day, category: ['groceries', 'dining', 'other'].includes(r.category) ? 'bills' : r.category, accountId: defaultAccount('bill'), key: r.key }); },
  'bill-save': async b => {
    const amount = calcAmount($('#b-amt').value), name = $('#b-name').value.trim(), start = $('#b-date').value, until = $('#b-until').value || undefined;
    const count = Math.min(600, parseInt($('#b-count').value, 10) || 0) || undefined, err = m => ($('#b-err').textContent = m);
    if (!name) return err(t('Give the bill a name.'));
    if (!amount || amount <= 0) { $('#b-amt').setAttribute('aria-invalid', 'true'); return err(amtErr($('#b-amt').value)); }
    $('#b-amt').removeAttribute('aria-invalid');
    if (!validIso(start)) return err(t('Pick a date.'));
    if (until && !(validIso(until) && until >= start)) return err(t('The end date must be after the next payment.'));
    const old = S.recurring.find(x => x.id === b.dataset.id) || {};
    // Due on the 31st, shown as the 30th in a shorter month: the month's last day keeps the day it was set to.
    const picked = +start.slice(8), day = picked === new Date(+start.slice(0, 4), +start.slice(5, 7), 0).getDate() && old.day > picked ? old.day : picked;
    // Saving re-bases the bill on its next payment: dates and "payments left" count from there.
    await saveBill({ ...old, id: old.id || uid('b'), name, amount, day, start, freq: $('#b-freq').value, count, until, auto: $('#b-auto').checked, category: $('#b-cat').value, accountId: $('#b-acc').value, key: b.dataset.key || billKey(name) });
    closeSheet(); render(); toast(t('Saved'));
  },
  'bill-del': async b => { await deleteBill(b.dataset.id); closeSheet(); render(); toast(t('Deleted')); },
  // Paid by hand: dated on the day it was due, from the bill's own account, tagged so it isn't mistaken for everyday spending.
  'bill-paid': b => {
    const x = S.recurring.find(y => y.id === b.dataset.id); if (!x) return;
    openTxSheet({ amount: x.amount, category: x.category || 'bills', accountId: S.accounts.some(a => a.id === x.accountId) ? x.accountId : defaultAccount('bill'), merchant: x.name, bill: x.id, date: b.dataset.d || billStatus(x, today(), S.tx).date || today(), time: '' });
  },
  'bill-cal': b => {
    const x = S.recurring.find(y => y.id === b.dataset.id);
    openSheet(`<h2 class="sh-title">${esc(x.freq === 'weekly' || x.freq === 'yearly' ? t('Remind me before it is due') : t('Remind me every month'))}</h2><p class="sh-body">${esc(t('Your phone calendar reminds you a day before {0} is due, even when Tally is closed.', x.name))}</p>
      <a class="btn wide" href="${esc(googleUrl(billEv(x)))}" target="_blank" rel="noopener">${esc(t('Add to Google Calendar'))}</a>
      <button class="btn ghost wide" data-act="bill-ics" data-id="${esc(x.id)}">${esc(t('Download calendar file (iPhone, Outlook)'))}</button>`, { label: t('Reminder') });
  },
  'bill-ics': b => { const x = S.recurring.find(y => y.id === b.dataset.id); download(`tally-bill-${safeId(x.id)}.ics`, ics([billEv(x)]), 'text/calendar'); },
};
