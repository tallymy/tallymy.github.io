// Bounded, sequential receipt passes around the existing OCR model.
import { readAligned, zoomPaper } from './align.js';
import { rowsOf, parseReceipt } from './parse.js';
import { sections, cropPixels, mergeSections, enlarge, flattenPaper } from './receipt-image.js';

export async function detectSections(detect, raw) {
  const groups = [];
  for (const area of sections(raw.width, raw.height)) groups.push({ area, texts: (await detect(cropPixels(raw, area))).texts });
  return { texts: mergeSections(groups) };
}
export function reading(boxes) {
  const lines = layoutRows(rowsOf(boxes)), text = lines.map(l => l.text).join('\n'), receipt = parseReceipt(text);
  // A balance screen is not evidence of a purchase, even when its figures happen to add up.
  if (/account\s*overview|available\s*balance|account\s*balance/i.test(text.replace(/ACCOUNTOVERVIEW/gi,'ACCOUNT OVERVIEW')) && !/receipt|invoice|payment\s*(successful|received|completed)|transaction\s*(successful|details)|paid\s*(to|on)|merchant|purchase/i.test(text)) {
    Object.assign(receipt, parseReceipt(''), { notReceipt: true });
  }
  return { lines, text, receipt };
}
export function layoutRows(lines) {
  const amount = s => { const m = String(s).match(/^(?:RM\s*)?(\d{1,6})[.,](\d{2})$/i); return m ? +m[1] * 100 + +m[2] : null; };
  return lines.map(line => {
    const words = line.words || [], end = words.at(-1), unit = words.at(-2);
    if (words.length < 4 || /total|jumlah|tax|sst|service|discount|saving|round|cash|change|tender/i.test(line.text)) return line;
    const price = amount(end.text), each = amount(unit.text);
    if (!price || !each || (end.conf ?? 0) < 0.85 || (unit.conf ?? 0) < 0.85) return line;
    const qtyIndex = words.slice(0, -2).findIndex(w => /^\d{1,2}(?:[.,]\d{1,3})?$/.test(w.text.trim()));
    if (qtyIndex < 0) return line;
    const quantity = +words[qtyIndex].text.replace(',', '.');
    if (!(quantity > 0 && quantity <= 99) || Math.abs(Math.round(quantity * each) - price) > 1) return line;
    const name = words.slice(0, -2).filter((_, n) => n !== qtyIndex).map(w => w.text).join(' ').trim();
    if (!/\p{L}/u.test(name)) return line;
    // Only remove redundant numeric columns when their relationship is confirmed by the printed values.
    return { ...line, text: `${name} ${(price / 100).toFixed(2)}`, originalText: line.text, quantity, unit: each };
  });
}
export function retryAreas(lines, receipt, width, height) {
  const money = /\d[.,]\d{2}/, label = /total|jumlah|amount\s*due|nett|grand/i;
  const chosen = lines.filter(l => money.test(l.text) && l.conf < 0.85);
  if (!receipt.check.ok || receipt.total == null) {
    for (const l of lines.filter(l => label.test(l.text))) if (!chosen.includes(l)) chosen.push(l);
  }
  return chosen.sort((a, b) => a.conf - b.conf).slice(0, 4).map(l => {
    const y = Math.max(0, Math.floor(l.y - l.h * 1.4)), bottom = Math.min(height, Math.ceil(l.y + l.h * 1.4));
    return { x: 0, y, w: width, h: bottom - y, centre: l.y, lineHeight: l.h };
  });
}
export function acceptRetry(before, after) {
  const a = before.receipt, b = after.receipt;
  if (!b.items.length || (a.check.ok && !b.check.ok) || b.items.length < a.items.length || (a.date && a.date !== b.date)) return false;
  // A clear printed total is never changed just to force the arithmetic to agree.
  if (a.total != null && a.total !== b.total && before.lines.some(l => /total|jumlah|amount\s*due|nett|grand/i.test(l.text) && l.conf >= 0.9)) return false;
  const uncertain = r => r.lines.filter(l => /\d[.,]\d{2}/.test(l.text) && l.conf < 0.85).length;
  const confidence = r => r.lines.reduce((s, l) => s + l.conf, 0) / Math.max(1, r.lines.length);
  return (!a.check.ok && b.check.ok) || (a.check.ok === b.check.ok && uncertain(after) < uncertain(before) && confidence(after) > confidence(before));
}
export function annotate(r, height) {
  const used = new Set();
  for (const item of r.receipt.items) {
    // Consume each source row once so repeated products retain their own photo band and confidence.
    let index = r.lines.findIndex((l, n) => !used.has(n) && item.name && l.text.includes(item.name));
    if (index < 0) index = r.lines.findIndex((l, n) => !used.has(n) && !/subtotal|total|jumlah|cash|tender|change|service|sst|rounding|tax/i.test(l.text) && [...l.text.matchAll(/(-)?(\d{1,6})[.,](\d{2})/g)].some(m => (+m[2] * 100 + +m[3]) * (m[1] ? -1 : 1) === item.cents));
    const line = r.lines[index]; if (line) used.add(index);
    const conf = line?.conf ?? 0;
    item.flag = !item.name || conf < 0.85 || item.cents === 0;
    const moneyWords = line?.words?.filter(w => /\d[.,]\d{2}/.test(w.text)) || [];
    item.priceFlag = (moneyWords.length ? Math.min(...moneyWords.map(w => w.conf)) : conf) < 0.85 || item.cents === 0;
    const nameWords = line?.words?.filter(w => !/\d[.,]\d{2}/.test(w.text)) || [];
    item.nameFlag = !item.name || (nameWords.length ? Math.min(...nameWords.map(w => w.conf)) : conf) < 0.85;
    if (line?.quantity) { item.qty = line.quantity; item.unit = line.unit; }
    if (line) item.crop = { t: Math.max(0, (line.y - line.h) / height), b: Math.min(1, (line.y + line.h) / height) };
  }
  return r;
}
export async function readDocument(detect, original, onStage = () => {}, corners = null) {
  const raw = corners ? flattenPaper(original, corners) : original;
  const aligned = await readAligned(x => detectSections(detect, x), raw, onStage);
  let pixels = aligned.raw, boxes = aligned.texts, best = reading(boxes), tries = aligned.tries;
  if (best.receipt.notReceipt) return { ...aligned, receipt: best.receipt, text: best.text, retried: 0 };
  const areas = retryAreas(best.lines, best.receipt, pixels.width, pixels.height);
  for (const area of areas) {
    onStage('zoom');
    for (const contrast of [false, true]) {
      const cropped = cropPixels(pixels, area), enlarged = enlarge(cropped, 2, contrast), result = await detect(enlarged); tries++;
      const local = result.texts.map(b => ({ ...b, box: b.box.map(([x, y]) => [x * cropped.width / enlarged.width, y * cropped.height / enlarged.height + area.y]) }));
      // Replace only the middle row, leaving adjacent context intact.
      const centreOf = b => b.box.reduce((s, p) => s + p[1], 0) / 4;
      const middle = b => Math.abs(centreOf(b) - area.centre) <= area.lineHeight * 0.65;
      const candidate = [...boxes.filter(b => !middle(b)), ...local.filter(middle)], next = reading(candidate);
      if (acceptRetry(best, next)) { boxes = candidate; best = next; }
    }
  }
  if (!best.receipt.check.ok && (best.receipt.items.length || best.receipt.total == null)) {
    onStage('zoom');
    const closer = zoomPaper(pixels), second = await readAligned(x => detectSections(detect, x), closer, onStage), next = reading(second.texts); tries += second.tries;
    if (acceptRetry(best, next)) { boxes = second.texts; best = next; pixels = second.raw; }
  }
  annotate(best, pixels.height);
  return { ...aligned, raw: pixels, texts: boxes, tries, receipt: best.receipt, text: best.text, retried: areas.length };
}
