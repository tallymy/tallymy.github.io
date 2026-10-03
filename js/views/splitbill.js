// Split a bill with friends: tap a person, tap what they had; anything left untapped is shared by everyone. Tax, service
// charge and rounding are spread over the items first (as in Insights), so the shares add up to what was paid, to the sen.
// The result goes out as a picture or as text (WhatsApp), and "Save my share" records it: the bill becomes my share, the
// friends' shares money owed (engine OWING_KINDS). The names are remembered for next time.
import { S, settings, setSetting, cat, putAll, uid, today as todayIso, bookGeneration } from '../state.js';
import { get as getRecord } from '../db.js';
import { t, fmtDate } from '../i18n.js';
import { esc, openSheet, closeSheet, toast } from '../ui.js';
import { fmtRM, allocate, isFx, calcAmount, validIso } from '../engine.js';
import { typedShift } from '../io.js';
import { send, caption } from '../share.js';

/** splitBill, and what each person had of each item: {owe: {id: sen}, parts: {id: [sen per item]}}, parts summing to owe. */
export function splitShares(items, total, who, people) {
  // A line marked `extra` (tax & service) that nobody tapped isn't shared as a line: it's spread over the rest by size.
  const live = items.map((it, n) => !it.extra || (who[n] || []).some(p => people.includes(p)));
  const kept = items.filter((_, n) => live[n]);
  const extra = allocate(kept.map(i => i.cents), total - kept.reduce((s, i) => s + i.cents, 0));
  const owe = Object.fromEntries(people.map(p => [p, 0])), parts = Object.fromEntries(people.map(p => [p, items.map(() => 0)]));
  let k = -1;
  items.forEach((it, n) => {
    if (!live[n]) return;
    k += 1;
    const by = who[n]?.length ? who[n].filter(p => p in owe) : people, cost = it.cents + extra[k];
    if (!by.length) return;
    const each = Math.trunc(cost / by.length);
    // The odd sen of each item starts one person further along, so over a long receipt it isn't always the same one's.
    allocate(by.map(() => 1), cost - by.length * each).forEach((r, k) => { const p = by[(k + n) % by.length]; owe[p] += each + r; parts[p][n] += each + r; });
  });
  return { owe, parts };
}
/** items [{name, cents}], total (sen), who: [[person ids] per item, empty = everyone], people [ids] → {id: sen}. */
export const splitBill = (items, total, who, people) => splitShares(items, total, who, people).owe;

export const ME = '__me';
/** A split entry as it was before the split (to split it again): what was paid, its items, the account that paid. */
export function original(tx) {
  if (!tx.split) return tx;
  const { split, owedTo, items, ...o } = tx;
  return { ...o, amount: split.total, ...(split.acc ? { accountId: split.acc } : {}), ...(split.items ? { items: split.items } : {}) };
}
/** The lines the sheet splits: the receipt's items plus a tax & service line, or the payment as one. */
export const linesOf = o => {
  if (!o.items?.length) return [{ name: o.merchant || t(cat(o.category).name), cents: o.amount }];
  const lines = o.items.map(i => ({ name: i.name || t(cat(i.category).name), cents: i.cents }));
  const left = o.amount - lines.reduce((s, i) => s + i.cents, 0);
  // ponytail: a negative difference (rounding down, a discount) has no line; it just spreads by size as before.
  if (left > 0) lines.push({ name: t('Tax & service'), cents: left, extra: true });
  return lines;
};
const OWING_NAME = { owedme: 'Owed to you', iowe: 'You owe' };
/**
 * "Save my share" as one write for putAll ({accounts, tx, del}). The bill becomes my share: its amount, and my part of
 * each item (the ones I had none of left out), so spending and reliefs count only mine. I paid: each friend's share is a
 * transfer from the paying account to Owed to you, so that account's balance doesn't move. A friend paid: my share is
 * owed to them (the bill moves to You owe; the others settle with them). Split again: the old shares go first.
 */
export function splitRows({ tx, people, who, paidBy = ME, paid, shop = tx.merchant || '', accounts = S.accounts, txs = S.tx, today = todayIso(), now = Date.now() }) {
  const o = original(tx), { owe, parts } = splitShares(linesOf(o), o.amount, who, people), friends = people.filter(p => p !== ME);
  // `paid` ({person: sen} summing to the bill): who put money down at the counter. Each person's debt is their share
  // less what they put down. I'm short: my debt goes to the friend who put down the most over their share (several
  // overpaid: they settle between themselves, like the other friends always did). I'm over: the short friends owe me.
  const paidMap = paid || { [paidBy]: o.amount };
  if (Object.entries(paidMap).some(([p, v]) => !people.includes(p) || !Number.isSafeInteger(v) || v < 0) || Object.values(paidMap).reduce((s, v) => s + v, 0) !== o.amount) throw new Error('paid must add up to the bill');
  const net = p => (owe[p] || 0) - (paidMap[p] || 0), myNet = net(ME), friendPaid = myNet > 0;
  const payer = friendPaid ? friends.reduce((a, b) => (net(b) < net(a) ? b : a)) : null;
  const made = [], acct = kind => accounts.find(a => a.kind === kind) || made.find(a => a.kind === kind)
    || made[made.push({ id: uid('a'), name: OWING_NAME[kind], kind, opening: 0, createdAt: now, updatedAt: now }) - 1];   // never `typed`: no balance to keep
  const mine = o.items?.length ? o.items.map(({ qty, unit, ...i }, n) => ({ ...i, cents: parts[ME][n] })).filter(i => i.cents) : [];
  const { items, owedTo, split, ...base } = o;
  const bill = { ...base, amount: owe[ME], ...(mine.length ? { items: mine } : {}),
    split: { total: o.amount, with: friends, who: who.map(w => w.map(p => (p === ME ? '' : p))), ...(items?.length ? { items } : {}),
      ...(paid ? { paid: Object.fromEntries(Object.entries(paidMap).filter(([, v]) => v > 0).map(([p, v]) => [p === ME ? '' : p, v])) } : {}),
      ...(friendPaid ? { acc: o.accountId } : {}) },
    ...(friendPaid ? { accountId: acct('iowe').id, owedTo: payer } : {}) };
  const short = friends.map(f => Math.max(0, net(f))), take = friendPaid ? [] : allocate(short, -myNet);
  const shares = friendPaid ? [] : friends.flatMap((f, j) => (take[j] > 0 ? [{ id: uid('t'), type: 'transfer', date: o.date, ...(o.time ? { time: o.time } : {}), amount: take[j],
    accountId: o.accountId, toAccountId: acct('owedme').id, category: 'other', merchant: `${f} · ${shop}`.slice(0, 80), owedBy: f, splitOf: o.id, source: 'quick', createdAt: now }] : []));
  // A friend covered the bill and I put some down at the counter: that much of my debt is already paid.
  const down = friendPaid && paidMap[ME] > 0 ? [{ id: uid('t'), type: 'transfer', date: o.date, ...(o.time ? { time: o.time } : {}), amount: paidMap[ME],
    accountId: o.accountId, toAccountId: acct('iowe').id, category: 'other', merchant: `${payer} · ${shop}`.slice(0, 80), repaidTo: payer, splitOf: o.id, source: 'quick', createdAt: now }] : [];
  // A balance typed today already holds the back-dated entries (state keepToday): an account's starting balance moves by
  // what this changes in it before that day, in the same write. Paid by me, it nets to nothing.
  const old = txs.filter(x => x.splitOf === tx.id), rest = txs.filter(x => x.id !== tx.id && x.splitOf !== tx.id), typed = accounts.filter(a => a.typed);
  const was = typedShift(typed, rest, [tx, ...old], today), is = typedShift(typed, rest, [bill, ...shares, ...down], today);
  const moved = typed.filter(a => (is[a.id] || 0) !== (was[a.id] || 0)).map(a => ({ ...a, opening: (a.opening || 0) + (is[a.id] || 0) - (was[a.id] || 0), updatedAt: now }));
  return { accounts: [...made, ...moved], tx: [bill, ...shares, ...down], del: { tx: old.map(x => x.id) } };
}
/** splitRows, written all or nothing. */
export async function saveSplit(o, guard = null) {
  if (!guard) return putAll({ ...splitRows(o), edit: true });
  const stale = () => Object.assign(Error('The entry changed on your phone. Refresh and try again.'), { code: 'STALE' });
  const shape = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
  const accounts = structuredClone(o.accounts || S.accounts), txs = structuredClone(o.txs || S.tx), base = guard.expected;
  const shares = guard.shares || [];
  const live = txs.find(x => x.id === base?.id), liveShares = txs.filter(x => x.splitOf === base?.id).sort((a, b) => a.id.localeCompare(b.id));
  if (!base || shape(live) !== shape(base) || shape(liveShares) !== shape([...shares].sort((a, b) => a.id.localeCompare(b.id))) || guard.generation !== bookGeneration()) throw stale();
  const settingsRecord = await getRecord('kv', 'settings');
  if (shape(settingsRecord?.value || {}) !== shape(settings())) throw stale();
  const rows = splitRows({ ...o, tx: base, accounts, txs });
  const touched = new Set([base.accountId, base.toAccountId, ...rows.tx.flatMap(x => [x.accountId, x.toAccountId]), ...rows.accounts.map(a => a.id), ...shares.flatMap(x => [x.accountId, x.toAccountId])].filter(Boolean));
  return putAll({ ...rows, edit: true, expected: {
    tx: [{ id: base.id, value: base }, ...shares.map(row => ({ id: row.id, value: row }))],
    accounts: [...touched].map(id => ({ id, value: accounts.find(a => a.id === id) })),
    kv: [{ id: 'settings', value: settingsRecord ?? undefined }, { id: 'bookGeneration', value: guard.generation == null ? undefined : { key: 'bookGeneration', value: guard.generation } }],
  } });
}

export function openSplit(tx) {
  tx = structuredClone(tx);
  const guard = { expected: structuredClone(tx), shares: structuredClone(S.tx.filter(x => x.splitOf === tx.id)), generation: bookGeneration() };
  const o = original(tx), items = linesOf(o), sp = tx.split;
  // Split before: the same people, who had what and who paid, to change and save again.
  const people = sp ? [ME, ...sp.with] : [ME, ...(settings().friends || []).slice(0, 3)];
  const who = items.map((_, n) => (sp?.who?.[n] || []).map(p => (p === '' ? ME : p)).filter(p => people.includes(p)));
  let current = people[1] || ME;
  // Who put money down at the counter: usually one person, the whole bill; more, each with an amount (split.paid).
  let payers = sp?.paid ? Object.keys(sp.paid).map(p => (p === '' ? ME : p)).filter(p => people.includes(p)) : [people.includes(tx.owedTo) ? tx.owedTo : ME];
  if (!payers.length) payers = [ME];
  const paidAmt = {};
  if (sp?.paid) for (const [p, v] of Object.entries(sp.paid)) paidAmt[p === '' ? ME : p] = v;
  // One payer paid it all; with more, the first picks up what the others' typed amounts leave over.
  const rebalance = () => {
    if (payers.length === 1) { paidAmt[payers[0]] = o.amount; return; }
    for (const p of payers) paidAmt[p] = paidAmt[p] || 0;
    const left = o.amount - payers.slice(1).reduce((s, p) => s + paidAmt[p], 0);
    if (left >= 0) paidAmt[payers[0]] = left;
  };
  rebalance();
  const paidOf = p => (payers.length > 1 ? paidAmt[p] || 0 : p === payers[0] ? o.amount : 0);
  const name = p => (p === ME ? t('Me') : p);
  const chip = (p, on, data) => `<button type="button" class="chip${on ? ' on' : ''}" ${data}="${esc(p)}" aria-pressed="${on}">${esc(name(p))}</button>`;
  const body = () => {
    const owe = splitBill(items, o.amount, who, people), paidSum = people.reduce((s, p) => s + paidOf(p), 0);
    const myNet = owe[ME] - paidOf(ME), top = myNet > 0 ? people.filter(p => p !== ME).reduce((a, b) => (owe[b] - paidOf(b) < owe[a] - paidOf(a) ? b : a)) : null;
    return `<div class="chips" role="group" aria-label="${esc(t('Who'))}">${people.map(p => chip(p, p === current, 'data-p')).join('')}
      <input id="sp-new" class="chip sp-new" maxlength="20" placeholder="${esc(t('+ Name'))}" aria-label="${esc(t('Add a person'))}" autocomplete="off"></div>
      <p class="fine">${esc(t('Tap a person, then what they had; tap the same thing as more than one person to share it. Anything not tapped is shared by everyone. Tap a name again to take them off.'))}</p>
      ${people.length > 1 ? `<div class="sp-paid" role="group" aria-label="${esc(t('Paid by'))}"><span class="fine">${esc(t('Paid by'))}</span><div class="chips">${people.map(p => chip(p, payers.includes(p), 'data-by')).join('')}</div></div>
      ${payers.length > 1 ? `<div class="grid2 keep2">${payers.map(p => `<label class="field"><span>${esc(t('{0} paid (RM)', name(p)))}</span><input class="sp-amt" data-pa="${esc(p)}" inputmode="decimal" autocomplete="off" value="${((paidAmt[p] || 0) / 100).toFixed(2)}"></label>`).join('')}</div>
      ${paidSum !== o.amount ? `<p class="err" role="alert">${esc(t('What everyone paid must add up to {0}.', fmtRM(o.amount)))}</p>` : ''}` : ''}` : ''}
      <ul class="relief sp-items">${items.map((it, n) => `<li><button type="button" class="rbtn${who[n].includes(current) ? ' on' : ''}" data-i="${n}" aria-pressed="${who[n].includes(current)}"><span class="rowb"><b>${esc(it.name)}</b><span class="num">${esc(fmtRM(it.cents))}</span></span>
        <small>${esc(who[n].length ? who[n].map(name).join(', ') : it.extra ? t('With the food') : t('Everyone'))}</small></button></li>`).join('')}</ul>
      <ul class="list sp-sum">${people.map(p => `<li class="rowb"><span>${esc(name(p))}${payers.includes(p) && people.length > 1 ? ` <small class="pill">${esc(t('paid'))}</small>` : ''}</span><b class="num">${esc(fmtRM(owe[p]))}</b></li>`).join('')}
        ${people.length > 1 && myNet !== 0 ? `<li class="rowb sp-owed"><span>${esc(myNet < 0 ? t('Owed to you') : t('You owe {0}', top))}</span><b class="num">${esc(fmtRM(Math.abs(myNet)))}</b></li>` : ''}</ul>`;
  };
  // A share in another currency would land in the RM accounts of what is owed: that one is shared, not saved.
  // ponytail: RM only; convert at the account's rate if people split bills abroad.
  const canSave = !isFx(S.accounts.find(a => a.id === o.accountId));
  const el = openSheet(`<h2 class="sh-title">${esc(t('Split with friends'))}</h2><p class="fine">${esc(`${o.merchant || ''} · ${fmtDate(o.date)} · ${fmtRM(o.amount)}`)}</p>
    <div class="sp-body">${body()}</div>
    <div class="sheetfoot sp-foot"><div class="row2"><button class="btn ghost" data-x="text">${esc(t('Copy text'))}</button><button class="btn ghost" data-x="img">${esc(t('Share picture'))}</button></div>
    ${canSave ? `<button class="btn wide" data-x="save">${esc(t('Save my share'))}</button>` : ''}</div>`, { label: t('Split with friends') });
  const redraw = () => { el.querySelector('.sp-body').innerHTML = body(); };
  const addPerson = async v => {
    v = v.trim().slice(0, 20); if (!v || people.includes(v) || people.length >= 8) return;
    people.push(v); current = v;
    await setSetting('friends', [v, ...(settings().friends || []).filter(x => x !== v)].slice(0, 12));   // remembered for next time
    redraw(); el.querySelector('#sp-new')?.focus();
  };
  el.addEventListener('keydown', e => { if (e.target.id === 'sp-new' && e.key === 'Enter') { e.preventDefault(); addPerson(e.target.value); } });
  el.addEventListener('change', e => {
    if (e.target.id === 'sp-new') return addPerson(e.target.value);
    if (e.target.classList.contains('sp-amt')) {
      const p = e.target.dataset.pa, v = calcAmount(e.target.value);
      paidAmt[p] = Math.max(0, Math.min(o.amount, v || 0));
      if (p !== payers[0]) rebalance();   // typing a friend's amount: mine picks up the rest
      redraw();
    }
  });
  el.addEventListener('click', async e => {
    const pb = e.target.closest('[data-p]'), by = e.target.closest('[data-by]'), ib = e.target.closest('[data-i]'), xb = e.target.closest('[data-x]'), x = xb?.dataset.x;
    if (pb) {
      const p = pb.dataset.p;
      if (p === current && p !== ME) {   // tapping the picked person again takes them off the bill
        people.splice(people.indexOf(p), 1);
        who.forEach(w => { const k = w.indexOf(p); if (k >= 0) w.splice(k, 1); });
        payers = payers.filter(q => q !== p); delete paidAmt[p];
        if (!payers.length) payers = [ME];
        rebalance(); current = ME;
      } else current = p;
      redraw(); return;
    }
    if (by) {
      const p = by.dataset.by, k = payers.indexOf(p);
      if (k < 0) payers.push(p); else if (payers.length > 1) payers.splice(k, 1);
      rebalance(); redraw(); return;
    }
    if (ib) { const w = who[+ib.dataset.i], k = w.indexOf(current); if (k < 0) w.push(current); else w.splice(k, 1); redraw(); return; }
    if (!x) return;
    const owe = splitBill(items, o.amount, who, people), myNet = owe[ME] - paidOf(ME);
    if (x === 'save') {
      const paid = payers.length > 1 ? Object.fromEntries(payers.map(p => [p, paidAmt[p] || 0])) : null;
      if (paid && Object.values(paid).reduce((s, v) => s + v, 0) !== o.amount) return toast(t('What everyone paid must add up to {0}.', fmtRM(o.amount)), { k: 'bad' });
      xb.disabled = true;
      try { await saveSplit({ tx, people, who, paidBy: payers[0], ...(paid ? { paid } : {}) }, guard); }
      catch (err) {
        console.error(err); xb.disabled = false;
        return toast(err?.code === 'STALE' ? t('The entry changed on your phone. Refresh and try again.') + ' ' + t('Close this form and reopen the entry before saving.') : t('Could not save. Your phone may be out of space.'), { k: err?.code === 'STALE' ? 'warn' : 'bad' });
      }
      closeSheet(); (await import('../app.js')).render();
      const top = myNet > 0 ? people.filter(p => p !== ME).reduce((a, b) => (owe[b] - paidOf(b) < owe[a] - paidOf(a) ? b : a)) : null;
      toast(myNet > 0 ? t('Saved. You owe {0}: {1}', top, fmtRM(myNet)) : t('Saved. Your share: {0}. Owed to you: {1}', fmtRM(owe[ME]), fmtRM(-myNet)), { icon: 'check' });
    }
    if (x === 'text') {
      const text = [`${o.merchant || t('Bill')} · ${fmtDate(o.date)} · ${fmtRM(o.amount)}`, ...people.map(p => `${name(p)}: ${fmtRM(owe[p])}`), t('Split with Tally · tallymy.github.io')].join('\n');
      try { await navigator.clipboard.writeText(text); toast(t('Copied. Paste it in your chat.'), { k: 'good', icon: 'check' }); } catch { toast(text); }
    }
    if (x === 'img') {
      const blob = await picture(o, items, who, people, owe, name);
      if (blob) await send(blob, `tally-split-${o.date}`, o.merchant || t('Bill'), caption('split'));
    }
  });
}

/** The split as a picture to send: the bill, then each person with what they had and what they owe. */
function picture(tx, items, who, people, owe, name) {
  const W = 720, pad = 40, lh = 36;
  const c = Object.assign(document.createElement('canvas'), { width: W, height: pad + (people.length * 2 + 2) * lh + 24 }), g = c.getContext('2d');
  g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, c.width, c.height);
  let y = pad + 16;
  const line = (left, right, { size = 24, weight = 400, color = '#0F172A' } = {}) => {
    g.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif`; g.fillStyle = color; g.textAlign = 'left';
    g.fillText(left.length > 40 ? `${left.slice(0, 39)}…` : left, pad, y);
    if (right) { g.textAlign = 'right'; g.fillText(right, W - pad, y); }
    y += lh;
  };
  line(`${tx.merchant || t('Bill')} · ${fmtDate(tx.date, { year: true })}`, fmtRM(tx.amount), { size: 28, weight: 700 });
  y += 8;
  for (const p of people) {
    line(name(p), fmtRM(owe[p]), { size: 26, weight: 700, color: '#1E40AF' });
    line(items.filter((it, n) => (who[n].length ? who[n] : it.extra ? [] : people).includes(p)).map(i => i.name).join(', ') || t('Nothing'), '', { size: 20, color: '#55607A' });
  }
  line(t('Split with Tally · tallymy.github.io'), '', { size: 18, color: '#8A94A8' });
  return new Promise(r => c.toBlob(r, 'image/png'));
}

/** A repayment, including an optional treat, as a single atomic write. Values are integer sen. */
export function repayRows({ kind, name, amount, total, boxId, accountId, date, treat = false, accounts = S.accounts, txs = S.tx, today = todayIso(), now = Date.now(), note = t('My treat') }) {
  if (!['owedme', 'iowe'].includes(kind) || !Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(amount) || amount < 0 || amount > total || (!amount && !(treat && kind === 'owedme')) || (treat && kind !== 'owedme') || !validIso(date) || date > today) throw new Error('Invalid repayment');
  if (!accounts.some(a => a.id === boxId && a.kind === kind && !isFx(a)) || !accounts.some(a => a.id === accountId && !['owedme', 'iowe'].includes(a.kind) && !isFx(a))) throw new Error('Invalid repayment account');
  const back = kind === 'owedme', tx = [];
  const transfer = value => ({ id: uid('t'), type: 'transfer', date, amount: value, accountId: back ? boxId : accountId, toAccountId: back ? accountId : boxId, category: 'other', merchant: name, [back ? 'repaidBy' : 'repaidTo']: name, source: 'quick', createdAt: now });
  if (amount) tx.push(transfer(amount));
  if (treat && total > amount) {
    tx.push(transfer(total - amount));
    tx.push({ id: uid('t'), type: 'expense', date, amount: total - amount, accountId, category: 'other', merchant: name, note, source: 'quick', createdAt: now });
  }
  const typed = accounts.filter(a => a.typed), shift = typedShift(typed, txs, tx, today);
  return { tx, accounts: typed.filter(a => shift[a.id]).map(a => ({ ...a, opening: (a.opening || 0) + shift[a.id], updatedAt: now })), edit: true };
}

/** The debt and payments the repayment sheet showed when it opened. */
export const repaymentBase = (kind, name, txs = S.tx) => structuredClone(txs.filter(x => kind === 'owedme'
  ? x.owedBy === name || x.repaidBy === name : x.owedTo === name || x.repaidTo === name));
/** Commit the repayment and any historical typed-balance adjustment against the same account snapshots. */
export async function saveRepayment(o, guard = null) {
  if (!guard) { const rows = repayRows(o); await putAll(rows); return rows; }
  const stale = () => Object.assign(Error('The entry changed on your phone. Refresh and try again.'), { code: 'STALE' });
  const shape = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
  const accounts = structuredClone(o.accounts || S.accounts), txs = structuredClone(o.txs || S.tx);
  const order = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id));
  if (guard.generation !== bookGeneration() || shape(order(repaymentBase(o.kind, o.name, txs))) !== shape(order(guard.tx))) throw stale();
  const rows = repayRows({ ...o, accounts, txs }), touched = new Set([o.boxId, o.accountId, ...rows.accounts.map(a => a.id)]);
  await putAll({ ...rows, expected: {
    tx: guard.tx.map(row => ({ id: row.id, value: row })),
    accounts: [...touched].map(id => ({ id, value: accounts.find(a => a.id === id) })),
    kv: [{ id: 'bookGeneration', value: guard.generation == null ? undefined : { key: 'bookGeneration', value: guard.generation } }],
  } });
  return rows;
}
