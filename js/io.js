// Files in and out: CSV / Excel / Google Sheets import from other money apps and bank statements, CSV export,
// JSON backup. Everything read from a file is untrusted: sizes, dates and amounts are checked.
import { RELIEFS, parseAmount, validIso, daysBetween, CATEGORIES, INCOME_CATEGORIES, categorize, shopCategory, incomeCategory, allocate, movedTo, ACCOUNT_KINDS, OWING_KINDS } from './engine.js';
import { CAT_ICONS } from './caticons.js';
import { isNative, saveFile } from './native.js';

export const LIMITS = { fileBytes: 25 * 1024 * 1024, backupBytes: 200 * 1024 * 1024, backupJson: 50 * 1024 * 1024, photoBytes: 40 * 1024 * 1024, pixels: 50_000_000, rows: 50_000, text: 200 };

// ---- CSV (adapted from we go gim's io.js) ------------------------------------------------
export function csvDelimiter(text) {
  const first = String(text).split(/\r?\n/, 1)[0].replace(/"[^"]*"/g, '');
  const n = c => first.split(c).length - 1;
  return [';', '\t'].reduce((best, c) => (n(c) > n(best) ? c : best), ',');
}
export function parseCSV(text, delim = csvDelimiter(text)) {
  // Full-width digits and punctuation (Chinese/Japanese keyboards) read as normal ones; runaway cells are cut.
  text = String(text).normalize('NFKC');
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { if (cell.length < 2000) cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else if (cell.length < 2000) cell += c;   // quoted cells are capped too: a 1 MB cell would stall the regexes
    } else if (c === '"' && cell === '') inQ = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else if (cell.length < 2000) cell += c;
    if (rows.length > LIMITS.rows) throw new Error(`This file has more than ${LIMITS.rows} rows. Split it into smaller files and import each one.`);
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  if (rows.length > LIMITS.rows) throw new Error(`This file has more than ${LIMITS.rows} rows. Split it into smaller files and import each one.`);
  return rows.filter(r => r.some(x => x.trim() !== ''));
}
/** Bytes → text: UTF-8 (with or without BOM), UTF-16, else GBK or Big5 when that reads as a money file's Chinese
 *  headers (日期, 金额, 余额…), else Windows-1252. AndroMoney's banner line says Big5 outright. */
export function decodeBytes(u8) {
  const b = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  const utf8 = new TextDecoder('utf-8').decode(b);
  if (!utf8.includes('�')) return utf8;
  if (/andromoney/i.test(utf8.slice(0, 200))) return new TextDecoder('big5').decode(b);
  const words = (enc, re) => { try { return (new TextDecoder(enc, { fatal: true }).decode(b.subarray(0, 4000)).match(re) || []).length; } catch { return 0; } };
  const gbk = words('gb18030', /日期|金额|收入|支出|余额|结余|类别|备注|账户|时间|摘要|交易/g), big5 = words('big5', /日期|金額|收入|支出|餘額|結餘|類別|備註|帳戶|時間|摘要|交易/g);
  return new TextDecoder(gbk && gbk >= big5 ? 'gb18030' : big5 ? 'big5' : 'windows-1252').decode(b);
}
/** Hidden characters out, length capped: names from files can't break the layout or hide text. */
export const cleanText = (s, max = LIMITS.text) => String(s ?? '').slice(0, max * 4).normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// ---- Excel (.xlsx) without a library: a zip of XML files, inflated with the built-in DecompressionStream ----
// Zips are untrusted (.xlsx, Money Manager and photo backups): one inflate budget per unzip call (zip bombs), a cap on entries read, and every offset checked.
export const ZIP = { budget: 150 * 1024 * 1024, entries: 5000 };
/** A byte stream → one Uint8Array; 'too big' past `max` bytes (zip entries, a fetched sheet). */
export async function readAll(stream, max) {
  const reader = stream.getReader(), parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { await reader.cancel().catch(() => {}); throw new Error('too big'); }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
/** A fetch response's bytes, refused past `max`: by Content-Length first, then while streaming. */
export async function readCapped(res, max) {
  if (+res.headers.get('content-length') > max) throw new Error('too big');
  return res.body ? readAll(res.body, max) : new Uint8Array(0);
}
const inflateRaw = (bytes, max) => {
  let decoder;try { decoder = new DecompressionStream('deflate-raw'); } catch { throw new Error('This Android WebView cannot open compressed ZIP entries. Update Android System WebView and try again.'); }
  return readAll(new Blob([bytes]).stream().pipeThrough(decoder), max);
};
/** Zip → {path: Uint8Array} for the paths wanted (stored or deflated entries). Bytes before the zip are
 * allowed (Money Manager backups start with 8 of them): offsets are taken from the first local header.
 * A deflated entry may not inflate past its declared size, nor all of them past `budget`; a repeated name is read once. */
export async function unzip(buf, want, { budget = ZIP.budget, entries = ZIP.entries, onEntry = async () => {} } = {}) {
  const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const bad = () => { throw new Error('bad zip'); };
  if (b.length < 22) bad();
  let base = 0;
  while (base < Math.min(64, b.length - 4) && dv.getUint32(base, true) !== 0x04034b50) base++;
  if (dv.getUint32(base, true) !== 0x04034b50) base = 0;
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) bad();
  const count = dv.getUint16(eocd + 10, true);
  let p = base + dv.getUint32(eocd + 16, true), left = budget, read = 0, taken = 0;
  const out = Object.create(null); // entry names are untrusted: "__proto__" is just a name here
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || dv.getUint32(p, true) !== 0x02014b50) bad();
    const flags = dv.getUint16(p + 8,true), checksum=dv.getUint32(p+16,true);
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true), full = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = base + dv.getUint32(p + 42, true);
    if (p + 46 + nameLen > b.length) bad();
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    await onEntry(n+1,count);
    if (!want(name) || name in out) continue;
    if(flags & 1)bad();
    if (++read > entries) break;
    if (local + 30 > b.length || dv.getUint32(local, true) !== 0x04034b50) bad();
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    if (start + size > b.length) bad();
    // Entries that don't overlap can't add up past the file: names sharing one local entry (or local headers nested in
    // each other's extra field) would hand out the same bytes thousands of times, past every budget.
    if ((taken += size) > b.length) bad();
    const data = b.subarray(start, start + size);
    if (method === 0) { if (size > left) throw new Error('too big'); out[name] = data; left -= size; } // stored: a view of the file, no copy
    else if (method === 8) { if (full > left) throw new Error('too big'); out[name] = await inflateRaw(data, full); left -= out[name].length; }
    else bad();
    if(out[name].length!==full || crc32(out[name])!==checksum)bad();
  }
  return out;
}
const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => cp(+n)).replace(/&#x([0-9a-f]+);/gi, (m, h) => cp(parseInt(h, 16))).replace(/&amp;/g, '&');
const colIndex = ref => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
// Linear scans with indexOf: a lazy regex over the whole sheet re-scans to the end on every unclosed "<row" (quadratic).
/** Each <tag …>body</tag> (or self-closed <tag …/>) in xml → fn(attrs, body). Stops early when fn returns false. */
function eachTag(xml, tag, fn) {
  const open = `<${tag}`, close = `</${tag}>`;
  for (let p = 0; ;) {
    const s = xml.indexOf(open, p);
    if (s < 0) return;
    const gt = xml.indexOf('>', s);
    if (gt < 0) return;
    const next = xml[s + open.length];
    if (next !== ' ' && next !== '>' && next !== '/' && next !== '\t' && next !== '\n' && next !== '\r') { p = s + open.length; continue; } // <col> is not <c>
    if (xml[gt - 1] === '/') { if (fn(xml.slice(s + open.length, gt - 1), '') === false) return; p = gt + 1; continue; }
    const e = xml.indexOf(close, gt);
    if (e < 0) return;
    if (fn(xml.slice(s + open.length, gt), xml.slice(gt + 1, e)) === false) return;
    p = e + close.length;
  }
}
const texts = body => { let s = ''; eachTag(body, 't', (a, b) => { s += b; }); return s; };
/** Shared strings (capped) and one worksheet's XML → rows of strings. Exported for the timing test. */
const serialIso = (n, base1904) => { const d = new Date(Date.UTC(base1904 ? 1904 : 1899, base1904 ? 0 : 11, base1904 ? 1 : 30) + Math.floor(n) * 864e5 + Math.round((n % 1) * 1440) * 6e4); return d.toISOString().slice(0, n % 1 ? 16 : 10).replace('T', ' '); };
export function sheetRows(xml, shared = [], { dates = new Set(), base1904 = false } = {}) {
  const rows = [], nums = [];
  eachTag(xml, 'row', (ra, body) => {
    const row = [];
    nums.push(+ra.match(/\br="(\d+)"/)?.[1] || (nums.at(-1) || 0) + 1);
    let n = 0;
    eachTag(body, 'c', (attrs, cell) => {
      const ref = attrs.match(/\br="([A-Z]{1,3})\d+"/)?.[1], type = attrs.match(/\bt="(\w+)"/)?.[1], st = attrs.match(/\bs="(\d+)"/)?.[1];
      let v = '';
      if (type === 'inlineStr') v = texts(cell);
      else { eachTag(cell, 'v', (a, b) => { v = b; return false; }); if (type === 's') v = shared[+v] ?? ''; else if ((!type || type === 'n') && st && dates.has(+st) && /^\d+(\.\d+)?$/.test(v) && +v > 0) v = serialIso(+v, base1904); }
      const col = ref ? colIndex(ref) : row.length;
      if (col < 200) row[col] = unxml(v).slice(0, 2000); // a crafted "ZZZ1" would make a huge sparse row; cells capped as in CSV
      return ++n < 1000;
    });
    rows.push(Array.from(row, x => x ?? ''));
    return rows.length < LIMITS.rows;
  });
  // A date merged down over several purchases: each row under it gets the date. At most 1000 merges, each ref once
  // (a crafted file repeating one tall merge would otherwise walk every row thousands of times).
  const at = new Map(nums.map((v, i) => [v, i])), done = new Set();
  eachTag(xml, 'mergeCell', a => {
    const m = a.match(/ref="([A-Z]{1,3})(\d+):([A-Z]{1,3})(\d+)"/);
    if (m && m[1] === m[3] && !done.has(m[0])) {
      done.add(m[0]);
      const c = colIndex(m[1]), top = at.get(+m[2]);
      if (top != null) for (let i = top + 1; i < rows.length && nums[i] <= +m[4]; i++) if (!String(rows[i][c] ?? '').trim()) rows[i][c] = rows[top][c];
    }
    return done.size < 1000;
  });
  return rows.filter(r => r.some(x => String(x).trim() !== ''));
}
/** Which cell styles show a date: built-in date formats, or a format of its own with d or y in it. */
function dateStyles(xml) {
  const custom = {}, out = new Set();
  eachTag(xml, 'numFmt', a => { const id = a.match(/numFmtId="(\d+)"/)?.[1], code = unxml(a.match(/formatCode="([^"]*)"/)?.[1] || ''); if (id) custom[id] = code; });
  const isDate = id => (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58) || /[dy]/i.test(String(custom[id] || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));
  eachTag(xml, 'cellXfs', (a, body) => { let i = 0; eachTag(body, 'xf', x => { if (isDate(+(x.match(/numFmtId="(\d+)"/)?.[1] ?? 0))) out.add(i); i++; }); return false; });
  return out;
}
/** Every worksheet of an .xlsx, in the workbook's tab order → [{name, rows}]. Dates stay Excel serials (fileDate reads those). */
export async function xlsxSheets(buf) {
  const files = await unzip(buf, n => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || n === 'xl/styles.xml' || n === 'xl/_rels/workbook.xml.rels' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n), { budget: 50 * 1024 * 1024 });   // a sheet's text is held as a string: 50 MB inflated at most
  const dec = x => (x ? new TextDecoder().decode(x).replace(/<(\/?)[A-Za-z][\w.-]*:(?=[A-Za-z])/g, '<$1') : '');   // <x:row> as <row> (OpenXML SDK files)
  const opts = { dates: dateStyles(dec(files['xl/styles.xml'])), base1904: /date1904="(1|true)"/.test(dec(files['xl/workbook.xml'])) };
  const shared = [];
  eachTag(dec(files['xl/sharedStrings.xml']), 'si', (a, b) => { shared.push(unxml(texts(b))); return shared.length < 200_000; });
  const rels = {};
  eachTag(dec(files['xl/_rels/workbook.xml.rels']), 'Relationship', a => { const id = a.match(/\bId="([^"]+)"/)?.[1], to = a.match(/\bTarget="([^"]+)"/)?.[1]; if (id && to) rels[id] = 'xl/' + to.replace(/^\/?(xl\/)?/, ''); });
  const tabs = [];
  eachTag(dec(files['xl/workbook.xml']), 'sheet', a => { const path = rels[a.match(/\br:id="([^"]+)"/)?.[1]]; if (files[path]) tabs.push({ name: cleanText(unxml(a.match(/\bname="([^"]*)"/)?.[1] || ''), 40), path }); });
  if (!tabs.length) for (const path of Object.keys(files).filter(n => n.startsWith('xl/worksheets/')).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)))) tabs.push({ name: path.match(/sheet\d+/)[0], path });
  if (!tabs.length) throw new Error('no sheet');
  return tabs.map(({ name, path }) => ({ name, rows: sheetRows(dec(files[path]), shared, opts) }));
}
/**
 * An .xlsx as one list of rows: the first tab with a header row, then every later tab that has a date and an amount
 * column (a tab per year), its own title and header rows left out. A later tab's columns may be ordered differently,
 * or have one more or one fewer: each goes under the first tab's column of the same name, else of the same meaning
 * (guessMapping), else into a new column at the end. rows.tabs = {read: [names], skipped: [{name, why: 'columns' |
 * 'rows'}]}, for the mapping sheet.
 */
export async function xlsxToRows(buf) {
  const all = (await xlsxSheets(buf)).map(s => ({ ...s, rows: reshape(s.rows, s.name) }));
  const ledger = rows => { const h = headerRow(rows), m = guessMapping((rows[h] || []).map(x => cleanText(x, 40))); return m.date != null && (m.amount ?? m.debit ?? m.credit) != null ? { h, m } : null; };
  const sig = s => { const l = ledger(s.rows); if (!l) return null; const k = l.m.amount ?? l.m.debit ?? l.m.credit; return s.rows.slice(l.h + 1).map(r => `${fileDate(r[l.m.date]) || r[l.m.date]}|${fileAmount(r[k]) ?? ''}|${fileAmount(r[l.m.credit]) ?? ''}`).filter(x => !/^\|/.test(x)); };
  const sigs = all.map(sig), sets = sigs.map(s => s && new Set(s));   // Sets: tabs of thousands of rows compare at once
  const sheets = all.filter((s, i) => !sigs[i] || !sigs[i].length || !sigs.some((o, j) => j !== i && o && o.length > sigs[i].length && sigs[i].every(x => sets[j].has(x))));
  if (!sheets.length) throw new Error('no sheet');
  const headOf = rows => { const h = headerRow(rows); return Object.keys(guessMapping(rows[h] || [])).length >= 2 ? h : -1; };
  const first = sheets.find(s => ledger(s.rows)) || sheets.find(s => headOf(s.rows) >= 0) || sheets.find(s => s.rows.length);
  if (!first) throw new Error('no sheet');
  const h0 = Math.max(0, headOf(first.rows)), head = [...(first.rows[h0] || [])], out = [...first.rows], tabs = { read: [first.name], skipped: [] };
  const name = x => cleanText(x, 40).toLowerCase();
  for (const s of sheets) {
    if (s === first || !s.rows.length) continue;
    const h = headOf(s.rows), hd = h >= 0 ? s.rows[h] : [], m = guessMapping(hd);
    if (h < 0 || m.date == null || (m.amount ?? m.debit ?? m.credit) == null) { tabs.skipped.push({ name: s.name, why: 'columns' }); continue; }
    if (out.length >= LIMITS.rows) { tabs.skipped.push({ name: s.name, why: 'rows' }); continue; }
    const m0 = guessMapping(head), meaning = Object.fromEntries(Object.entries(m).map(([k, i]) => [i, k]));
    const used = new Set(), to = hd.map((x, i) => {
      const n = name(x), same = n ? head.findIndex((y, j) => name(y) === n && !used.has(j)) : -1;
      const j = same >= 0 ? same : meaning[i] && m0[meaning[i]] != null && !used.has(m0[meaning[i]]) ? m0[meaning[i]] : n ? head.push(x) - 1 : -1;
      if (j >= 0) used.add(j);
      return j;
    });
    for (const r of s.rows.slice(h + 1)) { const row = []; to.forEach((j, i) => { if (j >= 0) row[j] = r[i] ?? ''; }); out.push(Array.from(row, x => x ?? '')); }
    tabs.read.push(s.name);
  }
  if (out.length) out[h0] = head;
  return Object.assign(out.slice(0, LIMITS.rows), { tabs });
}

// ---- Google Sheets ---------------------------------------------------------------------------------
/** A Google Sheets link → its CSV export URL (the sheet must be shared "Anyone with the link"), or null. */
export function sheetCsvUrl(link) {
  const s = String(link ?? '').trim();
  const pub = s.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/e\/([\w-]{20,})\/pub/);
  if (pub) { const g = s.match(/[#&?]gid=(\d+)/)?.[1]; return `https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=csv${g ? `&gid=${g}` : ''}`; }
  const m = s.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([\w-]{20,})/);
  if (!m) return null;
  const gid = s.match(/[#&?]gid=(\d+)/)?.[1];
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
}

/** Any supported file → rows. Routed by content (zip magic bytes), not by name. */
export async function fileToRows(name, buf) {
  const b = new Uint8Array(buf);
  if (b.length > LIMITS.fileBytes) throw new Error('This file is over 25 MB. Split it or export a shorter date range.');
  if (b[0] === 0x50 && b[1] === 0x4b) {
    try { return await xlsxToRows(buf); } catch (e) { throw new Error(e?.message === 'no sheet' ? 'This workbook has no rows of transactions (only charts or empty tabs).' : 'This Excel file could not be read. Save it as .xlsx or CSV and try again.'); }
  }
  if (b[0] === 0xd0 && b[1] === 0xcf) {
    if (new TextDecoder('utf-16le').decode(b.subarray(0, Math.min(b.length, 1 << 20))).includes('EncryptedPackage')) throw new Error('This Excel file is password-protected. Open it in Excel, remove the password, save it, and try again.');
    throw new Error('Old Excel files (.xls) are not supported. Open it and save as .xlsx or CSV.');
  }
  const text = decodeBytes(b);
  if (/^\s*(OFXHEADER|<\?xml[^>]*>\s*<\?OFX|<OFX>)/i.test(text.replace(/^﻿/, ''))) return ofxToRows(text);
  return /^\s*!(type|account|option|clear)\b/i.test(text.replace(/^﻿/, '')) ? qifToRows(text) : parseCSV(text);
}

// ---- guessing columns ---------------------------------------------------------------------
// [exact name, part of a name]. Exact names are tried first for every column ("Category" before "Category Group/Category").
const HEAD = {
  date: [/^(date|tarikh|日期|transaction date|trans(action)? ?date|posting date|time|masa|日期时间|tarikh transaksi|trans(action)? ?(date ?)?time|txn (date|time)|date ?\/? ?time|masa transaksi|交易时间|交易時間)$/i, /date|tarikh|日期/i],
  balance: [/^((running|closing|available|wallet|e-?wallet|account|current|statement|ledger|book) )?(balance|baki)( \((rm|myr)\))?$|^baki (akhir|semasa)$|^(账户|帳戶)?(余额|餘額|结余|結餘)$/i, /balance|^baki\b|结余|結餘|余额|餘額/i],
  debit: [/^(debit|withdrawals?|money out|out|outflow|expenses?|spent|pengeluaran|keluar|perbelanjaan|支出)( \((rm|myr)\))?$/i, /debit|withdraw|pengeluaran|keluar|支出|money out|out$|outflow/i],
  credit: [/^(credit|deposits?|money in|in|inflow|income|received|kredit|masuk|pendapatan|收入)( \((rm|myr)\))?$/i, /credit|deposit|kredit|masuk|收入|money in|in$|inflow/i],
  type: [/^(type|jenis|类型|類型|income ?\/ ?expense|expense ?\/ ?income|in ?\/ ?out|category type|收支|(transaction|trans\.?|txn) type|jenis transaksi|交易类型|交易類型|dr ?\/ ?cr|cr ?\/ ?dr|debit ?\/ ?credit|credit ?\/ ?debit|d ?\/ ?c|c ?\/ ?d|masuk ?\/ ?keluar)$/i, null],
  sub: [/^(sub ?-?categor(y|ies)( name)?|subkategori|subcategoria|子类别|子類別|子分类|子分類)$/i, /sub ?-?categ|subkategori|子类|子類/i],
  category: [/^(category|categories|kategori|类别|類別|分类|分類)$/i, /categor|kategori|类别|類別|分类|分類/i],
  merchant: [/^(merchant|payee|peniaga|商家|shop|kedai|recipient|penerima|item|items|perkara|perihal|项目|項目|摘要|描述|说明|說明|商户|商戶|description|transaction description|keterangan|butiran|catatan|details?|vendor|transaction|transaction details|particulars|what|bill|spent on|for|butiran transaksi|source|sumber|来源|來源)$/i, /merchant|payee|peniaga|商家|shop|kedai|recipient|penerima|description|摘要|描述/i],
  note: [/^(notes?|nota|memo|remarks?|备注|備註|comments?)$/i, /note|nota|memo|keterangan|butiran|备注|備註|details|remark|catatan/i],
  account: [/^(accounts?|account name|akaun|账户|帳戶|wallet|dompet)$/i, /^(paid (by|with|from|using)|pay(ment)? (by|method|mode)|payment (method|mode|type)|method|bayar (guna|dengan|melalui)|kaedah (bayaran|pembayaran)|付款方式|支付方式|who paid|paid by|dibayar oleh|bayar oleh|pembayar|付款人|付款者)$/i],
  currency: [/^(currency(?: [12])?|curr\.?|ccy|(?:account|wallet|transaction) currency|mata wang|货币|貨幣|幣別|币种)$/i, null],
  amount: [/^(amount|jumlah|amaun|金额|金額|value|nilai|sum|price|harga|价格|價格|total|cost|kos|rm|myr|ringgit)( \((rm|myr)\))?$/i, /amount|jumlah|amaun|金额|金額|price|harga/i],
};
/**
 * Sheets people draw instead of lists, as one list. (1) Tables side by side under titles (the Google "Monthly budget"
 * template: Expenses | Income): stacked, with the title as a Type column. Each block must name a date and money, so a
 * bank's "Transaction Date | Posting Date" is never split. (2) One column per category or account (Date | Food |
 * Transport | … | Total, or Date | Cash | Maybank | TNG) when there is no amount column of its own: a row per filled
 * cell, the column's name as its Category or Account; Total and Balance columns are left out. Else rows as they are.
 */
export function monthYear(s) {
  const t = cleanText(s, 30), m = t.match(/^([A-Za-z]{3})[a-z]*\.?[\s'-]*(\d{4})$/) || t.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月$/) || t.match(/^(\d{1,2})[/-](\d{4})$/);
  if (!m) return null;
  const mon = /^\d{4}$/.test(m[1]) ? +m[2] : /^\d+$/.test(m[1]) ? +m[1] : (MON_EN.indexOf(m[1].toLowerCase()) >= 0 ? MON_EN.indexOf(m[1].toLowerCase()) : MON_MS.indexOf(m[1].toLowerCase())) + 1;
  const year = /^\d{4}$/.test(m[1]) ? +m[1] : +m[2];
  return mon >= 1 && mon <= 12 ? `${year}-${String(mon).padStart(2, '0')}` : null;
}
export function reshape(rows, tab = '') {
  const clean = r => (r || []).map(x => cleanText(x, 40)), money = m => m.amount ?? m.debit ?? m.credit;
  const DAY = /^(day|hari|日|日期\(日\)|tarikh \(hari\))$/i, day = (ym, d) => (/^\d{1,2}$/.test(cleanText(d)) && +d >= 1 && +d <= 31 ? `${ym}-${String(+d).padStart(2, '0')}` : cleanText(d));
  for (let h = 0; h < Math.min(rows.length, 40); h++) {
    const r = clean(rows[h]), dc = r.findIndex(x => DAY.test(x));
    if (dc < 0 || r.some(x => HEAD.date[0].test(x))) continue;
    const months = r.map((x, i) => (i !== dc && monthYear(x) ? i : -1)).filter(i => i >= 0), ym = monthYear(tab);
    if (months.length) {   // Day | Jul 2026 | Aug 2026: a row per filled cell
      const out = [['Date', 'Amount']];
      for (const row of rows.slice(h + 1)) for (const i of months) if (fileAmount(row[i])) out.push([day(monthYear(r[i]), row[dc]), row[i]]);
      return [...rows.slice(0, h), ...out];
    }
    if (ym) return [...rows.slice(0, h), r.map((x, i) => (i === dc ? 'Date' : rows[h][i])), ...rows.slice(h + 1).map(row => row.map((x, i) => (i === dc ? day(ym, x) : x)))];
  }
  for (let h = 0; h < Math.min(rows.length, 40); h++) {
    const r = clean(rows[h]), starts = r.map((x, i) => (HEAD.date[0].test(x) ? i : -1)).filter(i => i >= 0);
    if (starts.length < 2) continue;
    const blocks = starts.map((s, k) => ({ s, e: k + 1 < starts.length ? starts[k + 1] : r.length }));
    if (!blocks.every(({ s, e }) => { const m = guessMapping(r.slice(s, e)); return m.date != null && money(m) != null; })) continue;
    // Columns by what they mean (the Expenses block's Item and the Income block's Source are both the description).
    const KEYS = [['date', 'Date'], ['amount', 'Amount'], ['debit', 'Money out'], ['credit', 'Money in'], ['merchant', 'Description'], ['category', 'Category'], ['note', 'Note'], ['account', 'Account'], ['currency', 'Currency']];
    const maps = blocks.map(({ s, e }) => guessMapping(r.slice(s, e))), keys = KEYS.filter(([k]) => maps.some(m => m[k] != null));
    const title = clean(rows[h - 1]), out = [[...keys.map(([, label]) => label), 'Type']];
    blocks.forEach(({ s, e }, b) => {
      const word = title.slice(s, e).find(Boolean) || title[s - 1] || '';
      for (const row of rows.slice(h + 1)) {
        const cells = keys.map(([k]) => (maps[b][k] != null ? row[s + maps[b][k]] ?? '' : ''));
        if (cells.some(c => cleanText(c))) out.push([...cells, word]);
      }
    });
    return [...rows.slice(0, h), ...out];
  }
  const h = headerRow(rows), head = clean(rows[h]), m = guessMapping(head), body = rows.slice(h + 1);
  const totalLike = x => /^(total|jumlah|sum|grand total|合计|合計|总计|總計)\b/i.test(x || '');
  if (m.date == null || (money(m) != null && !totalLike(head[money(m)]))) return rows;
  const numeric = i => { const v = body.map(r => cleanText(r[i])).filter(Boolean); return v.length > 0 && v.filter(x => fileAmount(x) != null).length >= v.length * 0.8; };
  const cols = head.map((x, i) => i).filter(i => i !== m.date && head[i] && !totalLike(head[i]) && !/^(baki|balance|running|结余|余额|餘額)/i.test(head[i]) && numeric(i));
  if (cols.length < 2) return rows;
  const cat = cols.filter(i => { const c = mapCategory(head[i]); return c && c !== 'other'; }).length * 2 >= cols.length;
  const text = head.map((x, i) => i).filter(i => i !== m.date && !cols.includes(i) && head[i] && !totalLike(head[i]) && !numeric(i));   // a Description or Note column rides along
  const out = [['Date', cat ? 'Category' : 'Account', 'Amount', ...text.map(i => head[i])]];
  for (const r of body) for (const i of cols) if (fileAmount(r[i])) out.push([r[m.date], head[i], r[i], ...text.map(j => r[j])]);
  return [...rows.slice(0, h), ...out];
}
/** Which column holds what: {date, amount | debit+credit, type?, category?, merchant?, note?, account?, balance?} as indexes. */
export function guessMapping(header) {
  const h = header.map(x => cleanText(x));
  const m = {}; const used = [];
  for (const pass of [0, 1]) for (const k of ['date', 'balance', 'debit', 'credit', 'type', 'category', 'merchant', 'note', 'account', 'currency', 'amount']) {
    const re = HEAD[k][pass];
    if (m[k] != null || !re) continue;
    const i = h.findIndex((x, j) => re.test(x) && !used.includes(j));
    if (i >= 0) { m[k] = i; used.push(i); }
  }
  if (m.amount != null && (m.debit == null) !== (m.credit == null)) { delete m.debit; delete m.credit; } // one-sided: use amount
  return m;
}

/** The header row: the first of the top 10 rows that names two or more columns, so title rows above it
 *  ("Family Budget 2026", "Prepared by…") are skipped. 0 when none does. */
export function headerRow(rows) {
  const named = r => Object.keys(guessMapping((r || []).map(x => cleanText(x, 40)))).length, dateLike = x => !!fileDate(x) || !!fileDate(x, true);
  let best = -1, score = 0;
  rows.slice(0, 40).forEach((r, i) => {
    const m = guessMapping((r || []).map(x => cleanText(x, 40)));
    if (m.date == null || (m.amount ?? m.debit ?? m.credit) == null) return;
    const sc = rows.slice(i + 1, i + 9).filter(x => dateLike(x?.[m.date])).length * 10 + Object.keys(m).length;
    if (sc > score) { score = sc; best = i; }
  });
  if (best >= 0 && score >= 10) return best;
  const i = rows.slice(0, 10).findIndex(r => named(r) >= 2);
  return i < 0 ? 0 : i;
}

// ---- dates in files -----------------------------------------------------------------------------
const MON_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON_MS = ['jan', 'feb', 'mac', 'apr', 'mei', 'jun', 'jul', 'ogo', 'sep', 'okt', 'nov', 'dis'];
/** "28/09/2026", "28-09-26", "2026-09-28", "2026/9/28", "20260928", "28 Sep 2026", "2026年9月28日", Excel serial → ISO,
 *  or null. Day first, unless monthFirst (a US-locale sheet: see dateOrder). */
export function fileDate(v, monthFirst = false) {
  const s = cleanText(v, 40).replace(/^(mon|tue|wed|thu|fri|sat|sun|isnin|selasa|rabu|khamis|jumaat|sabtu|ahad)[a-z]*,?\s+/i, '');
  if (/^\d{5}(\.\d+)?$/.test(s) && +s > 20000 && +s < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 864e5).toISOString().slice(0, 10);
  let m, y, yt, mo, d;   // yt: the year as written, so only a 2-digit one means 20xx ('0000' is not 2000)
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/) || s.match(/^(\d{4})(\d{2})(\d{2})$/))) [yt, mo, d] = [m[1], +m[2], +m[3]];
  else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) [d, mo, yt] = monthFirst ? [+m[2], +m[1], m[3]] : [+m[1], +m[2], m[3]];
  else if ((m = s.match(/^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[\s,.-]*(\d{2,4})/))) {
    const k = m[2].toLowerCase(), i = MON_EN.indexOf(k) >= 0 ? MON_EN.indexOf(k) : MON_MS.indexOf(k);
    [d, mo, yt] = [+m[1], i + 1, m[3]];
  } else if ((m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/))) {
    const k = m[1].toLowerCase(), i = MON_EN.indexOf(k) >= 0 ? MON_EN.indexOf(k) : MON_MS.indexOf(k);
    [d, mo, yt] = [+m[2], i + 1, m[3]];
  } else if ((m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/))) [yt, mo, d] = [m[1], +m[2], +m[3]];
  else return null;
  y = +yt + (yt.length <= 2 ? 2000 : 0);
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return mo >= 1 && validIso(iso) && y >= 2000 && y <= 2100 ? iso : null;
}
/** Month first for a whole column when some "a/b/yyyy" has b > 12 and none has a > 12 (7/13/2026 is 13 July).
 *  For an app that writes month first (mdy), unless some a > 12. */
export function dateOrder(rows, col, mdy = false) {
  let a = false, b = false;
  for (const r of rows) { const m = cleanText(r?.[col], 40).match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/); if (m) { a ||= +m[1] > 12; b ||= +m[2] > 12; } }
  if (a || b) return b && !a;
  // Every date could be either (9/1 … 9/12): the reading that doesn't put entries in the future wins (a US sheet's
  // 1–12 September is not January–December with October on still to come); else the app's own order.
  const n = new Date(), today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`, future =   // the phone's date: UTC is yesterday before 8 am in Malaysia
    mf => rows.filter(r => (fileDate(r?.[col], mf) || '') > today).length;
  const f = future(false), m = future(true);
  return f !== m ? m < f : mdy;
}
const pad2 = n => String(n).padStart(2, '0');
/** "12:40" in a cell, the fraction of an Excel date-time serial, or (bare) a Time column's "930" / "1845" (AndroMoney). */
const timeOf = (v, bare = false) => {
  const s = cleanText(v, 40), m = s.match(/\b(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:\s*([ap]\.?m\.?))?(?![\w:.]|\s*[ap]\.?m)/i);
  if (m) {
    let hour = +m[1];
    if (+m[2] > 59 || (m[3] != null && +m[3] > 59)) return null;
    if (m[4]) {
      if (hour < 1 || hour > 12) return null;
      hour = hour % 12 + (/^p/i.test(m[4]) ? 12 : 0);
    } else if (hour > 23) return null;
    return `${pad2(hour)}:${m[2]}`;
  }
  if (/^\d{5}\.\d+$/.test(s)) { const min = Math.round((+s % 1) * 1440) % 1440; return min ? `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}` : null; }
  return bare && /^\d{3,4}$/.test(s) && +s.slice(0, -2) < 24 && +s.slice(-2) < 60 ? `${pad2(s.slice(0, -2))}:${s.slice(-2)}` : null;
};
/** "2026-09-28T02:30:00Z" or "…+00:00": a moment with a time zone → this phone's date and time (Spendee). */
const zoned = v => {
  const s = cleanText(v, 40);
  if (!/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d(\.\d+)?)? ?(Z|[+-]\d\d:?\d\d)$/i.test(s)) return null;
  const d = new Date(s.replace(' ', 'T').replace(' ', '')), y = d.getFullYear(), date = `${y}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  // The same range as fileDate: '0000-…' or '9999-…' would be stored as '0-01-01' and crash date maths on every start.
  return isNaN(d) || y < 2000 || y > 2100 || !validIso(date) ? null : { date, time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}` };
};

// ---- rows → transactions ---------------------------------------------------------------------------
const ALL_CATS = [...CATEGORIES, ...INCOME_CATEGORIES];
/** Shouting bank text reads as a name: "NASI LEMAK ANTARABANGSA" → "Nasi Lemak Antarabangsa"; short codes (TNB, KFC, MR DIY) stay. */
const unshout = s => (/[a-z]/.test(s) ? s : s.replace(/[A-Z]{4,}/g, w => w[0] + w.slice(1).toLowerCase()));
/** Bank and wallet descriptions without the time, status and channel prefix: "07:52 Success Payment 7-Eleven" → "7-Eleven". */
export const cleanDesc = s => unshout(cleanDesc0(s));
const LEAD = /^(\d{1,2}:\d{2}(:\d{2})?\s*([ap]\.?m\.?)?\s+)?((success(ful)?|completed?|berjaya|pending|approved)\b[\s:-]*)?/i;
const cleanDesc0 = s => {
  const c = cleanText(s, 120).replace(LEAD, '');
  return c.replace(/^(card purchase|sale debit|pos purchase|debit card|mydebit|duitnow( qr| to| transfer)?|fpx( payment)?|jompay|ibg( credit| debit)?|instant transfer|fund transfer( to| from)?|trf( to| from)?|payment( to| via)?|online banking|pembayaran|pindahan)\b[\s:-]*/i, '')
    .replace(/^(\p{L}+) (?=\1\b)/iu, '').trim() || c || cleanText(s, 120); // "Reload Reload via FPX" (type + description)
};
const INCOME_WORD = /income|pendapatan|masuk|收入|credit|kredit|deposit|salary|gaji|paycheck|payroll|wage|薪|副业|副業|sampingan|freelance|bonus|dividen|dividend|interest|faedah|利息/i;
// Wallet and bank "Transaction Type" words: a reload, top-up or money received is money in; a DR/CR column says it outright.
const IN_TYPE = /^(cr|c|\+|in)$|reload|top ?-?up|cash ?in|tambah nilai|receiv|terima|refund|cash ?back|\bin$/i;
const OUT_TYPE = /^(dr|d|-|out)$/i;
const TRANSFER_WORD = /transfer|pindahan|转账|轉帳/i;
/** Another app's category name → ours: catMap (the mapping step), then the user's own categories by name, then ours by
 *  id or name, then words. */
export function mapCategory(name, catMap = {}, merchant = '', custom = []) {
  if (Object.hasOwn(catMap, cleanText(name, 60))) return catMap[cleanText(name, 60)];
  const n = catName(cleanText(name, 60)), lo = n.toLowerCase();
  const hit = [...custom, ...ALL_CATS].find(c => c.id === lo || String(c.name).toLowerCase() === lo);
  if (hit) return movedTo(hit.id);   // not a category the user removed
  return movedTo(CAT_WORDS.find(([, re]) => re.test(n))?.[0] || categorize(n, merchant));
}
const cp = n => (n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : '');
const LEAD_EMOJI = /^[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}️‍⃣\s]+/u;
/** Another app's category name as a person reads it: HTML codes decoded (Money Manager by Realbyte stores "🍜 Food" as
 *  "&#x1f35c; Food") and a leading emoji dropped (Tally shows its own icons), so it matches the category of that name. */
/** The HTML codes catName decodes (and what repairCatNames looks for: the same, so a name it can't decode is left alone). */
export const CAT_CODE = /&#(x[0-9a-f]{1,6}|\d{1,7});/i;
export function catName(s) {
  // Decoded text is file text too: cleaned again (NFKC, no hidden, bidi or control characters), or the codes would
  // bring back what cleanText removed.
  const d = cleanText(String(s ?? '').replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => cp(parseInt(h, 16))).replace(/&#(\d{1,7});/g, (m, n) => cp(+n))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[k]), 60);
  return d.replace(LEAD_EMOJI, '').trim() || d;
}
/** Another app's category → the Tally one with exactly that name (built-in or the user's own), else null: imports keep the user's names. */
export function sameCategory(name, custom = [], income = false) {
  const lo = catName(cleanText(name, 40)).toLowerCase();
  return (lo && [...custom.filter(c => (c.kind === 'income') === income), ...(income ? INCOME_CATEGORIES : CATEGORIES)].find(c => String(c.name).toLowerCase() === lo)?.id) || null;   // the name shown, never Tally's inner id ("Income" is not "Other income")
}
/** "Other" in another app is Tally's Other, not a new category. */
export const OTHER_NAME = /^(other|others|misc|lain|lain-lain|lain2|其他|其它)$/i;
// Category names people use in their own sheets, English, Malay and Chinese. Order matters: "Sekolah Anak" is Kids.
const CAT_WORDS = [
  ['salary', /salary|gaji|paycheck|payroll|wage|工资|工資|薪/i], ['allowance', /elaun|allowance|biasiswa|scholarship|津贴|津貼/i],
  ['groceries', /grocer|barang dapur|runcit|pasar|杂货|雜貨|超市|买菜|買菜/i], ['dining', /food|drink|makan|minum|餐|meal|restaurant|dining|eating|饮食|飲食/i],
  ['transport', /transport|pengangkutan|\bcar\b|kereta|fuel|petrol|minyak|toll|parking|交通|汽油/i], ['bills', /bill|util|\bbil\b|账单|帳單|水电|水電/i],
  ['health', /health|kesihatan|perubatan|medical|医疗|醫療|健康/i], ['personal', /personal|penjagaan diri|kecantikan|beauty|个人护理|個人護理/i],
  ['household', /household|rumah|perabot|家居|日用/i], ['kids', /\bkids?\b|children|anak|kanak|孩子|小孩|儿童|兒童/i],
  ['electronics', /electronic|elektronik|gadget|gajet|电子|電子/i], ['shopping', /shop|belanja|beli|购物|購物|cloth|pakaian/i],
  ['fun', /entertain|hiburan|leisure|娱乐|娛樂/i], ['education', /educat|pendidikan|school|sekolah|yuran|教育|学费|學費/i],
];
/** Excel stores computed cells as long doubles ("12.720000000000001"): round those to sen, read the rest as typed. */
export const fileAmount = v => { const s = cleanText(v, 40).replace(/^(-?) ?(MYR|\$) ?/i, '$1'); return /^-?\d+\.\d{3,}$/.test(s) ? Math.round(parseFloat(s) * 100) : parseAmount(s); };
/** o[k] only when o has k itself: a name from a file ("constructor") never reaches Object's own properties. */
export const ownKey = (o, k) => (o && Object.hasOwn(o, k) ? o[k] : undefined);
/** Short stable hash (FNV-1a) → base36. */
export const hash = str => { let h = 0x811c9dc5; for (const ch of String(str)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); };
/**
 * Stable id per imported row from its date, amount, text and how many identical rows came before it in the file:
 * importing the same file twice adds nothing, and two identical purchases on one day both stay.
 */
export function importIds(txs, prefix) {
  const seen = new Map(), used = new Set();
  for (const t of txs) {
    const key = `${t.date}|${t.type}|${t.amount}|${t.merchant || ''}|${t.accountId}`;
    let n = (seen.get(key) || 0) + 1;
    // 64 bits (two FNV-1a runs): 32 alone collide by chance in big files. Never the same id twice in one file.
    while (used.has(`${prefix}_${hash(key)}${hash(`#${key}`)}_${n}`)) n++;
    seen.set(key, n);
    t.id = `${prefix}_${hash(key)}${hash(`#${key}`)}_${n}`;
    used.add(t.id);
  }
  return txs;
}
/**
 * Opening balance for a new account from a statement's Balance column: the balance on the last row up to `upTo`,
 * minus everything imported up to then. Works for oldest-first and newest-first files. null without a balance column.
 */
export function openingFromBalance(rows, map, txs, upTo) {
  if (map.balance == null || map.date == null) return null;
  const mdy = dateOrder(rows, map.date);
  const dated = rows.map((r, i) => ({ i, date: fileDate(r[map.date], mdy), bal: fileAmount(r[map.balance]) })).filter(x => x.date && x.bal != null && x.date <= upTo);
  if (!dated.length) return null;
  const asc = dated[0].date <= dated.at(-1).date;
  const last = dated.reduce((a, b) => (b.date > a.date || (b.date === a.date && asc) ? b : a));
  const net = txs.filter(x => x.date <= upTo).reduce((s, x) => s + (x.type === 'income' ? x.amount : -x.amount), 0);
  return last.bal - net;
}
/** Each row's direction from its running balance (1 in, −1 out, 0 can't tell), in whichever order the file runs. */
export function balanceSigns(rows, map, amtOf) {
  if (map.balance == null) return [];
  const pts = rows.map((r, i) => ({ i, a: amtOf(r), b: fileAmount(r[map.balance]) })).filter(p => p.a && p.b != null);
  const fit = (p, q) => (q && Math.abs(p.b - q.b) === p.a ? Math.sign(p.b - q.b) : 0);
  const asc = pts.map((p, k) => fit(p, pts[k - 1])), desc = pts.map((p, k) => fit(p, pts[k + 1]));
  const use = asc.filter(Boolean).length >= desc.filter(Boolean).length ? asc : desc;
  const out = [];
  pts.forEach((p, k) => { out[p.i] = use[k]; });
  return out;
}
/**
 * Rows (after the header) → {txs, skipped: [{row, why}]}. Amounts: a signed amount, or debit/credit columns.
 * Direction: the running balance when it says, else a type column (income/expense, DR/CR, Payment/Reload), else the
 * sign. With neither: if any amount is negative the file is signed (negative = spent); if none is, all is spending.
 * `accounts` maps an Account column's values (lower case) to account ids.
 * A `preset` (presets.js, with the file's `header`) adds another app's rules: its transfers between accounts become
 * Tally transfers (both halves of one transfer → one), its balance corrections go into `opening` (per account name,
 * lower case) instead of spending, and its category names map to ours. → also {transfers, loose (a transfer half
 * whose other side isn't in the file, kept as money in or out), adjustments, opening}.
 */
// Currency evidence belongs to the selected numeric cells, never the filename or app-wide currency.
const CSV_CURRENCY_COLUMN = /^(currency(?: [12])?|curr\.?|ccy|(?:account|wallet|transaction|main) currency|mata wang|货币|貨幣|幣別|币种)$/i;
const CSV_FOREIGN_TAG = /(?:^|[\s(_/])(?:USD|US\$|SGD|S\$|EUR|GBP|AUD|CAD|NZD|JPY|CNY|RMB|HKD|BND|IDR|THB|INR|KRW|PHP|VND|CHF|BRL|TWD)(?:$|[\s)/_])/i;
const CSV_CURRENCY_CODES=new Set(['USD','SGD','EUR','GBP','AUD','CAD','NZD','JPY','CNY','HKD','BND','IDR','THB','INR','KRW','PHP','VND','CHF','BRL','TWD','ZAR',...(typeof Intl.supportedValuesOf==='function'?Intl.supportedValuesOf('currency'):[])]);
export function rowCurrency(row, map, header = []) {
  const columns = [...new Set([...header.flatMap((h,i)=>CSV_CURRENCY_COLUMN.test(cleanText(h,40))?[i]:[]), ...(Number.isInteger(map.currency)?[map.currency]:[])])];
  const codes = columns.map(i=>cleanText(row[i],40).toUpperCase()).filter(Boolean);
  if(codes.some(code=>!['MYR','RM'].includes(code)))return 'other';
  let myr=codes.length>0;
  // Match rowsToTx: a nonzero debit wins over credit. The unused cell cannot prove its currency.
  const money = map.debit != null || map.credit != null ? [fileAmount(row[map.debit]) ? map.debit : map.credit] : [map.amount];
  for(const i of money){
    if(i==null||!cleanText(row[i],40)||fileAmount(row[i])===0)continue;
    const head=cleanText(header[i],60),value=cleanText(row[i],60).toUpperCase();
    const tags=[...(head.toUpperCase().match(/\b[A-Z]{3}\b/g)||[]),...(value.match(/^[-+(\s]*([A-Z]{3})(?=\s*[+\-(.\d])/)?.slice(1)||[]),...(value.match(/\b([A-Z]{3})\s*\)?$/)?.slice(1)||[])];
    if(tags.some(code=>code!=='MYR'&&CSV_CURRENCY_CODES.has(code)))return 'other';
    if(CSV_FOREIGN_TAG.test(head)||/^[-+(\s]*(?:US\$|S\$|(?:USD|SGD|EUR|GBP|AUD|CAD|NZD|JPY|CNY|RMB|HKD|BND|IDR|THB|INR|KRW|PHP|VND|CHF|BRL|TWD)\s*|[€£¥₹₩₱฿])/.test(value))return 'other';
    if(/(?:^|[\s(_/])(?:MYR|RM|ringgit)(?:$|[\s)/_])/i.test(head)||/^[-+(\s]*(?:MYR|RM)\s*(?=[+\-(.\d])/.test(value)||/\b(?:MYR|RM)\s*\)?$/.test(value))myr=true;
  }
  return myr?'MYR':'unknown';
}
export function currencyReview(rows,map,{header=[],preset=null}={}){
  const out={myr:0,unknown:0,other:0},status=header.findIndex(h=>/^(status|transaction status|status transaksi|状态|狀態)$/i.test(cleanText(h,30))),paid=header.findIndex(h=>/^(paid\??|done|settled|dibayar\??|sudah bayar|bayar\??|已付|已付款|已繳)$/i.test(cleanText(h,30)));
  for(const row of rows){
    if(status>=0&&/fail|unsuccess|gagal|cancel|batal|reject|declin|revers|refused|失败|失敗|取消/i.test(row[status]??''))continue;
    if(paid>=0&&/^(false|no|tidak|belum|0|☐|✗|否)$/i.test(cleanText(row[paid],10)))continue;
    const ctx=rowCtx(row,map,header);if(preset?.type&&!preset.type(ctx)&&!preset.transfer?.(ctx)&&!preset.adjust?.(ctx))continue;
    const state=rowCurrency(row,map,header),money=map.debit!=null||map.credit!=null?[map.debit,map.credit]:[map.amount];
    if(!money.some(i=>i!=null&&fileAmount(row[i]))) { if(state==='other'&&money.some(i=>i!=null&&cleanText(row[i],40)))out.other++;continue; }
    out[state==='MYR'?'myr':state]++;
  }
  return out;
}

export function rowsToTx(rows, map, { accountId, accounts = {}, catMap = {}, customCats = [], source = 'import', idPrefix = 'i', now = Date.now(), preset = null, header = [], strictCurrency = false, sourceCurrency = null, accountCurrencies = {} } = {}) {
  // Keyed by account names from the file: no prototype, so "constructor" or "__proto__" is just a name.
  const txs = [], skipped = [], legs = [], opening = Object.create(null), adjAt = Object.create(null), firstAt = Object.create(null);
  let adjustments = 0;
  if (rows.length > LIMITS.rows) throw new Error(`This file has more than ${LIMITS.rows} rows. Split it into smaller files and import each one.`);
  // An app that signs its amounts: a file with only money in (a refund, a salary) is still income, not spending.
  const amts = map.amount == null ? [] : rows.map(r => fileAmount(r[map.amount])).filter(a => a), negs = amts.filter(a => a < 0).length;
  const signed = !!preset?.signed || (negs > 0 && negs >= amts.length * 0.15);
  // A Paid? / Done column of ticks: unticked rows are bills still to pay, not spending yet.
  const paidCol = header.findIndex(h => /^(paid\??|done|settled|dibayar\??|sudah bayar|bayar\??|已付|已付款|已缴)$/i.test(cleanText(h, 30)));

  const fxCol = header.findIndex((h, i) => i !== map.amount && /^(sgd|s\$|usd|us\$|eur|gbp|aud|idr|thb|cny|rmb|jpy|hkd|bnd)$|\((sgd|s\$|usd|eur|gbp|aud|idr|thb|cny|jpy|hkd|bnd)\)$/i.test(cleanText(h, 30)));
  const dc = map.debit != null || map.credit != null, mdy = map.date != null && (preset && typeof preset.mdy === 'boolean' ? preset.mdy : dateOrder(rows, map.date));
  const amtOf = r => { const a = dc ? fileAmount(r[map.debit]) || fileAmount(r[map.credit]) : fileAmount(r[map.amount]); return a ? Math.abs(a) : null; };
  const bal = balanceSigns(rows, map, amtOf);
  // An e-wallet's Status column: a failed, cancelled or reversed payment never moved money.
  const status = header.findIndex(h => /^(status|transaction status|status transaksi|状态|狀態)$/i.test(cleanText(h, 30)));
  rows.forEach((r, n) => {
    if (status >= 0 && /fail|unsuccess|gagal|cancel|batal|reject|declin|revers|refused|失败|失敗|取消/i.test(r[status] ?? '')) return skipped.push({ row: n + 2, why: 'failed' });
    if (paidCol >= 0 && /^(false|no|tidak|belum|0|☐|✗|否)$/i.test(cleanText(r[paidCol], 10))) return skipped.push({ row: n + 2, why: 'unpaid' });
    // Another currency (a Currency column, or S$ / SGD in the amount) is never read as ringgit.
    const currency = rowCurrency(r,map,header);
    if (currency === 'other' || (fxCol >= 0 && !cleanText(r[map.amount ?? -1]) && cleanText(r[fxCol]))) return skipped.push({ row: n + 2, why: 'currency' });
    const cx = rowCtx(r, map, header), get = cx.get;
    if (preset?.type && !preset.type(cx) && !preset.transfer?.(cx) && !preset.adjust?.(cx)) return skipped.push({ row: n + 2, why: 'type' });
    const rawDate = get('date');
    const z = zoned(rawDate) || (preset?.utc && /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(cleanText(rawDate, 40)) ? zoned(cleanText(rawDate, 40) + 'Z') : null), date = z?.date || fileDate(rawDate, mdy);
    let amt = null, type = null, sign = 1;
    if (dc) {
      const d = fileAmount(get('debit')), c = fileAmount(get('credit'));
      if (d) { amt = Math.abs(d); type = 'expense'; sign = -1; } else if (c) { amt = Math.abs(c); type = 'income'; }
    } else {
      const a = fileAmount(get('amount'));
      if (a != null) { amt = Math.abs(a); type = a < 0 ? (signed ? 'expense' : 'income') : signed ? 'income' : null; sign = a < 0 ? -1 : 1; }
    }
    if (!amt) return skipped.push({ row: n + 2, why: 'amount' });
    if(strictCurrency && currency==='unknown' && sourceCurrency!=='MYR') return skipped.push({row:n+2,why:sourceCurrency==='OTHER'?'currency':'currency-unconfirmed'});
    const refundRow = !signed && !dc && (fileAmount(get('amount')) ?? 0) < 0;   // a minus in a list of spending: money back
    // A total or subtotal row is the sum of rows already here; a b/f or opening row is where the account started.
    const label = cleanText(`${get('merchant')} ${get('note')} ${/[a-z]/i.test(get('date')) ? get('date') : ''}`, 80);
    if (/^((sub ?)?total|grand total|jumlah( besar| keseluruhan| kecil)?|合计|合計|总计|總計|小计|小計|carried forward|c\/f\b)/i.test(label)) return;
    const own = preset?.amount && fileAmount(preset.amount(cx)); if (own) amt = Math.abs(own);   // Toshl: the amount in the main currency
    const tword = cleanText(get('type'), 40);
    if (preset && map.type != null && tword && !/^(income|expense|expenses|exp\.?|transfer(?:[ -](?:out|in))?|outgoing transfer|incoming transfer)$/i.test(tword) && !preset.transfer?.(cx) && !preset.adjust?.(cx)) return skipped.push({ row: n + 2, why: 'type' });
    if (tword) type = OUT_TYPE.test(tword) ? 'expense' : IN_TYPE.test(tword) ? 'income' : TRANSFER_WORD.test(tword) ? 'expense' : INCOME_WORD.test(tword) ? 'income' : 'expense';
    if (bal[n] && !dc && !signed) type = bal[n] > 0 ? 'income' : 'expense'; // only unsigned amounts: columns and signs say it outright
    type = preset?.type?.(cx) || type || 'expense'; // ponytail: transfers from unknown apps come in as expenses; pairTransfers joins the ones it can see
    if (!(dc || signed)) sign = type === 'income' ? 1 : -1;  // which way the money went, whatever the type column calls it
    const accName = cleanText(preset?.account ? preset.account(cx) : get('account'), 40);
    const destination = accName && Object.keys(accounts).length ? ownKey(accounts,accName.toLowerCase()) : accountId;
    if(strictCurrency && (accountCurrencies[destination] || 'MYR')!=='MYR')return skipped.push({row:n+2,why:'currency-target'});
    // Another app's balance correction: part of the account's opening balance, never spending (dated or not).
    if (preset?.adjust?.(cx) && !preset.transfer?.(cx)) { const k = accName.toLowerCase(); opening[k] = (opening[k] || 0) + sign * amt; (adjAt[k] ||= []).push(date || ''); adjustments++; return; }
    if (!date) return skipped.push({ row: n + 2, why: 'date' });
    { const k = accName.toLowerCase(); if (!firstAt[k] || date < firstAt[k]) firstAt[k] = date; }
    const fromMerchant = map.merchant != null && !!cleanText(get('merchant'));   // an empty Payee falls back to the note
    const merchant = cleanDesc(fromMerchant ? get('merchant') : get('note')).slice(0, 80).trim(), note = fromMerchant ? cleanText(get('note'), 200) : '';
    const time = z?.time || timeOf(get('date')) || timeOf(get('time'), true), acc = accName && Object.keys(accounts).length ? ownKey(accounts, accName.toLowerCase()) : accountId;
    if (!acc) return skipped.push({ row: n + 2, why: 'account' });   // an account past the ones planned (20): never merged into another
    // An opening row is money held: its own sign (a plain 500.00 is +500), not the direction spending goes.
    if (/^(opening balance|balance b\/?f|brought forward|b\/f\b|baki (awal|dibawa|b\/?b|b\/?f|permulaan|mula)|期初|上期结余|上期結餘)/i.test(label)) { const k = accName.toLowerCase(); opening[k] = (opening[k] || 0) + (dc ? sign : (fileAmount(get('amount')) ?? 0) < 0 ? -1 : 1) * amt; (adjAt[k] ||= []).push(''); adjustments++; return; }
    // A Type column that says Transfer: the words say which way ("to TNG" out, "from Maybank" in), and the other half pairs up.
    const typedTr = !preset && TRANSFER_WORD.test(tword) && (() => { const txt = `${get('merchant')} ${get('note')}`.slice(0, 300), other = txt.match(/\b(?:to|ke|kepada|from|dari|daripada)\s+(.+)$/i)?.[1]; return { dir: sign < 0 && (dc || signed) ? 'out' : /\b(from|dari|daripada|received|terima)\b/i.test(txt) ? 'in' : 'out', to: other && ownKey(accounts, cleanText(other, 40).toLowerCase()) ? cleanText(other, 40) : null }; })();
    const tr = preset?.transfer?.(cx) || typedTr;
    if (tr && strictCurrency && tr.to && (accountCurrencies[ownKey(accounts,cleanText(tr.to,40).toLowerCase())] || 'MYR')!=='MYR')return skipped.push({row:n+2,why:'currency-target'});
    if (tr) { legs.push({ n, date, time, amt, acc, dir: tr.dir || (sign < 0 ? 'out' : 'in'), to: tr.to ? ownKey(accounts, cleanText(tr.to, 40).toLowerCase()) : null, merchant, note }); return; }
    const rawCat = preset?.category ? preset.category(cx) : get('category'), pc = ownKey(preset?.cats, cleanText(rawCat, 60).toLowerCase());
    let category = rawCat ? (!Object.hasOwn(catMap, cleanText(rawCat, 60)) && pc) || mapCategory(rawCat, catMap, merchant, customCats) : categorize(merchant, merchant);
    // "Food" in another app at KFC or a mamak is a meal, not groceries (a category actually named Groceries stays).
    if (category === 'groceries' && !CAT_WORDS.find(([c]) => c === 'groceries')[1].test(rawCat || '') && shopCategory(merchant) === 'dining') category = 'dining';
    // No type column and unsigned amounts: a row the user mapped to Salary / Other income is money in, not spending.
    if (!tword && !signed && !bal[n] && !dc && !preset?.type && (INCOME_CATEGORIES.some(c => c.id === category) || INCOME_WORD.test(cleanText(rawCat, 60)))) type = 'income';
    const ownIncome = String(category).startsWith('new:') || customCats.some(c => c.id === category && c.kind === 'income');   // their own name: settled when saved
    if (type === 'income' && !ownIncome && !INCOME_CATEGORIES.some(c => c.id === category)) category = incomeCategory(`${rawCat} ${merchant}`);
    if (type === 'expense' && (INCOME_CATEGORIES.some(c => c.id === category) || customCats.some(c => c.id === category && c.kind === 'income'))) category = 'other';
    if (refundRow && type === 'income') { txs.push({ id: '', date, ...(time ? { time } : {}), type, amount: amt, accountId: acc, category: 'refund', cat: INCOME_CATEGORIES.some(c => c.id === category) ? 'other' : category, merchant, note, source, createdAt: now }); return; }
    const sub = cleanText(get('sub'), 30);   // another app's subcategory (Money Manager, Cashew…) kept as Tally's
    txs.push({ id: '', date, ...(time ? { time } : {}), type, amount: amt, accountId: acc, category, ...(sub ? { sub } : {}), merchant, note, source, createdAt: now });
  });
  const { transfers, loose } = joinLegs(legs);
  const tx = t => ({ id: '', date: t.date, ...(t.time ? { time: t.time } : {}), type: t.type, amount: t.amt, accountId: t.acc, ...(t.toAcc ? { toAccountId: t.toAcc } : {}), category: t.type === 'income' ? 'income' : 'other', merchant: t.type === 'transfer' ? t.merchant.replace(/^transfer\s*:.*$/i, '') : t.merchant, note: t.note, source, createdAt: now });
  const all = [...txs, ...transfers.map(t => tx({ ...t, type: 'transfer' })), ...loose.map(t => tx({ ...t, type: t.dir === 'in' ? 'income' : 'expense', note: t.note || 'Transfer' }))];   // the word lets pairTransfers join it to the other side, imported later
  // An opening balance is known only from a correction at the start (Initial balance); one in mid-history (Adjust
  // Balance, Reconciliation) says nothing about what the account held before the file: still ask.
  const openKnown = Object.keys(adjAt).filter(k => adjAt[k].some(d => !d || !firstAt[k] || d <= firstAt[k]));
  return { txs: importIds(all, idPrefix), skipped, transfers: transfers.length, loose: loose.length, adjustments, opening, openKnown };
}
/** A row's cells by mapped key (get) and by the app's own column name (raw), for presets.js. */
function rowCtx(r, map, header = []) {
  const get = k => (map[k] != null ? r[map[k]] ?? '' : '');
  return { get, raw: name => { const i = header.findIndex(h => cleanText(h, 60).toLowerCase() === name); return i >= 0 ? r[i] ?? '' : ''; } };
}
/**
 * Transfer halves → one transfer each. A half that names the other account ("To 'Savings'", "Transfer : Maybank")
 * is a transfer by itself, and the matching half from the other account's rows is dropped. Halves that don't name it
 * (Money Lover, Spendee, Wallet) pair up: out of one account, into another, same amount, within a day, nearest first.
 * What's left over is `loose`: its other side is not in the file.
 * ponytail: O(halves²), fine for a few thousand transfers; bucket by amount if a file ever has tens of thousands.
 */
function joinLegs(legs) {
  const transfers = [], loose = [], anon = [];
  const near = (a, b) => Math.abs(daysBetween(a.date, b.date)) <= 1;
  for (const l of legs) {
    if (!l.to) { anon.push(l); continue; }
    const [from, to] = l.dir === 'out' ? [l.acc, l.to] : [l.to, l.acc];
    const twin = transfers.find(t => !t.twin && t.dir !== l.dir && t.acc === from && t.toAcc === to && t.amt === l.amt && near(t, l));
    if (twin) { twin.twin = true; continue; }
    if (from === to) { loose.push(l); continue; }
    transfers.push({ ...l, acc: from, toAcc: to });
  }
  const used = new Set();
  for (const o of anon.filter(l => l.dir === 'out')) {
    let best = null;
    for (const i of anon) {
      if (i.dir !== 'in' || used.has(i) || i.acc === o.acc || i.amt !== o.amt || !near(o, i)) continue;
      const d = Math.abs(daysBetween(o.date, i.date)) * 1440 + Math.abs(mins(o.time) - mins(i.time));
      if (!best || d < best.d) best = { i, d };
    }
    if (best) { used.add(best.i); used.add(o); transfers.push({ ...o, toAcc: best.i.acc, merchant: o.merchant || best.i.merchant }); }
  }
  loose.push(...anon.filter(l => !used.has(l)));
  return { transfers, loose };
}
const mins = t => (t ? +t.slice(0, 2) * 60 + +t.slice(3) : 0);
/** The accounts a file names: its Account column (or the preset's rule) and the other side of its transfers.
 *  → {names (as written, first spelling), blanks: some money row has none}. */
export function accountNames(rows, map, { preset = null, header = [] } = {}) {
  const names = new Map();
  let blanks = false;
  if (map.account == null && !preset?.account) return { names: [], blanks };
  for (const r of rows.slice(0, LIMITS.rows)) {
    const cx = rowCtx(r, map, header), tr = preset?.transfer?.(cx);
    for (const v of [preset?.account ? preset.account(cx) : cx.get('account'), tr?.to]) {
      const s = cleanText(v, 40);
      if (s && !names.has(s.toLowerCase())) names.set(s.toLowerCase(), s);
    }
    if (!cleanText(preset?.account ? preset.account(cx) : cx.get('account'), 40) && !preset?.adjust?.(cx)) blanks = true;
  }
  return { names: [...names.values()], blanks };
}
/** False for a preset's transfer and balance-correction rows: their Category cell isn't a spending category. */
export const isMoneyRow = (r, map, { preset = null, header = [] } = {}) => { const cx = rowCtx(r, map, header); return !preset?.transfer?.(cx) && !preset?.adjust?.(cx); };
/** A row's category cell (a preset may take it from another column on some rows: 1Money's income). */
export const rowCategory = (r, map, { preset = null, header = [] } = {}) => { const cx = rowCtx(r, map, header); return preset?.category ? preset.category(cx) : cx.get('category'); };

// ---- after an import: already here? transfers between the user's own accounts ----------------------------------------
/**
 * Split an import into {fresh, dups}. Already here: the same id (the same file again); the same money on the same day
 * and account from another source (a receipt, then its statement line); or one side of a transfer already recorded
 * (a wallet reload paired with its bank line earlier, then the wallet's statement brought in); or the same ledger
 * from another format of the same app (a .mmbak, then its Excel export): same day, amount, type and account, and a
 * word of the text in common (or no text on either). Rows repeated within the import all stay (two teh tarik on one
 * day). `names` (account id → name) matches accounts by name, so a second format's new accounts meet the first's.
 */
export function splitDups(existing, txs, names = {}) {
  const ids = new Set(existing.map(x => x.id)), by = new Map(), add = (k, x) => { const l = by.get(k); if (l) l.push(x); else by.set(k, [x]); };
  const acc = id => (Object.hasOwn(names, id) ? `@${String(names[id]).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')}` : id);
  for (const y of existing) {
    if (y.type !== 'transfer') add(`${acc(y.accountId)}|${y.date}|${y.amount}`, y);
    else { add(`out|${acc(y.accountId)}|${y.amount}`, y); add(`in|${acc(y.toAccountId)}|${y.amount}`, y); }
  }
  // Each existing transaction stands for one incoming row at most.
  const take = (list = [], ok) => { const i = list.findIndex(ok); return i >= 0 && !!list.splice(i, 1); };
  const tr = x => by.get(`${x.type === 'income' ? 'in' : 'out'}|${acc(x.accountId)}|${x.amount}`);
  const words = x => new Set(`${x.merchant || ''} ${x.note || ''}`.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
  const alike = (x, y) => { const a = words(x), b = words(y); return !a.size && !b.size ? true : [...a].some(w => b.has(w)); };
  const dup = x => ids.has(x.id)
    || take(by.get(`${acc(x.accountId)}|${x.date}|${x.amount}`), y => y.type === x.type && (y.source !== x.source || alike(x, y)))
    || take(tr(x), y => y.date === x.date) || take(tr(x), y => Math.abs(daysBetween(y.date, x.date)) <= 1);
  const fresh = [], dups = [];
  for (const x of txs) (dup(x) ? dups : fresh).push(x);
  return { fresh, dups };
}
const TOPUP = /reload|top[\s-]?up|tambah nilai|transfer|\btrf\b|pindahan|touch\s*['’]?\s*n\s*['’]?\s*go|\btng\b|grab\s*pay|\bboost\b|shopee\s*pay|big\s*pay|setel|own account|akaun sendiri|\bvia\b|cash\s*in/i;
/**
 * Money that left one account and arrived in another: an expense and an income of the same amount, on two different
 * accounts, within a day, one of them worded like a top-up or transfer ("TRANSFER TO TNG DIGITAL", "Reload via
 * Maybank"). Only pairs touching `fresh` (the import). → [[expense, income]], each transaction used once, nearest day first.
 */
export function pairTransfers(all, fresh) {
  const isNew = new Set(fresh.map(x => x.id)), used = new Set(), pairs = [], ins = new Map();
  for (const i of all) if (i.type === 'income' && i.category !== 'salary') { const l = ins.get(i.amount); if (l) l.push(i); else ins.set(i.amount, [i]); }
  const word = x => TOPUP.test(`${x.merchant || ''} ${x.note || ''}`);
  for (const o of all.filter(x => x.type === 'expense' && ins.has(x.amount)).sort((a, b) => a.date.localeCompare(b.date))) {
    let best = null;
    for (const i of ins.get(o.amount)) {
      if (used.has(i.id) || i.accountId === o.accountId || !(isNew.has(o.id) || isNew.has(i.id)) || !(word(o) || word(i))) continue;
      const d = Math.abs(daysBetween(o.date, i.date));
      if (d <= 1 && (!best || d < best.d)) best = { i, d };
    }
    if (best) { used.add(best.i.id); pairs.push([o, best.i]); }
  }
  return pairs;
}
/**
 * A wallet statement imported first saves each reload as a transfer from "Other bank" (outside). When the bank's
 * statement comes later, its line for that reload ("Transfer TO TNG Digital") is that same money: the transfer now
 * comes from this bank, and the bank line is not saved as spending. → {relink: updated transfers, taken: bank-line ids}
 */
export function relinkReloads(existing, fresh, outsideId) {
  const open = existing.filter(x => x.type === 'transfer' && x.accountId === outsideId), relink = [], taken = new Set();
  for (const x of fresh) {
    if (x.type !== 'expense' || x.accountId === outsideId || !TOPUP.test(`${x.merchant || ''} ${x.note || ''}`)) continue;
    const i = open.findIndex(o => o.amount === x.amount && Math.abs(daysBetween(o.date, x.date)) <= 1);
    if (i >= 0) { relink.push({ ...open[i], accountId: x.accountId }); taken.add(x.id); open.splice(i, 1); }
  }
  return { relink, taken };
}
/** One transfer for a pair: the expense's id, day and text, into the income's account. */
export const asTransfer = ([o, i]) => ({ ...o, type: 'transfer', toAccountId: i.accountId, category: 'other' });
/**
 * Accounts whose balance the user typed (`typed`: Start fresh, the account sheet, "What is in these accounts today?"):
 * imported rows dated before the day the account was made are already inside that figure. → {accountId: sen to add
 * to its opening} so today's balance stays what the user typed. Accounts from before the flag existed count as typed
 * unless they already hold imported rows from before they were made (then they are an app's history: left alone).
 * `today`: the app's day; an account can't be made later than it (a phone clock or time zone that moved back).
 */
export function typedShift(accounts, existing, rows, today = '9999-12-31') {
  const made = a => { const d = new Date(a.createdAt); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
  const on = (x, id) => x.accountId === id || x.toAccountId === id, out = {};
  for (const a of accounts) {
    if (!(a.createdAt > 0) || a.outside || a.typed === false) continue;   // never given: no balance to keep
    const day = made(a) < today ? made(a) : today;
    if (!a.typed && existing.some(x => on(x, a.id) && x.date < day && (x.source === 'import' || x.source === 'statement'))) continue;
    const net = rows.filter(x => on(x, a.id) && x.date < day).reduce((s, x) => s + (x.type === 'income' || (x.type === 'transfer' && x.toAccountId === a.id) ? x.amount : -x.amount), 0);
    if (net) out[a.id] = -net;
  }
  return out;
}
const ATM = /\b(atm|cash withdrawal|withdrawal atm|pengeluaran tunai|cdm withdrawal)\b|取款|提款/i;
/** A bank row that is cash taken out at an ATM. */
export const isAtm = x => x.type === 'expense' && ATM.test(`${x.merchant || ''} ${x.note || ''}`);
const RELOAD = /\b(reload|top[\s-]?up|tambah nilai)\b/i, NOT_NAME = /^(bank|akaun|account|savings|simpanan|semasa|current|card|kad)$/;
/**
 * E-wallet reloads left over after pairTransfers ("Reload via FPX Maybank" with no Maybank line): money the user moved
 * from their own bank, never income. Each becomes a transfer into the wallet from the bank or card account its text
 * names (that bank's statement, imported later, then finds it already here: splitDups), else from `other`, a
 * placeholder for a bank not in Tally. → the transfers, same ids.
 */
export function reloadTransfers(txs, accounts, other) {
  const kind = new Map(accounts.map(a => [a.id, a.kind])), banks = accounts.filter(a => (a.kind === 'bank' || a.kind === 'card') && !a.outside);
  const words = s => String(s || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
  // An ATM withdrawal on a bank statement is cash moved into the wallet, not spending (the cash is spent later, and logged then).
  const cash = accounts.find(a => a.kind === 'cash' && !a.outside);
  const atm = cash ? txs.filter(x => kind.get(x.accountId) !== 'cash' && isAtm(x)).map(x => ({ ...x, type: 'transfer', toAccountId: cash.id, category: 'other' })) : [];
  return txs.filter(x => x.type === 'income' && kind.get(x.accountId) === 'ewallet' && RELOAD.test(`${x.merchant || ''} ${x.note || ''}`)).map(x => {
    const text = words(`${x.merchant} ${x.note}`), from = banks.find(a => words(a.name).some(w => !NOT_NAME.test(w) && text.some(x => x === w || (w.length >= 4 && x.startsWith(w)))));   // "Maybank2u" is Maybank
    return { ...x, type: 'transfer', accountId: from?.id || other, toAccountId: x.accountId, category: 'other' };
  }).concat(atm);
}
// ---- export ------------------------------------------------------------------------------------------
const q = v => (/[",\n\r;]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
/** Spreadsheets run cells starting with = + - @; a leading quote makes them plain text. */
export const safeText = v => (/^[=+\-@\t\r]/.test(String(v ?? '')) ? `'${v}` : String(v ?? ''));
/** One CSV row, quoted and safe to open in a spreadsheet. */
export const csvLine = cells => cells.map(c => q(safeText(c))).join(',');
const catNameOf = id => ALL_CATS.find(c => c.id === id)?.name || id || '';
/** Every entry as spreadsheet rows, header first, one row per receipt item; amounts are numbers in RM. CSV, Excel and
 *  Google Sheets exports share it, and the 'tally' preset reads any of them back. */
export function txRows(txs, accounts, catName = catNameOf) {
  const acc = Object.fromEntries(accounts.map(a => [a.id, a.name]));
  const rows = [['Date', 'Type', 'Amount', 'Account', 'To account', 'Category', 'Merchant', 'Item', 'Note', 'Time', 'Subcategory']];   // Subcategory last: older readers keep their columns
  for (const t of [...txs].sort((a, b) => a.date.localeCompare(b.date))) {
    const head = [t.date, t.type], acct = [acc[t.accountId] || '', acc[t.toAccountId] || ''];
    // Tax, service charge and rounding spread over the items, so the rows add up to what was paid (as in Insights).
    const extra = t.items?.length ? allocate(t.items.map(i => i.cents), t.amount - t.items.reduce((a, i) => a + i.cents, 0)) : [];
    if (t.items?.length) for (const [n, it] of t.items.entries()) rows.push([...head, (it.cents + extra[n]) / 100, ...acct, catName(it.category), t.merchant || '', it.name || '', t.note || '', t.time || '', t.sub || '']);
    else rows.push([...head, t.amount / 100, ...acct, catName(t.category), t.merchant || '', '', t.note || '', t.time || '', t.sub || '']);
  }
  return rows;
}
const cell = c => (typeof c === 'number' ? c.toFixed(2) : safeText(c));
export const toCSV = (txs, accounts, catName) => '﻿' + txRows(txs, accounts, catName).map(r => r.map(c => q(cell(c))).join(',')).join('\n');   // BOM: Excel opens Malay and Chinese text as UTF-8
/** Tab-separated, for pasting into Google Sheets (formula-safe like the CSV; a tab or line break in a note becomes a space). */
export const toTSV = (txs, accounts, catName) => txRows(txs, accounts, catName).map(r => r.map(c => cell(c).replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');

/** Rows → a small .xlsx (one sheet, text inline, amounts as numbers) that Excel, Google Sheets, Numbers and LibreOffice open. */
export function toXlsx(rows, sheet = 'Tally') {
  const x = s => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const ref = (i, y) => `${String.fromCharCode(65 + i)}${y + 1}`;   // ponytail: columns A-Z; txRows has 10
  const data = rows.map((r, y) => `<row r="${y + 1}">${r.map((c, i) => (typeof c === 'number' ? `<c r="${ref(i, y)}"><v>${c}</v></c>` : `<c r="${ref(i, y)}" t="inlineStr"><is><t xml:space="preserve">${x(c)}</t></is></c>`)).join('')}</row>`).join('');
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', R = 'http://schemas.openxmlformats.org', enc = s => new TextEncoder().encode(X + s);
  return zipStore([
    { name: '[Content_Types].xml', data: enc(`<Types xmlns="${R}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`) },
    { name: '_rels/.rels', data: enc(`<Relationships xmlns="${R}/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', data: enc(`<workbook xmlns="${R}/spreadsheetml/2006/main" xmlns:r="${R}/officeDocument/2006/relationships"><sheets><sheet name="${x(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc(`<Relationships xmlns="${R}/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`) },
    { name: 'xl/worksheets/sheet1.xml', data: enc(`<worksheet xmlns="${R}/spreadsheetml/2006/main"><sheetData>${data}</sheetData></worksheet>`) },
  ]);
}

/** QIF, the old standard desktop money apps import (GnuCash, HomeBank, Quicken, Moneydance, Money Manager Ex): a section
 *  per account in its own currency, dates MM/DD/YYYY, spending negative, a receipt's items as splits, transfers as [Account]. */
export function toQIF(txs, accounts, catName = catNameOf) {
  const line = s => String(s ?? '').replace(/[\r\n]+/g, ' ').trim(), cat = c => line(catName(c)).replace(/[:/]/g, ' ');
  const name = Object.fromEntries(accounts.map(a => [a.id, line(a.name)])), m = c => (c / 100).toFixed(2);
  const out = [];
  for (const a of accounts) {
    const mine = txs.filter(t => t.accountId === a.id || (t.type === 'transfer' && t.toAccountId === a.id)).sort((x, y) => x.date.localeCompare(y.date));
    if (!mine.length) continue;
    const type = a.kind === 'card' ? 'CCard' : a.kind === 'cash' ? 'Cash' : 'Bank';
    out.push('!Account', `N${name[a.id]}`, `T${type}`, '^', `!Type:${type}`);
    for (const t of mine) {
      const into = t.type === 'transfer' && t.toAccountId === a.id, cents = into ? t.toAmount ?? t.amount : t.fx ?? t.amount;
      out.push(`D${t.date.slice(5, 7)}/${t.date.slice(8, 10)}/${t.date.slice(0, 4)}`, `T${t.type === 'income' || into ? '' : '-'}${m(cents)}`);
      if (t.merchant) out.push(`P${line(t.merchant)}`);
      if (t.note) out.push(`M${line(t.note)}`);
      out.push(t.type === 'transfer' ? `L[${name[into ? t.accountId : t.toAccountId] || ''}]` : `L${cat(t.category)}`);
      if (t.items?.length > 1 && t.fx == null) {
        const extra = allocate(t.items.map(i => i.cents), t.amount - t.items.reduce((s, i) => s + i.cents, 0)), sign = t.type === 'income' ? '' : '-';
        t.items.forEach((it, n) => out.push(`S${cat(it.category)}`, `E${line(it.name)}`, `$${sign}${m(it.cents + extra[n])}`));
      }
      out.push('^');
    }
  }
  return out.join('\n') + '\n';
}
/** An OFX / QFX bank download (SGML 1.x or XML 2.x) as the same rows as a QIF file: one per <STMTTRN>, the account from
 *  ACCTID, dates YYYYMMDD made ISO (so month-first never applies), amounts already signed. */
export function ofxToRows(text) {
  const rows = [['Date', 'Amount', 'Payee', 'Category', 'Memo', 'QIF account']];
  const tag = (s, k) => (s.match(new RegExp(`<${k}>([^<\\r\\n]*)`, 'i'))?.[1] || '').trim();
  for (const stmt of String(text).split(/<(?:STMTRS|CCSTMTRS)>/i).slice(1)) {
    const acc = tag(stmt, 'ACCTID');
    for (const tr of stmt.split(/<STMTTRN>/i).slice(1)) {
      const d = tag(tr, 'DTPOSTED').match(/^(\d{4})(\d{2})(\d{2})/);
      if (d) rows.push([`${d[1]}-${d[2]}-${d[3]}`, tag(tr, 'TRNAMT'), tag(tr, 'NAME') || tag(tr, 'PAYEE'), '', tag(tr, 'MEMO'), acc]);
    }
  }
  return rows;
}
/** A QIF file (from GnuCash, HomeBank, Quicken…) as rows, header first, for the 'qif' preset: one row per entry or split. */
export function qifToRows(text) {
  const rows = [['Date', 'Amount', 'Payee', 'Category', 'Memo', 'QIF account']];
  let acc = '', inAcc = false, skip = false, r = {}, splits = [];
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const k = raw[0], v = raw.slice(1).trim();
    if (k === '!') { const h = raw.trim().toLowerCase(); inAcc = h === '!account'; skip = /^!type:(invst|cat|class|memorized|prices|security)/.test(h); r = {}; splits = []; continue; }
    if (k === '^') {
      if (inAcc) inAcc = false;
      else if (!skip && r.D) {
        const date = r.D.replace(/\s+/g, '').replace("'", '/');   // "12/31'25"
        if (splits.length) for (const s of splits) rows.push([date, s.$ ?? '', r.P || '', s.S || '', s.E || r.M || '', acc]);
        else rows.push([date, r.T ?? r.U ?? '', r.P || '', r.L || '', r.M || '', acc]);
      }
      r = {}; splits = []; continue;
    }
    if (inAcc) { if (k === 'N') acc = v; continue; }
    if (skip || !k) continue;
    if (k === 'S') splits.push({ S: v }); else if ((k === 'E' || k === '$') && splits.length) splits.at(-1)[k] = v; else r[k] = v;
  }
  return rows;
}

// ---- backup ------------------------------------------------------------------------------------------
export const BACKUP_APP = 'tally';
export const makeBackup = ({ accounts, tx, recurring, kv }) => JSON.stringify({ app: BACKUP_APP, v: 1, exportedAt: new Date().toISOString(), accounts, tx, recurring, kv });
const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
const okAmt = n => Number.isInteger(n) && n >= 0 && n <= 100_000_000_00;
export const okSigned = n => Number.isInteger(n) && Math.abs(n) <= 100_000_000_00;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']); // never an id or a key: they reach plain objects
/** Ids end up in calendar files, file names and object keys. */
export const okId = id => typeof id === 'string' && /^[\w-]{1,60}$/.test(id) && !RESERVED.has(id);
const list = (x, max) => (Array.isArray(x) ? x.slice(0, max) : []);
const upd = n => (Number.isSafeInteger(n) && n > 0 ? { updatedAt: Math.min(n, Date.now()) } : {}); // a file can't claim to be edited in the future
/** A creation time from a file: 2000 to tomorrow, else 0 (unknown). Year 500 became '500-06-15' in Home's banner and crashed it. */
export const okMs = n => (Number.isSafeInteger(n) && n >= Date.UTC(2000, 0, 1) && n <= Date.now() + 864e5 ? n : 0);
// Known book metadata only: refuse invalid additions instead of silently dropping them.
const sampleFlag = r => { if (!Object.hasOwn(r, 'sample')) return {}; if (typeof r.sample !== 'boolean') throw new Error('This backup has an invalid sample-data flag. Nothing was restored.'); return { sample: r.sample }; };
const recurringCreated = r => { if (!Object.hasOwn(r, 'createdAt')) return {}; const n = r.createdAt; if (!Number.isSafeInteger(n) || (n !== 0 && okMs(n) !== n)) throw new Error('This backup has an invalid bill creation time. Nothing was restored.'); return { createdAt: n }; };
const validFriends = v => Array.isArray(v) && v.length <= 12 && v.every(s => typeof s === 'string' && s.length > 0 && s.length <= 20 && cleanText(s, 20) === s && !RESERVED.has(s));
export function checkedJointGone(value) {
  if (!isObj(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length > 1000 || !Object.entries(value).every(([id, at]) => okId(id) && Number.isSafeInteger(at) && at > 0 && okMs(at) === at && at <= Date.now())) throw new Error('This backup has invalid shared-entry deletion markers. Nothing was restored.');
  return Object.fromEntries(Object.entries(value));
}
/** The most a backup holds: readBackup refuses a whole backup over any of these, so nothing may store more (overCap). */
export const CAPS = { accounts: 200, tx: 200_000, recurring: 500, customCats: 50 };
/** The first limit these records are over ('' when none): a backup of them would not restore. */
export const overCap = r => Object.keys(CAPS).find(k => (r[k] || []).length > CAPS[k]) || '';
/** overCap of `local` after adding `add` (by id, replacing) and deleting `del` ({accounts, tx, recurring}: ids). */
export function overCapAfter(local, add, del = {}) {
  const join = k => { const m = new Map((local[k] || []).map(x => [x.id, x])); for (const x of add[k] || []) m.set(x.id, x); for (const id of del[k] || []) m.delete(id); return [...m.values()]; };
  // Over a cap and growing: a phone already over one (from before the caps) can still take what doesn't add to it.
  return Object.keys(CAPS).find(k => { const n = join(k).length; return n > CAPS[k] && n > (local[k] || []).length; }) || '';
}
/** Would restore read all of this backup? The file, the JSON inside a zip, and the zip's entries (JSON + photos) each have
 *  restore's limit: a photo backup over any of them was refused whole, or lost photos, after being reported as saved. */
export const backupFits = ({ zip, fileBytes, jsonBytes, entries = 1 }) => fileBytes <= (zip ? LIMITS.backupBytes : LIMITS.backupJson) && jsonBytes <= LIMITS.backupJson && entries <= ZIP.entries;
/** A sealed backup is base64 of the file in JSON: this long at most for the biggest file importFile reads back. */
export const SEALED_MAX = Math.ceil((LIMITS.backupBytes + 16) / 3) * 4 + 1024;
/** Backup text → cleaned {accounts, tx, recurring, kv, dropped}, or throws a message the user can act on. */
export function readBackup(text) {
  if (String(text).length > LIMITS.backupJson) throw new Error('This backup is too big to restore (over 50 MB).');
  let d;
  try { d = JSON.parse(text); } catch { throw new Error('This file is not a Tally backup (it is not valid JSON).'); }
  if (!isObj(d) || d.app !== BACKUP_APP) throw new Error('This file is not a Tally backup.');
  if (d.v > 1) throw new Error('This backup is from a newer version of Tally. Update the app, then restore.');
  for (const key of ['accounts', 'tx', 'recurring']) {
    const max = CAPS[key];
    if (Array.isArray(d[key]) && d[key].length > max) throw new Error(`This backup has more than ${max} ${key === 'tx' ? 'transactions' : key === 'recurring' ? 'bills' : key}. Nothing was restored.`);
  }
  // Over 50 own categories (a backup from before the cap): the first 50 are kept below, rows in the rest become Other.
  // Custom categories first: only the ones that pass are category ids anywhere else in the backup.
  const customCats = list(isObj(d.kv) && d.kv.customCats, 50).filter(c => isObj(c) && /^c_[\w-]{1,40}$/.test(c.id)).map(c => ({ id: c.id, name: cleanText(c.name, 40) || 'Custom', color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#64748B', ...(c.kind === 'income' ? { kind: 'income' } : {}) }));
  const customIds = new Set(customCats.map(c => c.id));
  const cat = c => (ALL_CATS.some(x => x.id === c) || customIds.has(c) ? c : 'other');
  const accounts = list(d.accounts, 200).filter(a => isObj(a) && okId(a.id))
    .map(a => ({ id: a.id, name: cleanText(a.name, 60) || 'Account', kind: [...ACCOUNT_KINDS, ...OWING_KINDS].includes(a.kind) ? a.kind : 'cash', opening: okSigned(a.opening) ? a.opening : 0, createdAt: okMs(+a.createdAt), ...((a.scope === 'joint' || a.scope === 'business') && !OWING_KINDS.includes(a.kind) ? { scope: a.scope } : {}),   // what friends owe is never joint
      ...(/^[A-Z]{3}$/.test(a.currency) && a.currency !== 'MYR' ? { currency: a.currency, ...(+a.rate > 0 && +a.rate < 1e5 ? { rate: +a.rate } : {}) } : {}), ...(a.outside === true ? { outside: true } : {}), ...(typeof a.typed === 'boolean' ? { typed: a.typed } : {}), ...sampleFlag(a), ...upd(a.updatedAt) }));
  const ids = new Set(accounts.map(a => a.id));
  // A friend's name (a split bill): as the split sheet takes it, and never a key that reaches an object's prototype.
  const friend = v => { const s = typeof v === 'string' ? cleanText(v, 20) : ''; return s && !RESERVED.has(s) ? s : ''; };
  const cleanItems = arr => arr.filter(i => isObj(i) && okSigned(i.cents)).slice(0, 500).map(i => ({ name: cleanText(i.name, 80), raw: cleanText(i.raw, 80), cents: i.cents, category: cat(i.category), ...(Number.isInteger(i.qty) && i.qty > 1 && i.qty < 10000 && okSigned(i.unit) ? { qty: i.qty, unit: i.unit } : {}) }));
  // A split bill: what was really paid, with whom, who had what ('' = me), who put down what at the counter ('' = me),
  // the receipt's items and the account that paid when a friend did. My share can be nothing (amount 0).
  const paidOf = p => { if (!isObj(p)) return null; const e = Object.entries(p).slice(0, 9).filter(([k, v]) => (k === '' || friend(k)) && okAmt(v)).map(([k, v]) => [k === '' ? '' : friend(k), v]); return e.length ? Object.fromEntries(e) : null; };
  const split = s => (isObj(s) && okAmt(s.total) && s.total > 0 ? { total: s.total, with: list(s.with, 8).map(friend).filter(Boolean),
    who: list(s.who, 500).map(w => list(w, 8).filter(p => p === '' || friend(p)).map(p => p && friend(p))), ...(Array.isArray(s.items) ? { items: cleanItems(s.items) } : {}), ...(paidOf(s.paid) ? { paid: paidOf(s.paid) } : {}), ...(ids.has(s.acc) ? { acc: s.acc } : {}) } : null);
  // A friend's debt rides only on the row that moves it (as splitRows and Paid back write them): a share into Owed to you,
  // a payback out of it, a bill a friend paid in You owe, my payback into it. Anywhere else (a partner's joint rows, which
  // never touch these accounts) it would put a made-up debt on Home.
  const kindOf = new Map(accounts.map(a => [a.id, a.kind])), tr = t => t.type === 'transfer';
  const OWE_TAG = { owedBy: t => tr(t) && kindOf.get(t.toAccountId) === 'owedme', repaidBy: t => tr(t) && kindOf.get(t.accountId) === 'owedme',
    owedTo: t => t.type === 'expense' && kindOf.get(t.accountId) === 'iowe', repaidTo: t => tr(t) && kindOf.get(t.toAccountId) === 'iowe' };
  const tx = list(d.tx, 200_000).filter(t => isObj(t) && okId(t.id) && validIso(t.date) && okAmt(t.amount) && (t.amount > 0 || (t.type === 'expense' && !!split(t.split))) && ['expense', 'income', 'transfer'].includes(t.type) && ids.has(t.accountId) && (t.type !== 'transfer' || (ids.has(t.toAccountId) && t.toAccountId !== t.accountId)))
    .map(t => ({
      id: t.id, date: t.date, ...(/^([01]\d|2[0-3]):[0-5]\d$/.test(t.time) ? { time: t.time } : {}), type: t.type, amount: t.amount, accountId: t.accountId, ...(t.type === 'transfer' ? { toAccountId: t.toAccountId, ...(okAmt(t.toAmount) && t.toAmount > 0 ? { toAmount: t.toAmount } : {}) } : {}), ...(+t.rate > 0 && +t.rate < 1e5 ? { rate: +t.rate } : {}),
      category: cat(t.category), ...(t.cat ? { cat: cat(t.cat) } : {}), ...(t.type !== 'transfer' && cleanText(t.sub, 30) ? { sub: cleanText(t.sub, 30) } : {}), merchant: cleanText(t.merchant, 80), note: cleanText(t.note, 200), source: ['quick', 'receipt', 'import', 'statement', 'recurring'].includes(t.source) ? t.source : 'import', createdAt: okMs(+t.createdAt),
      ...(Array.isArray(t.items) ? { items: cleanItems(t.items) } : {}),
      ...(t.type === 'expense' && split(t.split) ? { split: split(t.split) } : {}), ...(okId(t.splitOf) ? { splitOf: t.splitOf } : {}),
      ...Object.entries(OWE_TAG).reduce((o, [k, ok]) => (ok(t) && friend(t[k]) ? { ...o, [k]: friend(t[k]) } : o), {}),
      ...['tax', 'service', 'rounding'].reduce((o, k) => (okSigned(t[k]) ? { ...o, [k]: t[k] } : o), {}),
      ...(okId(t.receiptId) ? { receiptId: t.receiptId } : {}),
      ...(okId(t.refundOf) ? { refundOf: t.refundOf } : {}), ...(validIso(t.warranty) ? { warranty: t.warranty } : {}), ...(validIso(t.returnBy) ? { returnBy: t.returnBy } : {}),
      ...(cleanText(t.by, 30) ? { by: cleanText(t.by, 30) } : {}), ...(t.spouse === true ? { spouse: true } : {}), ...(t.type === 'expense' && (t.relief === 'none' || RELIEFS.some(r => r.id === t.relief)) ? { relief: t.relief } : {}), ...upd(t.updatedAt),
      ...(okId(t.bill) ? { bill: t.bill } : {}), ...sampleFlag(t),
    }));
  const recurring = list(d.recurring, 500).filter(r => isObj(r) && okId(r.id) && okAmt(r.amount))
    .map(r => ({ id: r.id, name: cleanText(r.name, 60) || 'Bill', amount: r.amount, category: cat(r.category), accountId: ids.has(r.accountId) ? r.accountId : accounts[0]?.id, day: Math.min(31, Math.max(1, Math.trunc(+r.day) || 1)), key: cleanText(r.key, 60),
      // Bills that add themselves (0.4.0): how often, from when, how many or until when, and the last day they ran.
      ...(['weekly', 'yearly'].includes(r.freq) ? { freq: r.freq } : {}), auto: r.auto === true, ...(Number.isInteger(r.count) && r.count > 0 && r.count <= 600 ? { count: r.count } : {}),
      ...['start', 'until', 'last'].reduce((o, k) => (validIso(r[k]) ? { ...o, [k]: r[k] } : o), {}), ...recurringCreated(r), ...sampleFlag(r), ...upd(r.updatedAt) }));
  const kv = {};
  if (isObj(d.kv)) {
    if (Object.hasOwn(d.kv, 'jointGone')) kv.jointGone = checkedJointGone(d.kv.jointGone);
    const bud = b => ({ total: okAmt(b.total) ? b.total : 0, byCat: Object.fromEntries(Object.entries(isObj(b.byCat) ? b.byCat : {}).filter(([k, v]) => cat(k) === k && okAmt(v))) });
    if (isObj(d.kv.budgets)) kv.budgets = { ...bud(d.kv.budgets), ...(isObj(d.kv.budgets.joint) ? { joint: { ...bud(d.kv.budgets.joint), ...upd(d.kv.budgets.joint.updatedAt) } } : {}), ...(isObj(d.kv.budgets.business) ? { business: bud(d.kv.budgets.business) } : {}) };
    if (isObj(d.kv.rules)) kv.rules = Object.fromEntries(Object.entries(d.kv.rules).slice(0, 5000).map(([k, v]) => [cleanText(k, 70), cat(v)]).filter(([k]) => k && !RESERVED.has(k)));
    if (isObj(d.kv.shopNames)) kv.shopNames = Object.fromEntries(Object.entries(d.kv.shopNames).slice(0, 500).map(([k, v]) => [cleanText(k, 60), cleanText(v, 80)]).filter(([k, v]) => k && v && !RESERVED.has(k)));
    if (isObj(d.kv.itemNames)) kv.itemNames = Object.fromEntries(Object.entries(d.kv.itemNames).slice(-2000).map(([k, v]) => [cleanText(k, 60), cleanText(v, 80)]).filter(([k, v]) => k && v && !RESERVED.has(k)));
    // A category's own subcategories: up to 30 short names each, under a known-looking category id
    if (isObj(d.kv.subcats)) kv.subcats = Object.fromEntries(Object.entries(d.kv.subcats).filter(([k, v]) => /^[\w-]{1,40}$/.test(k) && !RESERVED.has(k) && Array.isArray(v)).slice(0, 80).map(([k, v]) => [k, [...new Set(v.map(x => cleanText(x, 30)).filter(Boolean))].slice(0, 30)]));
    // What a shop's subcategory was: {shopKey: [category, sub]}
    if (isObj(d.kv.subRules)) kv.subRules = Object.fromEntries(Object.entries(d.kv.subRules).filter(([k, v]) => cleanText(k, 60) && !RESERVED.has(k) && Array.isArray(v) && /^[\w-]{1,40}$/.test(v[0]) && cleanText(v[1], 30)).slice(-1000).map(([k, v]) => [cleanText(k, 60), [v[0], cleanText(v[1], 30)]]));
    if (Array.isArray(d.kv.dismissed)) kv.dismissed = d.kv.dismissed.filter(x => typeof x === 'string' && x.length <= 120).slice(-300);
    if (Array.isArray(d.kv.customCats)) kv.customCats = customCats;
    if (isObj(d.kv.catColors)) kv.catColors = Object.fromEntries(Object.entries(d.kv.catColors).slice(0, 100).filter(([k, v]) => cat(k) === k && /^#[0-9a-f]{6}$/i.test(v)));
    if (isObj(d.kv.catIcons)) kv.catIcons = Object.fromEntries(Object.entries(d.kv.catIcons).slice(0, 100).filter(([k, v]) => cat(k) === k && Object.hasOwn(CAT_ICONS, v)));
    // Savings goals: at most 20, each rebuilt from its checked fields (no other keys come through); a link only to an account in the file.
    if (Array.isArray(d.kv.goals)) kv.goals = d.kv.goals.slice(0, 20).filter(g => isObj(g) && okId(g.id) && okAmt(g.target) && g.target > 0)
      .map(g => ({ id: g.id, name: cleanText(g.name, 30) || 'Goal', target: g.target, ...(validIso(g.by) ? { by: g.by } : {}), ...(ids.has(g.accountId) ? { accountId: g.accountId } : {}), createdAt: okMs(+g.createdAt), ...sampleFlag(g) }));
  }
  return { accounts, tx, recurring, kv, settings: backupSettings(d.kv?.settings), dropped: (Array.isArray(d.tx) ? d.tx.length : 0) - tx.length, ...(d.kind === 'joint' ? { joint: true, by: cleanText(d.by, 30),
    gone: Object.fromEntries(list(d.gone, 1000).filter(g => Array.isArray(g) && okId(g[0]) && Number.isSafeInteger(g[1]) && g[1] > 0).map(([id, at]) => [id, Math.min(at, Date.now())])) } : {}) };
}
/** Settings a backup carries, each checked: how Tally counts and looks, and your name. Never the app PIN, import memory or first-run flags. */
const SETTINGS = {
  friends: validFriends, sample: v => typeof v === 'boolean',
  quickAccount: v => okId(v),
  monthStart: v => Number.isInteger(v) && ((v >= 1 && v <= 28) || v === -1 || v === -2), weekStart: v => v === 0 || v === 1, lang: v => ['en', 'ms', 'zh', 'zh-Hant', 'ja', 'ta'].includes(v),
  textSize: v => [100, 115, 130].includes(v), theme: v => ['light', 'dark'].includes(v), accent: v => /^#[0-9a-f]{6}$/i.test(v),
  photoKeep: v => [0, 30, 90, 365].includes(v),   // days receipt photos are kept (0: always)
  compact: v => typeof v === 'boolean', ownCats: v => typeof v === 'boolean', hideBal: v => typeof v === 'boolean', haptics: v => typeof v === 'boolean', gamify: v => typeof v === 'boolean', learnHidden: v => typeof v === 'boolean',
  myName: v => typeof v === 'string' && v.length <= 30 && !!cleanText(v, 30), remindAt: v => /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
  features: v => isObj(v) && Object.keys(v).length <= 30 && Object.entries(v).every(([k, b]) => /^[a-z]{1,20}$/.test(k) && typeof b === 'boolean'),
  appPalette: v => /^([a-z]{1,12}|book-\d{4}-\d{2})$/.test(v), bookPalettes: v => isObj(v) && Object.keys(v).length <= 120 && Object.entries(v).every(([k, p]) => /^\d{4}-\d{2}$/.test(k) && SETTINGS.myPalette(p)), palette: v => /^[a-z]{1,12}$/.test(v),
  myPalette: v => isObj(v) && Object.keys(v).length === 3 && /^#[0-9a-f]{6}$/i.test(v.accent) && ['dark', 'light'].every(m => Array.isArray(v[m]) && v[m].length === 3 && v[m].every(h => /^#[0-9a-f]{6}$/i.test(h))),
  // Tally's categories removed → where they went: Other, another of Tally's spending categories or one of the user's own
  // (never an income category, a made-up word or a key like 'constructor', which broke every month's totals).
  movedCats: v => isObj(v) && Object.entries(v).every(([k, to]) => CATEGORIES.slice(0, -1).some(c => c.id === k) && typeof to === 'string' && (CATEGORIES.some(c => c.id === to) || /^c_[\w-]{1,40}$/.test(to)) && !Object.hasOwn(v, to)),
  homeHide: v => Array.isArray(v) && v.length <= 20 && v.every(x => /^[\w-]{1,20}$/.test(x)), noSpend: v => Array.isArray(v) && v.length <= 400 && v.every(validIso),
};
export const backupSettings = s => {
  if (isObj(s) && ((Object.hasOwn(s, 'friends') && !validFriends(s.friends)) || (Object.hasOwn(s, 'sample') && typeof s.sample !== 'boolean'))) throw new Error('This backup has invalid sample-data settings or friend names. Nothing was restored.');
  return Object.fromEntries(Object.entries(isObj(s) ? s : {}).filter(([k, v]) => Object.hasOwn(SETTINGS, k) && SETTINGS[k](v)).map(([k, v]) => [k, k === 'myName' ? cleanText(v, 30) : v]));
};
/** The receipt photos an import may write: those of the rows it adds or updates, never an id that another row on this
 *  phone (`before`) already uses. A file can't overwrite a photo it doesn't own. */
export const photosToWrite = (rows, before) => {
  const users = photoUsers(before);   // every row using a photo: one photo can be shared (Money Manager links one to many entries)
  return new Set(rows.filter(t => t.receiptId && [...(users.get(t.receiptId) || [t.id])].every(id => id === t.id)).map(t => t.receiptId));
};
/** An import's own categories that fit: those of `fileCats` the imported rows (`used`) need, up to 50 of the user's own in
 *  all (a backup with more won't restore). Rows and items in `rows` using one that doesn't fit get Tally's nearest. */
export function fitCats(have, fileCats, used, rows) {
  // One of theirs with the name of one of the user's own is that one, not a second "Food".
  const same = new Map(fileCats.filter(c => !have.some(h => h.id === c.id)).map(c => [c.id, sameCategory(c.name, have, c.kind === 'income')]).filter(([, v]) => v));
  if (same.size) for (const x of rows) { if (same.has(x.category)) x.category = same.get(x.category); for (const i of x.items || []) if (same.has(i.category)) i.category = same.get(i.category); }
  fileCats = fileCats.filter(c => !same.has(c.id));
  const ids = new Set(have.map(c => c.id)), needs = c => used.some(x => x.category === c.id || x.items?.some(i => i.category === c.id));
  const want = fileCats.filter(c => !ids.has(c.id) && needs(c)), cats = want.slice(0, Math.max(0, 50 - have.length));
  const out = new Map(want.slice(cats.length).map(c => [c.id, c]));
  const near = (id, income) => { const c = out.get(id); if (!c) return id; if (income) return /salary|gaji|工资|薪/i.test(c.name) ? 'salary' : 'income'; const n = mapCategory(c.name); return INCOME_CATEGORIES.some(x => x.id === n) ? 'other' : n; };
  if (out.size) for (const x of rows) { x.category = near(x.category, x.type === 'income'); for (const i of x.items || []) i.category = near(i.category, false); }
  return cats;
}
const photoUsers = rows => { const m = new Map(); for (const t of rows) if (t.receiptId) (m.get(t.receiptId) || m.set(t.receiptId, new Set()).get(t.receiptId)).add(t.id); return m; };
/** Merge restore: keep everything local, add what the backup has that we don't (by id). Local settings win. */
export function mergeBackup(local, incoming) {
  if (Object.keys(incoming.kv.jointGone || {}).length) throw new Error('This backup contains shared-entry deletion markers. Use Replace to keep them; Merge will not apply them.');
  const merge = (a, b) => { const ids = new Set(a.map(x => x.id)); return [...a, ...b.filter(x => !ids.has(x.id))]; };
  const budgets = local.kv.budgets?.total || Object.keys(local.kv.budgets?.byCat || {}).length ? local.kv.budgets : incoming.kv.budgets || local.kv.budgets;
  const jb = local.kv.budgets?.joint || incoming.kv.budgets?.joint;
  return {
    accounts: merge(local.accounts, incoming.accounts),
    tx: merge(local.tx, incoming.tx),
    recurring: merge(local.recurring, incoming.recurring),
    kv: {
      rules: { ...(incoming.kv.rules || {}), ...(local.kv.rules || {}) },
      shopNames: { ...(incoming.kv.shopNames || {}), ...(local.kv.shopNames || {}) },
      itemNames: { ...(incoming.kv.itemNames || {}), ...(local.kv.itemNames || {}) },
      subRules: { ...(incoming.kv.subRules || {}), ...(local.kv.subRules || {}) },
      subcats: Object.fromEntries([...new Set([...Object.keys(incoming.kv.subcats || {}), ...Object.keys(local.kv.subcats || {})])].map(k => [k, [...new Set([...(local.kv.subcats?.[k] || []), ...(incoming.kv.subcats?.[k] || [])])].slice(0, 30)])),
      customCats: merge(local.kv.customCats || [], incoming.kv.customCats || []),
      catColors: { ...(incoming.kv.catColors || {}), ...(local.kv.catColors || {}) },
      catIcons: { ...(incoming.kv.catIcons || {}), ...(local.kv.catIcons || {}) },
      budgets: budgets && jb ? { ...budgets, joint: jb } : budgets,
      dismissed: [...new Set([...(local.kv.dismissed || []), ...(incoming.kv.dismissed || [])])].slice(-300),
      goals: merge(local.kv.goals || [], incoming.kv.goals || []).slice(0, 20),
    },
  };
}

// ---- joint accounts: a file for the spouse ---------------------------------------------------------------------
/**
 * Only the joint accounts, their transactions, joint budgets and the custom categories those use: never a personal
 * account, row, rule or budget. A transfer between a personal and a joint account goes in as money in or out of the
 * joint account, without the personal side.
 */
export function makeJointShare({ accounts, tx, kv = {}, recurring = [] }, by = '') {
  const joint = accounts.filter(a => a.scope === 'joint'), ids = new Set(joint.map(a => a.id));
  const rows = tx.filter(t => ids.has(t.accountId) || ids.has(t.toAccountId)).map(({ spouse, ...t }) => {
    if (t.type !== 'transfer' || (ids.has(t.accountId) && ids.has(t.toAccountId))) return t;
    const { toAccountId, ...rest } = t;
    return ids.has(t.accountId) ? { ...rest, type: 'expense', category: 'other' } : { ...rest, type: 'income', accountId: toAccountId, category: 'income' };
  });
  const bills = recurring.filter(r => ids.has(r.accountId));
  const used = new Set([...rows.flatMap(t => [t.category, ...(t.items || []).map(i => i.category)]), ...Object.keys(kv.budgets?.joint?.byCat || {}), ...bills.map(r => r.category)]);
  return JSON.stringify({ app: BACKUP_APP, v: 1, kind: 'joint', by, exportedAt: new Date().toISOString(), accounts: joint, tx: rows, recurring: bills, gone: Object.entries(kv.jointGone || {}),
    kv: { budgets: { total: 0, byCat: {}, ...(kv.budgets?.joint ? { joint: kv.budgets.joint } : {}) }, customCats: (kv.customCats || []).filter(c => used.has(c.id)) } });
}
/**
 * A spouse's share file (after readBackup) against this phone → the records to write. By id, the newer edit
 * (updatedAt) wins. Nothing from the file may touch a personal account here or a row that uses one.
 * Deletions travel as `gone` markers (id -> when): a row deleted after its last edit stays deleted on both phones.
 * New rows from the file are marked `spouse` here (they don't count toward this phone's streak or missions).
 */
export function mergeJoint(local, incoming) {
  const newer = (mine, theirs) => !mine || (theirs.updatedAt || 0) > (mine.updatedAt || 0);
  const acc = new Map(local.accounts.map(a => [a.id, a])), txs = new Map(local.tx.map(t => [t.id, t]));
  const personal = new Set(local.accounts.filter(a => a.scope !== 'joint').map(a => a.id));
  // Before the first swap each phone made its own joint account: it is the same account as the partner's (by name, or
  // the only one on each side). The one with the smaller id survives on both phones, so swaps that cross (both import
  // at once) agree, and what was added to the other one moves into it.
  const theirsAll = incoming.accounts.filter(a => a.scope === 'joint' && !personal.has(a.id));
  const same = n => String(n || '').trim().toLowerCase(), newTheirs = theirsAll.filter(a => !acc.has(a.id)), mineOnly = local.accounts.filter(a => a.scope === 'joint' && !theirsAll.some(x => x.id === a.id));
  const pairs = [];
  for (const a of mineOnly) {
    const b = newTheirs.find(x => same(x.name) === same(a.name) && !pairs.some(p => p.b === x.id)) || (mineOnly.length === 1 && newTheirs.length === 1 ? newTheirs[0] : null);
    if (b && (b.currency || 'MYR') === (a.currency || 'MYR') && b.kind === a.kind) pairs.push({ a: a.id, b: b.id });   // never into another currency or kind
  }
  const into = new Map(pairs.filter(p => p.b < p.a).map(p => [p.a, p.b])), keep = new Map(pairs.filter(p => p.a < p.b).map(p => [p.b, p.a]));   // ours → theirs, theirs → ours
  const ours = id => keep.get(id) || id, remap = x => (keep.has(x.accountId) || keep.has(x.toAccountId) ? { ...x, accountId: ours(x.accountId), ...(x.toAccountId ? { toAccountId: ours(x.toAccountId) } : {}) } : x);
  // An account this phone merges into keeps this phone's exchange rate: the file can't set what its RM worth is.
  const ourRate = new Map(pairs.filter(p => p.b < p.a).map(p => [p.b, acc.get(p.a)?.rate]));
  const myGone = local.kv.jointGone || {}, theirGone = incoming.gone || {}, me = local.kv.settings?.myName || '';
  // Joint bills and accounts delete like joint entries: one deleted here after its last edit doesn't come back, and one
  // the partner deleted after its last edit here goes. A joint account deleted here takes the file's rows and bills on it
  // with it (they are not written onto a missing account, where a bill's payments would fall to a personal one).
  const alive = x => !(Object.hasOwn(myGone, x.id) && myGone[x.id] >= (x.updatedAt || 0)), goneThere = x => (theirGone[x.id] || 0) > (x.updatedAt || 0);
  const joint = theirsAll.filter(a => !keep.has(a.id) && alive(a)).map(a => (ourRate.has(a.id) ? { ...a, rate: ourRate.get(a.id) } : a)), ids = new Set([...joint.map(a => a.id), ...keep.values()]);
  // A photo id a row here already uses belongs to that row: a file's row pointing at it loses the link (else the next
  // joint share would send a personal row's photo, and the zip's copy would overwrite it).
  // A row keeps the link it already has here (shared or not); photosToWrite then decides whether the file's copy is written.
  const used = photoUsers(local.tx);
  const ownPhoto = t => (!t.receiptId || !used.has(t.receiptId) || txs.get(t.id)?.receiptId === t.receiptId ? t : (({ receiptId, ...r }) => r)(t));
  const tx = incoming.tx.map(remap).filter(t => ids.has(t.accountId) && (t.type !== 'transfer' || ids.has(t.toAccountId)))
    .filter(t => { const m = txs.get(t.id); return !(m && (personal.has(m.accountId) || personal.has(m.toAccountId))) && newer(m, t) && !((myGone[t.id] || 0) >= (t.updatedAt || 0)); })
    .map(t => { const m = txs.get(t.id); return m ? { ...t, ...(m.spouse ? { spouse: true } : {}), ...(m.by && !t.by ? { by: m.by } : {}) } : { ...t, ...(me && t.by === me ? {} : { spouse: true }) }; })
    .map(ownPhoto);
  const jointHere = new Set(local.accounts.filter(a => a.scope === 'joint').map(a => a.id));
  // A delete from the partner removes joint-only rows; one that also uses a personal account here (a transfer in) stays.
  const drop = local.tx.filter(t => (jointHere.has(t.accountId) || jointHere.has(t.toAccountId)) && !personal.has(t.accountId) && !personal.has(t.toAccountId) && (theirGone[t.id] || 0) > (t.updatedAt || 0)).map(t => t.id), dropped = new Set(drop);
  const mattersHere = id => id in myGone || txs.has(id);   // my deletes and rows on this phone outrank made-up ids when trimming
  const gone = Object.fromEntries(Object.keys({ ...theirGone, ...myGone }).map(id => [id, Math.max(theirGone[id] || 0, myGone[id] || 0)])
    .sort((a, b) => (mattersHere(b[0]) - mattersHere(a[0])) || (b[1] - a[1])).slice(0, 1000));
  const empty = mineOnly.filter(a => into.has(a.id)).map(a => ({ ...a, moved: local.tx.filter(t => t.accountId === a.id || t.toAccountId === a.id).length }));
  const to = id => into.get(id) || id;   // moved rows keep their edit time: a newer edit on the other phone still wins; a deleted one stays deleted
  const moved = local.tx.filter(t => (into.has(t.accountId) || into.has(t.toAccountId)) && !dropped.has(t.id)).map(t => ({ ...t, accountId: to(t.accountId), ...(t.toAccountId ? { toAccountId: to(t.toAccountId) } : {}) }));
  const movedBills = (local.recurring || []).filter(r => into.has(r.accountId)).map(r => ({ ...r, accountId: to(r.accountId) }));
  const have = new Set((local.kv.customCats || []).map(c => c.id));
  // Joint budgets: the newer one wins per category, and a category only one phone has budgeted is kept.
  const jb = incoming.kv.budgets?.joint, mine = local.kv.budgets?.joint;
  const [older, newest] = jb && newer(mine, jb) ? [mine, jb] : [jb, mine];
  const budgetsJoint = jb && { ...newest, byCat: { ...(older?.byCat || {}), ...(newest?.byCat || {}) } };
  const bills = new Map((local.recurring || []).map(r => [r.id, r]));
  const recurring = [...(incoming.recurring || []).map(remap).filter(r => alive(r) && ids.has(r.accountId) && !personal.has(bills.get(r.id)?.accountId) && newer(bills.get(r.id), r)), ...movedBills];   // a personal bill is never overwritten
  // A joint account the partner deleted goes once no row or bill from the file uses it, and its bills here go with it.
  const uses = id => t => t.accountId === id || t.toAccountId === id;
  const dropAccounts = local.accounts.filter(a => jointHere.has(a.id) && goneThere(a) && !into.has(a.id) && !local.tx.some(t => !dropped.has(t.id) && uses(a.id)(t)) && !tx.some(uses(a.id)) && !recurring.some(uses(a.id))).map(a => a.id);
  const dropBills = (local.recurring || []).filter(r => jointHere.has(r.accountId) && (goneThere(r) || dropAccounts.includes(r.accountId))).map(r => r.id);
  return {
    accounts: joint.filter(a => newer(acc.get(a.id), a)), tx: [...tx, ...moved], drop, gone, empty, dropBills, dropAccounts, recurring,
    customCats: (incoming.kv.customCats || []).filter(c => !have.has(c.id)),
    ...(budgetsJoint && JSON.stringify(budgetsJoint) !== JSON.stringify(mine) ? { budgetsJoint } : {}),
  };
}

/** A JPEG or PNG file's first bytes → {type, w, h}, or null for anything else: the pixel size is known before decoding. */
export function imageInfo(b) {
  if (b.length >= 24 && String.fromCharCode(...b.subarray(0, 4), ...b.subarray(12, 16)) === '\x89PNGIHDR') {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), w = dv.getUint32(16), h = dv.getUint32(20);
    return w && h ? { type: 'image/png', w, h } : null;
  }
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  for (let i = 2; i + 9 < b.length;) { // JPEG: walk the segments to the frame header (SOFn)
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { const h = (b[i + 5] << 8) | b[i + 6], w = (b[i + 7] << 8) | b[i + 8]; return w && h ? { type: 'image/jpeg', w, h } : null; }
    if (m === 0xd9 || m === 0xda) return null;
    i += m === 0x01 || (m >= 0xd0 && m <= 0xd8) ? 2 : 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return null;
}

// ---- browser-only helpers ---------------------------------------------------------------------------
// ---- zip (write) ---------------------------------------------------------------------------------------------------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export const crc32 = d => { let c = ~0; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8); return ~c >>> 0; };
/** [{name, data: Uint8Array}] → a zip Blob, stored without compression (receipt photos are JPEG already). */
export function zipStore(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let off = 0;
  for (const f of files.slice(0, 65000)) {
    const name = enc.encode(f.name), n = f.data.length, crc = crc32(f.data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint32(14, crc, true); h.setUint32(18, n, true); h.setUint32(22, n, true); h.setUint16(26, name.length, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint32(16, crc, true); c.setUint32(20, n, true); c.setUint32(24, n, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    parts.push(h, name, f.data); central.push(c, name);
    off += 30 + name.length + n;
  }
  const size = central.reduce((s, x) => s + x.byteLength, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, central.length / 2, true); e.setUint16(10, central.length / 2, true); e.setUint32(12, size, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, e], { type: 'application/zip' });
}
export const BACKUP_JSON = 'tally-backup.json';

// ---- password-protected backups ------------------------------------------------------------------------------------
// The backup file (JSON or zip) sealed with AES-GCM under a key from the password (PBKDF2-SHA256, 600 000 rounds, random
// salt and IV). Without the password nobody can open it, Tally included: there is no reset.
const ENC_ITER = 600000;   // PBKDF2-SHA-256 (OWASP 2023); files made with 310,000 still open
const toB64 = u => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const sealKey = async (password, salt, iter, use) => crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter },
  await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']), { name: 'AES-GCM', length: 256 }, false, [use]);
export const isSealed = text => /^\s*\{\s*"tally"\s*:\s*"sealed"/.test(text);
/** Backup bytes → the sealed file's text. */
export async function sealBackup(bytes, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sealKey(password, salt, ENC_ITER, 'encrypt'), bytes));
  return JSON.stringify({ tally: 'sealed', v: 1, kdf: 'PBKDF2-SHA256', iter: ENC_ITER, salt: toB64(salt), iv: toB64(iv), data: toB64(data) });
}
/** The sealed file's text + password → the backup bytes; a wrong password (or a changed file) throws. */
export async function openBackup(text, password) {
  const o = JSON.parse(text);
  if (o.v !== 1 || !(o.iter >= 100000 && o.iter <= 2e6)) throw new Error('This protected backup was made by a newer Tally. Update Tally and try again.');
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(o.iv) }, await sealKey(password, fromB64(o.salt), o.iter, 'decrypt'), fromB64(o.data))); }
  catch { throw new Error('Wrong password, or the file was changed.'); }
}
/** A receipt photo's file name that sorts by date and says what it was: "2026-09-29 Good Timing RM4.50.jpg".
 *  `dir` puts it in a folder of the zip; `taken` keeps every path in one zip different. */
export function receiptName(tx, taken = new Set(), dir = '') {
  const clean = s => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const base = `${clean(dir) ? `${clean(dir)}/` : ''}${tx.date} ${clean(tx.merchant).slice(0, 40) || 'Receipt'} RM${(tx.amount / 100).toFixed(2)}`;
  let name = `${base}.jpg`;
  for (let n = 2; taken.has(name); n++) name = `${base} (${n}).jpg`;
  taken.add(name);
  return name;
}

export function download(name, text, type = 'text/plain') {
  if (isNative) return saveFile(name, new Blob([text], { type }), type);   // resolves only after the phone's Save as screen saves or cancels
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export async function shareFile(name, text, type = 'application/json') {
  const file = new File([text], name, { type });
  if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: name }); return true; }
  return false;
}
