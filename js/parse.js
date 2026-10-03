// Receipt text (from OCR) -> structured receipt. Pure, no DOM. Amounts are integer cents (sen).
// Tuned for Malaysian receipts: SST, service charge, 5-sen rounding, SR/ZR tax codes, day-first dates.
import { brandOf, knownShop, categoryOf } from './brands.js';
import { calcAmount } from './engine.js';

// "12.90", "12,90", "RM 12.90", "$12.90", "-2.00", "2.00-", then optional trailing tax code or OCR junk
// (SR, ZR, T, *, "2" for a misread Z, "§", ":")
// A glued unit ("1.25L", "0.50KG") is a pack size in a name, not a price with a tax code.
const AMOUNT = /(-)?\s*(?:RM\s*|MYR\s*|\$)?(\d{1,6})[.,] ?(\d{2})(-)?(?:\s*(?!(?:ML|KG|MM|CM|L|G|M)\b)(?:[A-Z]{1,2}|\*)|\s+[^\s\d]{1,2}|\s+\d)?\s*$/i;
const COUNT = /\b([il1]te[mn]|qty)\s*[(（]s[)）]|\bno\.?\s*of\s*items|\bitem\s*count/i; // "Item(s): 5 Qty(s): 5"
const UNIT_ONLY = /^\s*(\d{1,3})\s*(?:ea|pcs?|units?)?\s*[x×@]\s*(?:RM\s*)?\d+[.,]\d{2}\s*$/i;   // "2 x 10.90", "1ea@5.90"
// A delivery rider's plate and bike with a rating ("VFV4311·WM110 5.00"); a drink's options ("Dairy| Less Sweet| Less Ice")
// with its price before a discount; a shop app's badges ("15 Days Free Returns", "Preferred+"): never things bought.
const NOT_ITEM = /\b[A-Z]{1,3}\s?\d{3,4}[A-Z]?\s*[·•]\s*[A-Z]|[A-Z]\s*[·•]\s*[A-Z]{1,3}\s?\d{3,4}\b|\|.*\|/;
const BADGE = /(\d+\s*days?\s*)?free\s*returns\W*|guarantee|voucher\s*applied|my\s*purchases|preferred\s*\+?|visit\s*shop|chat\s*now|\bmall\b|expected\s*delivery|contact\s*seller|support\s*cent(er|re)|you\s*may\s*also\s*like/i;
const QTY = /^\s*\d+(?:[.,]\d+)?\s*(?:ea|pcs?|units?|kgs?|g|l|ltrs?|litres?)?\s*[x@]\s*(?:RM\s*)?\d+[.,]\d{2}(?:\s*\/\s*(?:kg|g|ea|pcs?|unit|l|ltr|litre))?\s*/i;   // weighed "1.438 KG X 6.90/KG", pumped "26.615L@ RM2.05/L"

// Also OCR's "jotal", "[otal", "Tota", "Totil", "Total2 items", "TOTALAMOUNT".
const TOTAL = /[o0]ta[l1i]?(?![a-z])|t[o0]t[ai][l1](?![a-z])|t[o0]ta[l1](?=with|incl|[il1]ncl|amt|amount|sales|rm|myr)|jumlah|amount\s*due|\bnett?\b|grand/i;
const PAYMENT = /\b(cash|tunai|change|baki|tender|[uv]isa|master|card|credit|debit|paid|payment|e-?wallet|grabpay|boost|tng|touch\s*n)/i;
// "Total Qty", "Total Items", "Total Saving", "Total 0% supplies" (a group total), "Item 2 Total with GST"
const NOT_TOTAL = /[sg]ub\s*-?\s*t[o0]ta|t[o0]ta[l1]?\s*(qty|quantity|items?\b|sa[uv]ing|disc)|^(qty|items?)\b|sa[uv]ing|excl|suppl/i;   // and OCR's "Sauings"
// A line that says both "total" and "tax"/"rounding" is the total only when it says so ("incl", "payment"...)
const TOTAL_WINS = /[il1]ncl|with|after|payment|payable|amount|due|nett|grand|jumlah/i;
const ALL_AMOUNTS = /(?:RM\s*|MYR\s*|\$)?(\d{1,6})[.,] ?(\d{2})(?!\d)/gi;
const SUBTOTAL = /[sg]ub\s*-?\s*t[o0]ta[il1]?/i; // also OCR's "Gubtotai"
const SERVICE = /service\s*(charge|chg)|\bsvc\b|\bs\/?c\b|caj\s*perkhidmatan|shipping|delivery\s*(fee|charge)|penghantaran|运费|運費|platform\s*fee|carbon\s*neutral|packaging\s*(fee|charge)|small\s*order\s*fee|service\s*fee|cleaning\s*fee/i;   // a charge on top of the items (Shopee's shipping)
const TAX = /\bsst(?![a-z])|\bgst(?![a-z])|\bvat(?![a-z])|service\s*tax|sales\s*tax|\btax(?![a-z])|cukai/i;   // "TAX6%" too
const ROUNDING = /round|pelarasan|bundar/i;
const MONEY_LABEL = new RegExp([TOTAL, SUBTOTAL, TAX, SERVICE, ROUNDING].map(x => x.source).join('|'), 'i');
const DISCOUNT = /disc(ount)?|\bdsc\b|diskaun|potongan|sa[uv]ing|voucher|baucar|coupon|kupon|pro[mn]o|rebate|redeem|points? (used|redeemed)|优惠|折扣/i;
// Printed shop names end like this; a handwritten name or a garbled logo above them is not the shop.
const COMPANY = /\bsdn\.?\s*bhd|sdnbhd|\bbhd\b|enterprise|trading|restoran|restaurant|supermarket|hypermarket|pharmacy|farmasi|\bkedai\b|\bmart\b|\bstore\b|bakery|\bcafe\b/i;
/** Strip codes, quantities, prices and units: what is left is the item's name (maybe nothing). */
const bareName = s => s.replace(/^\s*(?:\d+\s*x|x\s*[1il]|[1il]\s*x)(?=\s*\d{6,})/i, ' ')   // "1x 9555…", read as "XI 3693…" / "IX 9555…": a qty and a barcode
  .replace(/\d+(?:[.,]\d+)?/g, ' ').replace(/\b(pcs?|set|units?|ea|nos?|btl|pkt|x)\b/gi, ' ').replace(/\s+/g, ' ').trim();
// Year may be glued to the time by OCR: "25/12/20188:13PM", "01/03/1819:14"
// Day first (Malaysia) with one separator used twice ("#19-04/05/2024" is 04/05, not 19-04/05); year first; and the
// year may run straight into the time ("2024-04-0402:43:48").
const DATE = /(?<!\d)(\d{1,2})([\/.-])(\d{1,2})\2(20\d{2}|\d{2})(?=\d{1,2}:\d{2}|\D|$)|(?<!\d)(20\d{2})([\/.-])(\d{1,2})\6(\d{1,2})(?=\d{1,2}:\d{2}|\D|$)/g;
const MON = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
// "18 Aug 2022", "11SEP202217:17:41", "04Sept2022", "1September2022", "12 Dec 24"; and "Aug 18, 2022", "OCT6,202410:52AM" (app screenshots).
const DATE_WORDS = new RegExp(String.raw`(?<!\d)(\d{1,2})\s*[-/ ]?\s*(${MON})[a-z]*\.?\s*[-/, ]?\s*(20\d{2}|\d{2}(?!\d))|\b(${MON})[a-z]*\.?\s*(\d{1,2}),?\s*(20\d{2})`, 'gi');
const monthOf = s => MON.split('|').indexOf(s.slice(0, 3).toLowerCase()) + 1;

// OCR boxes [{text, box: [[x,y] x4]}] -> text with one receipt row per line.
// Boxes whose vertical centres are within half a line height join left-to-right ("Nasi Lemak" + "12.90"). On a slightly
// tilted photo the rows slope, so centres are measured along the text's own slope (the median of the wide boxes): a
// price at the far right then stays on its item's row instead of the next one (synthetic bench: 2-3° tilts lost half
// their items). Under half a degree, nothing changes.
/** OCR boxes → rows, top to bottom: {text, conf (the row's least sure word), y, h}. The app's scan and joinRows share it. */
export function rowsOf(boxes) {
  const run = q => ({ w: Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]), h: Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]) });
  const slopes = boxes.map(b => b.box).filter(q => { const e = run(q); return e.w > 2.5 * e.h && e.w > 40; }).map(q => (q[1][1] - q[0][1]) / ((q[1][0] - q[0][0]) || 1)).sort((a, c) => a - c);
  const med = slopes.length >= 3 ? slopes[slopes.length >> 1] : 0, slope = Math.abs(med) > 0.0087 ? med : 0;
  const b = boxes.map(({ text, box, mean }) => {
    const ys = box.map(p => p[1]), xs = box.map(p => p[0]), top = Math.min(...ys), bottom = Math.max(...ys), x = Math.min(...xs), y = (top + bottom) / 2;
    return { text, mean, x, y, v: y - slope * (x + Math.max(...xs)) / 2, h: bottom - top };
  }).sort((a, c) => a.v - c.v);
  const rows = [];
  for (const w of b) {
    const row = rows.at(-1);
    if (row && Math.abs(w.v - row.v) < Math.min(w.h, row.h) / 2) row.words.push(w);
    else rows.push({ v: w.v, h: w.h, words: [w] });
  }
  return rows.map(r => { const ws = r.words.sort((a, c) => a.x - c.x); return { text: ws.map(w => w.text).join(' '), words: ws.map(w => ({ text: w.text, conf: w.mean ?? 1, x: w.x })), conf: Math.min(...ws.map(w => w.mean ?? 1)), y: ws.reduce((s, w) => s + w.y, 0) / ws.length, h: Math.max(...ws.map(w => w.h)) }; });
}
export const joinRows = boxes => rowsOf(boxes).map(r => r.text).join('\n');

export function toCents(m) {
  const cents = parseInt(m[2], 10) * 100 + parseInt(m[3], 10);
  return m[1] || m[4] ? -cents : cents;
}

/** "13:05", "1:05 PM", "19:08:32", glued to a date ("20188:13:39PM") → 'HH:MM' 24-hour, or null. */
export function parseTime(line) {
  const hinted = /time|masa|时间|時間|am\b|pm\b|:\d\d:\d\d/i.test(line) || DATE_HINT.test(line);
  const rest = line.replace(/\d{1,2}[\/.-]\d{1,2}[\/.-](?:20\d{2}|\d{2})/g, ' '); // "25/12/20188:13" → " 8:13"
  const m = rest.match(/(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\s*([AaPp][Mm])?(?![\d:])/);
  if (!m || !hinted) return null;
  let h = +m[1];
  if (m[3]) { if (h > 12) return null; h = (h % 12) + (/p/i.test(m[3]) ? 12 : 0); }
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}
const DATE_HINT = /\d{1,4}[\/.-]\d{1,2}[\/.-]\d{2,4}/;

export function parseDate(line) {
  line = String(line ?? '')
    .replace(/(\d{1,2}:\d{2})(?=\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2})/g, '$1 ')   // a time glued to the date: "21:0221/04/23"
    .replace(/(\d{1,2}[\/.-]\d{1,2}[\/.-]20\d{2})(?=[0-2]\d:?[0-5]\d(?!\d))/g, '$1 ')   // the time glued after the year: "29/09/20261733"
    .replace(/(?<![\d/])([0-3]\d)([01]\d)\/?(20\d{2})(?=\s+\d{1,2}:\d{2})/g, '$1/$2/$3')   // "28082022 15:23:12", "0105/2024 18:39": only before a time
    .replace(/\bju1\b/gi, 'jul').replace(/\b0ct\b/gi, 'oct').replace(/\bn0v\b/gi, 'nov').replace(/\bs3p\b/gi, 'sep')   // OCR's 1/0/3 in month names
    .replace(/(?<!\d)\d(\d{2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[\s,/-]*20\d{2})/gi, '$1');   // "118 AUG 2022": a stray digit before the day
  const ok = (y, mo, d) => {
    if (y < 100) y += 2000;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    // ponytail: receipts from 2010 to next year; "C4.03.00" (a mall unit) would otherwise be 4 March 2000, and a phone's
    // status bar ("8:45 8 OCT 40%") 8 October 2040
    return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d && y >= 2010 && y <= new Date().getUTCFullYear() + 1 ? dt.toISOString().slice(0, 10) : null;
  };
  for (const re of [DATE, DATE_WORDS]) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(line)); ) { // first valid one
      const iso = re === DATE ? (m[5] ? ok(+m[5], +m[7], +m[8]) : ok(+m[4], +m[3], +m[1]) || (+m[3] > 12 ? ok(+m[4], +m[1], +m[3]) : null)) : m[4] ? ok(+m[6], monthOf(m[4]), +m[5]) : ok(+m[3], monthOf(m[2]), +m[1]);
      if (iso) return iso;
      re.lastIndex = m.index + 1; // retry one char later so an invalid match can't swallow the real date
    }
  }
  return null; // rejects 31/02, 13/13
}
const DATE_LABEL = /date|tarikh|tkh\b|日期|transaction|purchased|order\s*time|\bdt\b/i;
const NOT_DATE = /exp|valid|till|until|before|mail\s*out|ship\s*out|member\s*since|promo|warranty|estimat|deliver|arriv/i;   // "arrive by 14-09-2024": a shop app's delivery date
/** The receipt's date: a line labelled Date or carrying a time beats the first date-like text (a promo's "valid till"). */
function receiptDate(lines) {
  let best = null;
  for (const l of lines) {
    const d = parseDate(l); if (!d) continue;
    const s = (DATE_LABEL.test(l) ? 2 : 0) + (/\d{1,2}:\d{2}/.test(l) ? 1 : 0) - (NOT_DATE.test(l) ? 3 : 0);
    if (!best || s > best.s) best = { d, s };
  }
  return best?.d ?? null;
}

/**
 * Items typed by hand, one per line: "Phone 1299", "Ikan kembung 25.50", "RM 8 sayur", "Teh ais: 2.5", "Sayur 8.-".
 * A quantity or sum is worked out: "Eggs 2x6.20", "Telur 6.20x2", "Teh ais 2@2.50", "Kuih 3*1.20", "Roti 4.5+2".
 * → {items: [{name, cents, qty?, unit?}], skipped: [lines with no name or no price]}.
 */
export function parseItemLines(text) {
  // "1,299" and "1,299.50" are thousands; "25,50" is 25.50 (comma decimals); a list comma ("鱼 25, 菜 8") splits items.
  const cents = s => { const [a, b = ''] = s.replace(/,(?=\d{3}(?!\d))/g, '').split(/[.,]/); return +a * 100 + +(b + '00').slice(0, 2); };
  const PRICE = String.raw`(?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,6}(?:[.,]\d{1,2})?)`, EXPR = String.raw`${PRICE}(?:\s*[x×*@+]\s*${PRICE})*`;
  const tailRe = new RegExp(String.raw`^(.*?\S)[\s:=\-–]*(?:RM|MYR)?\s*(${EXPR})$`, 'i'), headRe = new RegExp(String.raw`^(?:RM|MYR)?\s*(${PRICE})[\s:=\-–]+(\D.*)$`, 'i');
  const worth = e => {   // "2x6.20" → 12.40, qty 2 at 6.20; "4.5+2" → 6.50 (the Amount field's calcAmount does the sum)
    const p = e.split(/\s*([x×*@+])\s*/i), total = calcAmount(p.map((s, i) => (i % 2 ? s.replace('@', '*') : (cents(s) / 100).toFixed(2))).join(''));
    if (p.length !== 3 || p[1] === '+') return { cents: total };
    const q = /^\d+$/.test(p[0]) ? 0 : /^\d+$/.test(p[2]) ? 2 : -1;   // the whole number is the quantity: 2x6.20, 6.20x2
    return q < 0 || +p[q] < 2 ? { cents: total } : { cents: total, qty: +p[q], unit: cents(p[2 - q]) };
  };
  const items = [], skipped = [];
  // Several on one line with spaces only ("ikan 12 sayur 5 cili 2", "鱼 25 菜 8"): a new item starts after a price when a word
  // follows, unless that word is a unit ("telur 30 biji 12"). A line that starts with a number ("100 Plus 2.50") never splits there.
  const NEXT = /(?<=\p{L}.*\d(?:[.,]\d{1,2})?)(?<!^\s*(?:RM|MYR)\s*[\d.,]+)\s+(?=\p{L})(?!(?:x|kg|g|gm|ml|l|ltr|pcs?|biji|ekor|pek|paket|bungkus|keping|botol|tin|unit|ea|each|packs?|个|斤|包|粒|瓶|块)(?![\p{L}]))/iu;
  for (const l of String(text ?? '').split(/\r?\n|[，、;；]|,(?!\d{3}(?!\d))(?!\d{1,2}(?!\d))/).flatMap(l => l.slice(0, 300).split(NEXT)).map(l => l.trim()).filter(Boolean)) {
    const s = l.replace(/(\d)[.,]-$/, '$1');   // "8.-" is RM 8
    const tail = s.match(tailRe);   // name then price
    const head = s.match(headRe);   // price then name
    const [name, price] = tail ? [tail[1], tail[2]] : head ? [head[2], head[1]] : [];
    const w = name && /\p{L}/u.test(name) ? worth(price) : null;
    if (w?.cents > 0) items.push({ name: name.replace(/[\s:=\-–]+$/, '').slice(0, 80), ...w }); else skipped.push(l);
  }
  return { items, skipped };
}

// Lines at the top that never name the shop: a phone's status bar, headings, order numbers, a card terminal's bank.
const NOT_SHOP = new RegExp([
  /^\d{1,2}:\d{2}\b|\d+\s*%|\d+\.\d{2}\b|\b\d{1,2}\s*[:.]\d{2}\s*(am|pm)\b|\b\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*\d{2,4}/.source,   // times, percentages, amounts, dates
  /order\s*(summary|details|number|no|id|on)|your\s*(order|receipt|payment)|official\s*receipt|tax\s*invoice|deal\s*details|contact\s*support|my\s*purchases|seller\s*will/.source,
  /we'?ll\s*(let|notify)|your\s*seller|hope\s*you\s*enjoy|to\s*make\s*changes|arriv|estimated|preparing|note\s*to\s*driver|^items\W*$|my\s*tickets|\bcopy$|deliver\s*to|track\s*your\s*order|thank\s*you\s*for\s*using|we\s*are\s*pleased|transfer\s*money|successful|pick-?\s*up|dine-?\s*in|visit\s*store|show\s*your\s*qr|collect\s*your|authori[sz]e|exclusive\s*deals|^\W*promotions?\W*$|^\W*step\s*\d/.source,   // app screens' own words
  /ro[lu]n?ding|sub\s*-?t[o0]tal|\bt[o0]tal\b|\bqty\b|kuantiti|delivery|note\s*to|to\s*pay|visit\s*shop|premium|payment\s*successful|tbl\s*no/.source,   // money-part and app-screen words
  /^\W*(invoice|receipt|resit|welcome|selamat|thank|terima\s*kasih|date|time|ticket|table|cashier|pos\s*no|bill\s*no|payment|quantity|description)\b/.source,
  /^(tel|fax|gst|sst|co\.?\s*(no|reg)|reg\.?\s*no|company\s*(no|reg)|registration)|^\(|^\d{3,}|^[\d\W]+$/.source,   // numbers, a "(Perub…)" or "(123456-X)" line
].join('|'), 'i');
const BANK_SLIP = /^(public\s*bank|hong\s*leong|maybank|cimb|rhb|ambank|bank\s*islam|bsn|affin|uob|ocbc|hsbc|alliance\s*bank)/i;
const PAID_WITH = /\bbank\b|e-?wallet|duit\s*now|touch\s*'?\s*n\s*'?\s*go|\btng\b|grab\s*pay|\bboost\b|shopee\s*pay|\bmae\b|master\s*card|\bvisa\b|\bdebit\b|\bamex\b|\bmydebit\b|\bpaynet\b/i;
const ADDRESS = /\b(jalan|jln|lot|no\.?\s*\d+|taman|lorong|level|floor|lg-?\d+|kuala lumpur|selangor|\d{5})\b/i;
const CO_TAIL = /[\s.,]*\(?\b(m|malaysia)?\)?\s*(sd[nh]\.?\s*bh?d|sdnbhd|berhad|bhd)\b.*$/i;   // "(M) SDN. BHD. (123-X)", OCR's "Sdh"
const titleCase = s => (s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s(&/-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()) : s);
/** OCR splits a shop's name over lines: "RESTORAN" / "MAJU JAYA", "ALL IT" / "HYPERMARKET SDN BHD". Put them back together. */
function joinNameLines(lines) {
  const out = [];
  for (const l of lines) {
    const bare = l.replace(CO_TAIL, '').replace(/\b(trading|enterprise|hypermarket|supermarket)\b/gi, '').replace(/[^\p{L}]/gu, '');
    if (out.length && bare.length < 3 && COMPANY.test(l) && !/\d+\.\d{2}/.test(out.at(-1))) out[out.length - 1] += ' ' + l;   // a company word left alone
    else out.push(l.replace(/^i?(restoran)(?=\p{L})/iu, '$1 '));   // "Restoranthoulath", OCR's "Irestoran"
  }
  return out.flatMap((l, i, a) => (/^(restoran|restaurant|kedai(\s*makan)?|rumah\s*makan)$/i.test(l.trim()) && a[i + 1] ? [] : [i && /^(restoran|restaurant|kedai(\s*makan)?|rumah\s*makan)$/i.test(a[i - 1].trim()) ? `${a[i - 1].trim()} ${l}` : l]));
}
// A screenshot of a shopping, delivery or bank app: the phone's status bar on top ("9:37 95%") or an app's own heading.
const appScreen = lines => /^\W*\d{1,2}[:.]\d{2}\b.{0,30}\d{1,3}\s*%/.test(lines[0] ?? '') || lines.slice(0, 12).some(l => /order\s*(summary|details)|booking\s*code|transfer\s*money|deal\s*details/i.test(l));
const PLATFORM = /^(GrabFood|Grab|foodpanda|ShopeeFood)$/;
/** On an app screen the shop is often far down: Shopee by its own words; else any known brand on the screen that isn't the
 *  delivery app; a Grab order's restaurant from its "Name-Branch" line; else the delivery app itself. → name or null. */
function appShop(lines) {
  if (lines.some(l => /shopee(?!\s*pay|\s*food)|on-?\s*time\s*guarantee|preferred\s*\+|shop\s*voucher/i.test(l))) return 'Shopee';
  const brands = lines.filter(l => !PAID_WITH.test(l)).map(l => brandOf([l], 1)).filter(Boolean);
  const shop = brands.find(b => !PLATFORM.test(b)); if (shop) return shop;
  if (brands.length || lines.some(l => /\bgrab\b|\bGF-\d{3}|note\s*to\s*driver/i.test(l))) {
    const dash = lines.slice(0, 20).map(l => l.match(/^([\p{L}][\p{L}\d'&. ]{2,40}?)\s*-\s*(?:rate\s*order|[\p{L}].{2,40})$/u)?.[1]).find(n => n && !ADDRESS.test(n) && !NOT_SHOP.test(n));
    return dash ? titleCase(dash.trim()) : brands[0] || 'Grab';
  }
  return null;
}
/** "HEXTAR LUCKIN M SDN BHD" → Luckin Coffee (a known brand); "RESTORAN MAJU JAYA SDN.BHD (123-X)" → Restoran Maju Jaya. */
export function shopName(lines) {
  // An e-wallet or DuitNow slip names the shop it paid: "Recipient: GERAI MAK TEH".
  const payee = lines.slice(0, 25).map(l => l.match(/^\W*(?:recipient|merchant(?:\s*name)?|paid\s*to|pay\s*to|penerima|payee)\s*[:\-]?\s*([\p{L}\d].{1,60})$/iu)?.[1]).find(n => n && /\p{L}{3}/u.test(n) && !/^name\b/i.test(n));   // "Recipient Name": the label, not a name
  // or puts the name on the line under its label: "Recipient Name" / "NG TECK HIN".
  const under = payee || lines.slice(0, 25).map((l, i) => (/^\W*(?:recipient(?:\s*name)?|name|payee|pay\s*to|merchant\s*name|penerima)\W*$/i.test(l) ? lines[i + 1] : null))
    .find(n => n && /\p{L}{3}/u.test(n) && !/\d[.,]\d{2}/.test(n));
  if (under) return brandOf([under]) || titleCase(under.replace(CO_TAIL, '').trim()).slice(0, 80);
  if (appScreen(lines)) { const n = appShop(lines); if (n) return n; }
  // The bank, card or wallet printed on the slip is how it was paid, never the shop (card-terminal slips put it on top).
  const pool = lines.filter(l => !PAID_WITH.test(l));
  const brand = brandOf(pool) || knownShop(pool.slice(0, 10).filter(l => !ADDRESS.test(l) && !/\d[.,]\d{2}/.test(l)))?.name; if (brand) return brand;   // not "Jalan Setia", not "Cheese Burger 4.50"
  // a lone "Bhd" is no name; on an app screen, nor is a line starting in lower case (a wrapped "code order", "promotions!")
  const app = appScreen(lines), top = joinNameLines(lines.slice(0, 10)).filter(l => !NOT_SHOP.test(l) && !BANK_SLIP.test(l) && /\p{L}{3}/u.test(l.replace(CO_TAIL, '')) && !(app && /^\P{L}*\p{Ll}/u.test(l))).slice(0, 8);
  const co = top.find(l => COMPANY.test(l)) || top.find(l => !ADDRESS.test(l));
  if (!co) return null;
  const name = co.replace(CO_TAIL, '').replace(/\(?\s*(co\.?\s*(no|reg)|company)[^)]*\)?/i, '').replace(/\(\s*[\w-]*\d[\w-]*\s*\)/g, '').replace(/[\s.,:;*-]+$/, '').trim()
    .replace(/\s+(\S{6,})$/, (m, w, at, s) => { const x = s.slice(0, at).toLowerCase().split(/\s+/); return x.some((a, i) => x[i + 1] && w.toLowerCase().includes(a + x[i + 1])) ? '' : m; });   // "GOOD TIMING FOOD VILLAGE MCGOODTIMING SDN BHD": the company, glued on
  return titleCase(name || co).slice(0, 80);
}

export function parseReceipt(text) {
  text = String(text ?? '').normalize('NFKC');   // the Chinese model returns full-width digits: "27/09/２0２6"
  const lines = text.split(/\r?\n/).map(l => l.slice(0, 300).replace(/\s+/g, ' ').trim())   // receipt lines are short: a runaway one can't stall the patterns
    .map(l => l.replace(/\bbarcode\s*:?\s*(?:[0-9][0-9A-Z]{10,13}\b)?/gi, ' ').replace(/\s+/g, ' ').trim())   // "Barcode: 9555C39200019" (OCR's C for 0): never a name
    .map(l => l.replace(/\bRM ?O(?=[.,]\d{2}\b)/gi, 'RM0'))   // "RMO.01": OCR's O for the 0 of a sen amount
    .map(l => ROUNDING.test(l) ? l.replace(/(^|[\s-])O(?=[.,]\d{2}\b)/g, '$10') : l)   // a labelled "ROUNDING -O.02"; never change an item's letters
    // "1,299.00" is one amount: without this the amount patterns read "299.00" and leave "1," in the name, and a total
    // misread the same way still adds up (CORD bench). Commas only: "3 499.00" may be 3 × 499.
    .map(l => l.replace(/(?<![\d.,])(\d{1,3})((?:,\d{3})+)(?=[.,]\d{2}(?!\d))/g, (m, a, b) => a + b.replace(/,/g, '')))
    // Words past a row's price are something beside the slip (a keyboard's "PgDn", a till screen's "WELCOME TO"): their
    // own line, so the price stays at the end of its row. Tax codes (Z, SR) are shorter and stay. When those words are a
    // money label, two columns ran together ("Profile: RM49.99 Subtotal"): the label and its amount are the line.
    .flatMap(l => {
      const m = l.match(/((?:RM|MYR)?\s*-?\d{1,6}[.,]\d{2})\s+(\p{L}{3,}(?:\s+\p{L}+)*)$/u);
      // Only after a bare "Label:" on the left: "AYAM TANDOORI 5.00 TOTAL" is an item with a column heading beside it
      return m && /^(sub\s*-?\s*)?total$/i.test(m[2]) && /^\W*\p{L}[\p{L} ]{0,20}:\s*$/u.test(l.slice(0, m.index)) ? [`${m[2]} ${m[1]}`] : l.replace(/(\d[.,]\d{2})\s+(\p{L}{3,}(?:\s+\p{L}+)*)$/u, '$1\n$2').split('\n');
    })
    .filter(Boolean)
    // "Jumlah Barang" with its "7.50" on the next line: one money line, not an item named "Jumlah Barang"
    .reduce((out, l, i, a) => {
      if (out.skip === i) return out;
      const n = a[i + 1];
      if (n !== undefined && !AMOUNT.test(l) && MONEY_LABEL.test(l) && /^\W*(?:RM|MYR)?\s*-?\d{1,6}[.,]\d{2}\W*$/i.test(n)) { out.push(l + ' ' + n); out.skip = i + 1; } else out.push(l);
      return out;
    }, []);
  const r = { merchant: null, date: null, time: null, items: [], subtotal: null, tax: null, service: null, rounding: null, total: null };
  let pendingName = null; // name line waiting for a "2 x 3.50  7.00" line
  // A shop app's product block: name, variant, "15 Days Free Returns x2", then "RM48.00 RM28.30" (old and new price).
  const app = appScreen(lines);
  let block = [];         // the text lines since the last item or shop header
  let paid = false;       // after TOTAL, the first payment line (Cash, Visa, Change...) ends the money part
  let billOff = 0;        // a discount on the whole bill
  let svcInSub = false;   // a fee printed above the subtotal ("Processing&Delivery Fee") is already inside it
  let prevLine = '', boundary = false, pendingAt = null;   // the line before; an item or column-header line just ended; where pendingName was read
  const below = namesBelow(lines);

  r.merchant = shopName(lines);
  r.shopCat = r.merchant && categoryOf(r.merchant);   // a known shop's usual category (Parkson: shopping)
  r.date = receiptDate(lines);
  for (const line of lines) {
    const before = prevLine, wasBoundary = boundary; prevLine = line; boundary = false;
    if (!r.time) r.time = parseTime(line);
    if (r.total !== null && PAYMENT.test(line)) paid = true;
    if (paid) continue; // payment, change, tax summary follow. Only the date is still wanted.

    const m = line.match(AMOUNT);
    const label = m ? line.slice(0, m.index).trim() : line;
    if (!m) {
      if (app) block = /^\W*(preferred|mall)\b|visit\s*shop|chat\s*now|\bto\s*(ship|receive|pay)\b|order\s*summary/i.test(line) ? [] : [...block, line];   // a shop's header ("… To Ship"), or the tabs
      // "Item (s):1 Qty(s):1" is a footer and "QTY ITEM", "Table: 8", "Payment :" are headers: never an item's name
      const hasText = /[a-z]{2}/i.test(line) && !COUNT.test(line) && !BADGE.test(line) && !/^(qty|quantity|item|description|table|payment|purchased|order|cashier|kuantiti|t?otal\s*items?)\b/i.test(line);
      const last = r.items.at(-1);
      if (hasText && last && last.name === null) { last.name = last.pre ? `${last.pre} ${line}` : line; delete last.pre; pendingName = null; } // name printed under the price (its first half above it, when the price sat between)
      else { pendingName = hasText ? (pendingName && r.items.length && line.length <= 14 && pendingName.length < 40 && !TOTAL.test(line) && !PAYMENT.test(line) ? `${pendingName} ${line}` : line) : null; }   // a name wrapped onto a short second line ("SPECIAL"): both halves; never the shop's header
      if (!hasText && /^\s*(qty|quantity|item|description)\b/i.test(line)) boundary = true;   // a column header: what follows starts an item
      else if (pendingName === line) pendingAt = wasBoundary;
      continue;
    }
    const cents = toCents(m);
    // "Total Saving 0.00 Total 77.20": classify by the words after the last number
    const key = label.replace(/^.*\d[.,]\d{2}\s*/, '') || label;

    // "6.0 % RM 3.14" under a "Tax  Tax Amount" heading: the rate alone on the line, the word on the line above
    const adj = ROUNDING.test(key) ? 'rounding' : SERVICE.test(key) ? 'service' : TAX.test(key) || (/^\W*\d{1,2}(?:[.,]\d+)?\s*%\W*$/.test(key) && TAX.test(before)) ? 'tax' : null;
    // Money off first: "Shipping Discount Subtotal -4.90" and "Shopee Voucher -5.00" are discounts, not the subtotal.
    // Money off: a negative amount, or a short line led or ended by the word ("MEMBER DISC 2.00", "Voucher 5.00");
    // "MILO PROMO PACK 17.50" and "TNG RELOAD VOUCHER 50.00" are things bought.
    // On an app, a positive price on a "Voucher Applied" line is what was paid for the product above, not money off
    const offWord = cents < 0 || (!(app && /^\W*voucher\s*applied\W*$/i.test(key)) && key.split(/\s+/).length <= 3 && (DISCOUNT.test(key.split(/\s+/)[0]) || DISCOUNT.test(key.split(/\s+/).at(-1))));
    const offKey = DISCOUNT.test(key) && offWord;
    const off = offKey && !!cents && r.total === null && !/^\W*(sub\s*-?\s*)?t[o0]tal\b/i.test(key);
    if (off && r.subtotal === null && r.items.length) r.items.push({ name: 'Discount', cents: -Math.abs(cents) });
    else if (off) billOff += Math.abs(cents);
    // Watsons: "SUBTOTAL 19.14, ROUNDING 0.01, SUBTOTAL 19.15": the second one, rounded, is what was paid.
    else if (SUBTOTAL.test(key) && !adj) { if (r.total === null && r.rounding && r.subtotal !== null && cents === r.subtotal + r.rounding) r.total = cents; else r.subtotal = cents; }
    else if (SUBTOTAL.test(key)) r[adj] = (r[adj] ?? 0) + cents;   // "Shipping Subtotal 4.90" is a charge, not the items' subtotal
    else if (TOTAL.test(key) && NOT_TOTAL.test(key)) { /* a count or group total: skip */ }
    else if (TOTAL.test(key) && r.total !== null && /\b(SGD|USD|EUR|GBP|IDR|THB|RMB|CNY|JPY|AUD|HKD)\b|S\$|US\$/i.test(line)) { /* the same total in another currency, printed after ours */ }
    else if (TOTAL.test(key) && (!adj || TOTAL_WINS.test(key))) r.total =Math.max(Math.abs(cents), ...amountsIn(line)); // "Total (incl Tax) 17.80 0.00"; "RM-38.80" is OCR noise
    else if (!adj && r.subtotal !== null && /^\W*amount\s*[:：]?\s*$/i.test(key)) r.total = Math.abs(cents);   // an e-mail receipt's last line, "Amount: RM 55.45"
    else if (adj) { r[adj] = (r[adj] ?? 0) + cents; if (adj === 'tax' && /incl/i.test(key)) r.taxIncluded = true; if (adj === 'service' && r.subtotal === null && r.items.length) svcInSub = true; }
    else if (DISCOUNT.test(key) && !cents) { /* "Discount 0.00": nothing to record */ }
    else if (offKey && r.subtotal === null && r.total === null && r.items.length) r.items.push({ name: 'Discount', cents: -Math.abs(cents) });   // its own line, always money off ("-0.20", read "~0.20")
    else if (offKey && cents && r.total === null) billOff += Math.abs(cents);   // "Member discount -5.00" between subtotal and total
    else if (cents < 0 && r.subtotal !== null && r.total === null) billOff += -cents;   // "1 Frappe (any flavor) -9.50": a promotion between subtotal and total
    else if (r.subtotal === null && r.total === null && !COUNT.test(label)) { // items stop at the subtotal or first real total
      const name = label.replace(QTY, '').trim();
      // "2587 1.00 PCS 48.00": code, qty and price; "RM48.00 RM28.30": a shop app's old and new price. The name is elsewhere
      const qtyOnly = !/[a-z]{2}/i.test(bareName(name.replace(/(?:RM|MYR)\s*\d+[.,]\d{2}/gi, '')));
      // On a shop app, a price with no name of its own ("RM48.00 RM28.30", "15 Days Free Returns RM44.00") belongs to the
      // product block above it: the name from its first line, the quantity from its "x2" line (the price is for one).
      // also a badge or an old price with only a scrap of the variant left ("SPcs RM175.00", OCR's 5Pcs)
      const XN = /\bx\s*(\d{1,2})\s*$/i, badgeOnly = (BADGE.test(name) || /(?:RM|MYR)\s*\d/i.test(name))
        && name.replace(BADGE, '').replace(/(?:RM|MYR)\s*\d+[.,]\d{2}/gi, '').replace(/[^a-z]/gi, '').length <= 4;
      // the product's own line may carry its quantity ("Velvet Latte x1"): the name is what comes before it
      const product = app && (qtyOnly || badgeOnly) && block.map(l => l.replace(XN, '').trim()).find(l => /\p{L}{3}/u.test(l) && !BADGE.test(l));
      const times = product ? +(block.findLast(l => XN.test(l))?.match(XN)[1] ?? 1) : 1;
      // Number-only line: its name is the line above, or (code-qty-price layout) the line below, filled in above
      const unit = line.match(UNIT_ONLY);   // "2 x 10.90" with no line total: the total is on the line next to it
      const prev = r.items.at(-1);
      if (NOT_ITEM.test(line)) { /* a rider's plate and rating, a drink's options: not bought */ }
      else if (qtyOnly && !unit && prev?.q && prev.q * prev.cents === cents) { prev.cents = cents; delete prev.q; }   // "2 x 10.90" then "21.80": one item
      else if (product) r.items.push({ name: product, cents: cents * times, ...(times > 1 ? { one: cents } : {}) });
      else r.items.push({ name: qtyOnly ? (below ? null : pendingName) : name, cents, ...(unit ? { q: +unit[1] } : {}), ...(qtyOnly && below && pendingName && pendingAt && pendingName === before ? { pre: pendingName } : {}) });
      boundary = !qtyOnly;   // an item line with its own name: the next text line starts a new item
    }
    pendingName = null; block = [];
  }
  if (r.total === 0) r.total = null;   // "Total (MYR) 0.00" on tax-inclusive templates is never what was paid
  if (r.total === null) guessTotal(r, lines, svcInSub);
  // Cash rounding: 68.12 is paid as 68.10. When the rounded amount is printed too, that is the total.
  if (r.total > 0 && r.total % 5) {
    const r5 = Math.round(r.total / 5) * 5;
    if (lines.some(l => amountsIn(l).includes(r5))) { r.rounding = r.rounding === r5 - r.total ? r.rounding : (r.rounding ?? 0) + r5 - r.total; r.total = r5; }   // a printed "ROUNDING 0.01" is this same step
  }
  // A tax line printed after the payment ("TOTAL 6% Service Tax 0.98" under "Cash 20.00") counts only when it is exactly
  // the gap between the subtotal and the total: a tax summary table there never adds a guess.
  if (r.tax === null && r.subtotal !== null && r.total > r.subtotal) {
    const gap = r.total - r.subtotal - (svcInSub ? 0 : r.service ?? 0) - (r.rounding ?? 0);
    if (gap > 0 && lines.some(l => TAX.test(l) && amountsIn(l).includes(gap))) r.tax = gap;
  }
  // A misread line can land in tax/service/rounding: none can be a third of the bill, and rounding is at most 5 sen.
  if (r.total) for (const k of ['tax', 'service']) if (Math.abs(r[k] ?? 0) * 3 > r.total) r[k] = null;
  if (Math.abs(r.rounding ?? 0) > 5) r.rounding = null;
  // "2 x 10.90" next to "21.80" (above or below it) is one item of 21.80, named from whichever line has the name.
  for (let i = 0; i < r.items.length; i++) {
    const u = r.items[i]; if (!u.q) continue;
    const j = [i + 1, i - 1].find(k => r.items[k] && !r.items[k].q && r.items[k].cents === u.q * u.cents);
    if (j !== undefined) { r.items[j].name ||= u.name; r.items.splice(i--, 1); }
  }
  // A shop app's "x1" read as "X7": when the printed subtotal matches the prices taken once, they were once.
  const sum = list => list.reduce((s, it) => s + it.cents, 0);
  if (r.subtotal !== null && sum(r.items) !== r.subtotal) {
    const odd = r.items.find(it => it.one && sum(r.items) - it.cents + it.one === r.subtotal);   // the one misread
    if (odd) odd.cents = odd.one;
    else if (sum(r.items.map(it => ({ cents: it.one ?? it.cents }))) === r.subtotal) for (const it of r.items) it.cents = it.one ?? it.cents;
  }
  for (const it of r.items) { delete it.q; delete it.one; delete it.pre; }
  for (const it of r.items) if (it.name) it.name = cleanName(it.name);
  r.items = dropSummaryLines(r.items);
  // An app's one-item order with no price beside it (McDonald's): the line under "Order Summary", at the subtotal.
  if (app && !r.items.length && r.subtotal > 0) {
    const at = lines.findIndex(l => /order\s*summary|your\s*order\b/i.test(l));
    const name = at >= 0 && lines.slice(at + 1, at + 4).find(l => /\p{L}{3}/u.test(l) && !AMOUNT.test(l) && !NOT_SHOP.test(l));
    if (name) r.items.push({ name: name.trim(), cents: r.subtotal });   // not cleanName: "10pcs" isn't a quantity 1
  }
  r.check = checksum(r);
  // An app's voucher line under a price it already took off ("Voucher Applied -RM 9.01" under RM 4.99): only a note.
  if (app && !r.check.ok && r.items.some(i => i.cents < 0)) { const kept = r.items; r.items = kept.filter(i => i.cents > 0); r.check = checksum(r); if (!r.check.ok) { r.items = kept; r.check = checksum(r); } }
  // A summary line misread past recognition ("Qty 4.50" read as "aly 4.50"): the last line is the sum of those above it.
  if (!r.check.ok && r.items.length > 1) {
    const last = r.items.at(-1);
    if (last.cents === r.items.slice(0, -1).reduce((s, i) => s + i.cents, 0)) { r.items.pop(); r.check = checksum(r); if (!r.check.ok) { r.items.push(last); r.check = checksum(r); } }
  }
  // A whole-bill discount is a line of its own when the receipt adds up with it and not without ("You saved 5.00" is often already in the subtotal).
  if (billOff && !r.check.ok) { const d = { name: 'Discount', cents: -billOff }; r.items.push(d); r.check = checksum(r); if (!r.check.ok) { r.items.pop(); r.check = checksum(r); } }
  r.pay = payKind(lines);
  // A return window or warranty printed on the slip ("exchange & refund within 3 days", "1 year warranty"): offered as a reminder.
  const all = lines.join(' ');
  const ret = all.match(/(?:return|exchange|refund|pemulangan|tukar(?:an)?|退换|退貨|退货)[^.]{0,60}?(?:within|dalam(?:\s+tempoh)?|in)\s*(\d{1,3})\s*(?:days?|hari)|(\d{1,3})\s*(?:days?|hari)\s*(?:return|exchange|refund|pemulangan)|(\d{1,3})\s*天[内內]?(?:退|换)/i);
  if (ret) r.returnDays = +(ret[1] || ret[2] || ret[3]);
  const war = all.match(/(\d{1,2})\s*(years?|yrs?|tahun|months?|mths?|bulan|年|个月|個月)\s*(?:limited\s*)?(?:warranty|waranti|jaminan|保修|保固)|(?:warranty|waranti|jaminan|保修|保固)\s*[:：]?\s*(\d{1,2})\s*(years?|yrs?|tahun|months?|mths?|bulan|年|个月|個月)/i);
  if (war) { const n = +(war[1] || war[3]), u = war[2] || war[4]; r.warrantyMonths = /^(y|t|年)/i.test(u) ? n * 12 : n; }
  if (r.returnDays > 365) delete r.returnDays;
  if (!(r.warrantyMonths > 0 && r.warrantyMonths <= 120)) delete r.warrantyMonths;
  // Printed in Singapore dollars (a JB commuter's FairPrice receipt): it goes to an SGD account when there is one.
  r.currency = lines.some(l => /\bS\$|\bSGD\b|\bsingapore\b|\bpaynow\b|\bUEN\b|\bnets\b/i.test(l)) ? 'SGD' : 'MYR';
  // A meal out: a service charge, or a table, pax, dine-in or take-away line. Its eggs and rice are dishes, not groceries.
  r.meal = r.service != null || lines.some(l => /\b(table|meja|pax|dine[- ]?in|take[- ]?away|takeaway|bungkus|tapau|makan sini|server|waiter)\b|堂食|外带|外帶|桌号|桌號/i.test(l));
  // A refund or return slip is money back, not spending (words only: a "-38.80" alone is often OCR noise).
  // A title line ("REFUND RECEIPT", "CREDIT NOTE", "退货单") or a refund total; never "No refund after 30 days".
  r.refund = lines.some(l => /^\W*(refund|return(ed)?|credit note|nota kredit|pemulangan|bayaran balik|退款|退货|退貨)(\s*(receipt|slip|note|invoice|resit|单|單))?\W*$/i.test(l) || /\b(total\s*refund(ed)?|refund\s*(amount|total))\b/i.test(l));
  if (r.refund) { for (const it of r.items) it.cents = Math.abs(it.cents); r.check = checksum(r); }   // a refund slip prints -42.90: the money back, as positive lines
  return r;
}
/** How it was paid, from the payment line: 'card', 'ewallet' or 'cash' (null when the receipt doesn't say).
 *  A card or wallet line wins over cash: "CASH BILL" / "CASH SALE" is a receipt title, not how it was paid. */
export function payKind(lines) {
  // A debit card (MyDebit, NETS in Singapore) is the bank account; a credit card is the card.
  if (lines.some(l => /\b([mh]y ?debit|debit ?card|kad debit|nets|eftpos)\b|扣账卡/i.test(l))) return 'debit';
  if (lines.some(l => /\b(visa|master ?card|amex|credit ?card|kad kredit|card ?no|contactless|paywave)\b|信用卡/i.test(l))) return 'card';
  if (lines.some(l => /touch ?'?n ?go|\btng\b|e-?wallet|grab ?pay|\bboost\b|shopee ?pay|duitnow|\bmae\b|setel|big ?pay|电子钱包/i.test(l))) return 'ewallet';
  if (lines.some(l => /^(cash|tunai|现金|現金)\b(?! ?(bill|sale|sales|receipt))(.*\d|\s*[:：]?\s*$)/i.test(l))) return 'cash';   // "CASH 95.00", or "CASH" with the amount on the next line
  return null;
}

const amountsIn = line => [...line.matchAll(ALL_AMOUNTS)].map(m => +m[1] * 100 + +m[2]);
// The money part of a receipt that OCR misspelt, so it slipped into the items: "SUBTUTAL", "AHOUNT", "TOTAAMN",
// "GRAND TOTAI.", "TTL"; and payment / tax / rounding lines (card slips print them between the items and the total).
const SUMMARY_NAME = /^\W*(sub\s*-?\s*t[o0u]t[ao]?[l1i]?|grand\s*t[o0]t|t[o0]t[a4]?[l1iat]?(?![a-z]{3})|t[o0]ta\S*\s*(items?|amount|amt)|ttl\b|a[mh][o0]u?n?t\b|total\s*amount|taxable|item\s*qty)/i;
const MONEY_NAME = /^\W*(r[o0]u?n?d|f[o0]und(?:ing|ng)?\b|change|balance\b|cash\b|card\b|c?<+\s*card|visa|master|credit|debit|duit\s*now|a*duitnow|tendered|payment|ringgit\s*malaysia|items?\s*sold|service\s*(tax|charge)|serv\.?\s*charge|tax\s*\d|sst\b|gst\b|ixn\s*ref|rm$|qty$)/i;
/** Items end where the money part starts: a (misspelt) total line and everything after it goes; payment, tax and
 *  rounding lines go wherever they are. A real item never has a name like these. */
export function dropSummaryLines(items) {
  const end = items.findIndex(i => i.name && SUMMARY_NAME.test(i.name));
  return (end < 0 ? items : items.slice(0, end)).filter(i => !(i.name && MONEY_NAME.test(i.name)));
}
/** An item name as people read it: no barcode or SKU in front ("4208915 SAN REMO"), no unit price behind ("(4.50/ea)"), no glued quantity ("1x Teh O",
 *  "1NESCAFE"), and OCR's 0 inside a word back to O ("0NE ZER0THIN" → "ONE ZEROTHIN"). */
export const cleanName = n => n.replace(/\s*@\s*\d+[.,]\d{2}\b/g, '').replace(/(?<=[A-Za-z)])(?<![Rr][Mm])\s*\d+[.,]\d{2}(\s+[x×]?\d{1,3})?\s*$/, '')   // a unit price (and qty) left in the name: "ICED TEA 1.20 5", "@200.00"
  .replace(/\s+(unit|units|pkt|pkts|pck|ea)$/i, '').replace(/^\d{4,}\s*(?=\S)/, '').replace(/\s*\(\s*\d+\.\d{2}\s*\/\s*(ea|each|pc|pcs|unit)\s*\)/i, '').replace(/^\d{1,2}\s*[x×]\s+/i, '').replace(/^1\s+(?=(?:\d+\s*)?[A-Za-z]{3})/, '').replace(/^1(?=[A-Za-z][A-Za-z])/, '').replace(/^1(?=0[A-Za-z]{2})/, '')
  .replace(/(?<=[A-Za-z])0(?![\d.,])|(?<![\dA-Za-z.])0(?=[A-Za-z]{2})/g, 'O')
  .replace(/(?<=\d[0O]*)O(?=[0O]*(?:\d|ML|G|KG|L|S|PCS|PC|X)\b)/g, '0').trim() || n;   // and O inside a number back to 0: "1OS", "50OML", "5OPCS"   // "20OZ" keeps its digits
/**
 * No "Total" line (e-wallet and bank slips, torn receipts): subtotal plus adjustments, else the amount printed
 * most often (slips repeat it), else the largest RM amount. Marked totalGuessed so the review screen flags it.
 */
function guessTotal(r, lines, svcInSub) {
  const on = re => { for (const l of lines) if (re.test(l)) { const a = amountsIn(l).filter(c => c > 0); if (a.length) return a.at(-1); } return null; };
  const cash = on(/\b(cash|tunai)\b(?!\s*(back|out))/i), change = on(/\b(change|baki)\b/i);
  const paid = on(/\b(my\s*debit|visa|master|amex|card|e-?wallet|grab\s*pay|boost|tng|touch\s*'?n|duit\s*now|qr\s*pay|shopee\s*pay|debit|credit)\b/i);
  if (r.subtotal !== null) r.total = r.subtotal + (svcInSub ? 0 : r.service ?? 0) + (r.taxIncluded ? 0 : r.tax ?? 0) + (r.rounding ?? 0);
  else if (cash && change !== null && cash > change) r.total = cash - change;   // no Total line: what was handed over, less the change
  else if (paid) r.total = paid;   // a card or e-wallet line carries the amount charged
  else {
    const count = new Map();
    for (const l of lines) for (const c of new Set(amountsIn(l))) if (c > 0) count.set(c, (count.get(c) || 0) + 1);
    const rep = [...count].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    const rm = lines.flatMap(l => [...l.matchAll(/(?:RM|MYR)\s*(\d{1,6})[.,](\d{2})/gi)].map(m => +m[1] * 100 + +m[2])).sort((a, b) => b - a)[0];
    r.total = rep?.[0] ?? rm ?? null;
  }
  if (r.total !== null) r.totalGuessed = true;
}

const isText = l => l !== undefined && /[a-z]{2}/i.test(l) && !AMOUNT.test(l);
const isQtyOnly = l => { const m = l.match(AMOUNT); return !!m && !/[a-z]{2}/i.test(bareName(l.slice(0, m.index).replace(QTY, ''))); };

// One layout per receipt: are item names printed above or below number-only lines? Vote over the receipt.
// Tie: if the first number-only line is also the first money line, the text above it is the header, so names are below.
function namesBelow(lines) {
  const end = lines.findIndex(l => SUBTOTAL.test(l) || (TOTAL.test(l) && AMOUNT.test(l)));   // only the item block: a tax summary after the total votes nothing
  if (end > 0) lines = lines.slice(0, end);
  let above = 0, below = 0, first = -1;
  lines.forEach((l, i) => {
    if (!isQtyOnly(l)) return;
    if (first < 0) first = i;
    if (isText(lines[i - 1])) above++;
    if (isText(lines[i + 1])) below++;
  });
  if (below !== above) return below > above;
  // Tie (text both sides of every number line): the line after the LAST number line decides. A footer there
  // (Total, Item(s): 5, Subtotal) means each name sits above its numbers (Mr DIY, Giant); item text means below.
  const last = lines.reduce((k, l, i) => (isQtyOnly(l) ? i : k), -1), after = lines[last + 1];
  if (last >= 0 && after !== undefined) return !(COUNT.test(after) || TOTAL.test(after) || SUBTOTAL.test(after) || !isText(after));
  return first >= 0 && lines.findIndex(l => AMOUNT.test(l)) === first; // ponytail: vote heuristic; per-merchant layout memory if it misfires
}

// Does items + adjustments equal the printed total? Tries tax-exclusive, then tax-inclusive (retail SST "included").
export function checksum(r) {
  if (r.total === null) return { ok: false, mode: 'no total', diff: null };
  const items = r.items.reduce((s, i) => s + i.cents, 0);
  const round = r.rounding ?? 0, svc = r.service ?? 0, tax = r.tax ?? 0;
  const modes = [
    ['tax added', items + svc + tax + round],
    ['tax included', items + svc + round],
  ];
  for (const [mode, sum] of modes) if (sum === r.total) return { ok: true, mode, diff: 0 };
  return { ok: false, mode: 'mismatch', diff: r.total - modes[0][1] };
}
