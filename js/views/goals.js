// Savings goals: a name, a target, maybe a date and the account the money sits in (kv 'goals'). Progress is that
// account's balance; with a date, what a month gets there. On Home (a compact card) and in Settings → Accounts.
import { S, today, booked, setKv, uid, scopedAccounts, defaultAccount, bookGeneration } from '../state.js';
import { t, fmtMonth } from '../i18n.js';
import { esc, ICON, MASK, balHidden, openSheet, closeSheet, confirmSheet, toast } from '../ui.js';
import { balances, goalProgress, calcAmount, tooLarge, validIso, fmtAcct, owing } from '../engine.js';
import { cleanText } from '../io.js';
import { on } from '../features.js';
import { shareSheet } from '../share.js';

const goals = () => S.kv.goals || [];
const acctOf = g => S.accounts.find(a => a.id === g.accountId);
/** Add money: an ordinary transfer into the goal's account, so only an account that can hold a goal and is in the view
 *  (joint/business) gets the button. No account (or one deleted): it asks where the money is kept first. */
export function goalCanAdd(g, all, scoped) {
  const a = all.find(x => x.id === g.accountId);
  return !a || (goalAccounts([a]).length > 0 && scoped.some(x => x.id === a.id));
}
const addBtn = g => (goalCanAdd(g, S.accounts, scopedAccounts())
  ? `<button class="btn small ghost goaladd" data-act="goal-add" data-id="${esc(g.id)}" aria-label="${esc(`${t('Add money')}: ${g.name}`)}">${ICON.plus}${esc(t('Add money'))}</button>` : '');
/** The account the money comes from: the preferred everyday one if it can be, else the first that can; never the goal's own
 *  account, a card or an owed account; the goal account's currency first. '' = none. */
export function goalFrom(accounts, toId, preferred) {
  const cur = a => a?.currency || 'MYR', to = accounts.find(a => a.id === toId);
  const ok = accounts.filter(a => a.id !== toId && a.kind !== 'card' && !owing(a)), same = ok.filter(a => cur(a) === cur(to)), pool = same.length ? same : ok;
  return (pool.find(a => a.id === preferred) || pool[0])?.id || '';
}
/** What the transfer sheet opens with: the goal's account as To, the note says which goal (the amount is left to type). */
export const goalAddPreset = (g, accounts, preferred) => {
  const from = goalFrom(accounts, g.accountId, preferred);
  return { type: 'transfer', category: 'other', ...(from ? { accountId: from } : {}), toAccountId: g.accountId, merchant: cleanText(t('Goal: {0}', g.name), 80) };
};
/** Progress counts entries after the balance was typed, so an account that never had one gets a line saying so. */
export const goalAddNote = a => a?.typed === false;
/** Point a goal at its account (what "Where is this money kept?" saves). false: the goal or the account is gone. */
export async function linkGoal(id, accountId) {
  const a = S.accounts.find(x => x.id === accountId);
  if (!goals().some(g => g.id === id) || !a || !goalAccounts([a]).length) return false;
  await setKv('goals', goals().map(g => (g.id === id ? { ...g, accountId } : g)));
  return true;
}
/** The line under a goal: what a month gets there, reached, past its date, or what is left. */
function goalLine(g, p, hide) {
  const money = v => (hide ? MASK : fmtAcct(acctOf(g), v));
  return p.reached ? t("You're there!") : p.overdue ? t('Past its date: {0} to go', money(p.left))
    : p.months ? t('{0} a month gets you there by {1}', money(p.perMonth), fmtMonth(g.by.slice(0, 7))) : t('{0} to go', money(p.left));
}
/** Home: each goal with a thin bar (the bar stays when the balance is hidden; the amounts don't). Nothing without goals. */
export function goalsCard() {
  if (!on('goals') || !goals().length) return '';
  const bal = balances(S.accounts, booked()).by, hide = balHidden(), tdy = today();
  return `<section class="card goals"><h2>${esc(t('Goals'))}</h2><ul class="goallist">${goals().map(g => {
    const p = goalProgress(g, bal, tdy), pct = Math.round(p.pct * 100);
    const share = p.reached ? `<button class="icon-btn" data-act="goal-share" data-id="${esc(g.id)}" aria-label="${esc(t('Share'))}">${ICON.share}</button>` : '', acts = addBtn(g) + share;
    // The row opens the goal (edit); the share button stays its own button beside it (no button inside a button).
    return `<li class="goalrow"><button class="goalbtn" data-act="goal-edit" data-id="${esc(g.id)}" aria-label="${esc(`${t('Edit goal')}: ${g.name}`)}"><span class="rowb"><b>${esc(g.name)}</b><span class="num fine">${esc(hide ? MASK : `${fmtAcct(acctOf(g), Math.max(0, p.have))} / ${fmtAcct(acctOf(g), g.target)}`)}</span></span>
      <span class="meter${p.overdue ? ' warn' : ''}" role="img" aria-label="${esc(t('{0}% saved', pct))}"><i style="width:${pct}%"></i></span><small class="fine">${esc(goalLine(g, p, hide))}</small></button>${acts ? `<div class="goalact">${acts}</div>` : ''}</li>`;
  }).join('')}</ul></section>`;
}
/** Settings → Accounts: the goals, each opening its sheet, and Add. */
export function goalsSettings() {
  if (!on('goals')) return '';
  return `<h3>${esc(t('Savings goals'))}</h3>${goals().length ? `<ul class="list">${goals().map(g => `<li><button class="txrow" data-act="goal-edit" data-id="${esc(g.id)}"><span class="grow"><b>${esc(g.name)}</b><small>${esc([fmtAcct(acctOf(g), g.target), g.by && fmtMonth(g.by.slice(0, 7)), acctOf(g)?.name].filter(Boolean).join(' · '))}</small></span><span class="fine">${esc(t('Edit'))}</span></button>${addBtn(g) ? `<div class="goalact">${addBtn(g)}</div>` : ''}</li>`).join('')}</ul>` : ''}
    <button class="btn ghost wide" data-act="goal-edit">${ICON.plus}${esc(t('Add a savings goal'))}</button>`;
}
/** The accounts a goal can sit in: any but a card (it owes, it doesn't hold), savings first. */
export const goalAccounts = accounts => accounts.filter(a => a.kind !== 'card' && !owing(a)).sort((a, b) => (b.kind === 'savings') - (a.kind === 'savings'));
/** Which account the sheet starts on. An existing goal keeps its own. A new one is never guessed, except when only one
 *  account could hold it: then there is nothing to choose between. '' = none picked. */
export const goalPick = (g, accts) => (g.id ? g.accountId || '' : accts.length === 1 ? accts[0].id : '');
/** Saving with no account, or one with nothing in it (balance 0 or never typed): the bar would sit at 0. 'none' | 'empty' | null. */
export function goalNotice(accountId, accounts, bal) {
  if (!accountId) return 'none';
  const a = accounts.find(x => x.id === accountId);
  return !a || a.typed === false || !(bal[accountId] > 0) ? 'empty' : null;
}
/** A savings account made over a sheet comes back picked in its account select. Returns the stop function. */
function keepNewPicked(el, selId, blank) {
  const added = e => {
    const a = S.accounts.find(x => x.id === e.detail), sel = el.querySelector(selId);
    if (!a || !sel || !goalAccounts([a]).length) return;
    sel.innerHTML = accOptions(goalAccounts(S.accounts), a.id, blank);
  };
  document.addEventListener('tally:account-added', added);
  return () => document.removeEventListener('tally:account-added', added);
}
const accOptions = (accts, pick, blank) => `<option value="">${esc(blank)}</option>${accts.map(a => `<option value="${esc(a.id)}"${a.id === pick ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}`;
/** Add or edit a goal. "Saved in" comes right after the name and is chosen on purpose: progress is that account's balance. */
function goalSheet(g = {}) {
  const accts = goalAccounts(S.accounts), pick = goalPick(g, accts), blank = g.id ? t('Not linked to an account') : t('Choose an account');
  const el = openSheet(`<h2 class="sh-title">${esc(g.id ? t('Edit goal') : t('Add a savings goal'))}</h2>
    <label class="field"><span>${esc(t('Name'))}</span><input id="g-name" maxlength="30" autocomplete="off" value="${esc(g.name || '')}" placeholder="${esc(t('e.g. Emergency fund, Hari Raya, a new phone'))}"${g.id ? '' : ' autofocus'}></label>
    <label class="field"><span>${esc(t('Saved in'))}</span><select id="g-acc">${accOptions(accts, pick, blank)}</select>
      <small>${esc(t("Progress is this account's balance. Money you put into it fills the bar."))}</small></label>
    <button type="button" class="btn ghost wide" data-x="newacc">${ICON.plus}${esc(t('Create a savings account'))}</button>
    <div class="grid2 keep2"><label class="field"><span>${esc(t('Target (RM)'))}</span><input id="g-amt" inputmode="decimal" autocomplete="off" aria-describedby="g-err" value="${g.target ? (g.target / 100).toFixed(2) : ''}" placeholder="0.00"></label>
    <label class="field"><span>${esc(t('By (optional)'))}</span><input id="g-by" data-optional type="date" min="1990-01-01" value="${esc(g.by || '')}"></label></div>
    <p class="err" id="g-err" role="alert"></p>
    <div class="row2">${g.id ? `<button class="btn ghost danger" data-x="del">${esc(t('Delete'))}</button>` : `<button class="btn ghost" data-act="sheet-close">${esc(t('Cancel'))}</button>`}<button class="btn" data-x="save">${esc(t('Save'))}</button></div>`, { label: t('Savings goals'), onClose: () => stop() });
  // A savings account made from here opens over this sheet (what was typed stays) and comes back picked.
  const stop = keepNewPicked(el, '#g-acc', blank);
  el.addEventListener('click', async e => {
    const x = e.target.closest('[data-x]')?.dataset.x, { render } = await import('../app.js');
    if (x === 'newacc') return (await import('./setup.js')).act['acc-edit']({ dataset: { kind: 'savings', stack: '1' } });
    if (x === 'del') {
      if (!(await confirmSheet({ title: t('Delete this goal?'), body: g.name, ok: t('Delete'), danger: true }))) return;
      await setKv('goals', goals().filter(y => y.id !== g.id)); closeSheet(); render(); return toast(t('Deleted'));
    }
    if (x !== 'save') return;
    const name = cleanText(el.querySelector('#g-name').value, 30), target = calcAmount(el.querySelector('#g-amt').value), by = el.querySelector('#g-by').value, accountId = el.querySelector('#g-acc').value;
    const err = m => { el.querySelector('#g-err').textContent = m; };
    err('');
    if (!name) return err(t('Give the goal a name.'));
    if (!(target > 0)) return err(tooLarge(el.querySelector('#g-amt').value) ? t('That amount is too large (RM 100 million at most).') : t('Enter an amount, for example 12.50.'));
    if (by && !validIso(by)) return err(t('Pick a date.'));
    if (!g.id && goals().length >= 20) return err(t('20 goals is the most Tally keeps.'));   // what a backup restores
    // Not blocking: the goal can be saved as it is. Asked for a new goal or a changed account, not on every later edit.
    const why = !g.id || accountId !== (g.accountId || '') ? goalNotice(accountId, S.accounts, balances(S.accounts, booked()).by) : null;
    if (why && !(await confirmSheet({ title: t('This will show RM 0 until money is in the account'), ok: t('Save anyway'), no: t('Pick an account'),
      body: why === 'none' ? t('No account is picked, so the goal stays at RM 0. Pick the account the money sits in.') : t('That account has nothing in it yet, so the goal starts at RM 0. It fills as money goes in.') }))) return el.querySelector('#g-acc').focus();
    const goal = { id: g.id || uid('g'), name, target, ...(by ? { by } : {}), ...(accountId ? { accountId } : {}), createdAt: g.createdAt || Date.now() };
    await setKv('goals', g.id ? goals().map(y => (y.id === g.id ? goal : y)) : [...goals(), goal]);
    closeSheet(); render(); toast(t('Saved'), { icon: 'check' });
  });
}
/** "Where is this money kept?" for a goal with no account: pick one or make a savings account, then carry on to the transfer. */
function whereSheet(g) {
  const gen = bookGeneration(), accts = goalAccounts(scopedAccounts()), blank = t('Choose an account');
  const el = openSheet(`<h2 class="sh-title">${esc(t('Where is this money kept?'))}</h2><p class="sh-body">${esc(g.name)}</p>
    <label class="field"><span>${esc(t('Saved in'))}</span><select id="gw-acc" aria-describedby="gw-err">${accOptions(accts, goalPick({}, accts), blank)}</select></label>
    <button type="button" class="btn ghost wide" data-x="newacc">${ICON.plus}${esc(t('Create a savings account'))}</button>
    <p class="err" id="gw-err" role="alert"></p>
    <div class="row2 sheetfoot"><button class="btn ghost" data-act="sheet-close">${esc(t('Cancel'))}</button><button class="btn" data-x="go">${esc(t('Continue'))}</button></div>`, { label: t('Where is this money kept?'), onClose: () => stop() });
  const stop = keepNewPicked(el, '#gw-acc', blank), err = m => { el.querySelector('#gw-err').textContent = m; };
  el.addEventListener('click', async e => {
    const b = e.target.closest('[data-x]'), x = b?.dataset.x;
    if (x === 'newacc') return (await import('./setup.js')).act['acc-edit']({ dataset: { kind: 'savings', stack: '1' } });
    if (x !== 'go') return;
    const id = el.querySelector('#gw-acc').value;
    err('');
    if (!id) return err(t('Pick the account the money is kept in.'));
    if (bookGeneration() !== gen) return err(t('The entry changed on your phone. Refresh and try again.'));
    b.disabled = true;
    try { if (!(await linkGoal(g.id, id))) { b.disabled = false; return err(t('Pick the account the money is kept in.')); } }
    catch (error) { console.error(error); b.disabled = false; return err(t('Could not save. Your phone may be out of space.')); }
    const { render } = await import('../app.js');
    closeSheet(); render(); setTimeout(() => addMoney(g.id), 220);
  });
}
/** Add money: the ordinary transfer sheet, To = the goal's account, From = the everyday account, note naming the goal. */
async function addMoney(id) {
  const { openTxSheet } = await import('./money.js'), g = goals().find(x => x.id === id), a = g && acctOf(g);
  if (!g) return;
  if (!a || !goalAccounts([a]).length) return whereSheet(g);
  openTxSheet(goalAddPreset(g, S.accounts, defaultAccount('quick', { typedExpense: true, currency: a.currency || 'MYR' })));
  if (goalAddNote(a)) toast(t("This goal counts only money added after you set this account's balance."));
}
export const act = {
  'goal-add': b => addMoney(b.dataset.id),
  'goal-edit': b => goalSheet(goals().find(g => g.id === b.dataset.id) || {}),
  // A reached goal as a picture: its name and a full bar (the amount only if the sharer turns it on).
  'goal-share': b => { const g = goals().find(x => x.id === b.dataset.id); if (g) shareSheet('goal', { id: g.id, name: g.name, target: g.target }); },
};
