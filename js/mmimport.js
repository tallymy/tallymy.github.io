// Import from "Money manager & expenses" (Innim) backups (.mmbackup): a zip holding MyFinance.db (SQLite) and
// photos/. SQLite is read with sql.js (vendored, loaded only here). Accounts keep their current balances.
// Also Money Manager by Realbyte backups (.mmbak), below.
import { unzip, cleanText, mapCategory, sameCategory, catName, OTHER_NAME, hash, okId, okSigned } from './io.js';
import { INCOME_CATEGORIES, validIso, MAX_SEN, nextColor } from './engine.js';
import { guessKind } from './statement.js';

/** Their category keeps its name: Tally's of exactly that name, else a new one called the same (50 at most, then the nearest of Tally's). */
function keepName(title, income, customCats, id, color) {
  title = catName(title) || 'Category';   // "&#x1f35c; Food" is Food
  const same = sameCategory(title, [], income);
  if (same) return same;
  if (!OTHER_NAME.test(title) && customCats.length < 50) { customCats.push({ id, name: title, color, ...(income ? { kind: 'income' } : {}) }); return id; }
  if (income) return /salary|gaji|工资|薪/i.test(title) ? 'salary' : 'income';
  const near = mapCategory(title);
  return INCOME_CATEGORIES.some(x => x.id === near) ? 'other' : near;
}

/** Load sql.js in the browser (UMD script → window.initSqlJs). Node tests pass their own SQL instead. */
export async function loadSqlJs() {
  if (!globalThis.initSqlJs) await new Promise((res, rej) => {
    const s = Object.assign(document.createElement('script'), { src: new URL('../vendor/sql-wasm.js', import.meta.url).href, onload: res, onerror: () => rej(new Error('sql.js failed to load')) });
    document.head.appendChild(s);
  });
  return globalThis.initSqlJs({ locateFile: f => new URL(`../vendor/${f}`, import.meta.url).href });
}

const hex = argb => `#${(Number(argb) & 0xffffff).toString(16).padStart(6, '0')}`;
/** Their uid → our id, by the same rule as backups (a uid that breaks it is hashed instead). */
const mmId = u => { const text = String(u), id = `mm_${text}`; return text.length <= 40 && okId(id) ? id : `mm_h${hash(text)}`; };
const pad = n => String(n).padStart(2, '0');
/** '2023-04-20T09:30:40.418Z' → local 'HH:MM' (when the entry was logged: the habit engine learns from it). */
const localTime = iso => { const d = new Date(iso); return isNaN(d) ? undefined : `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/**
 * .mmbackup bytes → {accounts, tx, customCats, photos: [{path, txIds}], skipped, otherCurrency, transfersSkipped}.
 * One photos entry per photo file, with every entry that links it: a file linked 200,000 times is still one copy.
 * Their categories map onto Tally's where the name matches (Food → Dining…); the rest become custom categories
 * with the user's own names and colours. Nothing is saved here.
 */
export async function readMoneyManager(buf, SQL, { now = Date.now() } = {}) {
  const files = await unzip(buf, n => n === 'MyFinance.db');
  if (!files['MyFinance.db']) throw new Error('This file is not a Money Manager backup (MyFinance.db is missing).');
  const db = new SQL.Database(files['MyFinance.db']);
  try {
    const rows = sql => { const r = db.exec(sql)[0]; return r ? r.values.map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : []; };
    // Only real tables are read: a crafted file can't swap one for a view, or add computed (generated) columns.
    const has = t => rows(`select name from sqlite_master where type='table' and name='${t}' and upper(coalesce(sql, '')) not like 'CREATE VIRTUAL%'`).length > 0 && rows(`select count(*) as n from pragma_table_xinfo('${t}') where hidden > 1`)[0].n === 0;
    if (!['transaction', 'account', 'account_balance', 'category', 'sync_link'].every(has)) throw new Error('This Money Manager backup is from a version Tally does not know yet.');

    // Categories: theirs → ours, or a new custom one.
    const customCats = [];
    const catMap = Object.create(null);
    for (const c of rows(`select uid, title, type, color from category where isRemoved = 0 limit 2000`)) {
      const title = cleanText(c.title, 40) || 'Category', income = c.type === 'Income';
      catMap[c.uid] = keepName(title, income, customCats, `c_mm_${hash(c.uid)}`, hex(c.color));   // stable per backup: a second backup never lands in the first one's categories
    }

    // Links: transaction → account / category / photo.
    const link = new Map();
    for (const l of rows(`select entityUid, otherType, otherUid from sync_link where isRemoved = 0 and entityType = 'Transaction' limit 1000000`)) {
      if (!link.has(l.entityUid)) link.set(l.entityUid, Object.create(null));
      link.get(l.entityUid)[l.otherType] = l.otherUid;
    }
    const photoPath = new Map(has('sync_file') ? rows(`select uid, localPath from sync_file where isRemoved = 0 limit 200000`).map(f => [f.uid, `photos/${String(f.localPath || '').split(/[\\/]/).pop()}`]) : []);

    const accRows = rows(`select a.uid, a.title, a.currencyCode, a.created, b.value as balance from account a left join account_balance b on b.uid = a.uid where a.isRemoved = 0 limit 200`);
    const accIds = new Set(accRows.map(a => a.uid));
    const tx = [], photos = new Map();   // path → ids of the entries that link it
    let skipped = 0, adjustments = 0;
    for (const t of rows(`select uid, type, amountInAccountCurrency as amt, date, comment, created from "transaction" where isRemoved = 0 limit 200000`)) {
      const l = link.get(t.uid) || {};
      const amt = Number(t.amt);
      if (!['Income', 'Expense'].includes(t.type)) { skipped++; continue; }
      if (!validIso(t.date) || !Number.isInteger(amt) || amt <= 0 || amt > MAX_SEN || !accIds.has(l.Account)) { skipped++; continue; }
      // Money Manager records a manual balance correction as an uncategorised entry with no note. It isn't spending:
      // leaving it out folds it into the opening balance, so today's balances still match.
      if (!l.Category && !cleanText(t.comment)) { adjustments++; continue; }
      const type = t.type === 'Income' ? 'income' : 'expense';
      let category = catMap[l.Category] || (type === 'income' ? 'income' : 'other');
      if (type === 'income' && !INCOME_CATEGORIES.some(c => c.id === category) && !customCats.some(c => c.id === category && c.kind === 'income')) category = 'income';
      const id = mmId(t.uid);
      tx.push({ id, date: t.date, time: localTime(t.created), type, amount: amt, accountId: mmId(l.Account), category, merchant: cleanText(t.comment, 80), note: '', source: 'import', createdAt: now });
      if (photoPath.has(l.Photo)) { const p = photoPath.get(l.Photo); (photos.get(p) || photos.set(p, []).get(p)).push(id); }
    }

    // Transfers (ATM withdrawals, e-wallet reloads). No public source says where a transfer's two accounts are: on the row
    // (fromAccount/toAccount) or as sync_link rows (FromAccount/ToAccount). Either is read when it names two known accounts;
    // anything else is counted and left out, and balances still match (openings come from what was imported).
    let transfersSkipped = 0;
    if (has('transfer')) {
      const cols = rows(`select name from pragma_table_info('transfer')`).map(c => c.name), col = re => cols.find(c => re.test(c));
      const fromC = col(/^from_?acc/i), toC = col(/^to_?acc/i), amtC = col(/^fromAmount$/i) || col(/^amount$/i), toAmtC = col(/^toAmount$/i);
      const side = new Map();
      for (const l of rows(`select entityUid, otherType, otherUid from sync_link where isRemoved = 0 and entityType = 'Transfer' limit 1000000`)) (side.get(l.entityUid) || side.set(l.entityUid, {}).get(l.entityUid))[/^from/i.test(l.otherType) ? 'from' : /^to/i.test(l.otherType) ? 'to' : l.otherType] = l.otherUid;
      for (const r of rows(`select * from transfer where isRemoved = 0 limit 200000`)) {
        const s = side.get(r.uid) || {}, from = fromC ? r[fromC] : s.from, to = toC ? r[toC] : s.to, amt = Number(r[amtC]), toAmt = Number(r[toAmtC]);
        if (!accIds.has(from) || !accIds.has(to) || from === to || !validIso(r.date) || !Number.isInteger(amt) || amt <= 0 || amt > MAX_SEN) { transfersSkipped++; continue; }
        if (String(accRows.find(a => a.uid === from)?.currencyCode || 'MYR').trim().toUpperCase() !== String(accRows.find(a => a.uid === to)?.currencyCode || 'MYR').trim().toUpperCase() && !(Number.isInteger(toAmt) && toAmt > 0 && toAmt <= MAX_SEN)) { transfersSkipped++; continue; }
        tx.push({ id: mmId(r.uid), date: r.date, time: localTime(r.created), type: 'transfer', amount: amt, ...(Number.isInteger(toAmt) && toAmt > 0 && toAmt <= MAX_SEN && toAmt !== amt ? { toAmount: toAmt } : {}),
          accountId: mmId(from), toAccountId: mmId(to), category: 'other', merchant: cleanText(r.comment, 80), note: '', source: 'import', createdAt: now });
      }
    }

    // Opening balance = their current balance minus everything imported, so Tally shows the same balance today.
    const accounts = accRows.map(a => {
      const id = mmId(a.uid);
      const net = tx.reduce((s, t) => s + (t.accountId === id ? (t.type === 'income' ? t.amount : -t.amount) : 0) + (t.toAccountId === id ? t.toAmount ?? t.amount : 0), 0);
      const bal = Number.isInteger(Number(a.balance)) && a.balance != null ? Number(a.balance) : net;
      const title = String(a.title || '');
      return { id, name: cleanText(title, 60) || 'Account', kind: guessKind(title), opening: okSigned(bal - net) ? bal - net : 0, createdAt: Date.parse(a.created) || now, currency: a.currencyCode || 'MYR' };
    });
    return { accounts: accounts.map(keepCurrency), tx, customCats, photos: [...photos].map(([path, txIds]) => ({ path, txIds })), skipped, adjustments, otherCurrency: accounts.map(keepCurrency).filter(a => a.currency).map(a => a.name), transfersSkipped };
  } finally { db.close(); }
}

// ---- Money Manager by Realbyte (.mmbak) --------------------------------------------------------------------------------
// A SQLite database, bare or zipped (github.com/shubham1172/moneymanager-parser: "a ZIP-wrapped SQLite database";
// github.com/ramadiaz/vaultix-by-xanny writes it bare). Android schema, as in vaultix's mmbak-export.service.ts:
// INOUTCOME(uid, assetUid, toAssetUid, ctgUid, ZCONTENT, ZDATE ms since 1970, WDATE, DO_TYPE, ZMONEY, IS_DEL…),
// ASSETS(uid, NIC_NAME, currencyUid…), ZCATEGORY(uid, NAME, TYPE 0 income / 1 expense, pUid, C_IS_DEL),
// CURRENCY(uid, ISO…). DO_TYPE: 0 income, 1 expense, 3 transfer out (toAssetUid is the other account), 4 its mirror
// in the other account (github.com/brianpunzalan/finance-manager research.md; github.com/Oppai1442/O-Wallet
// sqliteImport.worker.ts), 7 / 8 balance up / down ("Modified Bal.", github.com/skypad123/mmbak-parser types.rs).
// Realbyte keeps no balance: each account's is what its rows add up to, so 7 / 8 become its opening balance.
// ponytail: the iPhone backup (Core Data, Z-prefixed tables) is refused with a message; add it when someone has one.
const SQLITE = 'SQLite format 3\0';
const isSqlite = b => b.length > 100 && String.fromCharCode(...b.subarray(0, 16)) === SQLITE;
export async function readRealbyte(buf, SQL, { now = Date.now() } = {}) {
  let bytes = new Uint8Array(buf);
  if (!isSqlite(bytes)) {
    const z = await unzip(buf, n => !n.endsWith('/') && !/\.(jpe?g|png|gif|webp)$/i.test(n), { entries: 20 });
    bytes = Object.values(z).find(x => x && isSqlite(x));
    if (!bytes) throw new Error('This file is not a Money Manager backup (no database inside).');
  }
  const db = new SQL.Database(bytes);
  try {
    const rows = sql => { const r = db.exec(sql)[0]; return r ? r.values.map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : []; };
    const cols = t => new Set(rows(`select name from pragma_table_xinfo('${t}') where hidden <= 1`).map(c => c.name));
    const has = t => rows(`select name from sqlite_master where type='table' and name='${t}' and upper(coalesce(sql, '')) not like 'CREATE VIRTUAL%'`).length > 0 && rows(`select count(*) as n from pragma_table_xinfo('${t}') where hidden > 1`)[0].n === 0;
    if (!['INOUTCOME', 'ASSETS'].every(has)) {
      if (['wallets', 'transactions', 'categories'].every(has)) return readCashew({ rows, cols, now });   // Cashew's backup is SQLite too (.sql)
      if (has('ZINOUTCOME')) throw new Error('This is an iPhone Money Manager backup. Export to Excel in the app instead, and import that file.');
      throw new Error('This Money Manager backup is from a version Tally does not know yet.');
    }
    const live = (t, c = cols(t)) => (c.has('IS_DEL') ? 'coalesce(IS_DEL, 0) = 0' : c.has('C_IS_DEL') ? 'coalesce(C_IS_DEL, 0) = 0' : '1');
    const need = (t, list) => { const c = cols(t); return list.every(x => c.has(x)); };
    if (!need('INOUTCOME', ['uid', 'assetUid', 'DO_TYPE', 'ZMONEY', 'ZDATE']) || !need('ASSETS', ['uid', 'NIC_NAME'])) throw new Error('This Money Manager backup is from a version Tally does not know yet.');

    const customCats = [], catMap = Object.create(null), subOf = Object.create(null);
    if (has('ZCATEGORY') && need('ZCATEGORY', ['uid', 'NAME', 'TYPE'])) {
      const all = rows(`select uid, NAME, TYPE${cols('ZCATEGORY').has('pUid') ? ', pUid' : ", '' as pUid"} from ZCATEGORY where ${live('ZCATEGORY')} limit 2000`);
      const byUid = new Map(all.map(c => [String(c.uid), c]));
      for (const c of all) if (!byUid.get(String(c.pUid)))
        catMap[String(c.uid)] = keepName(cleanText(c.NAME, 40) || 'Category', String(c.TYPE) === '0', customCats, `c_rb_${hash(c.uid)}`, nextColor(customCats.map(x => x.color)));
      // A subcategory files under its category and keeps its name as the entry's subcategory.
      for (const c of all) if (byUid.get(String(c.pUid))) subOf[String(c.uid)] = cleanText(c.NAME, 30);
      for (const c of all) if (byUid.get(String(c.pUid))) catMap[String(c.uid)] = catMap[String(c.pUid)] || (String(c.TYPE) === '0' ? 'income' : 'other');
    }

    const ac = cols('ASSETS'), cur = has('CURRENCY') && ac.has('currencyUid') && need('CURRENCY', ['uid', 'ISO']);
    const accRows = rows(`select a.uid, a.NIC_NAME${cur ? ', c.ISO as iso' : ''} from ASSETS a${cur ? ' left join CURRENCY c on c.uid = a.currencyUid' : ''} where ${live('ASSETS', ac).replace(/(IS_DEL|C_IS_DEL)/, 'a.$1')} limit 200`);
    const accId = new Map(accRows.map(a => [String(a.uid), rbId(a.uid)]));
    const ic = cols('INOUTCOME'), opt = c => (ic.has(c) ? c : `null as ${c}`);
    const tx = [], opening = new Map();
    let skipped = 0, adjustments = 0, transfers = 0;
    for (const t of rows(`select uid, assetUid, ${opt('toAssetUid')}, ${opt('ctgUid')}, ${opt('ZCONTENT')}, ZDATE, ${opt('WDATE')}, DO_TYPE, ZMONEY from INOUTCOME where ${live('INOUTCOME', ic)} limit 200000`)) {
      const kind = String(t.DO_TYPE), amt = Math.round(Math.abs(Number(t.ZMONEY)) * 100), acc = accId.get(String(t.assetUid));
      const ms = Number(t.ZDATE), d = new Date(ms > 1e11 ? ms : ms * 1000);
      const date = !isNaN(d) && ms > 0 ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : String(t.WDATE || '').slice(0, 10);
      if (kind === '4') continue;   // the mirror half of a transfer: its DO_TYPE 3 row is the transfer
      if (!acc || !Number.isInteger(amt) || amt <= 0 || amt > MAX_SEN || !validIso(date)) { skipped++; continue; }
      if (kind === '7' || kind === '8') { opening.set(acc, (opening.get(acc) || 0) + (kind === '7' ? amt : -amt)); adjustments++; continue; }
      const base = { id: rbId(t.uid), date, ...(isNaN(d) ? {} : { time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }), amount: amt, accountId: acc, merchant: cleanText(t.ZCONTENT, 80), note: '', source: 'import', createdAt: now };
      if (kind === '3') {
        const to = accId.get(String(t.toAssetUid));
        if (!to || to === acc) { skipped++; continue; }
        const fromCurrency = String(accRows.find(a => String(a.uid) === String(t.assetUid))?.iso || 'MYR').trim().toUpperCase(), toCurrency = String(accRows.find(a => String(a.uid) === String(t.toAssetUid))?.iso || 'MYR').trim().toUpperCase();
        if (fromCurrency !== toCurrency) throw new Error('This Money Manager backup has transfers between different currencies that cannot be read safely. Nothing was imported.');
        tx.push({ ...base, type: 'transfer', toAccountId: to, category: 'other' }); transfers++;
      } else if (kind === '0' || kind === '1') {
        const type = kind === '0' ? 'income' : 'expense';
        tx.push({ ...base, type, category: catMap[String(t.ctgUid)] || (type === 'income' ? 'income' : 'other'), ...(subOf[String(t.ctgUid)] ? { sub: subOf[String(t.ctgUid)] } : {}) });
      } else skipped++;
    }
    const accounts = accRows.map((a, n) => {
      const id = accId.get(String(a.uid)), title = String(a.NIC_NAME || ''), bal = opening.get(id) || 0;
      return { id, name: cleanText(title, 60) || 'Account', kind: guessKind(title), opening: okSigned(bal) ? bal : 0, createdAt: now + n, currency: String(a.iso || 'MYR').toUpperCase() };
    });
    return { accounts: accounts.map(keepCurrency), tx, customCats, photos: [], skipped, adjustments, otherCurrency: accounts.map(keepCurrency).filter(a => a.currency).map(a => a.name), transfersSkipped: 0, transfers, app: 'realbyte' };
  } finally { db.close(); }
}
// Cashew (github.com/jameskokoska/Cashew, Drift/SQLite, backup "*.sql"): wallets, categories (income 0/1, "0" is its
// Balance Correction), transactions (amount signed: spending negative; date_created in seconds; paid 0 = an upcoming
// or planned one, not happened yet; a transfer is two rows linked by paired_transaction_fk). Ids match the ones a
// converted Cashew backup got, so importing both never doubles anything.
function readCashew({ rows, cols, now }) {
  const need = (t, list) => { const c = cols(t); return list.every(x => c.has(x)); };
  if (!need('transactions', ['transaction_pk', 'amount', 'category_fk', 'wallet_fk', 'date_created']) || !need('wallets', ['wallet_pk', 'name']) || !need('categories', ['category_pk', 'name']))
    throw new Error('This Cashew backup is from a version Tally does not know yet.');
  const cw = pk => `cw_${hash(pk)}`, tc = cols('transactions'), opt = c => (tc.has(c) ? c : `null as ${c}`);
  // Refuse the entire file before projecting any rows. Partial collections can clear
  // type=3 while keeping objective_loan_fk; importing those as ordinary cashflow loses debt.
  // Probe the full table, not the later 200000-row preview limit.
  const debt = [tc.has('type') ? "(type = 3 or cast(type as text) = '3')" : '',
    tc.has('objective_loan_fk') ? "(objective_loan_fk is not null and length(cast(objective_loan_fk as text)) > 0)" : ''].filter(Boolean);
  if (debt.length && rows(`select 1 as unsupported from transactions where ${debt.join(' or ')} limit 1`).length)
    throw Object.assign(new Error("This Cashew backup contains loans or split debts that Tally cannot import safely. Nothing was imported. Keep the original backup and use Cashew for these debts."), { code: 'UNSUPPORTED_CASHEW_DEBT' });
  const customCats = [], catMap = Object.create(null), subMap = Object.create(null);
  const categories = rows(`select category_pk, name, ${cols('categories').has('income') ? 'income' : '0 as income'}, ${cols('categories').has('main_category_pk') ? 'main_category_pk' : 'null as main_category_pk'} from categories limit 2000`);
  const categoryIds = new Set(categories.map(c => String(c.category_pk)));
  for (const c of categories) if (String(c.category_pk) !== '0' && !categoryIds.has(String(c.main_category_pk)))
    catMap[String(c.category_pk)] = keepName(cleanText(c.name, 40) || 'Category', c.income === 1, customCats, `c_cw_${hash(c.category_pk)}`, nextColor(customCats.map(x => x.color)));
  for (const c of categories) if (categoryIds.has(String(c.main_category_pk))) {
    subMap[String(c.category_pk)] = { name: cleanText(c.name, 30), parent: String(c.main_category_pk) };
    catMap[String(c.category_pk)] = catMap[String(c.main_category_pk)] || (c.income === 1 ? 'income' : 'other');
  }
  const wc = cols('wallets'), wallets = rows(`select wallet_pk, name${wc.has('currency') ? ', currency' : ''}${wc.has('date_created') ? ', date_created' : ''} from wallets limit 200`);
  const accId = new Map(wallets.map(w => [String(w.wallet_pk), cw(w.wallet_pk)]));
  const all = rows(`select transaction_pk, ${opt('paired_transaction_fk')}, ${opt('name')}, ${opt('note')}, amount, category_fk, wallet_fk, date_created, ${opt('paid')}, ${opt('sub_category_fk')} from transactions limit 200000`);
  const byPk = new Map(all.map(t => [String(t.transaction_pk), t])), tx = [], opening = new Map(), done = new Set(), backLinks = new Map();
  for (const row of all) if (row.paired_transaction_fk != null) {
    const key = String(row.paired_transaction_fk); (backLinks.get(key) || backLinks.set(key, []).get(key)).push(row);
  }
  let skipped = 0, adjustments = 0, transfers = 0, planned = 0;
  const when = s => { const n = Number(s), d = new Date(n > 1e11 ? n : n * 1000); return isNaN(d) || n <= 0 ? null : { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }; };
  for (const t of all) {
    const pk = String(t.transaction_pk), acc = accId.get(String(t.wallet_fk)), w = when(t.date_created), amt = Math.round(Math.abs(Number(t.amount)) * 100);
    if (done.has(pk)) continue;
    if (t.paid === 0) { planned++; continue; }
    if (!acc || !w || !validIso(w.date) || !Number.isInteger(amt) || amt > MAX_SEN) { skipped++; continue; }
    if (!amt) continue;
    const inbound = backLinks.get(pk) || [];
    const other = t.paired_transaction_fk != null ? byPk.get(String(t.paired_transaction_fk)) : inbound.length === 1 ? inbound[0] : null, otherAcc = other && accId.get(String(other.wallet_fk));
    if (t.paired_transaction_fk != null || inbound.length) {
      const otherAmount = other && Math.round(Math.abs(Number(other.amount)) * 100);
      const pairOnly = other && (other.paired_transaction_fk == null || String(other.paired_transaction_fk) === pk) && inbound.every(row => String(row.transaction_pk) === String(other.transaction_pk)) && (backLinks.get(String(other.transaction_pk)) || []).every(row => String(row.transaction_pk) === pk);
      if (!otherAcc || otherAcc === acc || !pairOnly || other.paid === 0 || !when(other.date_created) || !Number.isInteger(otherAmount) || otherAmount <= 0 || otherAmount > MAX_SEN || !(Number(t.amount) * Number(other.amount) < 0)) { skipped++; continue; }
      done.add(pk); done.add(String(other.transaction_pk));
      const outgoing = Number(t.amount) < 0 ? t : other, incoming = outgoing === t ? other : t;
      const fromAmount = Math.round(Math.abs(Number(outgoing.amount)) * 100), toAmount = Math.round(Math.abs(Number(incoming.amount)) * 100);
      tx.push({ id: cw(String(outgoing.transaction_pk)), ...when(outgoing.date_created), type: 'transfer', amount: fromAmount, ...(toAmount !== fromAmount ? { toAmount } : {}), accountId: accId.get(String(outgoing.wallet_fk)), toAccountId: accId.get(String(incoming.wallet_fk)), category: 'other', merchant: cleanText(outgoing.name, 80), note: cleanText(outgoing.note, 200), source: 'import', createdAt: now });
      transfers++; continue;
    }
    if (String(t.category_fk) === '0') { opening.set(acc, (opening.get(acc) || 0) + (Number(t.amount) < 0 ? -amt : amt)); adjustments++; continue; }   // Balance Correction: not spending
    const type = Number(t.amount) > 0 ? 'income' : 'expense';
    let category = catMap[String(t.category_fk)] || (type === 'income' ? 'income' : 'other');
    if (type === 'income' && !INCOME_CATEGORIES.some(c => c.id === category) && !customCats.some(c => c.id === category && c.kind === 'income')) category = 'income';
    if (type === 'expense' && (INCOME_CATEGORIES.some(c => c.id === category) || customCats.some(c => c.id === category && c.kind === 'income'))) category = 'other';
    const sub = subMap[String(t.sub_category_fk)] || subMap[String(t.category_fk)];
    const subName = sub && catMap[sub.parent] === category ? sub.name : '';
    tx.push({ id: cw(pk), ...w, type, amount: amt, accountId: acc, category, ...(subName ? { sub: subName } : {}), merchant: cleanText(t.name, 80), note: cleanText(t.note, 200), source: 'import', createdAt: now });
  }
  const accounts = wallets.map((a, n) => {
    const id = accId.get(String(a.wallet_pk)), bal = opening.get(id) || 0, made = Number(a.date_created) * 1000;
    return { id, name: cleanText(a.name, 60) || 'Wallet', kind: guessKind(String(a.name || '')), opening: okSigned(bal) ? bal : 0, createdAt: made > Date.UTC(2000, 0, 1) && made <= now + 864e5 ? made : now + n, currency: String(a.currency || 'MYR').toUpperCase() };
  });
  return { accounts: accounts.map(keepCurrency), tx, customCats, photos: [], skipped, adjustments, planned, otherCurrency: accounts.map(keepCurrency).filter(a => a.currency).map(a => a.name), transfersSkipped: 0, transfers, app: 'cashew' };
}
/** An account in another currency keeps it (left out of the RM total, shown with its code); an RM one has none. */
const keepCurrency = ({ currency, ...a }) => {
  const code = String(currency || 'MYR').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error('This backup has an unreadable account currency. Nothing was imported.');
  return code !== 'MYR' ? { ...a, currency: code } : a;
};
const rbId = u => { const text = String(u), id = `rb_${text}`; return text.length <= 40 && okId(id) ? id : `rb_h${hash(text)}`; };

/** Photo bytes for some of the imported transactions (read from the same backup, only when the user asks). */
export const readPhotos = (buf, paths) => { const want = new Set(paths); return unzip(buf, n => want.has(n)); };
