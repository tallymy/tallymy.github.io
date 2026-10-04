/** ExpenseIQ V3 native backup reader. Parses a small data grammar; never executes SQL. */
export const LIMITS = Object.freeze({ input: 16 * 1024 * 1024, row: 65536, rows: 100000, photos: 200 * 1024 * 1024, photo: 40 * 1024 * 1024 });
const MAX = 10000000000, UUID = /^[a-f0-9]{32}$/;
const SCHEMAS = Object.freeze({
  account: '_id name description currency start_balance monthly_budget create_date position default_tran_status exclude_from_total uuid updated deleted icon color hidden',
  tran: '_id account_id title amount tran_date remarks category_id status repeat_id photo_id split_id transfer_account_id project_uuid uuid updated deleted',
  category: '_id name description color type parent_id uuid updated deleted icon',
  category_tag: '_id category_id name uuid updated deleted',
  category_color: '_id category_id color_code uuid updated deleted',
  budget: '_id account_id category_id amount currency uuid updated deleted',
  user_settings: '_id default_reminder_days reminder_time currency_symbol currency_code bills_reminder_currency default_reporting_period default_reporting_chart_period autobackup_time autobackup_enabled account_balance_display forward_period forward_period_bills auto_delete_backup_enabled auto_delete_backup_days sound_fx_enabled uuid updated deleted'
});
function fail(message) { throw new Error(`ExpenseIQ: ${message} Nothing was imported.`); }
function text(v, max, field) { if (typeof v !== 'string' || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) fail(`Invalid ${field}.`); return v; }
function integer(v, field) { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail(`Invalid ${field}.`); return v; }
function uid(v) { if (typeof v !== 'string' || !UUID.test(v)) fail('Invalid record UUID.'); return v.toLowerCase(); }
function money(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || !/^-?\d+(?:\.\d{1,2})?$/.test(String(v))) fail('Invalid money amount or fractional cents.');
  const n = Math.round(v * 100);
  if (!Number.isSafeInteger(n) || Math.abs(n) > MAX || Math.abs(v * 100 - n) > 0.00001) fail('Amounts must be exact cents within the supported limit.');
  return n;
}
const blank = v => v === null || v === '';
/** Restricted literal list: quoted SQLite text with doubled quotes, null, decimal numbers. */
function literals(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    while (/\s/.test(s[i] || '') && i < s.length) i++;
    let value;
    if (s[i] === "'") {
      i++; let valueText = '', closed = false;
      while (i < s.length) {
        if (s[i] === "'") { if (s[i + 1] === "'") { valueText += "'"; i += 2; continue; } i++; closed = true; break; }
        valueText += s[i++];
      }
      if (!closed) fail('Unclosed text literal.'); value = valueText;
    } else {
      const start = i; while (i < s.length && s[i] !== ',') i++;
      const token = s.slice(start, i).trim();
      if (/^null$/i.test(token)) value = null;
      else if (/^-?\d{1,15}(?:\.\d{1,8})?$/.test(token)) value = Number(token);
      else fail('Unsupported SQL literal or expression.');
    }
    out.push(value); while (i < s.length && /\s/.test(s[i])) i++;
    if (i === s.length) break;
    if (s[i++] !== ',' || i === s.length) fail('Invalid literal separators.');
  }
  return out;
}
function rowsOf(input) {
  if (!(input instanceof Uint8Array) || input.byteLength > LIMITS.input) fail('Backup exceeds the 16 MiB limit or is not bytes.');
  let raw; try { raw = new TextDecoder('utf-8', { fatal: true }).decode(input); } catch { fail('Backup is not valid UTF-8.'); }
  let breaks = 0; for (const c of raw) if (c === '\n' && ++breaks > LIMITS.rows + 2) fail('Too many encoded rows.');
  const lines = raw.split(/\r?\n/);
  if (lines.shift() !== '[EASYMONEY_BACKUP_V3]') fail('Choose an ExpenseIQ V3 native backup; this version is unsupported.');
  const tables = new Map(Object.keys(SCHEMAS).map(k => [k, []])); let count = 0;
  for (let index = 0; index < lines.length; index++) {
    const hex = lines[index]; if (!hex && index === lines.length - 1) continue;
    if (!hex || hex.length > LIMITS.row * 2 || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex) || ++count > LIMITS.rows) fail('Malformed or oversized encoded row.');
    const bytes = new Uint8Array(hex.length / 2);
    for (let j = 0; j < bytes.length; j++) bytes[j] = parseInt(hex[hex.length - 1 - j * 2] + hex[hex.length - 2 - j * 2], 16);
    let sql; try { sql = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('A row is not valid UTF-8.'); }
    const m = /^INSERT INTO ([a-z_]+)\(([^)]+)\)\s+VALUES\(([\s\S]*)\)\s*$/.exec(sql);
    if (!m || !Object.hasOwn(SCHEMAS, m[1])) fail('Unsupported table or SQL form; use a supported transaction export instead.');
    const columns = m[2].split(',').map(s => s.trim());
    if (columns.join(' ') !== SCHEMAS[m[1]]) fail(`Unsupported ${m[1]} column schema.`);
    const values = literals(m[3]); if (values.length !== columns.length) fail('Wrong number of row values.');
    const row = Object.fromEntries(columns.map((c, j) => [c, values[j]]));
    integer(row._id, 'row ID'); if (!row._id) fail('Invalid row ID.'); uid(row.uuid);
    if (!['0', '1'].includes(row.deleted)) fail('Unknown deletion marker.');
    tables.get(m[1]).push(row);
  }
  for (const rows of tables.values()) {
    const ids = new Set(), uuids = new Set();
    for (const row of rows) { if (ids.has(row._id) || uuids.has(uid(row.uuid))) fail('Duplicate source record.'); ids.add(row._id); uuids.add(uid(row.uuid)); }
  }
  return tables;
}
export function readExpenseIQ(input, { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const tables = rowsOf(input), live = name => tables.get(name).filter(r => r.deleted === '0');
  let formatter; try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch { fail('Invalid preview timezone.'); }
  const when = value => { integer(value, 'transaction timestamp'); if (value < 631152000000 || value > 4102444799999) fail('Timestamp is outside 1990–2099.'); const p = Object.fromEntries(formatter.formatToParts(value).map(x => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }; };
  const currency = value => { if (value !== 'MYR') fail('Only MYR ExpenseIQ native backups are supported; foreign currencies cannot be converted safely.'); };
  const accRows = live('account'); if (!accRows.length || accRows.length > 200) fail('Invalid account count.');
  const accountMap = new Map(), accounts = accRows.map(r => {
    currency(r.currency); text(r.name, 40, 'account name'); if (!r.name.trim()) fail('Empty account name.');
    when(r.create_date);
    if (r.exclude_from_total !== 'No' || r.hidden !== 0 || r.default_tran_status !== 'U') fail('Excluded, hidden or reconciled account semantics are not supported.');
    const id = `eiq_${uid(r.uuid)}`; accountMap.set(uid(r.uuid), id);
    return { id, name: r.name, kind: /^cash$/i.test(r.name) ? 'cash' : 'bank', opening: money(r.start_balance), createdAt: r.create_date, typed: true };
  });
  const catRows = live('category'), categoryMap = new Map(catRows.map(r => [uid(r.uuid), r]));
  const customCats = [], subcats = Object.create(null);
  for (const r of catRows) {
    text(r.name, blank(r.parent_id) ? 40 : 30, 'category name'); if (!r.name.trim() || !['E', 'I'].includes(r.type)) fail('Invalid category name or type.');
    if (blank(r.parent_id)) {
      const color = String(r.color || '').replace(/^ff/i, '');
      customCats.push({ id: `c_eiq_${uid(r.uuid)}`, name: r.name, color: /^[a-f0-9]{6}$/i.test(color) ? `#${color}` : '#64748B', ...(r.type === 'I' ? { kind: 'income' } : {}) });
    } else {
      const parent = categoryMap.get(uid(r.parent_id));
      if (!parent || !blank(parent.parent_id) || parent.type !== r.type) fail('Missing, cyclic or nested subcategory parent.');
      const key = `c_eiq_${uid(parent.uuid)}`; (subcats[key] ||= []).push(r.name);
      if (subcats[key].length > 30 || new Set(subcats[key]).size !== subcats[key].length) fail('Too many or duplicate subcategory names.');
    }
  }
  if (customCats.length > 50) fail('More than 50 root categories are not supported.');
  for (const r of live('user_settings')) currency(r.currency_code);
  const source = live('tran'), tx = [], photos = new Map(), used = new Set(); let transfers = 0;
  const transferIndex = new Map();
  const transferKey = r => `${r.account_id}|${r.transfer_account_id}|${r.tran_date}|${money(r.amount)}`;
  for (const r of source) {
    if (!blank(r.repeat_id) || !blank(r.split_id) || !blank(r.project_uuid)) fail('Split, repeating or project/debt transactions are not supported. Export ordinary transactions separately.');
    if (r.status !== 'U') fail('Cleared or reconciled transaction status is not supported.');
    if (!accountMap.has(uid(r.account_id))) fail('Transaction refers to a missing account.');
    if (!categoryMap.has(uid(r.category_id))) fail('Transaction refers to a missing category.');
    text(r.title, 80, 'transaction title'); text(r.remarks, 200, 'transaction notes'); when(r.tran_date);
    if (!blank(r.photo_id) && (typeof r.photo_id !== 'string' || r.photo_id.length > 120 || !/^[\w .-]+\.jpe?g$/i.test(r.photo_id) || r.photo_id.includes('..'))) fail('Unsafe or unsupported receipt filename.');
    money(r.amount); if (!r.amount) fail('Zero amount transactions are not supported.');
    if (!blank(r.transfer_account_id)) { uid(r.transfer_account_id); const key = transferKey(r); if (!transferIndex.has(key)) transferIndex.set(key, []); transferIndex.get(key).push(r); }
  }
  for (const r of source) {
    if (used.has(r.uuid)) continue;
    const cat = categoryMap.get(uid(r.category_id)), amount = money(r.amount), id = `eiq_${uid(r.uuid)}`;
    const base = { id, ...when(r.tran_date), accountId: accountMap.get(uid(r.account_id)), merchant: r.title, note: r.remarks, source: 'import', createdAt: r.tran_date };
    let entry;
    if (!blank(r.transfer_account_id)) {
      uid(r.transfer_account_id); if (!accountMap.has(r.transfer_account_id) || r.transfer_account_id === r.account_id) fail('Invalid transfer account.');
      const matches = transferIndex.get(`${r.transfer_account_id}|${r.account_id}|${r.tran_date}|${-amount}`) || [];
      if (matches.length !== 1 || used.has(matches[0].uuid)) fail('Transfer pair is missing or ambiguous.');
      const other = matches[0], out = amount < 0 ? r : other, incoming = amount < 0 ? other : r;
      if (categoryMap.get(out.category_id).type !== 'E' || categoryMap.get(incoming.category_id).type !== 'I' || !blank(out.photo_id) || !blank(incoming.photo_id) || out.remarks !== incoming.remarks) fail('Unsupported transfer category, notes or photo semantics.');
      entry = { ...base, id: `eiq_${out.uuid}`, accountId: accountMap.get(out.account_id), merchant: out.title, type: 'transfer', amount: Math.abs(amount), toAccountId: accountMap.get(incoming.account_id), category: 'other' };
      used.add(other.uuid); transfers++;
    } else {
      if ((cat.type === 'E' && amount > 0) || (cat.type === 'I' && amount < 0)) fail('Refund or category/sign semantics are not supported.');
      const parent = blank(cat.parent_id) ? cat : categoryMap.get(cat.parent_id);
      entry = { ...base, type: amount < 0 ? 'expense' : 'income', amount: Math.abs(amount), category: `c_eiq_${parent.uuid}`, ...(!blank(cat.parent_id) ? { sub: cat.name } : {}) };
      if (!blank(r.photo_id)) { const path = `photos/${r.photo_id}`; if (!photos.has(path)) photos.set(path, { path, txIds: [] }); photos.get(path).txIds.push(id); }
    }
    tx.push(entry); used.add(r.uuid);
  }
  const warnings = ['Account kinds are inferred from the name: Cash becomes cash; other accounts become bank. Review them before saving.', `Dates and times use ${timeZone}; the backup does not record its original timezone.`, 'ExpenseIQ app preferences, payee lists and category colours are not fully restored.'];
  if (photos.size) warnings.push('This backup contains receipt filenames, not photo bytes. Select the matching full-size companion photos, or explicitly continue without them.');
  if (live('budget').length || accRows.some(r => money(r.monthly_budget) !== 0)) warnings.push('ExpenseIQ budgets are not imported. Transaction amounts and opening balances are preserved.');
  const skipped = [...tables.values()].flat().filter(r => r.deleted === '1').length;
  if (skipped) warnings.push(`${skipped} deleted source records were left out.`);
  return { app: 'expenseiq', format: 'expenseiq-v3', accounts, tx, customCats, subcats, photos: [...photos.values()], transfers, skipped, adjustments: 0, otherCurrency: [], warnings, requiresReview: true };
}
/** Filename matching is not source authentication: ExpenseIQ stores no photo hash. No decoding or writes here. */
export async function mapExpenseIQPhotos(preview, files) {
  if (!(files instanceof Map) || files.size > 10000) fail('Invalid companion-photo selection.');
  if (!preview || preview.format !== 'expenseiq-v3' || !Array.isArray(preview.photos) || preview.photos.length > 10000) fail('Invalid photo preview.');
  const selected = [], paths = new Set(); let total = 0, references = 0;
  // Own the whole selection before the first await; callers cannot change a pending selection.
  for (const ref of preview.photos) {
    if (!ref || typeof ref.path !== 'string' || !/^photos\/[\w .-]+\.jpe?g$/i.test(ref.path) || ref.path.length > 127 || ref.path.includes('..') || paths.has(ref.path) || !Array.isArray(ref.txIds) || !ref.txIds.length || (references += ref.txIds.length) > LIMITS.rows || ref.txIds.some(id => typeof id !== 'string' || !/^eiq_[a-f0-9]{32}$/.test(id))) fail('Invalid companion-photo reference.');
    paths.add(ref.path);
    const bytes = files.get(ref.path);
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > LIMITS.photo || (total += bytes.length) > LIMITS.photos) fail(`Missing or oversized companion photo: ${ref.path}.`);
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) fail('Companion photo is not a JPEG.');
    selected.push({ path: ref.path, txIds: [...ref.txIds], bytes: bytes.slice() });
  }
  const result = [];
  for (const ref of selected) {
    const digest = await crypto.subtle.digest('SHA-256', ref.bytes);
    result.push({ ...ref, sha256: [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join(''), decodeVerified: false });
  }
  return result;
}
