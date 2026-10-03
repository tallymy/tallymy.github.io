// Pure money logic: no DOM, no storage. Every amount is integer sen (RM 1.00 = 100).

// The most used categories take the Okabe–Ito colours: still told apart with red-green colour blindness.
export const CATEGORIES = [
  { id: 'groceries', name: 'Groceries', color: '#009E73' },
  { id: 'dining', name: 'Dining', color: '#E69F00' },
  { id: 'transport', name: 'Transport', color: '#0072B2' },
  { id: 'bills', name: 'Bills', color: '#56B4E9' },
  { id: 'housing', name: 'Rent & housing', color: '#6D28D9' },
  { id: 'loans', name: 'Loans', color: '#B91C1C' },
  { id: 'insurance', name: 'Insurance & takaful', color: '#65A30D' },
  { id: 'household', name: 'Household', color: '#A16207' },
  { id: 'health', name: 'Health', color: '#CC79A7' },
  { id: 'personal', name: 'Personal care', color: '#EC4899' },
  { id: 'kids', name: 'Kids', color: '#DDCC77' },
  { id: 'electronics', name: 'Electronics', color: '#0D9488' },
  { id: 'shopping', name: 'Shopping', color: '#D55E00' },
  { id: 'fun', name: 'Entertainment', color: '#882255' },
  { id: 'education', name: 'Education', color: '#332288' },
  { id: 'giving', name: 'Zakat & giving', color: '#999933' },
  { id: 'other', name: 'Other', color: '#64748B' },
];
/** Colours for categories the user adds, none close to a built-in one; the first not yet used is taken. */
export const CUSTOM_COLORS = ['#22C55E', '#FB7185', '#C084FC', '#0369A1', '#EAB308', '#A3E635', '#78716C', '#F87171', '#2DD4BF', '#9A3412'];
export const nextColor = (used = []) => { const u = new Set(used.map(c => String(c).toLowerCase())); return CUSTOM_COLORS.find(c => !u.has(c.toLowerCase())) || CUSTOM_COLORS[u.size % CUSTOM_COLORS.length]; };
/** Subcategories (a module, off by default): the ones Tally suggests per category, in English and translated on screen,
 *  then the user's own (kv 'subcats': {category: [name]}). A subcategory is only a name on the entry (tx.sub). */
export const SUBS = {
  groceries: ['Fresh food', 'Dry goods', 'Snacks', 'Drinks'], dining: ['Kopitiam', 'Mamak', 'Delivery', 'Café', 'Fast food'],
  transport: ['Petrol', 'Toll', 'Parking', 'E-hailing', 'Public transport'], bills: ['Electricity', 'Water', 'Internet', 'Phone'],
  housing: ['Rent', 'Repairs'], health: ['Clinic', 'Pharmacy', 'Dental'], personal: ['Haircut', 'Skincare'], kids: ['School', 'Childcare', 'Toys'],
  shopping: ['Clothes', 'Online', 'Gifts'], fun: ['Movies', 'Sports', 'Travel'], education: ['Courses', 'Books'], giving: ['Zakat', 'Donations'],
};
export const subsOf = (c, own = {}) => [...new Set([...(SUBS[c] || []), ...(own?.[c] || [])])];
// A subcategory guessed from the shop's name and the items, per category, cautious: a wrong guess is worse than none.
// Groceries has none on purpose (one trip is fresh food, snacks and drinks at once).
const SUB_RULES = {
  dining: [[/grab ?food|food ?panda|shopee ?food|deliveroo|airasia food|mcdelivery|beep delivery/i, 'Delivery'],
    [/\b(kfc|mc ?donald'?s?|mcd|texas chick|marry ?brown|burger king|pizza hut|domino'?s|a&w|subway|kenny rogers|wendy'?s|4 ?fingers|popeyes|jollibee|nando'?s|sushi king)\b/i, 'Fast food'],
    [/kopitiam|kedai kopi|old ?town|kopi ?saigon|uncle don|hainan|kluang (station|rail)/i, 'Kopitiam'],
    [/mamak|nasi kandar|pelita|line clear|syed bistro/i, 'Mamak'],
    [/starbucks|\bzus\b|luckin|coffee bean|kenangan|gigi coffee|tim hortons|\bcaf(?:e\b|é)|coffee/i, 'Café']],
  transport: [[/petronas|\bshell\b|caltex|petron|\bbhp\b|ron ?9[57]|petrol|diesel|primax|v-?power/i, 'Petrol'],
    [/\bplus\b|\btolls?\b|\btol\b|lebuhraya|smart ?tag/i, 'Toll'], [/parking|parkir|letak kereta|flexi ?parking|parkeasy/i, 'Parking'],
    [/\bgrab\b(?! ?(food|mart|express))|airasia ride|maxim|indrive|e-?hailing/i, 'E-hailing'], [/rapid ?kl|\b(lrt|mrt|ktm|ets)\b|monorail|komuter/i, 'Public transport']],
  bills: [[/\btnb\b|tenaga nasional|my ?tnb|\bsesb\b|sesco/i, 'Electricity'], [/air selangor|indah water|syabas|ranhill|\bpba\b|\bsaj\b|\blaku\b/i, 'Water'],
    [/unifi|time ?fibre|maxis ?fibre|celcom ?home|broadband|internet/i, 'Internet'], [/celcom|\bdigi\b|maxis|u ?mobile|yes ?4g|tune ?talk|hotlink|\bxox\b|redone|prepaid|postpaid/i, 'Phone']],
  health: [[/watsons|guardian|caring pharmacy|alpro|big ?pharmacy|aa pharmacy|farmasi|pharmacy/i, 'Pharmacy'], [/pergigian|dental|dentist/i, 'Dental'], [/klinik|clinic|medical cent/i, 'Clinic']],
  personal: [[/barber|salon|gunting rambut|haircut/i, 'Haircut']],
  housing: [[/\bsewa\b|\brent(al)?\b/i, 'Rent']],
  fun: [[/\bgsc\b|golden screen|\btgv\b|\bmbo\b|cinema|wayang|\blfs\b/i, 'Movies'], [/airasia(?! (food|ride))|malaysia airlines|batik air|firefly|\bhotel\b|agoda|booking\.com|airbnb|trip\.com/i, 'Travel']],
  shopping: [[/shopee(?! ?(food|pay))|lazada|zalora|taobao|tiktok shop|\btemu\b|shein/i, 'Online'], [/uniqlo|h&m|\bzara\b|padini|brands outlet|cotton on/i, 'Clothes']],
  giving: [[/zakat|\bpzs\b|maiwp/i, 'Zakat'], [/derma|donation|tabung|wakaf|sumbangan/i, 'Donations']],
  education: [[/kinokuniya|popular book|\bmph\b|book ?xcess|bookstore/i, 'Books'], [/kursus|tuition|udemy|coursera/i, 'Courses']],
};
const ITEM_SAYS = { Petrol: /ron ?9[57]|diesel|primax|v-?power|\bpetrol\b/i, Mamak: /nasi kandar/i };
/** An entry's subcategory, guessed: the one you gave this shop before (learned: {shopKey: [category, sub]}), else a rule on
 *  the shop's name and its items, else none (''). */
export function subFor(category, merchant = '', items = [], learned = {}) {
  const k = shopWord(merchant || ''), was = k && Object.hasOwn(learned || {}, k) ? learned[k] : null;
  if (was?.[0] === category) return was[1];
  // The shop's name decides; an item only where the item says it (RON95 is petrol, nasi kandar is mamak): a kopi or a
  // "Hainan chicken rice" on the bill doesn't make the place a kopitiam (owner's bench: 3 bistros were).
  const names = items.slice(0, 12).map(i => i.name).filter(Boolean).join(' ');
  for (const [re, sub] of SUB_RULES[category] || []) if (re.test(merchant || '') || (ITEM_SAYS[sub]?.test(names))) return sub;
  return '';
}
/** What saving an entry teaches: its shop's subcategory (or forgets it when cleared). → the new learned map, or null. */
export function learnSub(learned = {}, tx) {
  const k = tx.merchant && shopWord(tx.merchant); if (!k || tx.type === 'transfer') return null;
  const was = Object.hasOwn(learned, k) ? learned[k] : null;
  if (tx.sub && !(was?.[0] === tx.category && was[1] === tx.sub)) return Object.fromEntries([...Object.entries(learned).filter(([x]) => x !== k), [k, [tx.category, tx.sub]]].slice(-1000));
  if (!tx.sub && was?.[0] === tx.category) { const { [k]: _, ...rest } = learned; return rest; }
  return null;
}
/** A category's spending in a month split by subcategory: [{sub ('' = none), v}], most first. Receipt items count with
 *  their entry's subcategory. */
export function subSplit(txs, c, ym, sd = 1) {
  const by = new Map();
  for (const t of txs) {
    if (t.type !== 'expense' || cycleKey(t.date, sd) !== ym) continue;
    const v = itemAmounts(t).filter(i => i.category === c).reduce((s, i) => s + i.cents, 0);
    if (v) by.set(t.sub || '', (by.get(t.sub || '') || 0) + v);
  }
  return [...by].map(([sub, v]) => ({ sub, v })).sort((a, b) => b.v - a.v);
}
export const INCOME_CATEGORIES = [
  { id: 'salary', name: 'Salary', color: '#059669' },
  { id: 'allowance', name: 'Allowance', color: '#10B981' },
  { id: 'family', name: 'From family', color: '#6EE7B7' },
  { id: 'refund', name: 'Refund', color: '#A7F3D0' },
  { id: 'income', name: 'Other income', color: '#34D399' },   // stays last: custom income categories go before it
];
/** Money back for something bought: money in, but it lowers spending in the category it returns to (`cat`), not income. */
export const isRefund = t => t.type === 'income' && t.category === 'refund';
/** Which income category text reads as: pay, an allowance or scholarship, money from family, else other income. */
export const incomeCategory = s => (/salary|gaji|payroll|paycheck|wage|工资|工資|薪/i.test(s) ? 'salary'
  : /elaun|allowance|ptptn|biasiswa|scholarship|bursary|zakat pendidikan|津贴|津貼|奖学金|獎學金/i.test(s) ? 'allowance'
  : /duit (mak|emak|ibu|ayah|abah|bapa|papa|mama)|(from|dari) (mum|mom|mother|dad|father|parents|family|keluarga|mak|ayah|abah|ibu)|家用|爸|妈|媽/i.test(s) ? 'family' : 'income');
export const ACCOUNT_KINDS = ['cash', 'bank', 'ewallet', 'card', 'savings'];
/** A split bill's money lent and owed sits in two accounts of their own, moved there by transfers: never spending or
 *  income, so no month changes. 'owedme' is a claim (its balance counts), 'iowe' a debt (negative). Made on first use. */
export const OWING_KINDS = ['owedme', 'iowe'];
export const owing = a => OWING_KINDS.includes(a?.kind);
export const MAX_SEN = 100_000_000_00; // RM 100 million: anything bigger is a typo or an attack

// ---- amounts ---------------------------------------------------------------------------
/** "RM 1,234.50" → 123450. Accepts "12", "12.5", "12,50", "RM12.90", "-3.00". null if not a sane amount. */
export function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v * 100) <= MAX_SEN ? Math.round(v * 100) : null;
  let s = String(v ?? '').normalize('NFKC').trim().replace(/^RM\s*/i, '').replace(/\s+/g, '');   // full-width １２．５０ too
  // Banks write the sign either side ("60.00-", "3,520.40+") or as DR / CR.
  const dr = /DR$/i.test(s), neg = dr || /^-|-$|^\(.*\)$/.test(s);
  s = s.replace(/(DR|CR)$/i, '').replace(/^[-+(]|[-+)]$/g, '').replace(/^RM/i, '');
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$|^\.\d{1,2}$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  const sen = (+w || 0) * 100 + +(f + '00').slice(0, 2);
  if (sen > MAX_SEN) return null;
  return neg ? -sen : sen;
}
/**
 * A sum typed into an amount field: "12.50+8*2" → 2850, "100/3" → 3333 (to the sen). Numbers, + - * / × ÷ − and
 * brackets only, read by a tiny recursive-descent parser (never eval). A plain amount goes through parseAmount.
 * null if it isn't a sum, divides by zero or is out of range.
 */
export function calcAmount(v) {
  if (typeof v === 'string') v = v.normalize('NFKC');   // ＋ × from a Chinese keyboard
  const plain = /\+\s*$/.test(String(v)) ? null : parseAmount(v);   // typing "12+" is a sum not finished yet, not a bank's +12
  if (plain != null || typeof v === 'number') return plain;
  const s = String(v ?? '').replace(/^\s*RM/i, '').replace(/[×xX]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-').replace(/\s+/g, '');
  if (!/^[\d.+\-*/()]{1,100}$/.test(s) || !/\d[^\d.]|[^\d.]\d/.test(s)) return null;
  let i = 0;
  const num = () => { const m = s.slice(i).match(/^\d+(\.\d*)?|^\.\d+/); if (!m) throw 0; i += m[0].length; return +m[0]; };
  const atom = () => {
    if (s[i] === '-') { i++; return -atom(); }
    if (s[i] === '+') { i++; return atom(); }
    if (s[i] === '(') { i++; const v = sum(); if (s[i++] !== ')') throw 0; return v; }
    return num();
  };
  const prod = () => { let v = atom(); while (s[i] === '*' || s[i] === '/') { const op = s[i++], b = atom(); if (op === '/' && !b) throw 0; v = op === '*' ? v * b : v / b; } return v; };
  const sum = () => { let v = prod(); while (s[i] === '+' || s[i] === '-') { const op = s[i++], b = prod(); v = op === '+' ? v + b : v - b; } return v; };
  try {
    const v = sum();
    if (i !== s.length || !Number.isFinite(v) || Math.abs(v * 100) > MAX_SEN) return null;
    return Math.round(Math.round(v * 1e6) / 1e4);   // 0.1+0.2 → 30 sen, not 30.000000000000004
  } catch { return null; }
}
/** 123450 → "RM 1,234.50" ("−RM 3.00" for negatives). */
export function fmtRM(sen, { plain = false } = {}) {
  if (sen == null || !Number.isFinite(sen)) return '–';
  const a = Math.abs(Math.round(sen));
  const s = `${Math.floor(a / 100).toLocaleString('en-MY')}.${String(a % 100).padStart(2, '0')}`;
  return (sen < 0 ? '−' : '') + (plain ? s : 'RM ' + s)   // never split "RM" from its figure;
}
/** A typed number over RM 100 million (MAX_SEN): the field says "too large", not "enter an amount". */
export const tooLarge = v => calcAmount(v) == null && (String(v ?? '').match(/\d[\d,]*(\.\d+)?/g) || []).some(n => parseFloat(n.replace(/,/g, '')) * 100 > MAX_SEN);
/** An account kept in another currency (an SGD bank for someone who works in Singapore). Its amounts are in that currency. */
export const isFx = a => !!a?.currency && a.currency !== 'MYR';
/** Where a new currency account's rate starts; the user's own rate, or the one a transfer between the two got, replaces it.
 *  ponytail: fixed starting points, not live rates (no server); add a rate feed only if people ask. */
export const FX_START = { SGD: 3.3, USD: 4.2, EUR: 4.9, GBP: 5.6, AUD: 2.8, BND: 3.3, HKD: 0.54, CNY: 0.59, THB: 0.13, IDR: 0.00026, JPY: 0.029 };
/** RM for 1 unit of the account's currency (1 for RM accounts; 0 when unknown). */
export const rateOf = a => (isFx(a) ? +a.rate || FX_START[a.currency] || 0 : 1);
/** Accounts left out of the RM total: a bank not in Tally, or a currency with no rate. */
export const offTotal = a => !!a?.outside || !rateOf(a);
/** An account's balance in its own currency: "SGD 1,234.50" for one kept in another currency. */
export const fmtAcct = (a, sen) => (a?.currency && a.currency !== 'MYR' ? `${a.currency} ${fmtRM(sen, { plain: true })}` : fmtRM(sen));

// ---- dates -------------------------------------------------------------------------------
export const monthOf = iso => iso.slice(0, 7);
export const daysInMonth = ym => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
export function addMonths(ym, n) {   // string arithmetic: payday months run this for every row
  const m = +ym.slice(5, 7) - 1 + n, y = +ym.slice(0, 4) + Math.floor(m / 12);
  return `${String(y).padStart(4, '0')}-${pad2(m - Math.floor(m / 12) * 12 + 1)}`;
}
export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Order of two ISO dates (or 'HH:MM' times): plain string order, many times faster than localeCompare. */
export const byDate = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
/** Should the entry sheet remind that this entry may already be inside a balance typed a few days ago? A balance typed
 *  within the last 3 days counts everything dated on or after that day as spent after it: something paid earlier but logged
 *  with today's date would come off twice. Only for an account whose balance was typed (not an app's history). */
export function lateTypedHint(account, date, today) {
  if (!account || !account.typed || !(account.createdAt > 0) || account.outside || owing(account)) return false;
  const d = new Date(account.createdAt), made = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const day = made < today ? made : today;   // an account can't be made later than today (a clock that moved back)
  return date >= day && daysBetween(day, today) <= 3;
}
const pad2 = n => String(n).padStart(2, '0');
/**
 * The budget month holding `iso` when months start on `startDay` (1–28, a payday): {start, end, key}. key is the
 * 'YYYY-MM' the cycle starts in, so addMonths still steps through cycles. startDay 1 is the calendar month.
 */
export function cycleOf(iso, startDay = 1) {
  const key = cycleKey(iso, startDay), next = addMonths(key, 1);
  return { key, start: `${key}-${pad2(startOf(key, startDay))}`, end: addDays(`${next}-${pad2(startOf(next, startDay))}`, -1) };
}
/** The day a payday month starts in `ym`: 1–28, or counted from the month's end (-1 the last day, -2 the second-last). */
export const startOf = (ym, sd = 1) => (sd < 0 ? daysInMonth(ym) + Math.max(-3, Math.trunc(sd)) + 1 : Math.min(28, Math.max(1, Math.trunc(sd) || 1)));
export const cycleKey = (iso, sd = 1) => (+iso.slice(8, 10) >= startOf(iso.slice(0, 7), sd) ? iso.slice(0, 7) : addMonths(iso.slice(0, 7), -1));
/** The cycle a key names: cycleSpan('2026-09', 25) → 25 Sep to 24 Oct; cycleSpan('2026-09', -2) → 29 Sep to 29 Oct. */
export const cycleSpan = (key, sd = 1) => cycleOf(`${key}-${pad2(startOf(key, sd))}`, sd);
export const validIso = s => /^(19[89]\d|20\d\d)-\d{2}-\d{2}$/.test(String(s)) &&   // 1990–2099: a year typed as "26" (0026) is a slip
  !isNaN(Date.parse(s)) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

// ---- categorizing ----------------------------------------------------------------------------
/** fn(text) worked out once per text: the same shop and item names come back on every screen. */
const once = fn => { const m = new Map(); return s => { let v = m.get(s); if (v === undefined) { if (m.size > 20000) m.clear(); m.set(s, v = fn(s)); } return v; }; };
/** Key for remembering an item: "KS SNRS 2PK " → "KS SNRS 2PK". Pure codes and prices are dropped. */
export const itemKey = once(name => String(name ?? '').toUpperCase().replace(/\b\d{5,}\b/g, '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60));
/** Item names the user fixed on a receipt ({name, raw: as read}) → the updated reading→name map, or null if nothing
 *  changed. A name put back to what was read forgets it. The newest 2000 are kept. */
export function learnNames(map = {}, items = []) {
  const m = { ...map }; let changed = false;
  for (const { name = '', raw = '' } of items) {
    const k = itemKey(raw), v = name.trim().slice(0, 80); if (!k) continue;
    if (v && v !== raw) { if (m[k] !== v) { delete m[k]; m[k] = v; changed = true; } }   // re-added: newest last
    else if (Object.hasOwn(m, k)) { delete m[k]; changed = true; }
  }
  return changed ? Object.fromEntries(Object.entries(m).slice(-2000)) : null;
}

// Malaysian shop words in English, Malay and Chinese, most specific first (奶粉 is Kids, not a 粉 noodle).
// ponytail: keyword list; user corrections become rules.
const WORDS = [
  // Named by what they are, before "rice" or "egg" make a meal groceries, or "Penang" looks like a pen.
  // Spices, seasoning mixes, stock cubes and cooking oil are shopping for the kitchen, even when named after a dish.
  ['groceries', /\b(rempah|serbuk|perencah|kiub|stock cube|minyak (masak|goreng)|cooking oil)\b/i],
  // Cooked dishes, named by how they're cooked, before their ingredients make them groceries (PriceCatcher's cooked food).
  ['dining', /\bgoreng\b|masak (merah|kicap|halia|kari|lemak|paprik)|\b(sup|soup)\b(?! (bunjut|adabi|cube|kiub))|\bpau\b|murtabak|roti (tisu|boom|bom|bakar|pisang|bawang|jala)|telur (dadar|bistik|rebus|setengah masak|mata)|tandoori|udang butter|butter chicken|sos lemon|sayur campur|\bkuih\b|rojak|vadai|kue?tiau|hailam|\bbandung\b|ladna|kung ?fu|\b(sarapan|breakfast|brunch|lunch|dinner|supper)\b|makan (pagi|tengah ?hari|malam)|早餐|午餐|晚餐|宵夜|economy rice|mixed rice|chap ?fan|杂饭|雜飯|经济饭|經濟飯|nasi campur|roti (telur|canai|kosong|bom|jala|tissue)|char kue?y teow|fried rice|nasi (goreng|lemak|kandar|ayam|kerabu|dagang|briyani|biryani)|(chicken|lamb|fish|pork) chop|tom ?yam|mee (goreng|kari|curry|rebus|hailam|bandung|sup)|kue?y ?teow|iced? (lemon|tea|coffee|milo|latte)|lemon tea|telur mata|teh (tarik|o|ais|c|halia)\b|kopi (o|c|ais|peng)\b|\bslice\b|set meal|炒饭|炒飯|面线|鸡饭|雞飯/i],
  ['giving', /zakat|fitrah|sedekah|derma\b|donation|sumbangan|infaq|infak|wakaf|charity|tabung masjid|捐款|捐赠|捐獻|香油钱/i],   // zakat is an LHDN rebate: kept apart from Other
  ['transport', /^ minyak $|柴油|油钱|油錢|油费|汽油|加油|油站|打油|minyak (motor|kereta|moto)|isi minyak|\bbrt\b|rapid ?(kl|penang|kuantan|bus)|巴士|公交|\bbas\b|\bbus\b|\blrt\b|\bmrt\b/i],
  ['education', /fotostat|photo ?copy|cetak nota|复印|複印/i],
  ['groceries', /\bgrocer(y|ies)\b|barang dapur|面粉|麵粉|面包|麵包|吐司/i],   // flour and bread before the dining noodles (面) and rice noodles (粉)
  // Car upkeep first: "minyak enjin" is not cooking oil, "bateri kereta" not a household battery. Not "filter" or "upah" alone.
  ['transport', /minyak enjin|engine oil|filter minyak|oil filter|\btayar\b|\btyres?\b|\btires?\b|puncture|wiper|bateri kereta|car battery|servis kereta|car service|bengkel|workshop|spark ?plug|\bbrek\b|\bbrakes?\b|absorber|alignment|road ?tax|cukai jalan|insurans kereta|car insurance/i],
  ['housing', /(house|room|home|condo|apartment|rumah|bilik) ?rent(al)?\b|\brent(al)? (rumah|bilik|house|room)|^ *(rent|sewa) *$|sewa (rumah|bilik)|maintenance fee|yuran penyelenggaraan|management fee|service charge|cukai (pintu|tanah)|quit ?rent|assessment|(housing|home) loan|pinjaman perumahan|mortgage|房租|租金|管理费|管理費|房贷|房貸/i],
  ['loans', /ptptn|car loan|pinjaman (kereta|peribadi)|personal loan|\bloan\b|pinjaman|ansuran|instal+ments?\b|hire purchase|paylater|pay later|\bbnpl\b|\batome\b|贷款|貸款|分期/i],
  ['insurance', /insurance|insurans|takaful|prudential|great eastern|\baia\b|allianz|etiqa|zurich|tokio marine|manulife|保险|保險/i],
  ['bills', /air selangor|air kelantan|syabas|indah water|ranhill|\bsaj\b|\bpba\b water|\brent(al)?\b|\bsewa\b|prepaid|hotlink|xpax|\btopup\b|reload (kredit|credit|phone|telefon)/i],
  ['kids', /diaper|petpet|huggies|anmum|sustagen|cerelac|enfagrow|lactogen|dumex|\bnan pro\b|lampin|pampers|mamypoko|drypers|susu formula|formula|baby|bayi|toy|mainan|crayon|school|sekolah|尿布|奶粉|玩具|婴儿|嬰兒/i],
  ['health', /panadol|claritin|(?<!ber)vitamin|ubat(?! gigi)|minyak angin|fisherman|medicine|medical|doctor|doktor|dental|dentist|clinic|klinik|pharmacy|farmasi|mask|plaster|antiseptic|dettol|strepsils|zyrtec|hospital|药|藥|维他命|維他命|口罩|诊所|診所/i],
  ['personal', /shampoo|deodoran|nivea|rexona|listerine|ubat gigi|syampu|toothpaste|ubat gigi|colgate|darlie|lotion|deodorant|razor|pisau cukur|sunblock|facial|cleanser|conditioner|sanitary|tuala wanita|kotex|laurier|haircut|gunting rambut|洗发|洗髮|牙膏|沐浴/i],
  ['dining', /nasi|mee |mee$|mi goreng|roti canai|teh |kopi|coffee|latte|milo ais|ais |burger|pizza|chicken rice|laksa|satay|restoran|restaurant|caf[eé]|kafe|food|makan|drink|minum|set meal|\bmeals?\b|kfc|mcd|mamak|饭|面|粉|咖啡|茶|奶茶|套餐|饮料|點心|点心|包子|炒/i],
  ['groceries', /beras|serbuk|kacang|\bcili\b|\boren\b|kelapa|kubis|krimer|santan|kunyit|\blada\b|marjerin|\bcola\b|\bsoya\b|rempah|kurma|\bsawi\b|capsicum|benggala|\blimau\b|\bepal\b|tembikai|\bdal\b|kordial|lobak|anggur|jambu|tomato|bawang|halia|cendawan|terung|timun|bayam|kangkung|jintan|\bbihun\b|rice|telur|egg|susu|milk|roti|bread|gardenia|gula|sugar|minyak|oil|ayam|chicken|ikan|fish|udang|prawn|sotong|squid|ketam|crab|kerang|daging|beef|kambing|mutton|lamb|sayur|vege|buah|fruit|garam|salt|tepung|flour|kicap|sos |sauce|mineral|air |water|biskut|biscuit|mentega|butter|cheese|yogurt|noodle|maggi|milo|nescafe|tea|bawang|onion|tomato|kentang|potato|米|蛋|鸡|雞|鱼|魚|肉|菜|水果|糖|油|盐|鹽|面包|麵包|牛奶|豆腐|酱|醬|虾|蝦|苹果|蘋果|葱|蔥|姜|薑|榴莲|榴槤|蒜|辣椒|瓜|豆芽|豆|芽|番茄|萝卜|蘿蔔|薯|芋|香蕉|橙|木瓜|西瓜|包菜|芥兰|芥蘭|白菜|菠菜|蘑菇|菇|蛤|蚬|蜆|螃蟹|蟹|鱿鱼|魷魚|江鱼仔|江魚仔|咸鱼|鹹魚|排骨|猪|豬|牛|羊|鸭|鴨|米粉|粿条|粿條|面条|麵條/i],
  ['household', /sabun|soap|detergent|tissue|tisu|bleach|sponge|mop|broom|penyapu|plastic|beg |bag|towel|tuala|bateri|battery|mentol|bulb|span|kitchen|dapur|pinggan|cawan|cup|peg|hanger|clorox|dynamo|downy|breeze|glad|ziploc|纸巾|紙巾|洗衣|清洁|清潔|垃圾袋|电池|電池|毛巾/i],
  ['transport', /petrol|ron ?9[57]|v-?power|diesel|primax|parking|letak kereta|toll|\btol\b|grab|touch ?n ?go|lrt|mrt|bus|teksi|taxi|fuel|汽油|停车|停車|过路费/i],
  ['bills', /tnb|electric|elektrik|syabas|air selangor|water bill|unifi|maxis|celcom|\bdigi\b|umobile|internet|astro|电费|電費|水费|水費/i],
  ['electronics', /\b(hand)?phone\b|telefon|iphone|ipad|samsung|xiaomi|redmi|huawei|oppo|vivo|realme|honor|charger|pengecas|\bcable\b|kabel|earphone|earbud|headphone|headset|airpods|power ?bank|laptop|notebook|macbook|\bmonitor\b|keyboard|\bmouse\b|printer|cartridge|sd card|memory card|pendrive|thumb ?drive|\busb\b|hdmi|speaker|\btv\b|television|smart ?watch|camera|console|playstation|\bps5\b|nintendo|electronic|elektronik|gadget|手机|手機|充电|耳机|耳機|电脑|電腦|平板/i],
  ['education', /book|buku|pen |pencil|pensel|stationery|stationer|alat tulis|tuition|tuisyen|yuran|\b(school|tuition|course|exam|class|kelas|registration) fees?\b|书|書|文具|补习|補習/i],
  ['fun', /cinema|wayang|gsc|tgv|netflix|spotify|game|karaoke|bowling|concert|电影|電影/i],
];
const SHOPS = [
  ['groceries', /\bkk ?(super ?)?mart\b/i],   // a convenience store, not "mart" shopping
  ['transport', /^grab$|\bgrab ?(car|taxi|bike|ride|express|share)\b/i],   // a Grab ride: fare and fees are transport (GrabFood stays a meal)
  ['dining', /restoran|restaurant|kedai makan|caf[eé]|kafe|kopitiam|bakery|mamak|food court|medan selera|kfc|mcdonald|pizza|starbucks|tealive|zus|餐厅|餐廳|茶室|饭店|飯店|咖啡店/i],
  ['transport', /petronas|shell|petromart|caltex|bhpetrol|petron/i],
  ['shopping', /shopee|lazada|zalora|tiktok ?shop|uniqlo|padini|vincci|h&m|\bzara\b|cotton on/i],
  ['education', /popular|bookshop|bookstore|kedai buku|mph|kinokuniya|stationery|stationer/i],
  ['health', /guardian|watsons|farmasi|pharmacy|caring|big pharmacy|klinik|clinic|药房|藥房/i],
  ['household', /mr\.? ?d\.?i\.?y|daiso|ikea|eco-?shop|kedai perkakasan|hardware|五金/i],
  ['groceries', /speedmart|mydin|aeon|tesco|lotus|giant|jaya grocer|village grocer|econsave|nsk|hero|family ?mart|7-eleven|99 |mart|grocer|pasar|supermarket|runcit|超市|杂货|雜貨/i],
  ['kids', /toys|mothercare|anakku|baby/i],
  ['electronics', /senheng|harvey norman|courts|machines|switch|all ?it|urban republic|thunder match|\bsamsung\b|apple store|electronic|电器|電器/i],
];
// Street and place words in statement text ("PETRONAS JLN HOSPITAL KB") name where, not what: they never decide.
// "kg" after a number is a weight, not a kampung.
const PLACE = /\b(jln|jalan|lorong|lrg|taman|tmn|persiaran|lebuh(raya)?|bandar|kampung|kpg|(?<![\d.]\s?)kg)\.?\s+[\p{L}\d]+/giu;
export const unplace = once(s => String(s ?? '').replace(PLACE, ' '));
/** Category for an item: the user's own rule first, then item words, then the shop's usual category. */
/** "Only my categories" (Settings): Tally's own word lists are off; only what the user taught it (rules) files things. */
let ownOnly = false, moved = {};
export const ownCategories = on => { ownOnly = !!on; };
/** Tally's categories the user removed → where their things go now ({kids: 'household'}): no guess lands in one. */
export const movedCategories = m => { moved = m || {}; };
export const movedTo = c => (Object.hasOwn(moved, c) ? moved[c] : c);
export function categorize(name, merchant = '', rules = {}) {
  const k = itemKey(name);
  if (k && Object.hasOwn(rules, k)) return movedTo(rules[k]);
  const shop = shopCategory(merchant, rules);
  if (ownOnly) return shop;
  const n = ' ' + unplace(name) + ' ';
  for (const [c, re] of WORDS) if (re.test(n)) return movedTo(c === 'groceries' && shop === 'dining' ? 'dining' : c); // teh at a kopitiam is a meal
  return shop;
}
export function shopCategory(merchant = '', rules = {}) {
  const mk = 'SHOP ' + itemKey(merchant);
  if (Object.hasOwn(rules, mk)) return movedTo(rules[mk]);
  if (ownOnly) return 'other';
  const m = unplace(merchant);
  for (const [c, re] of SHOPS) if (re.test(m)) return movedTo(c);
  return 'other';
}

// ---- splitting a receipt across categories ------------------------------------------------------
/** Spread `extra` sen over parts in proportion to their cents (largest remainder), so the result sums exactly. */
export function allocate(parts, extra) {
  const base = parts.reduce((s, p) => s + Math.max(0, p), 0);
  if (!extra) return parts.map(() => 0);
  if (!base) { const out = parts.map(() => 0); if (out.length) out[0] = extra; return out; }
  const raw = parts.map(p => Math.max(0, p) * extra / base);
  const out = raw.map(x => Math.trunc(x));
  let left = extra - out.reduce((s, x) => s + x, 0);
  const order = raw.map((x, i) => [Math.abs(x - Math.trunc(x)), i]).sort((a, b) => b[0] - a[0]);
  for (let j = 0; left !== 0; j++) { const i = order[j % order.length][1]; out[i] += Math.sign(left); left -= Math.sign(left); }
  return out;
}
/** Where an expense's money went: [{category, cents}] summing exactly to tx.amount. Tax, service and rounding spread by item. */
export function breakdown(tx) {
  const by = {};
  for (const { category, cents } of itemAmounts(tx)) by[category] = (by[category] || 0) + cents;
  return Object.entries(by).map(([category, cents]) => ({ category, cents }));
}
/** A receipt's items, each with its share of tax, service and rounding (summing exactly to tx.amount). No items: the payment as one. */
export function itemAmounts(tx) {
  const items = (tx.items || []).filter(i => Number.isFinite(i.cents));
  if (!items.length) return [{ name: '', category: tx.category || 'other', cents: tx.amount }];
  const add = allocate(items.map(i => i.cents), tx.amount - items.reduce((s, i) => s + i.cents, 0));
  return items.map((it, i) => ({ name: it.name, category: it.category || 'other', cents: it.cents + add[i] }));
}

// ---- balances & months -----------------------------------------------------------------------
/** Balance per account, each in its own currency, and the total in RM (other currencies at their rate; offTotal left
 *  out), optionally up to and including a date. Rows converted to RM for totals (state.js inRM) keep the account's own amount in `fx`;
 *  a transfer between currencies says what arrived in `toAmount`. */
export function balances(accounts, txs, upTo = null) {
  const by = Object.fromEntries(accounts.map(a => [a.id, a.opening || 0]));
  for (const t of txs) {
    if (upTo && t.date > upTo) continue;
    if (t.type === 'expense') by[t.accountId] = (by[t.accountId] ?? 0) - (t.fx ?? t.amount);
    else if (t.type === 'income') by[t.accountId] = (by[t.accountId] ?? 0) + (t.fx ?? t.amount);
    else if (t.type === 'transfer') { by[t.accountId] = (by[t.accountId] ?? 0) - t.amount; by[t.toAccountId] = (by[t.toAccountId] ?? 0) + (t.toAmount ?? t.amount); }
  }
  const total = accounts.filter(a => !offTotal(a)).reduce((s, a) => s + Math.round(by[a.id] * rateOf(a)), 0);
  return { by, total };
}
/**
 * What is still open per friend after split bills: owedMe (their shares, owedBy, less what they paid back, repaidBy) and
 * iOwe (my shares of bills they paid, owedTo, less what I paid back, repaidTo). → {owedMe, iOwe}: [{name, sen, from}],
 * `from`: the account that paid their oldest share not yet paid back (paid back first-in, first-out); `since`: its date.
 */
export function openShares(txs) {
  const me = new Map(), them = new Map(), got = (m, k) => m.get(k) || m.set(k, { sen: 0, shares: [] }).get(k);
  for (const x of [...txs].sort((a, b) => byDate(a.date, b.date))) {
    if (x.type === 'transfer' && x.owedBy) { const f = got(me, x.owedBy); f.sen += x.amount; f.shares.push(x); }
    else if (x.type === 'transfer' && x.repaidBy) got(me, x.repaidBy).sen -= x.amount;
    else if (x.type === 'expense' && x.owedTo) { const f = got(them, x.owedTo); f.sen += x.amount; f.shares.push(x); }
    else if (x.type === 'transfer' && x.repaidTo) got(them, x.repaidTo).sen -= x.amount;
  }
  const open = m => [...m].filter(([, f]) => f.sen > 0).map(([name, f]) => {
    let paid = f.shares.reduce((s, x) => s + x.amount, 0) - f.sen;   // what came back, set against the oldest shares first
    const oldest = f.shares.find(x => (paid -= x.amount) < 0);
    return { name, sen: f.sen, from: oldest?.accountId, since: oldest?.date };   // since: the oldest share still open
  });
  return { owedMe: open(me), iOwe: open(them) };
}
/**
 * Deleting split-bill rows (`goneIds`: a bill and its friends' shares): paybacks with those friends that would then
 * settle more than is still owed no longer settle anything. → {drop: [tx], trim: [tx with the smaller amount]},
 * newest payback first. Friends the deleted rows don't name are left as they are.
 */
export function leftOverPaybacks(txs, goneIds) {
  const gone = new Set(goneIds), left = txs.filter(x => !gone.has(x.id)), out = { drop: [], trim: [] };
  const debt = x => (x.type === 'transfer' && x.owedBy ? ['me', x.owedBy] : x.type === 'expense' && x.owedTo ? ['them', x.owedTo] : null);
  const back = x => (x.type === 'transfer' && x.repaidBy ? ['me', x.repaidBy] : x.type === 'transfer' && x.repaidTo ? ['them', x.repaidTo] : null);
  const touched = new Set(txs.filter(x => gone.has(x.id)).map(debt).filter(Boolean).map(k => k.join('\n')));
  for (const key of touched) {
    const of = f => x => f(x)?.join('\n') === key;
    let over = left.filter(of(back)).reduce((s, x) => s + x.amount, 0) - left.filter(of(debt)).reduce((s, x) => s + x.amount, 0);
    for (const x of left.filter(of(back)).sort((a, b) => byDate(b.date, a.date) || (b.createdAt || 0) - (a.createdAt || 0))) {
      if (over <= 0) break;
      if (x.amount <= over) out.drop.push(x); else out.trim.push({ ...x, amount: x.amount - over });
      over -= x.amount;
    }
  }
  return out;
}
/** A row in an account of another currency, in RM at `rate`: amount and items converted, the account's own amount kept in `fx`. */
export function toRM(x, rate) {
  const r = { ...x, amount: Math.round(x.amount * rate), fx: x.amount };
  if (x.items?.length) { r.items = x.items.map(i => ({ ...i, cents: Math.round(i.cents * rate) })); const more = allocate(r.items.map(i => i.cents), r.amount - r.items.reduce((s, i) => s + i.cents, 0)); r.items.forEach((i, n) => { i.cents += more[n]; }); }   // still adds up to the total, the difference spread by size (never a negative line)
  return r;
}
/**
 * Spending in a month (a cycle when months start on day `sd`): total and per category (receipts split by item).
 * Transfers never count. For pace: `each` lists the single everyday payments behind the total and each category,
 * `fixed` sums the bill payments (they come once a month, not every day).
 */
export const monthSpend = (txs, ym, sd = 1) => monthSpends(txs, [ym], sd)[ym];
/** monthSpend for several months in one pass over the transactions: {ym: monthSpend(txs, ym, sd)}. */
export function monthSpends(txs, yms, sd = 1) {
  const by = new Map(yms.map(ym => [ym, { total: 0, byCat: {}, each: { total: [] }, fixed: { total: 0 } }]));
  for (const t of txs) {
    const back = isRefund(t), m = (t.type === 'expense' || back) && by.get(cycleKey(t.date, sd));
    if (!m) continue;
    const { byCat, each, fixed } = m;
    if (back) { m.total -= t.amount; for (const { category, cents } of breakdown({ ...t, category: t.cat || 'other' })) byCat[category] = (byCat[category] || 0) - cents; continue; }
    const bill = isBill(t);
    m.total += t.amount; if (bill) fixed.total += t.amount; else each.total.push(t.amount);
    for (const { category, cents } of breakdown(t)) {
      byCat[category] = (byCat[category] || 0) + cents;
      if (bill) fixed[category] = (fixed[category] || 0) + cents; else (each[category] ||= []).push(cents);
    }
  }
  return Object.fromEntries(yms.map(ym => [ym, by.get(ym)]));
}
/** The n latest transactions (by date, then the last added), as a stable sort would list them, without sorting them all. */
export function newest(txs, n) {
  const later = (a, b) => byDate(b.date, a.date) || (b.createdAt - a.createdAt) || 0, top = [];
  if (!(n > 0)) return top;
  for (const x of txs) {
    if (top.length === n && later(x, top[n - 1]) >= 0) continue;
    let i = top.length;
    while (i > 0 && later(x, top[i - 1]) < 0) i--;
    top.splice(i, 0, x);
    if (top.length > n) top.pop();
  }
  return top;
}
/** A payment for a bill (added by the bill itself or with "Mark as paid"). */
/** Categories paid the same every month: never "unusual" or "down" news. */
export const FIXED_CATS = new Set(['bills', 'housing', 'loans', 'insurance']);
export const isBill = t => t.source === 'recurring' || !!t.bill;
export const monthIncome = (txs, ym, sd = 1) => monthIncomes(txs, [ym], sd)[ym];
/** Money in for several months in one pass: {ym: sen}. */
export function monthIncomes(txs, yms, sd = 1) {
  const by = new Map(yms.map(ym => [ym, 0]));
  for (const t of txs) if (t.type === 'income' && !isRefund(t)) { const k = cycleKey(t.date, sd); if (by.has(k)) by.set(k, by.get(k) + t.amount); }
  return Object.fromEntries(by);
}
export function cashFlow(txs, endYm, n = 6, sd = 1) {
  const yms = Array.from({ length: n }, (_, i) => addMonths(endYm, i - n + 1)), sp = monthSpends(txs, yms, sd), inc = monthIncomes(txs, yms, sd);
  return yms.map(ym => ({ ym, income: inc[ym], expense: sp[ym].total }));
}
/** Balance at the end of each of the last n months or cycles (today for the current one). */
export function balanceTrend(accounts, txs, today, n = 6, sd = 1) {
  const ym = cycleKey(today, sd);
  return Array.from({ length: n }, (_, i) => addMonths(ym, i - n + 1)).map(m => {
    const end = m === ym ? today : cycleSpan(m, sd).end;
    return { date: end, v: balances(accounts, txs, end).total };
  });
}

// ---- budgets -----------------------------------------------------------------------------------
/**
 * Pace of a budget this month (or cycle from `startDay`): share used, projected month-end spend, and whether it's
 * heading over. Calm by design: never "heading over" in the first 7 days, and bills (`fixed`) and any single payment
 * over 25% of the budget (rent, a phone) count in the total but not in the daily rate, so one big day can't project
 * a month of them. `amounts`: the single everyday payments behind `spent` (monthSpend().each / .fixed).
 */
export function pace(budget, spent, today, { startDay = 1, amounts = [], fixed = 0, first = '' } = {}) {
  const c = cycleOf(today, startDay), day = daysBetween(c.start, today) + 1, len = daysBetween(c.start, c.end) + 1;
  const n = first > c.start && first <= today ? daysBetween(first, today) + 1 : day;   // days of typed spending this month (`first`: firstSpend)
  const big = fixed + amounts.filter(a => oneOff(a, budget)).reduce((s, a) => s + a, 0);
  const projected = spent + Math.round((spent - big) / n * (len - day));
  return { pct: budget ? spent / budget : 0, projected, over: budget > 0 && n > 7 && projected > budget, left: budget - spent, daysLeft: len - day };
}
/** A buy too big to be everyday: RM 500+, or over a quarter of the budget. One rule for pace(), forecast() and Can I afford it? */
export const oneOff = (a, budget = 0) => a >= 500_00 || (budget > 0 && a > budget * 0.25);
/** The first day spending was typed (bills Tally posts by itself aren't typing): the everyday pace counts from here. '' when none. */
export const firstSpend = txs => txs.reduce((m, t) => (t.type === 'expense' && !isBill(t) && (!m || t.date < m) ? t.date : m), '');

// ---- duplicates --------------------------------------------------------------------------------
const shopWord = once(s => itemKey(s).split(' ').filter(w => w.length > 2 || /\p{Script=Han}/u.test(w)).slice(0, 2).join(' '));
/** An existing transaction that is probably the same purchase: same day, same amount, same shop (or no shop). */
export function findDuplicate(tx, txs) {
  return txs.find(t => t.id !== tx.id && t.type === tx.type && t.amount === tx.amount && t.date === tx.date
    && (!t.merchant || !tx.merchant || shopWord(t.merchant) === shopWord(tx.merchant))) || null;
}

// ---- insights ---------------------------------------------------------------------------------
/**
 * Plain rules over local data. Each insight: {id, kind, level ('warn'|'info'|'good'), title, body, cat?}.
 * title and body are [English template, ...values]; a value may be {cat: id}, {raw: user text}, {date: iso} or
 * {list: [[{cat}, amount]]}, so the view can translate the words around them. Ordered by importance.
 */
export function insights({ txs, budgets = {}, today, knownBills = [], startDay = 1 }) {
  const out = [], sd = startDay;
  const ym = cycleKey(today, sd), prev = addMonths(ym, -1);
  const { [ym]: now, [prev]: last } = monthSpends(txs, [ym, prev], sd), first = firstSpend(txs);
  // Pace: a budget heading over before the month ends.
  const checks = [['total', budgets.total, now.total], ...Object.entries(budgets.byCat || {}).map(([c, b]) => [c, b, now.byCat[c] || 0])];
  for (const [c, b, spent] of checks) {
    if (!b) continue;
    const p = pace(b, spent, today, { startDay: sd, amounts: now.each[c], fixed: now.fixed[c], first });
    const label = { cat: c };
    if (spent > b) out.push({ id: `over-${c}-${ym}`, kind: 'pace', level: 'warn', cat: c, title: ['{0} is over budget', label], body: ['Spent {0} of {1}.', fmtRM(spent), fmtRM(b)] });
    else if (p.over && p.pct >= 0.5) out.push({ id: `pace-${c}-${ym}`, kind: 'pace', level: 'warn', cat: c, title: ['{0} at {1}% with {2} days left', label, Math.round(p.pct * 100), p.daysLeft], body: ["At this pace you'll spend {0}, {1} over.", fmtRM(p.projected), fmtRM(p.projected - b)] });
  }
  // Unusual week: a category this week at 2x or more its usual week. "Usual" = the average over the weeks of the
  // last 12 that have any spending at all (4+ needed), so an old or stray receipt can't stretch the history.
  const weekStart = addDays(today, -6);
  const from = addDays(weekStart, -7 * 12), flex = txs.filter(t => t.type === 'expense' && !isBill(t) && t.date >= from && t.date <= today);
  const inRange = (a, b) => flex.filter(t => t.date >= a && t.date <= b);
  const active = Array.from({ length: 12 }, (_, k) => addDays(weekStart, -7 * (k + 1))).filter(s => { const e = addDays(s, 6); return flex.some(t => t.date >= s && t.date <= e); }).length;
  if (active >= 4) {
    const sum = list => { const by = {}; for (const t of list) for (const x of breakdown(t)) by[x.category] = (by[x.category] || 0) + x.cents; return by; };
    const thisWeek = sum(inRange(weekStart, today));
    const before = sum(inRange(addDays(weekStart, -7 * 12), addDays(weekStart, -1)));
    for (const [c, v] of Object.entries(thisWeek)) {
      if (FIXED_CATS.has(c)) continue;
      const avg = (before[c] || 0) / active;
      if (avg > 0 && v >= 2 * avg && v - avg >= 2000) out.push({ id: `week-${c}-${today}`, kind: 'unusual', level: 'info', cat: c, title: ['{0} this week is {1}× your usual week', { cat: c }, (v / avg).toFixed(1)], body: ['{0} vs about {1} a week.', fmtRM(v), fmtRM(Math.round(avg))] });
    }
  }
  // Item patterns: an item bought 3+ times this month, compared with last month.
  const itemsNow = {}, itemsPrev = {};
  let hadPrev = false;
  for (const t of txs) {
    if (t.type !== 'expense') continue;
    const m = cycleKey(t.date, sd), by = m === ym ? itemsNow : m === prev ? itemsPrev : null;
    if (m === prev) hadPrev = true;
    if (by) for (const it of t.items || []) {
      const k = itemKey(it.name); if (!k) continue;
      (by[k] ||= { n: 0, cents: 0, name: it.name }); by[k].n++; by[k].cents += it.cents;
    }
  }
  for (const [k, v] of Object.entries(itemsNow)) {
    if (v.n < 3 || !hadPrev) continue;
    const p = itemsPrev[k];
    const change = p?.cents ? Math.round((v.cents - p.cents) / p.cents * 100) : null;
    out.push({ id: `item-${k}-${ym}`, kind: 'item', level: 'info', title: ['You bought {0} {1}× this month ({2})', { raw: v.name }, v.n, fmtRM(v.cents)], body: change == null ? ['Not bought last month.'] : change === 0 ? ['Same as last month.'] : [change > 0 ? '{0}% more than last month.' : '{0}% less than last month.', Math.abs(change)] });
  }
  // Price changes in the last 30 days: the same item costs 10%+ more (or less) than the previous time.
  // Only each item's latest change, and the 3 most recent of those.
  const seen = {}, moved = {}, since = addDays(today, -30);
  for (const t of txs.filter(t => t.type === 'expense').sort((a, b) => byDate(a.date, b.date))) {
    for (const it of t.items || []) {
      const k = itemKey(it.name), unit = it.unit ?? it.cents;
      if (!k || !(unit > 0)) continue;
      if (seen[k] && t.date >= since && seen[k].date < t.date) {
        const ch = (unit - seen[k].unit) / seen[k].unit;
        if (Math.abs(ch) >= 0.1) moved[k] = { id: `price-${k}-${t.date}`, kind: 'price', level: ch > 0 ? 'info' : 'good', date: t.date, title: [ch > 0 ? '{0} went up {1}%' : '{0} went down {1}%', { raw: it.name }, Math.round(Math.abs(ch) * 100)], body: ['This time {0}, last time ({1}) {2}', fmtRM(unit), { date: seen[k].date }, fmtRM(seen[k].unit)] };
      }
      seen[k] = { unit, date: t.date };
    }
  }
  out.push(...Object.values(moved).sort((a, b) => byDate(b.date, a.date)).slice(0, 3));
  // Recurring: same shop and about the same amount in 3+ different months, not yet set up as a bill.
  for (const r of recurringCandidates(txs, knownBills)) out.push({ id: `rec-${r.key}`, kind: 'recurring', level: 'info', title: ['{0} looks like a monthly bill ({1})', { raw: r.merchant }, fmtRM(r.amount)], body: ['Add it to your bills to get a reminder before it is due.'], rec: r });
  // Month recap: the first 5 days of a month look back at the last one.
  if (daysBetween(cycleOf(today, sd).start, today) < 5 && last.total > 0) {
    const top = Object.entries(last.byCat).sort((a, b) => b[1] - a[1]).slice(0, 3);
    out.push({ id: `recap-${prev}`, kind: 'recap', level: 'good', title: ['Last month you spent {0}', fmtRM(last.total)], body: ['Top: {0}.', { list: top.map(([c, v]) => [{ cat: c }, fmtRM(v)]) }] });
  }
  const rank = { warn: 0, info: 1, good: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

const EVERYDAY = /\bgrab|food ?panda|shopee|lazada|makan|mamak|kopitiam|restoran|tesco|lotus|aeon|giant|mydin|speedmart|econsave|jaya grocer|family ?mart|7-?eleven|kk ?mart|supermarket|pasar|kedai runcit|petronas|shell|touch ?n ?go|\btng\b/i;
/** Shop + amount (within 5%) seen in 3+ different months. `known`: shop keys already set up as bills. */
export function recurringCandidates(txs, known = []) {
  const groups = {};
  for (const t of txs) {
    if (t.type !== 'expense' || !t.merchant) continue;
    const k = shopWord(t.merchant);
    if (k) (groups[k] ||= []).push(t);
  }
  const out = [], latest = txs.reduce((m, t) => (t.date > m ? t.date : m), '');
  const run3 = months => months.some(m => months.includes(addMonths(m, 1)) && months.includes(addMonths(m, 2)));
  for (const [k, list] of Object.entries(groups)) {
    const months = new Set(list.map(t => monthOf(t.date))).size;
    if (known.includes(k) || months < 2) continue;
    const amts = list.map(t => t.amount).sort((a, b) => a - b), mid = amts[Math.floor(amts.length / 2)];
    // Everyday places (ride-hailing, food delivery, supermarkets, online shops, "makan", or 3+ visits a month) are a bill
    // only when nearly every payment there is the same amount, about once a month (a subscription, an instalment).
    const everyday = list.length > months * 3 || EVERYDAY.test(list[0].merchant) || ['dining', 'groceries', 'shopping', 'transport'].includes(shopCategory(list[0].merchant));
    const close = list.filter(t => Math.abs(t.amount - mid) <= mid * (everyday ? 0.01 : 0.05));
    if (everyday && close.length < list.length * 0.8) continue;
    const need = everyday ? 3 : 2;
    if (months < need || new Set(close.map(t => monthOf(t.date))).size < need) continue;
    // A bill comes on about the same day each month, costs RM 20 or more, and isn't a meal or groceries.
    const days = close.map(t => +t.date.slice(8, 10)).sort((a, b) => a - b), mday = days[Math.floor(days.length / 2)];
    if (mid < 2000 || close.filter(t => Math.abs(+t.date.slice(8, 10) - mday) <= 3).length < need) continue;
    if (close.every(t => ['dining', 'groceries', 'transport'].includes(t.category) || (t.items || []).length)) continue;
    // Three months in a row, still going (seen in the last 45 days), and not an instalment that has ended ("12/12").
    const lastTx = list.reduce((a, b) => (a.date > b.date ? a : b));
    if (!run3([...new Set(close.map(t => monthOf(t.date)))]) || daysBetween(lastTx.date, latest) > 45) continue;
    const inst = `${lastTx.note || ''} ${lastTx.merchant}`.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/);
    if (inst && +inst[1] >= +inst[2] && +inst[2] > 1) continue;
    out.push({ key: k, merchant: lastTx.merchant, amount: mid, category: lastTx.category || 'bills', day: +lastTx.date.slice(8, 10), months: new Set(close.map(t => monthOf(t.date))).size });
  }
  return out;
}
export const billKey = shopWord;

/** The day an account last went below zero ('' if it isn't): its balance at the end of each day, from `txs`. */
export function belowSince(a, txs) {
  const move = {};
  for (const x of txs) {
    if (x.accountId === a.id) move[x.date] = (move[x.date] || 0) + (x.type === 'income' ? x.amount : -x.amount);
    if (x.type === 'transfer' && x.toAccountId === a.id) move[x.date] = (move[x.date] || 0) + x.amount;
  }
  let bal = a.opening || 0, since = '';
  for (const d of Object.keys(move).sort()) { bal += move[d]; since = bal < 0 ? since || d : ''; }
  return since;
}

// ---- the account a new entry starts on --------------------------------------------------------------------------
const BIG = 5000, HABIT_CATS = ['transport', 'groceries'];   // RM 50 or more, fuel and the supermarket: usually not cash
/**
 * One rule per kind, each easy to say:
 *  'bill': the main bank account (most salary paid in, else the bank used most). Never cash.
 *  'receipt': where this shop was paid before; else, for RM 50+ or fuel/groceries, the card, bank or e-wallet used most
 *    for such spending; else the everyday account.
 *  'quick': the everyday account, the one of the latest spending or income (not a transfer or a bill).
 * Then, for a receipt or quick add: never an account that would go below zero (cash, bank, e-wallet; a card owes by
 * design) while another has the money; the one with the most money instead. → an account id.
 * bal: {id: sen} now; txs: the entries to learn from.
 */
export function pickAccount({ accounts: all, txs = [], bal = {}, kind = 'quick', amount = 0, shop = '', category = '', pay = null, currency = 'MYR' }) {
  // Only accounts in the money of the entry (a Singapore receipt: the SGD account; anything typed: ringgit), when there are any.
  const inCur = a => (a.currency || 'MYR') === (currency || 'MYR'), accounts = all.some(inCur) ? all.filter(inCur) : all;
  const byId = new Map(accounts.map(a => [a.id, a]));
  const most = (list, ok = () => true) => {
    const n = new Map();
    for (const x of list) if (byId.has(x.accountId) && ok(byId.get(x.accountId))) n.set(x.accountId, (n.get(x.accountId) || 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  const bank = a => a.kind === 'bank', notCash = a => a.kind !== 'cash';
  const main = () => most(txs.filter(x => x.type === 'income' && x.category === 'salary'), bank) || most(txs, bank)
    || accounts.find(bank)?.id || accounts.find(notCash)?.id || accounts[0]?.id;
  if (kind === 'bill') return main();
  if (kind === 'income') {   // this payer's money landed here before ("Lalamove minggu" → Bank), else where income usually lands
    const k = shop && shopWord(shop), inc = txs.filter(x => x.type === 'income');
    return (k && (most(inc.filter(x => x.merchant && shopWord(x.merchant) === k)) || most(inc.filter(x => x.merchant && shopWord(x.merchant).split(' ')[0] === k.split(' ')[0])))) || most(inc) || main();
  }
  // The receipt says how it was paid: VISA → the card (or the bank without one), MyDebit / NETS → the bank, TNG → the e-wallet, cash → cash.
  if (kind === 'receipt' && pay) {
    const want = pay === 'debit' ? 'bank' : pay;
    if (accounts.some(a => a.kind === want)) return most(txs.filter(x => x.type === 'expense'), a => a.kind === want) || accounts.find(a => a.kind === want).id;
    if (pay === 'card' || pay === 'debit') return main();
  }
  // The latest everyday account, from what was typed (a card used for one big receipt isn't where the kopi goes).
  // Spending decides where spending goes: a pension landing in the bank doesn't make the next cash kopi a bank payment.
  const everyday = () => txs.filter(x => (txs.some(y => y.type === 'expense' && (y.source === 'quick' || !y.source)) ? x.type === 'expense' : x.type !== 'transfer') &&!x.bill && x.source !== 'recurring' && x.source !== 'receipt' && byId.has(x.accountId) && byId.get(x.accountId).kind !== 'card' && (byId.get(x.accountId).scope !== 'business' || accounts.every(a => a.scope === 'business')))   // one card purchase isn't where the kopi goes, nor a stall's cash where the owner's cough syrup goes
    .reduce((m, x) => (!m || (x.createdAt || 0) > (m.createdAt || 0) ? x : m), null)?.accountId || accounts.find(a => a.kind === 'cash')?.id || accounts[0]?.id;
  const spend = txs.filter(x => x.type === 'expense');
  let id = null;
  const k = shop && shopWord(shop);
  if (k) id = most(spend.filter(x => x.merchant && shopWord(x.merchant) === k)) || most(spend.filter(x => x.merchant && shopWord(x.merchant).split(' ')[0] === k.split(' ')[0]));   // this shop (a toll on TNG; "GrabFood" as "GrabFood McDonald's" in a wallet's file): where it was paid before
  if (!id && kind === 'receipt' && (amount >= BIG || HABIT_CATS.includes(category))) id = most(spend.filter(x => x.amount >= BIG || HABIT_CATS.includes(x.category)), notCash) || main();
  id ||= everyday();
  if (k && id) return id;   // a habit is a habit, even when the balance looks short
  const short = a => a && a.kind !== 'card' && (bal[a.id] || 0) < Math.max(amount, 1);
  if (!short(byId.get(id))) return id;
  const rich = accounts.filter(a => a.kind !== 'card' && !short(a)).sort((a, b) => (bal[b.id] || 0) - (bal[a.id] || 0))[0];   // same currency: the balances compare
  return rich?.id || id;
}

// ---- bills that add themselves ---------------------------------------------------------------------------
/**
 * Dates a bill falls on from its start up to `upTo`: monthly on its day (the 31st → the month's last day), weekly or
 * yearly; it stops after `count` payments or on `until` (instalments, a car loan). A bill from before 0.4.0 has only
 * a day: monthly since 2020.
 */
export function billDates(r, upTo) {
  const from = r.start || '2020-01-01', out = [], max = r.count > 0 ? r.count : Infinity;
  if (r.until && r.until < upTo) upTo = r.until;
  for (let k = 0; out.length < max && k < 5000; k++) {
    let d;
    if (r.freq === 'weekly') d = addDays(from, 7 * k);
    else {
      const ym = addMonths(monthOf(from), r.freq === 'yearly' ? 12 * k : k);
      d = `${ym}-${pad2(Math.min(r.day || +from.slice(8, 10), daysInMonth(ym)))}`;
      if (d < from) continue;
    }
    if (d > upTo) break;
    out.push(d);
  }
  return out;
}
/** The days a payment counts for a bill due on `date`: halfway back to the last due date to just before halfway on to the
 *  next (monthly: rent paid on 29 Sep counts for 1 Oct, once); 3 days either side (weekly); half a year (yearly). */
function billPeriod(r, date) {
  if (r.freq === 'weekly') return [addDays(date, -3), addDays(date, 3)];
  if (r.freq === 'yearly') return [addDays(date, -182), addDays(date, 182)];
  const dd = r.day || +(r.start || date).slice(8, 10), on = ym => `${ym}-${pad2(Math.min(dd, daysInMonth(ym)))}`, m = monthOf(date);
  return [addDays(date, -Math.floor(daysBetween(on(addMonths(m, -1)), date) / 2)), addDays(date, Math.ceil(daysBetween(date, on(addMonths(m, 1))) / 2) - 1)];
}
/** Paid for the period of the payment due on `date`: an expense with the bill's name, whatever the amount (utility bills vary), or one tagged with the bill. */
export function billPaid(r, date, txs) {
  const name = String(r.name || '').trim().toLowerCase(), [a, b] = billPeriod(r, date);
  if (txs.length < 256) return txs.some(t => t.type === 'expense' && t.date >= a && t.date <= b && (t.bill === r.id || String(t.id).startsWith(`rec-${r.id}-`) || (!!name && !t.bill && !String(t.id).startsWith('rec-') && String(t.merchant || '').trim().toLowerCase() === name)));
  // A big list: its paid dates by bill tag, posted id and shop name, sorted, found by binary search. Scanning every row
  // for every due date of every bill froze the first screen for minutes on a file of 500 bills and 200,000 rows.
  const { bill, rec, shop } = paidIndex(txs), hit = v => { if (!v) return false; let lo = 0, hi = v.length; while (lo < hi) { const m = (lo + hi) >> 1; if (v[m] < a) lo = m + 1; else hi = m; } return lo < v.length && v[lo] <= b; };
  return hit(bill.get(r.id)) || hit(rec.get(String(r.id))) || (!!name && hit(shop.get(name)));
}
const paidIdx = new WeakMap();   // per rows array: the app replaces it on every change, never edits it in place
function paidIndex(txs) {
  let ix = paidIdx.get(txs);
  if (ix) return ix;
  ix = { bill: new Map(), rec: new Map(), shop: new Map() };
  const add = (m, k, d) => (m.get(k) || m.set(k, []).get(k)).push(d);
  for (const t of txs) {
    if (t.type !== 'expense' || typeof t.date !== 'string') continue;
    const id = String(t.id), posted = id.startsWith('rec-');
    if (t.bill) add(ix.bill, t.bill, t.date);
    if (posted) for (let k = id.indexOf('-', 5); k > 0; k = id.indexOf('-', k + 1)) add(ix.rec, id.slice(4, k), t.date);   // every r.id with id.startsWith(`rec-${r.id}-`)
    if (!t.bill && !posted) add(ix.shop, String(t.merchant || '').trim().toLowerCase(), t.date);
  }
  for (const m of Object.values(ix)) for (const v of m.values()) v.sort();
  paidIdx.set(txs, ix);
  return ix;
}
/**
 * Where a bill stands today. date: the payment due in the next 3 days, else the latest one due (so an unpaid one
 * stays overdue until paid or until the next is 3 days away); days until it (negative: overdue); next: the next date
 * after today (none: an instalment that has finished).
 */
export function billStatus(r, today, txs) {
  const all = billDates(r, addDays(today, 400)), soon = addDays(today, 3), date = all.filter(d => d <= soon).at(-1);
  return { date, next: all.find(d => d > today), paid: !!date && billPaid(r, date, txs), days: date ? daysBetween(today, date) : null };
}
/**
 * Payments to add for bills set to add themselves: each date after the bill's last run up to today, dated on the due
 * date, skipping a period already paid. The id is the bill's id and the date, so adding twice never duplicates.
 */
/** Due payments less the joint ones deleted here or by the partner (`gone`: jointGone ids). A marker never stops a payment
 *  into an account that isn't joint: the partner's file may name any id, a personal bill's included. */
export const unmarkedPayments = (txs, gone, joint) => txs.filter(x => !(joint.has(x.accountId) && gone[x.id]));
export function dueBillTxs(rules, today, txs, now = Date.now()) {
  // ponytail: 400 days back at most. A bill imported with a 1990 start (up to 500 per file) would otherwise add
  // decades of payments before the first screen shows; raise it if long offline gaps ever need more.
  const out = [], from = addDays(today, -400);
  for (const r of rules) {
    if (!r.auto) continue;
    const mine = [];   // this bill's new payments: only these can pay its later dates (all bills' was quadratic)
    for (const d of billDates(r, today)) {
      if (d < from || (r.last && d <= r.last) || billPaid(r, d, txs) || billPaid(r, d, mine)) continue;
      mine.push({ id: `rec-${r.id}-${d}`, date: d, type: 'expense', amount: r.amount, accountId: r.accountId, category: r.category || 'bills', merchant: r.name, note: '', source: 'recurring', bill: r.id, createdAt: now });
    }
    out.push(...mine);
  }
  return out;
}

// ---- habits: when does this person usually spend? -------------------------------------------------------
// Only transactions with a time of day count (tx.time 'HH:MM', from the receipt or when it was added).
const mins = hhmm => (/^\d{2}:\d{2}$/.test(hhmm || '') ? +hhmm.slice(0, 2) * 60 + +hhmm.slice(3) : null);
const dayKind = iso => ([0, 6].includes(new Date(iso + 'T00:00:00Z').getUTCDay()) ? 'weekend' : 'weekday');
export const hhmm = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
/**
 * Habits from the last 4 weeks: a category spent 3+ times, on 3+ different days of the same kind (weekday or
 * weekend), within the same 90-minute window. → [{category, days, at: 'HH:MM' (median), count, amount (median)}]
 */
export function habits(txs, today) {
  // The latest 4 weeks that have timed spending: a break in logging doesn't wipe what Tally learned.
  const last = txs.reduce((m, t) => (t.type === 'expense' && mins(t.time) != null && t.date <= today && t.date > m ? t.date : m), '');
  if (!last) return [];
  today = last;
  const from = addDays(today, -28);
  const groups = {};
  for (const t of txs) {
    const m = mins(t.time);
    if (t.type !== 'expense' || m == null || t.date < from || t.date > today) continue;
    for (const { category } of breakdown(t).slice(0, 1)) (groups[`${category}|${dayKind(t.date)}`] ||= []).push({ m, date: t.date, amount: t.amount });
  }
  const out = [];
  for (const [key, list] of Object.entries(groups)) {
    const [category, days] = key.split('|');
    list.sort((a, b) => a.m - b.m);
    // Widest cluster of times inside 90 minutes (sliding window).
    let bi = 0, bj = -1;   // the window's bounds, copied once after: a copy per step was quadratic on a big import
    for (let i = 0, j = 0; j < list.length; j++) {
      while (list[j].m - list[i].m > 90) i++;
      if (j - i > bj - bi) { bi = i; bj = j; }
    }
    const best = list.slice(bi, bj + 1);
    if (best.length < 3 || new Set(best.map(x => x.date)).size < 3) continue;
    const mid = a => a[Math.floor(a.length / 2)];
    out.push({ category, days, at: hhmm(mid(best.map(x => x.m))), count: best.length, amount: mid(best.map(x => x.amount).sort((a, b) => a - b)) });
  }
  return out.sort((a, b) => b.count - a.count);
}
/**
 * The habit to nudge about right now: its usual time passed 30 to 180 minutes ago today, and nothing in that
 * category has been added today since an hour before it. `now` is local 'YYYY-MM-DDTHH:MM'.
 */
export function dueNudge(habitList, txs, now, dismissed = []) {
  const date = now.slice(0, 10), m = mins(now.slice(11, 16));
  for (const h of habitList) {
    const at = mins(h.at), id = `${h.category}|${h.days}|${date}`;
    if (h.days !== dayKind(date) || dismissed.includes(id) || m - at < 30 || m - at > 180) continue;
    const logged = txs.some(t => t.type === 'expense' && t.date === date && breakdown(t).some(b => b.category === h.category) && (mins(t.time) ?? at) >= at - 60);
    if (!logged) return { ...h, id };
  }
  return null;
}

// ---- analytics for Insights -----------------------------------------------------------------------------------------------
// Candidate expenses only. Eligibility, sublimits and year-specific rules require the taxpayer to check LHDN.
// The category examples below are informed by LHDN's published YA 2025 relief list.
/**
 * ESTIMATE, CHECK LHDN RULES: which spending may count toward which relief, from receipt item words (the shop's name too
 * when `shop`: a dental clinic's or kindergarten's whole bill counts), within `cats` when given. First match wins.
 * `no`: words that rule a line out (a phone case isn't a phone). A flu visit to a GP isn't medical relief, so plain
 * "klinik" is not in the list.
 */
export const RELIEFS = [
  { id: 'zakat', name: 'Zakat and fitrah (tax rebate)', shop: true, re: /zakat|fitrah/i },
  { id: 'donation', name: 'Donations (approved bodies only, official receipt needed)', re: /derma\b|donation|sumbangan|wakaf|捐款|捐赠|捐獻/i, no: /\bpibg\b|\bpta\b|yuran/i },
  { id: 'breastfeeding', name: 'Breastfeeding equipment', re: /breast ?pump|pam susu|breastfeed|penyusuan|milk storage|吸奶器|母乳/i },
  { id: 'childcare', name: 'Childcare and kindergarten fees', shop: true, re: /tadika|taska|kindergarten|pre-?school|prasekolah|child ?care|day ?care|nursery fee|幼儿园|幼兒園|托儿|托兒/i },
  // Anchored (^, m): unanchored lookaheads re-scanned the rest of the text from every position (quadratic on a long import).
  { id: 'ev', name: 'EV charging', shop: true, re: /^(?=.*(?:\bev charg(?:e|er|ing)|electric vehicle charg(?:e|er|ing)|charging (?:station|equipment)|wallbox|充电桩|充電樁))(?=.*(?:install(?:ation)?|rent(?:al)?|purchas(?:e|ing)|subscription|equipment|pemasangan|sewaan|pembelian|langganan|peralatan|安装|安裝|购买|購買|租赁|租賃|订阅|訂閱))/im },
  { id: 'sports', name: 'Sports and gym', shop: true, re: /\bgym\b|\bfitness\b|badminton|futsal|racket|raket|shuttlecock|jersey|kasut sukan|running shoe|marathon|yoga|pilates|swimming|renang|\bsports?\b|\bsukan\b|健身|羽毛球/i, no: /drink|minuman|isotonic|100 ?plus|cereal|bijirin|\u996e\u6599|\u98f2\u6599/i },
  { id: 'medical', name: 'Medical, dental and vaccination', shop: true, cats: ['health', 'other'], re: /dental|dentist|pergigian|\bgigi\b|scaling|vaksin|vaccin|medical check|health screening|pemeriksaan kesihatan|fertility|\bivf\b|mental health|psychiatr|psycholog|牙医|牙醫|牙科|疫苗|体检|體檢/i, no: /kucing|\bcats?\b|anjing|\bdogs?\b|\bpets?\b|veterin|\bvet\b|haiwan|\u732b|\u8c93|\u72d7|\u5ba0\u7269|\u5bf5\u7269/i },
  { id: 'education', name: 'Education fees (yourself)', shop: true, cats: ['education', 'other', 'bills'], re: /yuran pengajian|course fee|semester fee|university|universiti|\bcollege\b|\bkolej\b|\bdegree\b|\bmba\b|\bphd\b|upskill|\bkursus\b|学费|學費/i, no: /memandu|driving|kahwin|perkahwinan|marriage|tuisyen|\u8865\u4e60|\u88dc\u7fd2/i },
  { id: 'lifestyle', name: 'Books, phone, computer and internet', re: /\bbooks?\b|\bbuku\b|\bnovel\b|magazine|majalah|newspaper|akhbar|smartphone|\b(hand)?phone\b|telefon bimbit|iphone|galaxy|redmi|tablet|\bipad\b|laptop|computer|komputer|macbook|internet|unifi|broadband|fibre (?:broadband|internet|plan)|书|書|杂志|雜誌|手机|手機|电脑|電腦|平板/i, no: /reload|prepaid|top ?up|\bcase\b|casing|cover|protector|charger|cable|kabel|buku latihan|buku tulis|exercise book|\bmouse\b|keyboard|earphone|headphone|speaker|watch|\bband\b|\bmg\b|panadol|paracetamol|ubat|vitamin|\d+\s*(?:s|tabs?|tablets?)\b|\u58f3|\u6bbc|\u5957|\u819c|\u4e66\u5305|\u66f8\u5305/i },
];
/** The relief a line of spending may count toward, or null. `item`: the item's words; `shop`: the shop and note. */
export function reliefOf(item, shop, category) {
  for (const r of RELIEFS) {
    if (r.cats && !r.cats.includes(category)) continue;
    const text = ` ${unplace(item)} ${r.shop ? unplace(shop) : ''} `;
    if (r.re.test(text) && !(r.no && r.no.test(text))) return r.id;
  }
  return null;
}
/**
 * Recorded candidate spending by calendar year: [{id, name, total, entries:
 * [{id, date, merchant, cents, proof (has a receipt photo)}], proof (entries with one)}] in RELIEFS order. Only the user's own
 * personal spending: not a partner's entries (only the spouse who paid can claim), not a business account's (`business`:
 * its ids). A relief the user picked for a payment (t.relief) wins over the words: 'none' leaves it out, a relief's id
 * counts the whole payment there.
 */
export function taxRelief(txs, year, business = []) {
  const biz = new Set(business), lines = Object.fromEntries(RELIEFS.map(r => [r.id, { id: r.id, name: r.name, total: 0, entries: [] }]));
  for (const t of txs) {
    if (t.type !== 'expense' || t.date.slice(0, 4) !== String(year) || !ownRelief(t, biz)) continue;
    if (pickedRelief(t)) { const P = lines[t.relief]; P.entries.push({ id: t.id, date: t.date, merchant: t.merchant || '', cents: t.amount, proof: !!t.receiptId }); P.total += t.amount; continue; }   // picked by hand: the whole payment
    const parts = itemAmounts(t), shop = `${t.merchant || ''} ${t.note || ''}`;
    for (const it of parts) {
      // A payment without items is judged by its shop and note alone.
      const id = reliefOf(parts.length === 1 && !it.name ? shop : it.name, shop, it.category);
      if (!id) continue;
      const L = lines[id], last = L.entries.at(-1), e = last?.id === t.id ? last : null;   // a payment's parts come together: only the last entry can be it
      if (e) e.cents += it.cents; else L.entries.push({ id: t.id, date: t.date, merchant: t.merchant || it.name, cents: it.cents, proof: !!t.receiptId });
      L.total += it.cents;
    }
  }
  return RELIEFS.map(r => { const L = lines[r.id]; return { ...L, proof: L.entries.filter(e => e.proof).length }; });
}
const ownRelief = (t, business) => !t.spouse && t.relief !== 'none' && !business.has(t.accountId);
const pickedRelief = t => !!t.relief && t.relief !== 'none' && RELIEFS.some(r => r.id === t.relief);
/** The relief Tally finds for a payment from its words (the first part that matches), whatever the user picked; null if none. */
export function reliefGuess(t) {
  if (t.type !== 'expense') return null;
  const parts = itemAmounts(t), shop = `${t.merchant || ''} ${t.note || ''}`;
  for (const it of parts) { const id = reliefOf(parts.length === 1 && !it.name ? shop : it.name, shop, it.category); if (id) return id; }
  return null;
}
/** LHDN can ask for a relief's receipts for 7 years from the end of the year the return is filed: spending in 2025 is
 *  filed in 2026 and kept until 31 Dec 2033. The last day a relief receipt must be kept, or '' for one that isn't a relief. */
export const keepReceiptUntil = t => (t.type === 'expense' && t.relief !== 'none' && (pickedRelief(t) || reliefGuess(t)) ? `${+t.date.slice(0, 4) + 8}-12-31` : '');

/** Item names that are really codes or run-together OCR text are left out of item lists. */
export const plainItem = name => !!itemKey(name) && !/\d{5,}/.test(name) && !/[A-Za-z]{16,}/.test(name);
/** Price history of items on `min`+ receipts: [{key, name, points: [{date, unit}]}], most bought first. */
export function priceHistory(txs, min = 3) {
  const by = {};
  for (const t of txs.filter(x => x.type === 'expense' && x.items?.length).sort((a, b) => byDate(a.date, b.date))) {
    const seen = new Set();   // the same item twice on one receipt is one purchase
    for (const it of t.items) {
      const k = itemKey(it.name), unit = it.unit ?? it.cents;
      if (!plainItem(it.name) || !(unit > 0) || seen.has(k)) continue;
      seen.add(k);
      (by[k] ||= { key: k, name: it.name, points: [] }).points.push({ date: t.date, unit });
    }
  }
  return Object.values(by).filter(h => h.points.length >= min).sort((a, b) => b.points.length - a.points.length || byDate(b.points.at(-1).date, a.points.at(-1).date));
}
/**
 * Your basket: the items you keep buying (priceHistory), each at its latest price (bought in the last 90 days) against
 * its price about `months` ago (else its first price, if that is 60+ days old), weighted by how often you buy it.
 * → {pct (0.042 = 4.2% dearer), n items, since (oldest base date), now, then} or null.
 */
export function basketIndex(hist, today, months = 6) {
  const target = addDays(today, -Math.round(months * 30.44)), old = addDays(today, -60), recent = addDays(today, -90);
  let now = 0, then = 0, n = 0, since = today;
  for (const h of hist) {
    const last = h.points.at(-1), base = h.points.filter(p => p.date <= target).at(-1) || (h.points[0].date <= old ? h.points[0] : null);
    if (!base || last.date <= base.date || last.date < recent) continue;
    const w = h.points.length;
    now += w * last.unit; then += w * base.unit; n++;
    if (base.date < since) since = base.date;
  }
  return n ? { pct: (now - then) / then, n, since, now, then } : null;
}

/** Monthly cost of a bill: weekly × 52 / 12, yearly / 12. */
export const perMonth = r => Math.round(r.freq === 'weekly' ? r.amount * 52 / 12 : r.freq === 'yearly' ? r.amount / 12 : r.amount);
/**
 * Month-end forecast for the budget month holding `today`: spent so far + bills still due before it ends + everyday
 * spending at its daily pace (dailyPace) for the days left. safe: the budget left per day, today included.
 */
export function forecast({ txs, today, startDay = 1, budget = 0, bills = [] }) {
  const c = cycleOf(today, startDay), day = daysBetween(c.start, today) + 1, len = daysBetween(c.start, c.end) + 1, left = len - day;
  const sp = monthSpend(txs, c.key, startDay), p = dailyPace({ txs, today, budget, bills });
  const upcoming = bills.reduce((s, r) => s + billDates(r, c.end).filter(d => d >= today && d >= c.start && !billPaid(r, d, txs)).length * r.amount, 0);   // due today and not paid yet: still to pay
  return { spent: sp.total, upcoming, rate: Math.round(p.rate), days: p.days, projected: sp.total + upcoming + Math.round(p.rate * left), daysLeft: left, end: c.end, early: p.early,
    safe: budget ? Math.max(0, Math.floor((budget - sp.total - upcoming) / (left + 1))) : null };
}
/**
 * The everyday pace in sen a day: typed spending over the last 30 days, or since the first typed spend when that is later
 * (RM 60 typed on the 28th of someone's first month is RM 60 a day, not RM 2), bills and one-off buys left out. No month
 * boundary, so the first days of a month need no fallback. A week or more with nothing typed (no spending or income, bills
 * Tally posts aside) and then entries again: the window starts after it, so days not logged don't count as RM 0 spent.
 * days: how many days it is from; early: under a week of them. from: its first day; cats: [{category, amount}] counted,
 * most first; bills, oneOffs: [{name, amount, date}] left out (bills: by tag or a bill's shop; one-offs: RM 500+ or over
 * a quarter of the budget).
 */
export function dailyPace({ txs, today, budget = 0, bills = [] }) {
  const billKeys = new Set(bills.map(r => r.key || shopWord(r.name)).filter(Boolean));
  const first = firstSpend(txs), back = addDays(today, -29);
  let from = first > back ? first : back;
  // Gaps: the last run of 7+ days without a typed entry that entries follow (a gap still running today is left alone).
  const typed = [...new Set(txs.filter(t => (t.type === 'expense' || t.type === 'income') && !isBill(t) && t.date >= from && t.date <= today).map(t => t.date))].sort();
  for (let i = 0, prev = addDays(from, -1); i < typed.length; prev = typed[i++]) if (daysBetween(prev, typed[i]) > 7) from = typed[i];
  const days = first && first <= today ? daysBetween(from, today) + 1 : 0, cats = {}, out = { bills: [], oneOffs: [] };
  let spent = 0;
  if (days) for (const t of txs) {
    if (t.type !== 'expense' || t.date < from || t.date > today) continue;
    const line = { name: t.merchant || t.note || t.category, amount: t.amount, date: t.date };
    if (isBill(t) || billKeys.has(shopWord(t.merchant))) out.bills.push(line);
    else if (oneOff(t.amount, budget)) out.oneOffs.push(line);
    else { spent += t.amount; cats[t.category] = (cats[t.category] || 0) + t.amount; }
  }
  return { rate: days ? spent / days : 0, days, early: days > 0 && days < 7, from: days ? from : null, spent,
    cats: Object.entries(cats).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount), ...out };
}
/** The pace's categories as listed: the biggest `n`, then the rest (with Other's own) as one Other row, so the rows
 *  still add up to what was spent. */
export function topCats(cats, n = 5) {
  if (cats.length <= n) return cats;
  const top = cats.filter(c => c.category !== 'other').slice(0, n), rest = cats.filter(c => !top.includes(c)).reduce((s, c) => s + c.amount, 0);
  return [...top, { category: 'other', amount: rest }];
}
/**
 * A savings goal ({target, by?, accountId?}) against its account's balance (`bal`: engine balances().by, in the account's
 * own money; no account: 0 saved). → {have, left, pct (0–1), reached, overdue, months, perMonth}: with a date, what a
 * month gets there by it, rounded up to the sen; months: the days until by in average months (30.44 days), at least 1.
 */
export function goalProgress(g, bal, today) {
  const have = g.accountId ? bal[g.accountId] || 0 : 0, left = Math.max(0, g.target - have), reached = !left;
  const overdue = !reached && !!g.by && g.by < today;
  const months = g.by && !reached && !overdue ? Math.max(1, Math.round(daysBetween(today, g.by) / 30.44)) : null;   // 1 Oct → 31 Dec is 3 months, not 2
  return { have, left, pct: Math.max(0, Math.min(have, g.target)) / g.target, reached, overdue, months, perMonth: months && Math.ceil(left / months) };
}
/** The money "Can I afford it?" counts: everyday accounts only (cash, bank, e-wallet, and cards as they stand). Savings
 *  (ASB, Tabung Haji) are shown apart, never spent on a phone; what friends owe and what I owe stay out. A balance never
 *  given (typed false) is not counted, as on Home. → {balance, savings} in RM sen. */
export function affordMoney(accounts, txs) {
  const known = accounts.filter(a => a.typed !== false), of = kinds => balances(known.filter(a => kinds.includes(a.kind || 'bank')), txs).total;
  return { balance: of(['cash', 'bank', 'ewallet', 'card']), savings: of(['savings']) };
}
/**
 * Can I afford it? The next 30 days [today, today+30) a day at a time: money there today (`balance`) less the price, then
 * each day's pay (the next payday not yet past, or up to 5 days late and not typed yet: the lowest of the last 3 salary
 * days' totals, on the latest day of the month among them, so pay that moves around is assumed late and small; with no salary lately, the usual income
 * spread over the days), bills due and everyday spending at the usual pace. The verdict is on the lowest day, not the
 * last: money that runs out before payday is short even if pay refills it. yes: a week of usual spending (at least
 * RM 100) still there on the lowest day, and within the budget if there is one. tight: less than that, over budget, or
 * short only because of a pace from under a week of spending. no: short; `months` of usual saving (the last 3 full
 * months' money in minus out) would cover it. path: the 30 days (next30 draws it). How it got there: rate (a day), pace
 * (dailyPace: its window, categories and what it left out), dues [{name, date, amount}], thin (the spending may be incomplete).
 */
export function affordCheck({ price, balance, txs, today, startDay = 1, bills = [], budget = 0 }) {
  const f = forecast({ txs, today, startDay, budget, bills }), pace = dailyPace({ txs, today, budget, bills }), end = addDays(today, 30), usual = Math.round(pace.rate * 30), due = new Map(), dues = [];
  for (const r of bills) for (const d of billDates(r, end)) if (d >= today && d < end && !billPaid(r, d, txs)) { due.set(d, (due.get(d) || 0) + r.amount); dues.push({ name: r.name, date: d, amount: r.amount }); }   // due today and not paid yet: still to pay
  const upcoming = [...due.values()].reduce((s, v) => s + v, 0);
  const salDays = [...new Set(txs.filter(x => x.type === 'income' && x.category === 'salary' && x.date <= today).map(x => x.date))].sort();
  const last = salDays.at(-1), [p1, p2] = salDays.slice(-2), fromEnd = d => daysInMonth(d.slice(0, 7)) - +d.slice(8, 10);
  const back = startDay < 0 ? -startDay - 1 : p1 && p2 && p1.slice(8) !== p2.slice(8) && fromEnd(p1) === fromEnd(p2) ? fromEnd(p2) : null;   // 29 Sep, 30 Oct: second-last day
  // Pay that moves around (25th, 28th, 26th) is expected on the latest of the last 3 days (28th): assume it comes late.
  const day = Math.max(...salDays.slice(-3).map(d => +d.slice(8, 10)));
  const payOn = ym => `${ym}-${pad2(back != null ? daysInMonth(ym) - back : Math.min(day, daysInMonth(ym)))}`;   // 31 Aug → 30 Sep
  let next = null;   // the first payday not yet past: a salary not typed yet, or a day late, still comes
  if (last) for (let k = 1; k < 4 && !(next >= addDays(today, -5)); k++) next = payOn(addMonths(last.slice(0, 7), k));
  if (next && next < today) next = today;   // up to 5 days late and not typed yet: still coming, counted from today
  // How much: the lowest of the last 3 paydays, each day's lines summed (KPI pay moves too): one good month can't make a buy look affordable.
  const payOf = d => txs.filter(x => x.type === 'income' && x.category === 'salary' && x.date === d).reduce((s, x) => s + x.amount, 0);
  const pay = next && next >= today && next < end ? Math.min(...salDays.slice(-3).map(payOf)) : 0;
  // No salary lately (riders, freelancers, small sellers): their usual income instead, the lowest of the last 3 full
  // months that have any entries (refunds aside), so one good month can't make a buy look affordable.
  const ym = cycleKey(today, startDay), recentPay = last && last >= addDays(today, -62);
  const full = recentPay ? [] : [1, 2, 3].map(k => addMonths(ym, -k)).filter(k => txs.some(x => cycleKey(x.date, startDay) === k));
  const earn = full.length ? Math.min(...full.map(k => txs.filter(x => x.type === 'income' && x.category !== 'refund' && cycleKey(x.date, startDay) === k).reduce((s, x) => s + x.amount, 0))) : 0;
  const path = []; let bal = balance - price, low = null;
  for (let i = 0; i < 30; i++) {
    const date = addDays(today, i), inn = (date === next ? pay : 0) + earn / 30, out = due.get(date) || 0;
    bal += inn - out - usual / 30;
    path.push({ date, bal: Math.round(bal), in: Math.round(inn), out });
    if (!low || bal < low.bal) low = { bal: Math.round(bal), date };
  }
  const left = Math.round(bal), over = budget ? Math.max(0, f.projected + price - Math.max(budget, f.projected)) : 0;   // what this buy adds over the budget
  const flow = cashFlow(txs, addMonths(ym, -1), 3, startDay).filter(m => m.income || m.expense);
  const net = flow.length ? Math.round(flow.reduce((s, m) => s + m.income - m.expense, 0) / flow.length) : 0;
  const short = Math.min(left, low.bal), cover = balance - price - upcoming + pay + earn >= 0;
  const verdict = short < 0 ? (f.early && cover ? 'tight' : 'no') : short < Math.max(100_00, Math.round(f.rate * 7)) || over ? 'tight' : 'yes';
  // thin: the spending may be incomplete (under a week of it, or under a tenth of the money coming in): say so first.
  const thin = f.early || (pay + earn > 0 && usual < (pay + earn) / 10);
  return { verdict, balance, pay, payDate: pay ? next : null, earn, upcoming, usual, price, left, low, path, end, over, net, early: f.early, days: f.days, rate: f.rate, thin,
    dues: dues.sort((a, b) => byDate(a.date, b.date)), pace, months: short < 0 && net > 0 ? Math.ceil(-short / net) : null };
}
/** A month's spending split into regular payments (bills, and shops that are known or detected bills) and day-to-day spending. */
export function fixedFlexible(txs, ym, sd = 1, billShops = []) {
  const keys = new Set(billShops);
  let fixed = 0, flexible = 0;
  for (const t of txs) {
    if (t.type !== 'expense' || cycleKey(t.date, sd) !== ym) continue;
    if (isBill(t) || (t.merchant && keys.has(shopWord(t.merchant)))) fixed += t.amount; else flexible += t.amount;
  }
  return { fixed, flexible };
}

/**
 * Spending per day of a month (or cycle): [{date, v, level}], every day listed. level 0 nothing, else 1–4 by the
 * day's rank among the days with spending (quarters), so one rent day doesn't wash out the rest.
 */
export function dailySpend(txs, ym, sd = 1) {
  const c = cycleSpan(ym, sd), by = {};
  for (const t of txs) if (t.type === 'expense' && t.date >= c.start && t.date <= c.end) by[t.date] = (by[t.date] || 0) + t.amount;
  const days = [];
  for (let d = c.start; d <= c.end; d = addDays(d, 1)) days.push({ date: d, v: by[d] || 0 });
  const sorted = days.map(x => x.v).filter(Boolean).sort((a, b) => a - b);
  return days.map(x => ({ ...x, level: x.v ? Math.ceil((sorted.lastIndexOf(x.v) + 1) / sorted.length * 4) : 0 }));
}
/** Time of day: 0 morning 05–11, 1 afternoon 11–17, 2 evening 17–22, 3 late night 22–05. */
export const slotOf = m => (m >= 300 && m < 660 ? 0 : m >= 660 && m < 1020 ? 1 : m >= 1020 && m < 1320 ? 2 : 3);
export const DELIVERY = /grab ?food|food ?panda|shopee ?food|deliveroo|airasia food|mcdelivery|beep delivery/i;
/**
 * Everyday spending with a time between two dates by weekday (0 Sunday) and time of day: grid[7][4] in sen. After
 * midnight counts for the night before (Friday late night includes Saturday 01:00). top: the biggest cell with its
 * main category; late: food delivery ordered late at night {v, n}.
 */
export function whenGrid(txs, from, to) {
  const grid = Array.from({ length: 7 }, () => [0, 0, 0, 0]), cats = {}, late = { v: 0, n: 0 };
  for (const t of txs) {
    const m = mins(t.time);
    if (t.type !== 'expense' || isBill(t) || m == null || t.date < from || t.date > to) continue;
    const w = new Date(`${m < 300 ? addDays(t.date, -1) : t.date}T00:00:00Z`).getUTCDay(), s = slotOf(m), k = `${w}|${s}`;
    grid[w][s] += t.amount;
    for (const b of breakdown(t)) (cats[k] ||= {})[b.category] = (cats[k][b.category] || 0) + b.cents;
    if (s === 3 && DELIVERY.test(`${t.merchant || ''} ${t.note || ''}`)) { late.v += t.amount; late.n++; }
  }
  let top = null;
  grid.forEach((row, w) => row.forEach((v, s) => { if (v && (!top || v > top.v)) top = { w, s, v }; }));
  if (top) top.category = Object.entries(cats[`${top.w}|${top.s}`]).sort((a, b) => b[1] - a[1])[0][0];
  return { grid, top, late };
}
/** Shops in a month by money and by visits (top 5 each): [{name, v, n}]. Names group as bills do (first two words). */
export function topShops(txs, ym, sd = 1) {
  const by = {};
  for (const t of txs) {
    if (t.type !== 'expense' || !t.merchant || cycleKey(t.date, sd) !== ym) continue;
    const k = shopWord(t.merchant) || itemKey(t.merchant);
    if (!k) continue;
    (by[k] ||= { name: t.merchant, v: 0, n: 0 }); by[k].v += t.amount; by[k].n++;
  }
  const all = Object.values(by);
  return { money: [...all].sort((a, b) => b.v - a.v).slice(0, 5), visits: [...all].sort((a, b) => b.n - a.n || b.v - a.v).slice(0, 5) };
}

/** A month's spending by the kind of account it came from: {cash, bank, ewallet, card, savings} in sen. */
export function paymentMix(txs, accounts, ym, sd = 1) {
  const kind = Object.fromEntries(accounts.map(a => [a.id, a.kind || 'bank'])), by = {};
  for (const t of txs) if (t.type === 'expense' && cycleKey(t.date, sd) === ym && kind[t.accountId]) by[kind[t.accountId]] = (by[kind[t.accountId]] || 0) + t.amount;
  return by;
}
/** Share of money in that was kept: (in − out) / in. null for a month with no money in. */
export const savingsRate = (income, expense) => (income > 0 ? (income - expense) / income : null);

/** Food in a month: groceries (cooking), dining out, and delivery (GrabFood, foodpanda, ShopeeFood: all but its groceries). */
export function foodSplit(txs, ym, sd = 1) {
  const out = { groceries: 0, dining: 0, delivery: 0 };
  for (const t of txs) {
    if (t.type !== 'expense' || cycleKey(t.date, sd) !== ym) continue;
    const del = DELIVERY.test(`${t.merchant || ''} ${t.note || ''}`);
    for (const b of breakdown(t)) {
      if (b.category === 'groceries') out.groceries += b.cents;
      else if (del) out.delivery += b.cents;
      else if (b.category === 'dining') out.dining += b.cents;
    }
  }
  return out;
}
/** SST and service charge paid in a calendar year, from receipts' tax and service lines; n: receipts with either. */
export function taxPaid(txs, year) {
  const out = { sst: 0, service: 0, n: 0 };
  for (const t of txs) {
    if (t.type !== 'expense' || t.date.slice(0, 4) !== String(year) || !(t.tax > 0 || t.service > 0)) continue;
    const k = t.split?.total ? t.amount / t.split.total : 1;   // a split bill keeps the receipt's figures: my part of them
    out.sst += Math.round(Math.max(0, t.tax || 0) * k); out.service += Math.round(Math.max(0, t.service || 0) * k); out.n++;
  }
  return out;
}
/**
 * Money put into joint accounts in a month (income into one, or a transfer from outside them), by who: rows marked
 * `spouse` came from the spouse's phone (named by `by`), the rest are yours. → [{me, name, v}], most first.
 */
export function jointIn(txs, jointIds, ym, sd = 1) {
  const by = {};
  for (const t of txs) {
    if (cycleKey(t.date, sd) !== ym) continue;
    const into = t.type === 'income' ? jointIds.has(t.accountId) : t.type === 'transfer' && jointIds.has(t.toAccountId) && !jointIds.has(t.accountId);
    if (!into) continue;
    const k = t.spouse ? `s:${t.by || ''}` : 'me';
    (by[k] ||= { me: !t.spouse, name: t.spouse ? t.by || '' : '', v: 0 }).v += t.amount;
  }
  return Object.values(by).sort((a, b) => b.v - a.v);
}

// ---- Insights: items, shops, the next 30 days, payday, bills, the year -------------------------------------------------------
/** What one category was spent on in a month: receipt items (each with its share of tax and charges) and, for payments
 *  without items, the shop. → [{name, v (sen), n, shop (true: a payment, not an item)}], most money first. */
export function categoryItems(txs, c, ym, sd = 1) {
  const by = new Map();
  for (const t of txs) {
    if (t.type !== 'expense' || cycleKey(t.date, sd) !== ym) continue;
    for (const it of itemAmounts(t)) {
      if (it.category !== c) continue;
      const name = it.name || t.merchant || t.note || '', k = it.name ? `i:${itemKey(it.name) || name}` : `s:${(t.merchant || '').toLowerCase()}`;
      const r = by.get(k) || by.set(k, { name, v: 0, n: 0, shop: !it.name }).get(k);
      r.v += it.cents; r.n++;
    }
  }
  return [...by.values()].sort((a, b) => b.v - a.v);
}
/** The same item bought at 2+ shops in the last `days`: its latest price at each, cheapest first. → [{name, shops:
 *  [{shop, unit, date}], save (sen: dearest − cheapest)}], biggest difference first. */
export function shopPrices(txs, today, days = 180) {
  const since = addDays(today, -days), by = new Map();
  for (const t of txs) {
    if (t.type !== 'expense' || !t.items?.length || !t.merchant || t.date < since || t.date > today) continue;
    for (const it of t.items) {
      const k = itemKey(it.name), unit = it.unit ?? it.cents;
      if (!plainItem(it.name) || !(unit > 0)) continue;
      const r = by.get(k) || by.set(k, { name: it.name, at: new Map() }).get(k), s = t.merchant.trim(), was = r.at.get(s.toLowerCase());
      if (!was || t.date >= was.date) r.at.set(s.toLowerCase(), { shop: s, unit, date: t.date });
    }
  }
  return [...by.values()].filter(r => r.at.size > 1).map(r => { const shops = [...r.at.values()].sort((a, b) => a.unit - b.unit); return { name: r.name, shops, save: shops.at(-1).unit - shops[0].unit }; })
    .filter(r => r.save > 0).sort((a, b) => b.save - a.save);
}
/** The next 30 days a day at a time: the path "Can I afford it?" judges (affordCheck, nothing bought), so the two always
 *  agree. → {days: [{date, bal, in, out}] (day 0 is today), low: the lowest day} */
export function next30({ balance, txs, today, startDay = 1, bills = [], budget = 0 }) {
  const days = affordCheck({ price: 0, balance, txs, today, startDay, bills, budget }).path;
  return { days, low: days.reduce((m, d) => (d.bal < m.bal ? d : m), days[0]) };
}
/** Everyday spending (no bills, no one-off buys of RM 500+) in the 7 days from each payday against the rest of that pay
 *  period, per day, over the last 3 periods. → {ratio, after (sen a week), usual (sen a week)} or null. */
export function paydayEffect(txs, today) {
  const pays = [...new Set(txs.filter(x => x.type === 'income' && x.category === 'salary' && x.date <= today).map(x => x.date))].sort().slice(-4);
  let after = 0, rest = 0, restDays = 0;
  for (let i = 0; i + 1 < pays.length; i++) {
    const p = pays[i], q = pays[i + 1], wk = addDays(p, 6);
    for (const t of txs) if (t.type === 'expense' && !isBill(t) && t.amount < 500_00 && t.date >= p && t.date < q) { if (t.date <= wk) after += t.amount; else rest += t.amount; }
    restDays += Math.max(0, daysBetween(wk, q) - 1);
  }
  if (pays.length < 2 || restDays < 7 || !rest || !after) return null;
  const a = after / ((pays.length - 1) * 7), u = rest / restDays;
  return { ratio: a / u, after: Math.round(a * 7), usual: Math.round(u * 7) };
}
/** Bills whose last payment differs from the one before (a subscription's price going up, or down). bills: [{id?, name,
 *  key?}]. → [{name, from, to, date}], latest first. */
export function billChanges(txs, bills) {
  const out = [];
  for (const r of bills) {
    // A bill typed as one word ("Netflix") is paid to "NETFLIX.COM": its first word is enough
    const key = r.key || shopWord(r.name), one = key && !key.includes(' '), same = m => { const w = shopWord(m); return w === key || (one && w.split(' ')[0] === key); };
    const paid = txs.filter(t => t.type === 'expense' && ((r.id && t.bill === r.id) || (key && t.merchant && same(t.merchant)))).sort((a, b) => byDate(a.date, b.date));
    const [p, q] = paid.slice(-2);
    if (q && Math.abs(q.amount - p.amount) > Math.max(100, p.amount * 0.01)) out.push({ name: r.name, from: p.amount, to: q.amount, date: q.date });
  }
  return out.sort((a, b) => byDate(b.date, a.date));
}
/** Malaysia's price change (DOSM CPI, {from: 'YYYY-MM', v: [index per month]}) between two months, the nearest
 *  published ones. → {pct, from, to} or null. */
export function cpiChange(cpi, fromYm, toYm) {
  const at = ym => { const k = (+ym.slice(0, 4) - +cpi.from.slice(0, 4)) * 12 + +ym.slice(5, 7) - +cpi.from.slice(5, 7); return Math.max(0, Math.min(cpi.v.length - 1, k)); };
  const i = at(fromYm), j = at(toYm), ym = k => addMonths(cpi.from, k);
  return j > i ? { pct: cpi.v[j] / cpi.v[i] - 1, from: ym(i), to: ym(j) } : null;
}
/** A year in a few numbers: spent, money in, top category, shop and item, days with nothing spent, days logged, SST and
 *  charges. → {spent, income, cat: {id, v}, shop: {name, v, n} (most visits), item: {name, n}, noSpend, logged, fees} */
export function yearReview(txs, year, noSpend = []) {
  const y = String(year), cats = {}, shops = {}, items = {}, days = new Set();
  let spent = 0, income = 0;
  for (const t of txs) {
    if (t.date.slice(0, 4) !== y) continue;
    days.add(t.date);
    if (t.type === 'income' && !isRefund(t)) income += t.amount;
    if (t.type !== 'expense') continue;
    spent += t.amount;
    for (const { category, cents } of breakdown(t)) cats[category] = (cats[category] || 0) + cents;
    if (t.merchant) { const s = (shops[t.merchant.toLowerCase()] ||= { name: t.merchant, v: 0, n: 0 }); s.v += t.amount; s.n++; }
    for (const it of t.items || []) if (plainItem(it.name)) (items[itemKey(it.name)] ||= { name: it.name, n: 0 }).n++;
  }
  const top = o => Object.values(o).sort((a, b) => b.n - a.n || b.v - a.v)[0] || null, tp = taxPaid(txs, y);   // the shop gone to most
  const c = Object.entries(cats).sort((a, b) => b[1] - a[1])[0];
  return { spent, income, cat: c ? { id: c[0], v: c[1] } : null, shop: top(shops), item: Object.values(items).sort((a, b) => b.n - a.n)[0] || null,
    noSpend: noSpend.filter(d => d.slice(0, 4) === y).length, logged: days.size, fees: tp.sst + tp.service };
}
