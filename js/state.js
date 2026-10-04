// In-memory state over IndexedDB. Views read S; every change goes through a function here so it is saved.
import * as db from './db.js';
import { isNative, mirrorReminderDay } from './native.js';
import { typedShift, CAPS, CAT_CODE, catName, sameCategory, mapCategory } from './io.js';
import { keepReceiptUntil, CATEGORIES, INCOME_CATEGORIES, itemKey, cycleKey, nextColor, pickAccount, balances, isFx, rateOf, toRM, ownCategories, movedCategories, owing } from './engine.js';

export const S = { accounts: [], tx: [], recurring: [], kv: {} };
const KV_KEYS = ['settings', 'budgets', 'rules', 'customCats', 'dismissed', 'lastBackup', 'backupReceipt', 'reviewDraft', 'scanQueue', 'catColors', 'catIcons', 'jointGone', 'shopNames', 'itemNames', 'goals', 'subcats', 'subRules', 'deskPlace', 'bookGeneration'];   // every key setKv writes must be here, or it is lost on restart
export const bookGeneration = () => S.kv.bookGeneration;
const bookGuard = generation => ({ kv: [{ id: 'bookGeneration', value: generation == null ? undefined : { key: 'bookGeneration', value: generation } }] });
const TRANSIENT_KV = ['reviewDraft', 'scanQueue', 'jointGone', 'deskPlace'];

/** Encrypted and not unlocked yet: nothing but the settings is loaded, and nothing may be saved. */
export const locked = () => !!S.kv.settings?.lock?.enc && !db.getKey();
export async function load() {
  const mode = await db.init();
  S.kv.settings = (await db.getKv('settings', null)) || {};
  if (db.getKey() && !db.keyMatches(S.kv.settings.lock?.enc)) db.setKey(null);   // changed in another tab: lock again, never write with an old key
  db.expectSealed(!!S.kv.settings.lock?.enc);
  if (locked()) { [S.accounts, S.tx, S.recurring] = [[], [], []]; for (const k of KV_KEYS) if (k !== 'settings') S.kv[k] = null; }
  else {
    [S.accounts, S.tx, S.recurring] = await Promise.all(['accounts', 'tx', 'recurring'].map(s => db.all(s)));
    for (const k of KV_KEYS) if (k !== 'settings') S.kv[k] = await db.getKv(k, null);
  }
  ownCategories(S.kv.settings.ownCats);
  movedCategories(S.kv.settings.movedCats);
  S.kv.budgets ||= { total: 0, byCat: {} };
  S.kv.rules ||= {};
  S.kv.customCats ||= [];
  for (const c of S.kv.customCats) if (/^#0ea5e9$/i.test(c.color)) c.color = nextColor(S.kv.customCats.map(x => x.color));   // the old first colour looked like Electronics and Bills
  S.kv.dismissed ||= [];
  S.kv.catColors ||= {};
  S.kv.catIcons ||= {};
  S.kv.goals ||= [];
  S.kv.subcats ||= {};
  S.kv.subRules ||= {};
  S.accounts.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  await syncReminderDay();
  return mode;
}
// Settings apply at once (screens read them straight after) and roll back if the save fails.
export async function setKv(k, v) {
  const old = S.kv[k], generation = bookGeneration();
  S.kv[k] = v;
  try {
    if (TRANSIENT_KV.includes(k)) await db.writeAtomic({ put: { kv: [{ key: k, value: v }] }, expected: bookGuard(generation) });
    else await db.setKv(k, v);
  } catch (e) { if (S.kv[k] === v && generation === bookGeneration()) S.kv[k] = old; throw e; }
  if (k === 'settings') await syncReminderDay();
}
export const settings = () => S.kv.settings;
/** Recompute from the complete book after a committed change, including PC/import/restore. */
export async function syncReminderDay() {
  if (!isNative || locked()) return;
  const day = today();
  await mirrorReminderDay({ day, logged: S.tx.some(x => x.type === 'expense' && x.date === day && !x.sample),
    eligible: S.accounts.length > 0 && !settings()?.sample, lang: settings()?.lang || globalThis.document?.documentElement?.lang || 'en' });
}
export const setSetting = (k, v) => setKv('settings', { ...S.kv.settings, [k]: v });

// ---- dates (overridable for tests and demos: ?today=2026-09-28&now=12:50, on this computer only) ----------------
/** The clock override is for local tests and simulations: a shared link to the live site can't move anyone's date. */
export const clockParams = loc => new URLSearchParams(['localhost', '127.0.0.1', '[::1]'].includes(loc?.hostname) ? loc.search : '');
const params = clockParams(globalThis.location);
const pad = n => String(n).padStart(2, '0');
const local = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => (/^\d{4}-\d{2}-\d{2}$/.test(params.get('today') || '') ? params.get('today') : local(new Date()));
export const nowTime = () => (/^\d{2}:\d{2}$/.test(params.get('now') || '') ? params.get('now') : `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`);
/** Transactions up to today, in the current scope. Rows dated later (a statement's future lines) count from their own day, everywhere. */
export const booked = () => { const d = today(), all = scopedTx(); return keep('booked', all, d, () => all.filter(x => x.date <= d)); };

// ---- worked out once per data change -----------------------------------------------------------------------------
// S.tx is replaced, never changed in place, by every save, delete, import and restore, so a result kept with the
// array it came from can't go stale. Screens pass S.tx, scopedTx() or booked() (the same array until the data changes).
const memo = new WeakMap(), last = {};
const keep = (name, src, key, fn) => { const m = last[name]; if (m?.src === src && m.key === key) return m.v; const v = fn(); last[name] = { src, key, v }; return v; };
/** fn(txs, ...args) worked out once per txs array and arguments (JSON), so a re-render or a month tap skips it. Never change what it returns. */
export function cached(fn, txs, ...args) {
  let byFn = memo.get(txs); if (!byFn) memo.set(txs, byFn = new Map());
  let m = byFn.get(fn); if (!m) byFn.set(fn, m = new Map());
  const k = JSON.stringify(args);
  if (!m.has(k)) m.set(k, fn(txs, ...args));
  return m.get(k);
}

// ---- scope: Me · Joint · Business · All (a couple's joint accounts, a stall's or rider's business accounts) -------
export const jointIds = () => new Set(S.accounts.filter(a => a.scope === 'joint').map(a => a.id));
export const hasJoint = () => S.accounts.some(a => a.scope === 'joint');
/** Which money an account holds: 'me' (personal), 'joint' or 'business'. */
export const groupOf = a => (a?.scope === 'joint' || a?.scope === 'business' ? a.scope : 'me');
/** The groups there are accounts for, personal first: ['me'] alone means no switch is shown. */
export const scopes = () => ['me', 'joint', 'business'].filter(g => g === 'me' || S.accounts.some(a => a.scope === g));
/** 'me', 'joint', 'business' or 'all'. With personal accounts only, everything is 'me'. */
export const scope = () => { const g = scopes(); return g.length === 1 ? 'me' : g.includes(S.kv.settings.scope) ? S.kv.settings.scope : 'all'; };
/** A transaction, bill or {accountId} in scope. A transfer between two groups (personal → joint, business → personal:
 *  paying yourself) is in both: money out of one, into the other (balances() only totals the accounts it is given). */
export function inScope(x, sc = scope(), groups = groupMap()) {
  if (sc === 'all') return true;
  const g = id => groups.get(id) || 'me';
  return g(x.accountId) === sc || (x.toAccountId != null && g(x.toAccountId) === sc);
}
const groupMap = () => new Map(S.accounts.map(a => [a.id, groupOf(a)]));
/** Every row in RM: spending and income in an account of another currency at its rate (engine toRM; `fx` keeps its own amount).
 *  Screens read these; saves take rows from S.tx, never from here (stamp refuses a converted row). */
export const rmTx = () => { const r = S.accounts.filter(isFx).map(a => [a.id, rateOf(a)]).filter(([, v]) => v); if (!r.length) return S.tx; const m = new Map(r); return keep('rm', S.tx, JSON.stringify(r), () => S.tx.map(x => (m.has(x.accountId) && x.type !== 'transfer' ? toRM(x, x.rate || m.get(x.accountId)) : x))); };
export const scopedTx = () => { const sc = scope(), g = groupMap(), all = rmTx(); return sc === 'all' || scopes().length === 1 ? all : keep('scoped', all, `${sc}|${[...g]}`, () => all.filter(x => inScope(x, sc, g))); };
export const scopedAccounts = () => { const sc = scope(); return S.accounts.filter(a => sc === 'all' || groupOf(a) === sc); };
/** Budgets for the scope: personal ones as before, joint ones in budgets.joint, All = both added up (read-only). */
export function budgetsFor(sc = scope()) {
  const me = S.kv.budgets, none = { total: 0, byCat: {} }, jt = me.joint || none, biz = me.business || none;
  if (sc !== 'all') return sc === 'joint' ? jt : sc === 'business' ? biz : me;
  const byCat = { ...me.byCat };
  for (const b of [jt, biz]) for (const [c, v] of Object.entries(b.byCat)) byCat[c] = (byCat[c] || 0) + v;
  return { total: me.total + jt.total + biz.total, byCat };
}
/** Every save is stamped (a spouse's share file merges by newest edit); joint rows also say who added them. */
const stamp = x => {
  if (x.fx != null) throw new Error('A converted row (RM) was about to be saved over its own currency');
  const by = S.kv.settings?.myName, j = jointIds(), a = S.accounts.find(y => y.id === x.accountId);
  // Spending in another currency keeps the rate of its day: a later rate doesn't re-value last month (RM totals stay put).
  const rate = x.type !== 'transfer' && isFx(a) && !x.rate && rateOf(a) ? { rate: rateOf(a) } : {};
  return { ...x, ...rate, updatedAt: Date.now(), ...(by && !x.by && !x.spouse && (j.has(x.accountId) || j.has(x.toAccountId)) ? { by } : {}) };
};
/** The account a new entry starts on, in the current scope: kind 'quick', 'receipt' ({amount, shop, category}) or 'bill' (engine.pickAccount). */
export function defaultAccount(kind = 'quick', o = {}) {
  // A receipt is paid however it was paid, whatever screen is showing (the Business view left on doesn't make a
  // Guardian receipt the stall's): every account and every entry. Typed entries follow the view.
  const all = kind === 'receipt', accounts = (all || !scopedAccounts().length ? S.accounts : scopedAccounts()).filter(a => !owing(a)), txs = all ? rmTx() : scopedTx(), d = today();   // never Owed to you or You owe: those move only through a split
  // Only the typed expense form opts in; repayment and other callers keep their existing defaults.
  if (kind === 'quick' && o.typedExpense === true) {
    const preferred = accounts.find(a => a.id === settings().quickAccount && (!o.currency || (a.currency || 'MYR') === o.currency));
    if (preferred) return preferred.id;
  }
  // Typing several in a row in Singapore dollars (a JB commuter at lunch): the next one is in that money too, for 3 hours.
  if (kind === 'quick' && !o.currency) { const last = S.tx.reduce((m, x) => (x.source === 'quick' && x.type === 'expense' && (!m || x.createdAt > m.createdAt) ? x : m), null), a = last && S.accounts.find(y => y.id === last.accountId); if (a?.currency && a.currency !== 'MYR' && Date.now() - last.createdAt < 3 * 36e5) o = { ...o, currency: a.currency }; }
  return pickAccount({ accounts, txs, bal: balances(accounts, txs.filter(x => x.date <= d)).by, kind, ...o });
}
/** The day budget months start on (a payday), 1 = calendar months; and the key of the month holding today. */
export const startDay = () => settings().monthStart || 1;
export const thisMonth = () => cycleKey(today(), startDay());
export const nowLocal = () => `${today()}T${nowTime()}`;
export const uid = p => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// ---- categories ---------------------------------------------------------------------------------------------------
/** A category with the colour chosen for it in Settings (kv catColors: {id: '#RRGGBB'}), if any. */
const tint = c => (S.kv.catColors?.[c.id] || S.kv.catIcons?.[c.id] ? { ...c, ...(S.kv.catColors?.[c.id] ? { color: S.kv.catColors[c.id] } : {}), ...(S.kv.catIcons?.[c.id] ? { icon: S.kv.catIcons[c.id] } : {}) } : c);   // and the icon (kv catIcons: {id: key})
/** A category's icon (a key of caticons.js CAT_ICONS), or its built-in one again. */
export const setCatIcon = (id, key) => { const m = { ...S.kv.catIcons }; if (key) m[id] = key; else delete m[id]; return setKv('catIcons', m); };
export const expenseCats = () => [...(S.kv.settings?.ownCats ? [] : CATEGORIES.slice(0, -1).filter(c => !Object.hasOwn(S.kv.settings?.movedCats || {}, c.id))), ...S.kv.customCats.filter(c => c.kind !== 'income'), CATEGORIES.at(-1)].map(tint);
export const incomeCats = () => [...INCOME_CATEGORIES.slice(0, -1), ...S.kv.customCats.filter(c => c.kind === 'income'), INCOME_CATEGORIES.at(-1)].map(tint);
export const allCats = () => [...expenseCats(), ...incomeCats()];
export function setCatColor(id, hex) {
  const m = { ...S.kv.catColors };
  if (hex) m[id] = hex; else delete m[id];
  return setKv('catColors', m);
}
let catIdx = null;   // cat() runs for every row drawn and searched: look it up, don't rebuild the list each time
export const cat = id => {
  if (catIdx?.cc !== S.kv.customCats || catIdx.cl !== S.kv.catColors || catIdx.ci !== S.kv.catIcons) { const m = new Map(); for (const c of allCats()) if (!m.has(c.id)) m.set(c.id, c); catIdx = { cc: S.kv.customCats, cl: S.kv.catColors, ci: S.kv.catIcons, m }; }
  return catIdx.m.get(id) || CATEGORIES.at(-1);
};
/** A category of the user's own: spending, or with kind 'income' a kind of money in (a side business, rental). */
export async function addCategory(name, color = nextColor(S.kv.customCats.map(x => x.color)), kind = 'expense') {
  // The same name again (Enter pressed twice, or typed twice) is that category, not a second one.
  const same = S.kv.customCats.find(x => x.name.trim().toLowerCase() === String(name).slice(0, 40).trim().toLowerCase() && (x.kind || 'expense') === kind);
  if (same) return same;
  if (S.kv.customCats.length >= CAPS.customCats) throw new Error('You have 50 categories of your own, the most a backup can hold.');
  const c = { id: uid('c_'), name: String(name).slice(0, 40), color, ...(kind === 'income' ? { kind } : {}) };
  await setKv('customCats', [...S.kv.customCats, c]);
  return c;
}

/**
 * Categories an older import saved with HTML codes in their names ("&#x1f35c; Food" from Money Manager by Realbyte):
 * each is folded into the category of that name (Tally's own or the user's), entries, bills, budgets and learned rules
 * moved with it, or else just renamed. Runs at start; a no-op once nothing has the codes. → how many were fixed.
 */
export async function repairCatNames() {
  const bad = S.kv.customCats.filter(c => CAT_CODE.test(c.name));
  if (!bad.length && S.kv.customCats.length <= CAPS.customCats) return 0;
  // Fold targets: every category without codes (wherever it sits in the list), then the renamed ones as they come.
  const into = new Map(), renamed = new Map(), keep = S.kv.customCats.filter(c => !bad.includes(c));
  for (const c of bad) {
    const name = catName(c.name).slice(0, 40), to = sameCategory(name, [...keep, ...renamed.values()], c.kind === 'income');
    if (to) into.set(c.id, to); else renamed.set(c.id, { ...c, name });
  }
  // Over 50 own categories (kept from before the cap: backups and imports refuse more): the least used past 50 fold into
  // Tally's nearest category, so the phone can back up again.
  const left = S.kv.customCats.filter(c => !into.has(c.id)).map(c => renamed.get(c.id) || c);
  if (left.length > CAPS.customCats) {
    const uses = new Map();
    const count = id => { if (id) uses.set(id, (uses.get(id) || 0) + 1); };
    for (const t of S.tx) { count(t.category); for (const i of t.items || []) count(i.category); }
    for (const r of S.recurring) count(r.category);
    const near = c => (c.kind === 'income' ? (/salary|gaji|工资|薪/i.test(c.name) ? 'salary' : 'income') : (n => (INCOME_CATEGORIES.some(x => x.id === n) ? 'other' : n))(mapCategory(c.name)));
    for (const c of [...left].sort((a, b) => (uses.get(b.id) || 0) - (uses.get(a.id) || 0)).slice(CAPS.customCats)) into.set(c.id, near(c));
  }
  await foldCategories(into, { customCats: S.kv.customCats.flatMap(c => (into.has(c.id) ? [] : [renamed.get(c.id) || c])) });
  return into.size + renamed.size;
}

/** Fold categories into others (into: Map id → id): entries, items, bills, budgets, learned rules, colours, icons and
 *  import mappings move with them, in one write. customCats: the list to keep; moved: settings.movedCats to store. */
export async function foldCategories(into, { customCats = S.kv.customCats, moved = null, edit = false } = {}) {
  const m = id => into.get(id) || id, hit = id => into.has(id);
  const tx = S.tx.filter(t => hit(t.category) || hit(t.cat) || t.items?.some(i => hit(i.category)))
    .map(t => ({ ...t, category: m(t.category), ...(t.cat ? { cat: m(t.cat) } : {}), ...(t.items ? { items: t.items.map(i => ({ ...i, category: m(i.category) })) } : {}) }));
  const recurring = S.recurring.filter(r => hit(r.category)).map(r => ({ ...r, category: m(r.category) }));
  const byCat = b => (b?.byCat ? { ...b, byCat: Object.entries(b.byCat).reduce((o, [k, v]) => ({ ...o, [m(k)]: (o[m(k)] || 0) + v }), {}) } : b);
  const moveKeys = o => {   // a folded one's colour/icon only where the category it joins has none
    const e = Object.entries(o || {}), r = Object.fromEntries(e.filter(([k]) => !hit(k)));
    for (const [k, v] of e) if (hit(k) && !(m(k) in r)) r[m(k)] = v;
    return r;
  };
  const b = S.kv.budgets, st = S.kv.settings;
  const importMaps = st.importMaps && Object.fromEntries(Object.entries(st.importMaps).map(([k, v]) => [k, v?.catMap ? { ...v, catMap: Object.fromEntries(Object.entries(v.catMap).map(([s, id]) => [s, m(id)])) } : v]));
  // One write. A repair keeps edit times (not an edit: a partner's real edit still wins at the next swap); a removal is one.
  await putAll({ tx, recurring, edit, kv: {
    customCats,
    ...(into.size ? { budgets: { ...byCat(b), ...(b.joint ? { joint: byCat(b.joint) } : {}), ...(b.business ? { business: byCat(b.business) } : {}) },
      rules: Object.fromEntries(Object.entries(S.kv.rules).map(([k, v]) => [k, m(v)])), catColors: moveKeys(S.kv.catColors), catIcons: moveKeys(S.kv.catIcons),
      } : {}),
    ...(importMaps || moved ? { settings: { ...st, ...(importMaps ? { importMaps } : {}), ...(moved ? { movedCats: moved } : {}) } } : {}),
  } });
}
/** Remove a category: the user's own is deleted, one of Tally's is hidden; everything in it moves to `to` (Other by
 *  default), and Tally's guesses for a hidden one land in `to` from now on. Other itself stays: it is where things fall. */
export async function removeCategory(id, to = 'other') {
  const builtIn = CATEGORIES.slice(0, -1).some(c => c.id === id), own = S.kv.customCats.some(c => c.id === id && c.kind !== 'income');
  if ((!builtIn && !own) || id === to || id === 'other' || !expenseCats().some(c => c.id === to)) throw new Error('This category cannot be removed.');
  const moved = { ...(S.kv.settings.movedCats || {}) };
  for (const [k, v] of Object.entries(moved)) if (v === id) moved[k] = to;   // what went into it goes on to `to`
  if (builtIn) moved[id] = to;
  await foldCategories(new Map([[id, to]]), { customCats: S.kv.customCats.filter(c => c.id !== id), moved, edit: true });
  movedCategories(S.kv.settings.movedCats);
}
/** One of Tally's removed categories back in the list (its old entries stay where they were moved). */
export async function bringBackCategory(id) {
  const moved = { ...(S.kv.settings.movedCats || {}) }; delete moved[id];
  await setKv('settings', { ...S.kv.settings, movedCats: moved });
  movedCategories(moved);
}

// ---- transactions -----------------------------------------------------------------------------------------------
// Records are written to the database first and only then shown: a failed save never leaves the screen ahead of the data.
/** Save a transaction. Saving the same id twice replaces it, so a double tap can never add it twice. */
export async function saveTx(tx, { expected } = {}) {
  if (expected !== undefined) {
    const generation = bookGeneration();
    // Guarded edits keep their opened row as the base; expected:null creates only an absent row.
    const settingsRecord = await db.get('kv', 'settings');
    const equal = (a, b) => JSON.stringify(a, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v) === JSON.stringify(b, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
    if ((expected !== null && expected.id !== tx.id) || !equal(settingsRecord?.value || {}, settings())) throw Object.assign(Error('The entry changed on your phone. Refresh and try again.'), { code: 'STALE' });
    const accountsBefore = structuredClone(S.accounts), remaining = S.tx.filter(x => x.id !== tx.id);
    const typed = accountsBefore.filter(a => a.typed), before = typedShift(typed, remaining, expected ? [expected] : [], today()), after = typedShift(typed, remaining, [tx], today());
    const touched = new Set([expected?.accountId, expected?.toAccountId, tx.accountId, tx.toAccountId].filter(Boolean));
    if ([tx.accountId, tx.toAccountId].filter(Boolean).some(id => !accountsBefore.some(a => a.id === id))) throw Object.assign(Error('The entry changed on your phone. Refresh and try again.'), { code: 'STALE' });
    const changed = new Map();
    for (const a of accountsBefore) {
      const delta = (after[a.id] || 0) - (before[a.id] || 0);
      if (delta) changed.set(a.id, { ...a, opening: (a.opening || 0) + delta, updatedAt: Date.now() });
    }
    // A foreign-currency transfer updates its rate in the same guarded account write, as rateFrom does for new entries.
    const a = accountsBefore.find(a => a.id === tx.accountId), b = accountsBefore.find(a => a.id === tx.toAccountId);
    if (tx.toAmount && a && b && isFx(a) !== isFx(b)) {
      const [fx, rm, units] = isFx(a) ? [a, tx.toAmount, tx.amount] : [b, tx.amount, tx.toAmount];
      changed.set(fx.id, { ...(changed.get(fx.id) || fx), rate: +(rm / units).toFixed(4), updatedAt: Date.now() });
    }
    const joint = new Set(accountsBefore.filter(a => a.scope === 'joint').map(a => a.id));
    const wasJoint = joint.has(expected?.accountId) || joint.has(expected?.toAccountId), stillJoint = joint.has(tx.accountId) || joint.has(tx.toAccountId);
    const goneRecord = wasJoint && !stillJoint ? await db.get('kv', 'jointGone') : null;
    const kv = wasJoint && !stillJoint ? { jointGone: Object.fromEntries([...Object.entries(goneRecord?.value || {}), [tx.id, Date.now()]].slice(-1000)) } : {};
    tx = stamp(tx);
    await db.writeAtomic({ put: { tx: [tx], accounts: [...changed.values()], kv: kvRows(kv) }, expected: {
      tx: [{ id: tx.id, value: expected ?? undefined }], accounts: accountsBefore.filter(a => touched.has(a.id)).map(a => ({ id: a.id, value: a })),
      kv: [...bookGuard(generation).kv, { id: 'settings', value: settingsRecord ?? undefined }, ...(wasJoint && !stillJoint ? [{ id: 'jointGone', value: goneRecord ?? undefined }] : [])],
    } });
    await load(); return tx;
  }
  const left = leftJoint([tx]);
  tx = stamp(tx);
  await db.put('tx', tx);
  await markGone(left);
  const i = S.tx.findIndex(t => t.id === tx.id);
  S.tx = i >= 0 ? S.tx.map((t, k) => (k === i ? tx : t)) : [...S.tx, tx];   // a new array: results kept for the old one (cached) are dropped
  await syncReminderDay();
  return tx;
}
export async function saveTxs(list) {
  const left = leftJoint(list);
  list = list.map(stamp);
  await db.putMany('tx', list);
  const ids = new Set(list.map(t => t.id));
  S.tx = [...S.tx.filter(t => !ids.has(t.id)), ...list];
  await markGone(left);
  await syncReminderDay();
}
/** Rows a save moves off every joint account (to a personal one, or a split bill a friend paid into You owe): the
 *  partner's copy must go as if deleted, or it stays on their joint account for good. → their ids. */
function leftJoint(list) {
  const j = jointIds(), on = t => j.has(t.accountId) || j.has(t.toAccountId);
  if (!j.size) return [];
  const was = new Map(S.tx.map(t => [t.id, t]));
  return list.filter(t => !on(t) && was.has(t.id) && on(was.get(t.id))).map(t => t.id);
}
/** Delete, returning an undo function. */
export async function deleteTx(id) {
  if (!S.tx.some(t => t.id === id)) return () => {};
  return deleteTxs([id]);   // one path, so a joint entry's delete marker is always written
}
export async function deleteTxs(ids) {
  const set = new Set(ids);
  const old = S.tx.filter(t => set.has(t.id)), j = jointIds();
  await db.delMany('tx', ids);
  S.tx = S.tx.filter(t => !set.has(t.id));
  // A deleted joint row stays deleted on the spouse's phone too (the share file carries these markers).
  const joint = old.filter(t => j.has(t.accountId) || j.has(t.toAccountId));
  await markGone(joint.map(t => t.id));
  await syncReminderDay();
  return async () => saveTxs(old);
}
/** Joint records deleted here (entries, bills, accounts): the share file carries these markers, so they stay deleted there. */
const withGone = ids => Object.fromEntries([...Object.entries(S.kv.jointGone || {}), ...ids.map(id => [id, Date.now()])].slice(-1000));
const markGone = ids => (ids.length ? setKv('jointGone', withGone(ids)) : undefined);
/** Remember the user's category for an item (and optionally for the shop). */
export async function learn(itemName, category, merchant = null) {
  const k = itemKey(itemName);
  const rules = { ...S.kv.rules };
  if (k) rules[k] = category;
  if (merchant) rules['SHOP ' + itemKey(merchant)] = category;
  await setKv('rules', rules);
}

// ---- accounts, bills, photos ----------------------------------------------------------------------------------
/** A new entry dated before the day an account's balance was typed (an old receipt scanned today): that balance is
 *  today's, so the money was already out of it. The starting balance moves instead, and today's stays as it was set.
 *  dir -1: that entry was deleted (or is being replaced by an edit), so the move is undone. */
export async function keepToday(tx, dir = 1) {
  const shift = typedShift(S.accounts.filter(a => a.typed), S.tx.filter(x => x.id !== tx.id), [tx], today());
  for (const [id, d] of Object.entries(shift)) { const a = S.accounts.find(x => x.id === id); if (a) await saveAccount({ ...a, opening: (a.opening || 0) + dir * d }); }
}
export async function saveAccount(a) {
  a = { ...a, updatedAt: Date.now() };
  await db.put('accounts', a);
  const i = S.accounts.findIndex(x => x.id === a.id);
  if (i >= 0) S.accounts[i] = a; else S.accounts.push(a);
  await syncReminderDay();
}
export async function deleteAccount(id) {
  if (S.tx.some(t => t.accountId === id || t.toAccountId === id)) throw new Error('in use');
  const joint = S.accounts.find(a => a.id === id)?.scope === 'joint';
  await db.del('accounts', id);
  S.accounts = S.accounts.filter(a => a.id !== id);
  if (joint) await markGone([id]);
  await syncReminderDay();
}
export async function saveBill(b, { edited = true } = {}) {
  if (edited) b = { ...b, updatedAt: Date.now() };   // a spouse's copy of a joint bill merges by newest edit
  await db.put('recurring', b);
  const i = S.recurring.findIndex(x => x.id === b.id);
  if (i >= 0) S.recurring[i] = b; else S.recurring.push(b);
}
export async function deleteBill(id) {
  const joint = jointIds().has(S.recurring.find(b => b.id === id)?.accountId);
  await db.del('recurring', id); S.recurring = S.recurring.filter(b => b.id !== id);
  if (joint) await markGone([id]);
}
/** true when saved. Photos are nice-to-have, so a failure doesn't stop the caller; the user still sees it (onSaveFailed). */
// The localStorage fallback (no IndexedDB: some private windows) can't hold a photo's bytes: say so, don't store {}.
export const savePhoto = (id, blob, guard = null) => (db.storageMode() === 'localstorage' && blob instanceof Blob ? Promise.resolve(false) : (guard ? db.writeAtomic({ put: { receipts: [{ id, blob }] }, expected: bookGuard(guard.generation) }) : db.put('receipts', { id, blob })).then(() => true, () => false));
export const deletePhotos = ids => db.delMany('receipts', ids).catch(() => {});
// A photo that went through JSON (saved by the fallback before it refused them) comes back as {}: that is no photo.
export const getPhoto = id => db.get('receipts', id).then(r => (r?.blob && Object.getPrototypeOf(r.blob) !== Object.prototype ? r.blob : null)).catch(() => null);
/** Receipt photos taken off the phone, the entries kept: every photo of an entry dated before `before` (null: all).
 *  The entries lose their link first, then the photos go: a failure between the two leaves only photos nothing uses,
 *  which the next start sweeps. A photo still being checked in review is not an entry's yet and stays. → photos removed */
export async function dropPhotos(before = null) {
  // A tidy-up by age (`before`) skips relief receipts LHDN may still ask for (keepReceiptUntil); deleting all is the user's own choice.
  const hit = S.tx.filter(x => x.receiptId && (!before || (x.date < before && !(keepReceiptUntil(x) >= today())))), ids = [...new Set(hit.map(x => x.receiptId))];
  if (!hit.length) return 0;
  await saveTxs(hit.map(x => { const { receiptId, ...rest } = x; return rest; }));
  const still = new Set(S.tx.map(x => x.receiptId).filter(Boolean));   // another entry (a split's friend, a refund) may share one
  await deletePhotos(ids.filter(id => !still.has(id)));
  return ids.length;
}
/** A deleted entry's receipt photo stays for its Undo; the next start removes photos nothing uses any more (no entry,
 *  no receipt being checked, no photo waiting to be read). Deleting an entry then deletes its photo from the phone. */
export async function sweepPhotos() {
  const used = new Set([...S.tx.map(t => t.receiptId), S.kv.reviewDraft?.draft?.receiptId].filter(Boolean));
  const gone = (await db.keys('receipts').catch(() => [])).filter(k => !used.has(k) && !String(k).startsWith('q_'));
  if (gone.length) await deletePhotos(gone);
  return gone.length;
}

// ---- whole-data operations (restore, erase) ---------------------------------------------------------------------
const BACKUP_KV = ['budgets', 'rules', 'customCats', 'dismissed', 'shopNames', 'itemNames', 'catColors', 'catIcons', 'goals', 'subcats', 'subRules'];
const kvRows = kv => Object.entries(kv || {}).filter(([k, v]) => KV_KEYS.includes(k) && v != null).map(([key, value]) => ({ key, value }));
/** Replace everything with a backup, all or nothing: old photos and the settings a backup carries go too. */
/** Snapshot the displayed book plus stored KV. Atomic row/key guards detect edits, new rows and replacements during restore preparation. */
export async function restoreSnapshot() {
  const generation=bookGeneration() ?? undefined, book={accounts:structuredClone(S.accounts),tx:structuredClone(S.tx),recurring:structuredClone(S.recurring),kv:structuredClone(S.kv)};
  const kv=await db.all('kv'), receiptKeys=await db.keys('receipts');
  const storedGeneration=kv.find(r=>r.key==='bookGeneration')?.value ?? undefined;
  if(generation!==(bookGeneration() ?? undefined) || generation!==storedGeneration)throw Object.assign(new Error('The entry changed on your phone. Refresh and try again.'),{code:'STALE'});
  book.kv={...book.kv,...Object.fromEntries(kv.map(r=>[r.key,r.value]))};
  const expected=Object.fromEntries(['accounts','tx','recurring'].map(store=>[store,book[store].map(value=>({id:value.id,value}))]));
  expected.kv=kv.map(value=>({id:value.key,value}));
  if(!kv.some(r=>r.key==='bookGeneration'))expected.kv.push({id:'bookGeneration',value:undefined});
  const expectedKeys={accounts:book.accounts.map(r=>r.id),tx:book.tx.map(r=>r.id),recurring:book.recurring.map(r=>r.id),kv:kv.map(r=>r.key),receipts:receiptKeys};
  return {book,expected,expectedKeys};
}
export async function replaceAll({ accounts, tx, recurring, kv, receipts = [], expected = {}, expectedKeys = {}, beforeWrite = () => {} }) {
  const nextKv = Object.fromEntries(Object.entries(kv || {}).filter(([key]) => !TRANSIENT_KV.includes(key)));
  await db.writeAtomic({ clear: ['accounts', 'tx', 'recurring', 'receipts'], del: { kv: [...BACKUP_KV, ...TRANSIENT_KV] }, put: { accounts, tx, recurring, receipts, kv: kvRows({ ...nextKv, bookGeneration: uid('book_') }) }, expected, expectedKeys, beforeWrite });
  await load();
  if (typeof globalThis.document?.dispatchEvent === 'function') document.dispatchEvent(new Event('tally:book-replaced'));
}
/** Add a merged backup's new records and settings, all or nothing. Existing records are never rewritten. */
export async function addAll({ accounts, tx, recurring, kv, receipts = [], del = {}, expected = {}, expectedKeys = {}, beforeWrite = () => {} }) {
  const has = (list, ids) => list.filter(x => !ids.has(x.id));
  const kept = (list, store) => new Set(list.filter(x => !(del[store] || []).includes(x.id)).map(x => x.id));
  await db.writeAtomic({ del, put: {
    accounts: has(accounts, kept(S.accounts, 'accounts')), tx: has(tx, kept(S.tx, 'tx')),
    recurring: has(recurring, kept(S.recurring, 'recurring')), receipts, kv: kvRows(kv),
  }, expected, expectedKeys, beforeWrite });
  await load();
}
/** Write records as given, overwriting (a spouse's newer joint edits), all or nothing. `edit`: the user's own change
 *  (an import and its Undo), stamped and with joint delete markers like saveTxs and deleteTxs, in the same write. */
export async function putAll({ accounts = [], tx = [], recurring = [], kv = {}, del = {}, edit = false, mark = true, expected = {}, expectedKeys = {}, receipts = [], beforeWrite = () => {} }) {
  if (edit) {
    // Only rows this write deletes and doesn't put back: a row put back next to its own marker was deleted by the next swap.
    const j = jointIds(), back = new Set(tx.map(t => t.id)), dead = new Set((del.tx || []).filter(id => !back.has(id)));
    const joint = mark ? [...S.tx.filter(t => dead.has(t.id) && (j.has(t.accountId) || j.has(t.toAccountId))).map(t => t.id), ...leftJoint(tx)] : [];
    tx = tx.map(stamp);
    if (joint.length) kv = { ...kv, jointGone: withGone(joint) };
  }
  await db.writeAtomic({ del, put: { accounts, tx, recurring, receipts, kv: kvRows(kv) }, expected, expectedKeys, beforeWrite });
  await load();
}
/** The old address (it shares its site with another app): Tally has moved to NEW_HOME. */
export const OLD_HOME = globalThis.location?.hostname === 'fir1412.github.io', NEW_HOME = 'https://tallymy.github.io/';
/** Everything Tally keeps at this address, and only Tally's: its database, its storage keys, caches and offline worker. */
export async function wipeSite() {
  db.setKey(null); db.expectSealed(false);
  await db.wipe();   // the erase every tab hears of: one still open here (the fallback has no versionchange) mustn't write the old data back
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('tally')) localStorage.removeItem(k); } catch {}
  try { for (const k of await caches.keys()) if (k.startsWith('tally')) await caches.delete(k); } catch {}
  try { for (const r of await navigator.serviceWorker.getRegistrations()) if (new URL(r.scope).pathname.startsWith('/tally/')) await r.unregister(); } catch {}
}
export async function eraseAll() {
  db.setKey(null); db.expectSealed(false);   // first: nothing written from here on is sealed with the old key
  await db.wipe();   // one step every tab sees: store-by-store left a window where another tab's sealed write survived
  await load();
}
export const storageMode = db.storageMode;
/** Ask the browser not to clear Tally's data when space runs low. persisted: true, false, or null (not known yet / unsupported). */
export const storage = { persisted: null };
export async function persistStorage() {
  if (isNative || !globalThis.navigator?.storage?.persist) return null;   // the app's own storage isn't the browser's to clear
  try { storage.persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist()); } catch { storage.persisted = false; }
  return storage.persisted;
}
export const onRemoteChange = db.onRemoteChange;
export const onSaveFailed = db.onSaveFailed;
