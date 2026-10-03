// Insights analytics: the month-end forecast (this month, near the top) and cards below it, each closed to one line
// with its headline figure. Sums come from engine.js; every chart has its numbers in text next to it or in a hidden table.
import { S, booked, today, startDay, thisMonth, scope, hasJoint, budgetsFor, inScope, settings, cat, cached, scopedAccounts } from '../state.js';
import { t, fmtDate, fmtMonth, cycleShort, getLang, langTag } from '../i18n.js';
import { esc, short, ICON, openSheet, closeSheet, lineChart, balHidden, MASK, toast } from '../ui.js';
import { fmtRM, addDays, addMonths, cycleSpan, monthIncomes, monthSpends, forecast, perMonth, billStatus, recurringCandidates, fixedFlexible, dailySpend, whenGrid, topShops, paymentMix, savingsRate, foodSplit, taxPaid, jointIn, taxRelief, priceHistory, basketIndex,
  categoryItems, subSplit, shopPrices, next30, paydayEffect, firstSpend, billChanges, openShares, cpiChange, yearReview, affordMoney, owing, monthOf, monthSpend, cycleKey, daysBetween } from '../engine.js';
import { CPI } from '../cpi.js';
import { catLabel, showIds, downloadReceipts, showCategory } from './money.js';
import { receiptName, csvLine } from '../io.js';
import { on } from '../features.js';
import { shareSheet, monthName, stickerDays } from '../share.js';
import { loggedDays } from '../gamify.js';
import { filledDays, loadBook, panelOf } from '../comic.js';

const OPEN = new Set();   // cards opened stay open across re-renders (a scope or month change)
const card = (id, title, head, body) => `<details class="card acard"${OPEN.has(id) ? ' open' : ''}><summary data-act="acard" data-id="${id}"><span class="grow"><span class="lbl">${esc(title)}</span><b>${esc(head)}</b></span><span class="chev" aria-hidden="true"></span></summary>${body}</details>`;
const pct = x => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(Math.round(x * 1000) / 10)}%`;
const later = msg => `<p class="fine">${esc(msg)}</p>`;
/** A bar split into parts [{label, v, color}] with a legend carrying the amounts (colour is never the only signal). */
function split(parts, label) {
  const tot = parts.reduce((s, p) => s + p.v, 0) || 1, on = parts.filter(p => p.v > 0);
  return `<div class="sbar" role="img" aria-label="${esc(`${label}: ${on.map(p => `${p.label} ${fmtRM(p.v)}`).join(', ')}`)}">${on.map(p => `<i style="flex:${p.v};background:${p.color}"></i>`).join('')}</div>
    <ul class="slegend">${parts.map(p => `<li><span class="key" style="background:${p.color}"></span><span class="grow">${esc(p.label)}</span><span class="num">${esc(fmtRM(p.v))}</span><span class="fine">${Math.round(p.v / tot * 100)}%</span></li>`).join('')}</ul>`;
}
/** Horizontal bars for a short ranked list [{name, v, text}]. */
const hbars = (rows, max) => `<ol class="hbars">${rows.map(r => `<li><span class="grow">${esc(r.name)}</span><span class="num">${esc(r.text)}</span><i style="width:${Math.max(3, Math.round(r.v / (max || 1) * 100))}%" aria-hidden="true"></i></li>`).join('')}</ol>`;
const weekStart = () => (settings().weekStart === 0 ? 0 : 1);
const dayName = (w, style = 'short') => new Intl.DateTimeFormat(langTag(), { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + w)));   // 1 Jan 2023 was a Sunday
const billShops = () => { const known = S.recurring.filter(b => inScope(b)).map(b => b.key); return [...known, ...cached(recurringCandidates, booked(), known).map(r => r.key)]; };
// Worked out once per data change (state.js cached): these take the transactions first.
const forecastOf = (txs, o) => forecast({ txs, ...o });

// ---- 3. month-end forecast ---------------------------------------------------------------------------------------------------
export function forecastCard() {
  const B = budgetsFor().total, f = cached(forecastOf, booked(), { today: today(), startDay: startDay(), budget: B, bills: S.recurring.filter(b => inScope(b)) });
  const head = `<span class="lbl">${esc(t('Month-end forecast'))}</span>`;
  if (!f.spent && !f.rate) return `<section class="card fcast">${head}${later(t('Appears after a few days of spending.'))}</section>`;
  const pace = f.projected - f.spent - f.upcoming, max = Math.max(f.projected, B) || 1, at = Math.min(100, B / max * 100);
  const w = v => `${(v / max * 100).toFixed(2)}%`;
  const parts = [[t('Spent so far'), f.spent, 'spent'], [t('Bills still due'), f.upcoming, 'due'], [t('At your usual pace'), pace, 'pace']];
  return `<section class="card fcast">${head}
    <div class="rowb"><b class="big num">${esc(fmtRM(f.projected))}</b>${B ? `<span class="pill ${f.projected > B ? 'bad' : 'good'}">${esc(f.projected > B ? t('{0} over budget', fmtRM(f.projected - B)) : t('{0} under budget', fmtRM(B - f.projected)))}</span>` : ''}</div>
    <p class="fine">${esc(t('Expected by {0}', fmtDate(f.end)))}</p>
    <div class="fbar" role="img" aria-label="${esc(`${parts.map(([l, v]) => `${l} ${fmtRM(v)}`).join(', ')}${B ? `, ${t('Budget')} ${fmtRM(B)}` : ''}`)}">
      <div class="sbar">${parts.filter(p => p[1] > 0).map(([, v, k]) => `<i class="${k}" style="width:${w(v)}"></i>`).join('')}</div>
      ${B ? `<span class="mark${at > 70 ? ' end' : ''}" style="left:${at.toFixed(2)}%"><span>${esc(t('Budget'))} ${esc(short(B))}</span></span>` : ''}</div>
    <ul class="slegend">${parts.map(([l, v, k]) => `<li><span class="key ${k}"></span><span class="grow">${esc(l)}</span><span class="num">${esc(fmtRM(v))}</span></li>`).join('')}</ul>
    ${f.safe != null ? `<p class="safe"><span class="lbl">${esc(t('Budget left per day'))}</span><b class="num">${esc(t('{0} a day', fmtRM(f.safe)))}</b><small>${esc(f.daysLeft === 0 ? t('for today only') : t('for {0} days, today included', f.daysLeft + 1))}</small></p>` : ''}
    <p class="fine">${esc(t('Spent so far, bills still due, and your everyday pace. One-off big buys count once.'))}${f.early ? ` ${esc(t('Your usual spending is from {0} days of entries so far, so it is a rough guess.', f.days))}` : ''}</p></section>`;
}

// ---- 4. fixed vs flexible ----------------------------------------------------------------------------------------------------
function fixedCard(M) {
  const sd = startDay(), ff = cached(fixedFlexible, booked(), M, sd, billShops()), tdy = today();
  const known = S.recurring.filter(b => inScope(b) && billStatus(b, tdy, S.tx).next).map(b => ({ name: b.name, v: perMonth(b) }));
  const found = cached(recurringCandidates, booked(), S.recurring.map(b => b.key)).map(r => ({ name: r.merchant, v: r.amount }));
  const regular = [...known, ...found].sort((a, b) => b.v - a.v), perMo = regular.reduce((s, r) => s + r.v, 0);
  const body = ff.fixed + ff.flexible ? split([{ label: t('Bills and subscriptions'), v: ff.fixed, color: 'var(--warn)' }, { label: t('Day to day'), v: ff.flexible, color: 'var(--accent)' }], t('Fixed and flexible spending')) : later(t('No spending in {0}.', fmtMonth(M, sd)));
  // A subscription's price going up shows here before it shows in the month's total.
  const changed = cached(billChanges, booked(), [...S.recurring.filter(b => inScope(b)).map(b => ({ id: b.id, name: b.name, key: b.key })), ...cached(recurringCandidates, booked(), S.recurring.map(b => b.key)).map(r => ({ name: r.merchant, key: r.key }))]);
  return card('fixed', t('Fixed vs flexible'), ff.fixed + ff.flexible ? t('Fixed {0} · flexible {1}', fmtRM(ff.fixed), fmtRM(ff.flexible)) : t('No spending yet'), `${body}
    ${regular.length ? `<h3>${esc(t('Bills and subscriptions: {0} a month, {1} a year', fmtRM(perMo), fmtRM(perMo * 12)))}</h3>${hbars(regular.slice(0, 6).map(r => ({ ...r, text: t('{0} · {1} a year', fmtRM(r.v), fmtRM(r.v * 12)) })), regular[0].v)}${found.length ? `<p class="fine">${esc(t('Includes {0} Tally spotted that are not set up as bills yet.', found.length))}</p>` : ''}` : later(t('Bills you add in Budgets, and ones Tally spots, are listed here.'))}
    ${changed.length ? `<h3>${esc(t('Price changes'))}</h3><ul class="list">${changed.slice(0, 4).map(c => `<li class="rowb"><span class="grow">${esc(c.name)}<small>${esc(fmtDate(c.date))}</small></span><span class="num ${c.to > c.from ? 'bad' : 'good'}">${c.to > c.from ? '▲' : '▼'} ${esc(t('{0} to {1}', fmtRM(c.from), fmtRM(c.to)))}</span></li>`).join('')}</ul>` : ''}`);
}

// ---- 5. when and where -------------------------------------------------------------------------------------------------------
const SLOTS = () => [t('Morning'), t('Afternoon'), t('Evening'), t('Late night')];
function whenCard(M) {
  const sd = startDay(), span = cycleSpan(M, sd), days = cached(dailySpend, booked(), M, sd), ws = weekStart();
  const end = M === thisMonth() ? today() : span.end, wg = cached(whenGrid, booked(), addDays(end, -89), end), shops = cached(topShops, booked(), M, sd);
  const lead = (new Date(`${span.start}T00:00:00Z`).getUTCDay() - ws + 7) % 7, order = Array.from({ length: 7 }, (_, i) => (ws + i) % 7);
  const spentDays = days.filter(d => d.v);
  const cal = spentDays.length ? `<div class="cal" aria-hidden="true">${order.map(w => `<span class="wd">${esc(dayName(w, 'narrow'))}</span>`).join('')}${'<span></span>'.repeat(lead)}${days.map(d => `<span class="d l${d.level}"><b>${+d.date.slice(8)}</b><small>${d.v ? esc(short(d.v)) : ''}</small></span>`).join('')}</div>
    <p class="legendrow" aria-hidden="true">${esc(t('Less'))}${[1, 2, 3, 4].map(l => `<span class="key l${l}"></span>`).join('')}${esc(t('More'))}</p>
    <table class="sr"><caption>${esc(t('Spending by day'))}</caption>${spentDays.map(d => `<tr><th>${esc(fmtDate(d.date))}</th><td>${esc(fmtRM(d.v))}</td></tr>`).join('')}</table>` : later(t('No spending in {0}.', fmtMonth(M, sd)));
  const gmax = Math.max(0, ...wg.grid.flat()), lvl = v => (v ? Math.ceil(v / gmax * 4) : 0);
  const grid = gmax ? `<table class="wgrid"><caption class="fine">${esc(t('Everyday spending by time, last 90 days'))}</caption><thead><tr><td></td>${SLOTS().map(s => `<th scope="col">${esc(s)}</th>`).join('')}</tr></thead>
    <tbody>${order.map(w => `<tr><th scope="row">${esc(dayName(w))}</th>${wg.grid[w].map(v => `<td class="l${lvl(v)}">${v ? esc(short(v)) : '<span class="nil">·</span>'}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : later(t('Appears once entries have a time of day.'));
  const head = wg.late.n >= 2 ? t('Late-night food delivery: {0} in 90 days', fmtRM(wg.late.v))
    : wg.top ? t('Most on {0} {1}: {2}', dayName(wg.top.w), SLOTS()[wg.top.s].toLowerCase(), catLabel(wg.top.category))
      : shops.money[0] ? t('Most at {0}: {1}', shops.money[0].name, fmtRM(shops.money[0].v)) : t('No spending yet');
  const shopHtml = shops.money.length ? `<div class="two"><div><h3>${esc(t('Top shops by money'))}</h3>${hbars(shops.money.map(s => ({ ...s, text: fmtRM(s.v) })), shops.money[0].v)}</div>
    <div><h3>${esc(t('Top shops by visits'))}</h3>${hbars(shops.visits.map(s => ({ ...s, v: s.n, text: `${s.n}×` })), shops.visits[0].n)}</div></div>` : '';
  // The week after payday against the rest of the pay period: only worth saying when it really is different.
  const pd = cached(paydayEffect, booked(), today());
  const payday = pd && pd.ratio >= 1.25 ? `<p class="callout">${esc(t('In the week after payday you spend {0}× your usual week: {1} against {2}.', (Math.round(pd.ratio * 10) / 10).toLocaleString(langTag()), fmtRM(pd.after), fmtRM(pd.usual)))}</p>` : '';
  return card('when', t('When and where'), head, `${payday}<h3>${esc(fmtMonth(M, sd))}</h3>${cal}${grid}${shopHtml}`);
}

// ---- 6. payment mix and savings rate ------------------------------------------------------------------------------------------
const KINDS = { cash: ['Cash', '#65A30D'], bank: ['Bank account', '#2563EB'], ewallet: ['E-wallet', '#D946EF'], card: ['Credit card', '#F97316'], savings: ['Savings', '#06B6D4'] };
/** Savings rate per month as bars from a zero line, each labelled with its %. */
function rateBars(rows, label) {
  const W = 340, H = 140, T = 18, B = 22, rs = rows.map(r => (r.rate == null ? 0 : Math.max(-1, Math.min(1, r.rate))));
  const hi = Math.max(0.05, ...rs), lo = Math.max(0, ...rs.map(r => -r)), y0 = T + (H - T - B) * hi / (hi + lo), bw = (W - 16) / rows.length;
  let g = `<line x1="8" x2="${W - 8}" y1="${y0.toFixed(1)}" y2="${y0.toFixed(1)}" stroke="var(--line)"/>`;
  rows.forEach((r, i) => {
    const v = rs[i], h = Math.abs(v) / (hi + lo) * (H - T - B), x = 8 + i * bw + bw * 0.2, y = v >= 0 ? y0 - h : y0, cx = (8 + i * bw + bw / 2).toFixed(1);
    if (r.rate != null) g += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.6).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="2" fill="var(--chart-${v < 0 ? 'bad' : 'good'})"/>`;
    g += `<text x="${cx}" y="${(v >= 0 ? y - 4 : y + h + 12).toFixed(1)}" text-anchor="middle" font-size="11" fill="var(--ink)">${r.rate == null ? '–' : esc(pct(r.rate).replace('+', ''))}</text>`;
    g += `<text x="${cx}" y="${H - 5}" text-anchor="middle" font-size="11" fill="var(--mute)">${esc(r.label)}</text>`;
  });
  return `<svg class="chartsvg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${label}: ${rows.map(r => `${r.label} ${r.rate == null ? '–' : pct(r.rate)}`).join(', ')}`)}">${g}</svg>`;
}
function payCard(M) {
  const sd = startDay(), mix = cached(paymentMix, booked(), S.accounts, M, sd);
  const yms = Array.from({ length: 6 }, (_, k) => addMonths(M, k - 5)), ins = cached(monthIncomes, booked(), yms, sd), outs = cached(monthSpends, booked(), yms, sd);
  const months = yms.map(m => { const i = ins[m], o = outs[m].total; return { m, label: cycleShort(m, sd), rate: savingsRate(i, o), i, o }; });
  const now = months.at(-1), has = months.some(r => r.i || r.o);
  const head = now.rate == null ? t('No money in yet this month') : now.rate >= 0 ? t('Kept {0}% of money in', Math.round(now.rate * 100)) : t('Spent {0} more than came in', fmtRM(now.o - now.i));
  const parts = Object.entries(KINDS).map(([k, [n, c]]) => ({ label: t(n), v: mix[k] || 0, color: c })).filter(p => p.v);
  return card('pay', t('Payment mix and savings'), head, `<h3>${esc(t('Paid with'))}</h3>${parts.length ? split(parts, t('Paid with')) : later(t('No spending in {0}.', fmtMonth(M, sd)))}
    <h3>${esc(t('Savings rate'))}</h3>${has ? rateBars(months, t('Savings rate')) : later(t('Appears after money in and out are added.'))}
    <p class="fine">${esc(t('(money in − money out) ÷ money in, each month.'))}</p>`);
}

// ---- 7. eating out vs cooking --------------------------------------------------------------------------------------------------
function foodCard(M) {
  const sd = startDay(), f = cached(foodSplit, booked(), M, sd), out = f.dining + f.delivery;   // SST and charges: their own card
  const body = f.groceries + out ? split([{ label: t('Groceries (cooking)'), v: f.groceries, color: cat('groceries').color }, { label: t('Dining out'), v: f.dining, color: cat('dining').color }, { label: t('Delivery'), v: f.delivery, color: '#DB2777' }], t('Food')) : later(t('Appears after some food spending.'));
  return card('food', t('Eating out vs cooking'), f.groceries + out ? t('Eating out {0} · cooking {1}', fmtRM(out), fmtRM(f.groceries)) : t('No food spending yet'), `${body}
    <p class="fine">${esc(t('Delivery: GrabFood, foodpanda, ShopeeFood and the like.'))}</p>`);
}

// ---- fees: SST and charges over the year -----------------------------------------------------------------------------------------
function feesCard(M) {
  const year = M.slice(0, 4), tx = cached(taxPaid, booked(), year), fees = tx.sst + tx.service, y = cached(yearReview, booked(), year);
  const end = year === today().slice(0, 4) ? today() : `${year}-12-31`, from = cached(firstSpend, booked()) > `${year}-01-01` ? cached(firstSpend, booked()) : `${year}-01-01`, perDay = from <= end ? y.spent / (daysBetween(from, end) + 1) : 0, worth = perDay ? Math.round(fees / perDay) : 0;
  return card('fees', t('SST and charges in {0}', year), tx.n ? t('{0} in SST and charges', fmtRM(fees)) : t('Nothing found yet for {0}', year), tx.n
    ? `<p class="rowb"><span>${esc(t('SST'))} <b class="num">${esc(fmtRM(tx.sst))}</b></span><span>${esc(t('Service, delivery and app fees'))} <b class="num">${esc(fmtRM(tx.service))}</b></span></p>
      ${worth >= 1 ? `<p class="callout">${esc(worth === 1 ? t('About 1 day of your usual spending.') : t('About {0} days of your usual spending.', worth))}</p>` : ''}<p class="fine">${esc(t('From {0} receipts that show them.', tx.n))}</p>`
    : later(t('Appears when scanned receipts show SST or a service charge.')));
}

// ---- the same item at different shops --------------------------------------------------------------------------------------------
function shopsCard() {
  const rows = cached(shopPrices, booked(), today()).slice(0, 5), r = rows[0];
  return card('shops', t('Same item, different shops'), r ? t('{0}: {1} less at {2}', r.name, fmtRM(r.save), r.shops[0].shop) : t('Nothing to compare yet'), rows.length
    ? `<ul class="cmp">${rows.map(x => `<li><b>${esc(x.name)}</b><ul class="list">${x.shops.map((s, i) => `<li class="rowb"><span class="grow">${esc(s.shop)}<small>${esc(fmtDate(s.date))}</small></span><span class="num${i === 0 ? ' good' : ''}">${esc(fmtRM(s.unit))}</span></li>`).join('')}</ul></li>`).join('')}</ul>
      <p class="fine">${esc(t('From your own receipts in the last 6 months: the price on the day you last bought it at each shop.'))}</p>`
    : later(t('Appears when you buy the same item at two shops.')));
}

// ---- friends: who owes what, and since when ---------------------------------------------------------------------------------------
function owedCard() {
  const o = openShares(booked()), tdy = today(), sum = l => l.reduce((s, f) => s + f.sen, 0);
  if (!o.owedMe.length && !o.iOwe.length) return '';
  const age = f => (f.since ? daysBetween(f.since, tdy) : 0), oldest = l => [...l].sort((a, b) => age(b) - age(a));
  const row = (f, mine) => `<li class="rowb"><span class="grow"><b>${esc(f.name)}</b><small>${esc(age(f) ? t('for {0} days', age(f)) : t('since today'))}</small></span><span class="num">${esc(fmtRM(f.sen))}</span>${mine
    ? `<button class="btn small ghost" data-act="friend-remind" data-name="${esc(f.name)}">${ICON.chat}${esc(t('Remind'))}</button>` : ''}</li>`;
  return card('owed', t('Between friends'), [o.owedMe.length && t('Owed to you {0}', fmtRM(sum(o.owedMe))), o.iOwe.length && t('You owe {0}', fmtRM(sum(o.iOwe)))].filter(Boolean).join(' · '),
    `${o.owedMe.length ? `<h3>${esc(t('Owed to you'))}</h3><ul class="list">${oldest(o.owedMe).map(f => row(f, true)).join('')}</ul>` : ''}${o.iOwe.length ? `<h3>${esc(t('You owe'))}</h3><ul class="list">${oldest(o.iOwe).map(f => row(f, false)).join('')}</ul>` : ''}
    <p class="fine">${esc(t('Edit the message, then choose an app to share it. Tally sends nothing itself.'))}</p>`);
}

/** A personal draft only: sharing happens after the user edits and chooses Share. */
export function openReminder(friend) {
  const message = t('Hi {0}, a small reminder: {1} for the bill we split. Thanks!', friend.name, fmtRM(friend.sen));
  const canShare = typeof navigator.share === 'function';
  const sheet = openSheet(`<h2 class="sh-title">${esc(t('Remind'))}</h2><p class="fine">${esc(t('Edit the message, then choose an app to share it. Tally sends nothing itself.'))}</p>
    <label class="field"><span>${esc(t('Reminder message'))}</span><textarea id="reminder-draft" rows="6">${esc(message)}</textarea></label>
    <p class="err" id="reminder-error" role="alert"></p><div class="row2 sheetfoot"><button class="btn ghost" id="reminder-cancel">${esc(t('Cancel'))}</button><button class="btn" id="reminder-share"${canShare ? '' : ' hidden'}>${ICON.share}${esc(t('Share'))}</button><button class="btn${canShare ? ' ghost' : ''}" id="reminder-copy"${canShare ? ' hidden' : ''}>${esc(t('Copy message'))}</button></div>`, { label: t('Remind') });
  const draft = sheet.querySelector('#reminder-draft'), share = sheet.querySelector('#reminder-share'), copy = sheet.querySelector('#reminder-copy'), error = sheet.querySelector('#reminder-error');
  let busy = false;
  const update = () => { share.disabled = copy.disabled = busy || !draft.value.trim(); };
  draft.addEventListener('input', update); update();
  sheet.querySelector('#reminder-cancel').onclick = () => closeSheet();
  share.onclick = async () => {
    if (busy || !draft.value.trim()) return;
    busy = true; update(); error.textContent = '';
    try { await navigator.share({ text: draft.value }); }
    catch (e) {
      if (e?.name !== 'AbortError') { error.textContent = t('Could not share. Try copying the message instead.'); copy.hidden = false; }
    } finally { busy = false; update(); }
  };
  copy.onclick = async () => {
    if (busy || !draft.value.trim()) return;
    busy = true; update(); error.textContent = '';
    try { await navigator.clipboard.writeText(draft.value); toast(t('Copied. Paste it in your chat.')); }
    catch { error.textContent = t('Could not copy. Select the message and copy it.'); }
    finally { busy = false; update(); }
  };
}

// ---- the next 30 days ------------------------------------------------------------------------------------------------------------
/** What "Can I afford it?" and the next 30 days count: everyday money, and bills (yours and the ones Tally spotted, monthly
 *  on their usual day). counted: an everyday account with a balance given (none: no starting point). */
export function affordInputs() {
  const accts = scopedAccounts(), known = S.recurring.filter(b => inScope(b)), tdy = today();
  const bills = [...known, ...cached(recurringCandidates, booked(), known.map(b => b.key)).map(c => ({ id: `c-${c.key}`, name: c.merchant, amount: c.amount, freq: 'monthly', day: c.day, start: `${monthOf(tdy)}-01` }))];
  return { ...affordMoney(accts, booked()), bills, counted: accts.some(a => a.typed !== false && !owing(a) && a.kind !== 'savings') };
}
const next30Of = (txs, o) => next30({ txs, ...o });
function next30Card() {
  const a = affordInputs(); if (!a.counted) return '';
  const n = cached(next30Of, booked(), { balance: a.balance, today: today(), startDay: startDay(), bills: a.bills, budget: on('budgets') ? budgetsFor().total : 0 }), hide = balHidden(), money = v => (hide ? MASK : fmtRM(v));
  const base = Math.min(...n.days.slice(1).map(d => d.in)), events = n.days.filter(d => d.out || d.in - base > 50), dip = n.days.find(d => d.bal < 0);
  return card('next30', t('Next 30 days'), hide ? t('Lowest on {0}', fmtDate(n.low.date)) : t('Lowest: {0} on {1}', fmtRM(n.low.bal), fmtDate(n.low.date)),
    `${dip ? `<p class="callout bad">${esc(t('You may run short around {0}.', fmtDate(dip.date)))}</p>` : ''}${hide ? '' : lineChart(n.days.map(d => ({ date: d.date, v: d.bal })), { label: t('Your money over the next 30 days') })}
    ${events.length ? `<ul class="list">${events.map(d => `<li class="rowb"><span class="grow">${esc(fmtDate(d.date))}</span>${d.in - base > 50 ? `<span class="num good">+${esc(money(d.in - base))} ${esc(t('pay'))}</span>` : ''}${d.out ? `<span class="num bad">−${esc(money(d.out))} ${esc(t('bills'))}</span>` : ''}</li>`).join('')}</ul>` : ''}
    <p class="fine">${esc(t('Your money today, with pay and bills on their days and your usual everyday spending each day: the same sums as "Can I afford it?".'))}</p>`);
}

// ---- 2. your prices --------------------------------------------------------------------------------------------------------------
function spark(points) {
  const W = 84, H = 28, vs = points.map(p => p.unit), lo = vs.reduce((a, b) => (b < a ? b : a), Infinity), sp = vs.reduce((a, b) => (b > a ? b : a), -Infinity) - lo || 1;   // no spread: one item can be on 125k+ receipts
  const xy = points.map((p, i) => [2 + i / (points.length - 1) * (W - 6), H - 4 - (p.unit - lo) / sp * (H - 8)]);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${xy.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${xy.at(-1)[0].toFixed(1)}" cy="${xy.at(-1)[1].toFixed(1)}" r="3" fill="var(--accent)"/></svg>`;
}
function pricesCard() {
  const hist = cached(priceHistory, booked()), b = basketIndex(hist, today());
  const head = b ? t('Your basket {0} since {1}', pct(b.pct), fmtDate(b.since)) : hist.length ? t('{0} items you buy often', hist.length) : t('Not enough receipts yet');
  const rows = hist.slice(0, 6).map(h => {
    const first = h.points[0].unit, last = h.points.at(-1).unit, ch = (last - first) / first;
    return `<li>${spark(h.points)}<span class="grow"><b>${esc(h.name)}</b><small>${esc(t('{0} buys', h.points.length))}</small><span class="sr">${esc(h.points.map(p => `${fmtDate(p.date)} ${fmtRM(p.unit)}`).join(', '))}</span></span>
      <span class="pr"><b class="num">${esc(fmtRM(last))}</b><small class="${ch > 0.005 ? 'bad' : ch < -0.005 ? 'good' : 'fine'}">${Math.abs(ch) < 0.005 ? esc(t('same')) : `${ch > 0 ? '▲' : '▼'} ${esc(pct(Math.abs(ch)).replace('+', ''))}`}</small></span></li>`;
  }).join('');
  // Malaysia's food prices (DOSM CPI) over about the same months, the nearest ones published
  const my = b && cpiChange(CPI.food, b.since.slice(0, 7), today().slice(0, 7));
  const vs = my ? `<p class="callout">${esc(t("Malaysia's food prices over about the same time: {0} ({1} to {2}).", pct(my.pct), fmtMonth(my.from), fmtMonth(my.to)))}<small>${esc(t('Source: DOSM consumer price index, food and drinks.'))}</small></p>` : '';
  return card('prices', t('Your prices'), head, hist.length ? `${b ? `<p class="fine">${esc(t('Your usual basket ({0} items) at today\'s prices against {1}: {2} then, {3} now.', b.n, fmtDate(b.since), fmtRM(b.then), fmtRM(b.now)))}</p>${vs}` : ''}<ul class="prices">${rows}</ul>`
    : later(t('Appears once an item is on 3 receipts.')));
}

// ---- 1. LHDN tax relief ----------------------------------------------------------------------------------------------------------
const reliefYear = M => M.slice(0, 4);
/** Business accounts: their spending is the business's, never a personal relief. A sorted array, so cached() keys on it. */
const bizIds = () => S.accounts.filter(a => a.scope === 'business').map(a => a.id).sort();
const NOT_RELIEF = ['zakat', 'donation'];   // a rebate and a deduction: listed, not added into the reliefs' total
function reliefCard(M) {
  const year = reliefYear(M), lines = cached(taxRelief, booked(), year, bizIds()), got = lines.filter(l => l.entries.length), total = got.filter(l => !NOT_RELIEF.includes(l.id)).reduce((s, l) => s + l.total, 0);
  const rows = got.map(l => `<li><button class="rbtn" data-act="relief-show" data-id="${esc(l.id)}" data-y="${year}"><span class="rowb"><b>${esc(t(l.name))}</b><span class="num">${esc(fmtRM(l.total))}</span></span>
    <small>${esc(l.entries.length === 1 ? t('1 entry') : t('{0} entries', l.entries.length))} · ${esc(t('{0} with receipt photo', l.proof))}</small></button></li>`).join('');
  const none = lines.filter(l => !l.entries.length).map(l => t(l.name));
  return card('relief', t('Possible tax-relief expenses in {0}', year), got.length ? t('{0} in spending to review', fmtRM(total)) : t('Nothing found yet for {0}', year),
    `${rows ? `<ul class="relief">${rows}</ul>` : ''}${got.some(l => l.proof) ? `<button class="btn ghost" data-act="relief-dl" data-y="${year}">${ICON.download}${esc(t('Download the receipts for {0}', year))}</button>` : ''}${none.length ? `<details class="fine more-cats"><summary>${esc(t('Also looked for'))}</summary>${esc(none.join(', '))}</details>` : ''}
    <p class="fine">${esc(t("Tally matches receipt words, so it can be wrong both ways: it may list things that don't count and miss things that do. Amounts are what you spent, not what you can claim. Each relief has a yearly limit and its own conditions. Zakat is a rebate and donations are a deduction, not reliefs. Rules here follow LHDN's YA 2025 list; YA {0} may differ. Not tax advice. Check LHDN's official list before you file.", year))} <a class="srclink" href="https://www.hasil.gov.my/individu/pelepasan-cukai/" target="_blank" rel="noopener noreferrer">${esc(t('LHDN source: YA 2025 rules'))}</a></p>`);
}

// ---- 8. couples: who put money into the joint account --------------------------------------------------------------------------
function jointCard(M) {
  const sd = startDay(), rows = jointIn(booked(), new Set(S.accounts.filter(a => a.scope === 'joint').map(a => a.id)), M, sd);
  const who = r => (r.me ? settings().myName || t('You') : r.name || t('Your partner'));
  const colors = ['var(--accent)', '#D946EF', 'var(--warn)'];
  return card('joint', t('Into the joint account'), rows.length ? rows.map(r => `${who(r)} ${fmtRM(r.v)}`).join(' · ') : t('Nothing put in yet this month'),
    `${rows.length ? split(rows.map((r, i) => ({ label: who(r), v: r.v, color: colors[i % 3] })), t('Into the joint account')) : ''}<p class="fine">${esc(t('Transfers and income into joint accounts in {0}. Entries from your partner\'s file count as theirs.', fmtMonth(M, sd)))}</p>`);
}

/** The analytics cards for month M, most useful first; one short placeholder for a new user instead of empty charts. */
export function analyticsCards(M) {
  const n = booked().filter(x => x.type === 'expense').length, need = 5;
  // Tax relief doesn't wait for 5 entries: people come to Tally for it at tax time (a zakat payment, a child's books).
  if (n < need) return `<section class="card"><h2>${esc(t('More insights'))}</h2>${later(t('Forecasts, prices, tax relief and more appear after {0} more entries.', need - n))}</section>${on('taxrelief') && cached(taxRelief, booked(), reliefYear(M), bizIds()).some(l => l.entries.length) ? reliefCard(M) : ''}`;
  return [scope() === 'joint' && jointCard(M), M === thisMonth() && next30Card(), owedCard(), fixedCard(M), foodCard(M), feesCard(M), whenCard(M), shopsCard(), payCard(M), pricesCard(), on('taxrelief') && reliefCard(M)].filter(Boolean).join('');
}

// ---- top of Insights: three numbers first, then a picture to share, then the year -----------------------------------------------------
/** Spent, money in and kept in month M; spent against last month (this month: up to the same day of it). */
export function headline(M) {
  const sd = startDay(), all = booked(), pm = addMonths(M, -1), cur = M === thisMonth();
  const spent = cached(monthSpends, all, [M], sd)[M].total, inn = cached(monthIncomes, all, [M], sd)[M];
  const ps = cycleSpan(pm, sd).start, into = daysBetween(cycleSpan(M, sd).start, today());
  const before = cur ? monthSpend(all.filter(x => cycleKey(x.date, sd) !== pm || daysBetween(ps, x.date) <= into), pm, sd).total : cached(monthSpends, all, [pm], sd)[pm].total;
  return { spent, inn, kept: inn - spent, change: before ? (spent - before) / before : null, cur };
}
export function tilesHtml(M) {
  const sd = startDay(), h = headline(M), year = M.slice(0, 4);
  if (!h.spent && !h.inn) return '';
  const ch = h.change == null ? '' : Math.abs(h.change) < 0.005 ? t('same as {0}', cycleShort(addMonths(M, -1), sd)) : `${h.change > 0 ? '▲' : '▼'} ${t('{0} vs {1}', pct(Math.abs(h.change)).replace('+', ''), cycleShort(addMonths(M, -1), sd))}`;
  return `<section class="tiles" aria-label="${esc(fmtMonth(M, sd))}">
    <div class="tile"><span class="lbl">${esc(t('Spent'))}</span><b class="num">${esc(fmtRM(h.spent))}</b>${ch ? `<small class="${h.change > 0.005 ? 'bad' : h.change < -0.005 ? 'good' : ''}">${esc(ch)}${h.cur ? ` ${esc(t('(same day)'))}` : ''}</small>` : ''}</div>
    <div class="tile"><span class="lbl">${esc(t('Money in'))}</span><b class="num">${esc(fmtRM(h.inn))}</b></div>
    ${h.inn ? `<div class="tile"><span class="lbl">${esc(h.kept >= 0 ? t('Kept') : t('Over'))}</span><b class="num ${h.kept >= 0 ? 'good' : 'bad'}">${esc(fmtRM(Math.abs(h.kept)))}</b></div>`
      : `<div class="tile"><span class="lbl">${esc(t('Kept'))}</span><b class="num">–</b><small>${esc(t('when money comes in'))}</small></div>`}</section>
    <div class="tilebar">${mine() ? `<button class="link" data-act="month-share" data-m="${M}">${ICON.share}${esc(t('Share this month'))}</button>` : ''}<button class="link" data-act="year-open" data-y="${year}">${ICON.award}${esc(t('Your {0}', year))}</button></div>`;
}
/** Subcategories are off until wanted: once there is some spending, one card shows what they look like (a drawing, few
 *  words) and turns them on in one tap. Dismissed or on: never again. */
export function subHint() {
  if (on('subcats') || (S.kv.dismissed || []).includes('hint-subcats') || booked().filter(x => x.type === 'expense').length < 10) return '';
  const parts = [['Kopitiam', 180, '#B5533A'], ['Mamak', 120, '#D97706'], ['Delivery', 90, '#DB2777'], ['Café', 30, '#7C3AED']];
  let x = 12; const bars = parts.map(([n, v, col]) => { const w = v / 420 * 296, r = `<rect x="${x.toFixed(1)}" y="64" width="${(w - 3).toFixed(1)}" height="16" rx="4" fill="${col}"/><text x="${(x + 2).toFixed(1)}" y="96" font-size="10" fill="var(--ink)">${esc(t(n))}</text><text x="${(x + 2).toFixed(1)}" y="108" font-size="10" fill="var(--mute)">${v}</text>`; x += w; return r; }).join('');
  const pic = `<svg class="hintpic" viewBox="0 0 320 116" role="img" aria-label="${esc(t('Dining RM 420, split into kopitiam, mamak, delivery and café'))}"><rect x="12" y="10" width="296" height="22" rx="6" fill="${cat('dining').color}"/><text x="20" y="25" font-size="12" font-weight="700" fill="#fff">${esc(t('Dining'))} RM 420</text><path d="M160 36v10m-6-6 6 6 6-6" stroke="var(--mute)" stroke-width="2" fill="none" stroke-linecap="round"/>${bars}</svg>`;
  return `<section class="card hint"><div class="rowb"><b class="grow">${esc(t('Want more detail? Try subcategories'))}</b><button class="icon-btn" data-act="dismiss" data-id="hint-subcats" aria-label="${esc(t('Dismiss'))}">${ICON.x}</button></div>${pic}
    <p class="fine">${esc(t('Split a category into smaller ones, like Dining into kopitiam, mamak and delivery. Pick one when you add an entry.'))}</p><button class="btn small" data-act="subcats-on">${esc(t('Turn on subcategories'))}</button></section>`;
}
/** The year in a few big numbers. */
function yearRows(year) {
  const y = yearReview(booked(), year, settings().noSpend || []);
  return [[t('Spent'), fmtRM(y.spent)], y.income && [t('Money in'), fmtRM(y.income)], y.income && [y.income >= y.spent ? t('Kept') : t('Over'), fmtRM(Math.abs(y.income - y.spent))],
    y.cat && [t('Most went to'), `${catLabel(y.cat.id)} · ${fmtRM(y.cat.v)}`], y.shop && [t('Your most-visited shop'), `${y.shop.name} · ${t('{0} visits', y.shop.n)}`],
    y.item && [t('What you bought most'), `${y.item.name} · ${y.item.n}×`], [t('Days you logged'), String(y.logged)], y.noSpend && [t('Days with nothing spent'), String(y.noSpend)],
    y.fees && [t('SST and charges'), fmtRM(y.fees)]].filter(Boolean);
}
const catInfo = c => ({ label: catLabel(c), color: cat(c).color });
// "Where my money went" is only true of the user's own money: no share picture while the scope holds a joint account's.
const mine = () => !(scope() === 'joint' || (scope() === 'all' && hasJoint()));

export const act = {
  'friend-remind': b => { const friend = openShares(booked()).owedMe.find(f => f.name === b.dataset.name); if (friend) openReminder(friend); },
  acard: b => { const d = b.parentElement, id = b.dataset.id; d.open = !d.open; if (d.open) OPEN.add(id); else OPEN.delete(id); },
  // A category on the donut: what was bought in it (receipt items; payments without one by shop), then its entries.
  'cat-items': b => {
    const c = b.dataset.c, M = b.dataset.m, sd = startDay(), rows = categoryItems(booked(), c, M, sd), subs = on('subcats') ? subSplit(booked(), c, M, sd) : [];
    openSheet(`<div class="sheethead"><h2 class="sh-title">${esc(`${catLabel(c)} · ${fmtMonth(M, sd)}`)}</h2><button class="icon-btn" data-act="sheet-close" aria-label="${esc(t('Close'))}">${ICON.x}</button></div>
      ${subs.some(x => x.sub) ? `<h3>${esc(t('By subcategory'))}</h3>${hbars(subs.map(x => ({ name: x.sub ? t(x.sub) : t('No subcategory'), v: x.v, text: fmtRM(x.v) })), subs[0].v)}<h3>${esc(t('What you bought'))}</h3>` : ''}
      ${rows.length ? hbars(rows.slice(0, 15).map(r => ({ name: r.name, v: r.v, text: r.n > 1 ? t('{0} · {1}×', fmtRM(r.v), r.n) : fmtRM(r.v) })), rows[0].v) : later(t('No spending in {0}.', fmtMonth(M, sd)))}
      ${rows.length > 15 ? later(t('And {0} more.', rows.length - 15)) : ''}<p class="fine">${esc(t('Scanned receipts are split item by item, each with its share of SST and charges. Payments without items show their shop.'))}</p>
      <button class="btn wide" data-act="cat-go" data-c="${esc(c)}" data-m="${M}">${esc(t('See the entries'))}</button>`, { label: catLabel(c) });
  },
  'subcats-on': async () => { const { setModules } = await import('../features.js'); await setModules({ subcats: true }); (await import('../app.js')).render(); },
  'cat-go': b => { closeSheet(); showCategory(b.dataset.c, b.dataset.m); },
  // A month's picture: its categories and the days logged (so far, this month); the stickers of two logged days.
  'month-share': async b => {
    const M = b.dataset.m, sd = startDay(), h = headline(M), span = cycleSpan(M, sd), end = h.cur ? today() : span.end, s = settings();
    const days = loggedDays(S.tx, s.noSpend || [], s.myName || ''), n = daysBetween(span.start, end) + 1;
    let got = 0; for (let d = span.start; d <= end; d = addDays(d, 1)) got += days.has(d);
    const ym = span.end.slice(0, 7), book = await loadBook(ym), dn = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
    const filled = filledDays({ tx: S.tx, noSpend: s.noSpend || [], me: s.myName || '', ym, today: today() });
    shareSheet('month', { ym: M, ...monthName(M, sd), label: fmtMonth(M, sd), change: h.change, prev: monthName(addMonths(M, -1), sd).name, date: sd === 1 ? M : `${span.start.slice(8)}.${span.start.slice(5, 7)}–${span.end.slice(8)}.${span.end.slice(5, 7)}`,
      spent: h.spent, inn: h.inn, byCat: cached(monthSpends, booked(), [M], sd)[M].byCat, info: catInfo, got, n,
      stickers: stickerDays(filled, dn).map(d => book.stickers[panelOf(d, dn)]?.svg).filter(Boolean) });
  },
  'year-open': b => {
    const y = b.dataset.y;
    openSheet(`<div class="sheethead"><h2 class="sh-title">${esc(t('Your {0}', y))}</h2><button class="icon-btn" data-act="sheet-close" aria-label="${esc(t('Close'))}">${ICON.x}</button></div>
      <ol class="yr">${yearRows(y).map(([l, v]) => `<li><span class="lbl">${esc(l)}</span><b>${esc(v)}</b></li>`).join('')}</ol>
      ${mine() ? `<button class="btn wide" data-act="year-share" data-y="${y}">${ICON.share}${esc(t('Share as a picture'))}</button><p class="fine">${esc(t('The picture is made on this phone. Nothing leaves it unless you share it.'))}</p>` : ''}`, { label: t('Your {0}', y) });
  },
  'year-share': b => {
    const y = b.dataset.y, months = Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`), byCat = {};
    for (const m of Object.values(cached(monthSpends, booked(), months, 1))) for (const [c, v] of Object.entries(m.byCat)) byCat[c] = (byCat[c] || 0) + v;
    // Well logged: on 2/3 of the days from the year's first entry (counting from 1 January would punish starting late).
    const r = yearReview(booked(), y, settings().noSpend || []), first = booked().map(x => x.date).filter(d => d.startsWith(y)).sort()[0], end = [today(), `${y}-12-31`].sort()[0];
    shareSheet('year', { year: y, y: r, byCat, info: catInfo, well: !first || r.logged >= (daysBetween(first, end) + 1) * 2 / 3 });
  },
  // Every relief's receipt photos in a folder of its own, with a list of all its entries (photo or not) for the tax form.
  'relief-dl': b => {
    const y = b.dataset.y, byId = new Map(S.tx.map(x => [x.id, x])), taken = new Set(), rows = [], csv = [csvLine(['Relief', 'Date', 'Shop', 'Amount (RM)', 'Photo'])];
    for (const l of cached(taxRelief, booked(), y, bizIds())) for (const e of l.entries) {
      const tx = byId.get(e.id); if (!tx) continue;
      if (tx.receiptId) rows.push({ tx, dir: t(l.name) });
      csv.push(csvLine([t(l.name), e.date, e.merchant || '', (e.cents / 100).toFixed(2), tx.receiptId ? receiptName(tx, taken, t(l.name)) : '']));
    }
    return downloadReceipts(rows, `tally-tax-relief-${y}`, '﻿' + csv.join('\n'));
  },
  'relief-show': b => {
    const l = cached(taxRelief, booked(), b.dataset.y, bizIds()).find(x => x.id === b.dataset.id);
    if (l) showIds(l.entries.map(e => e.id), `${t(l.name)} ${b.dataset.y}`);
  },
};
