// Reading a receipt photo on the phone: PaddleOCR (vendored, ~30 MB, loaded on first scan and cached offline),
// then the Malaysian receipt parser. Nothing is uploaded.
import { isNative } from './native.js';
import { parseReceipt, rowsOf } from './parse.js';
import { imageInfo, LIMITS } from './io.js';

// OCR runs in a worker (js/ocr-worker.js): the screen stays responsive, and the page keeps a strict CSP.
let worker = null, loading = null, ready = false, seq = 0;
const pending = new Map();
/** One OCR request. A worker that doesn't answer within 2 minutes (first run includes the 30 MB download) is reset. */
function call(raw, onStage = () => {}, zoom = false) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reset(); reject(new Error('The receipt reader stopped responding. Try again.')); }, 120_000);
    pending.set(id, { stage: onStage, resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    worker.postMessage({ id, raw, zoom });
  });
}
function reset() { worker?.terminate(); worker = null; loading = null; ready = false; for (const p of pending.values()) p.reject(new Error('reset')); pending.clear(); }
export const ocrReady = () => ready;
/** The reading bar, 0–95 %: ms so far against the expected ms. Eases out and never ends before the read does. */
export const readPct = (el, est) => Math.round(95 * (1 - Math.exp(-2 * el / est)));
// What the reader needs, with sizes for when a server sends no Content-Length. ponytail: update the sizes with the vendor files.
const FILES = [['../vendor/ocr.js', 10373807], ['../vendor/ort-wasm-simd-threaded.wasm', 14239897], ['../vendor/ort-wasm-simd-threaded.mjs', 24381],
  ['../models/ch_PP-OCRv4_det_infer.onnx', 4745517], ['../models/ch_PP-OCRv4_rec_infer.onnx', 10822323], ['../models/ppocr_keys_v1.txt', 26249]].map(([p, n]) => [new URL(p, import.meta.url).href, n]);
export const OCR_BYTES = FILES.reduce((s, [, n]) => s + n, 0);
let onProgress = () => {};
/** Called with (bytes so far, total) while the reader downloads. */
export const ocrProgress = f => { onProgress = f; };
/** Is the reader already saved on this phone? (Only knowable where the service worker keeps it.) */
export const ocrSaved = async () => 'caches' in globalThis && !!(await caches.match(FILES[4][0]).catch(() => null));
async function prefetch() {
  let done = 0;
  for (const [url, size] of FILES) {
    if ('caches' in globalThis && await caches.match(url).catch(() => null)) { done += size; onProgress(done, OCR_BYTES); continue; }
    const res = await fetch(url).catch(() => null);   // offline: the same plain message, not "Failed to fetch"
    if (!res) throw new Error('The receipt reader could not be downloaded. Check the connection and try again.');
    if (!res.ok || !res.body) throw new Error('The receipt reader could not be downloaded. Check the connection and try again.');
    const reader = res.body.getReader(), start = done;
    for (;;) { const { done: end, value } = await reader.read(); if (end) break; done += value.length; onProgress(Math.min(done, OCR_BYTES), OCR_BYTES); }
    done = start + size;
  }
  onProgress(OCR_BYTES, OCR_BYTES);
}
/** Start the OCR worker and load the models once (about 1 s from cache, longer on the first download). */
export function loadOcr() {
  loading ||= (async () => {
    await prefetch();
    const workerUrl = new URL('./ocr-worker.js', import.meta.url);
    if (isNative) workerUrl.searchParams.set('threads', '1');
    worker = new Worker(workerUrl, { type: 'module' });
    worker.onmessage = ({ data }) => { const p = pending.get(data.id); if (!p) return; if (data.stage) return p.stage(data.stage); pending.delete(data.id); data.error ? p.reject(new Error(data.error)) : p.resolve(data); };
    worker.onerror = e => { e.preventDefault?.(); const err = new Error(e.message || 'The receipt reader failed to start.'); for (const p of pending.values()) p.reject(err); pending.clear(); reset(); };
    await call(null); // warm up: loads the models
    ready = true;
  })().catch(e => { loading = null; throw e; });
  return loading;
}

async function bitmap(file) {
  if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|heic)$/i.test(file.name)) throw new Error('not an image');
  if (file.size > LIMITS.photoBytes) throw new Error('too big');
  // 50 megapixels at most, read from the header before decoding. ponytail: JPEG and PNG only; WebP/HEIC rely on the 40 MB cap.
  const info = imageInfo(new Uint8Array(await file.slice(0, 1 << 20).arrayBuffer()));
  if (info && info.w * info.h > LIMITS.pixels) throw new Error('too many pixels');
  return createImageBitmap(file, { imageOrientation: 'from-image' });
}
function draw(bmp, maxSide) {
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}

/** A canvas turned by quarter turns and then by -angle degrees about its centre (white corners): js/align.js on a canvas. */
function straightened(src, turns, angle) {
  const c = document.createElement('canvas'), q = turns % 2;
  c.width = q ? src.height : src.width; c.height = q ? src.width : src.height;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.translate(c.width / 2, c.height / 2); g.rotate((turns * 90 - angle) * Math.PI / 180); g.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}
const shrink = (src, maxSide) => { const s = Math.min(1, maxSide / Math.max(src.width, src.height)), c = document.createElement('canvas'); c.width = Math.round(src.width * s); c.height = Math.round(src.height * s); c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); return c; };
/** OCR boxes → rows with the lowest confidence of the boxes in each row: parse.js's own, so the benches read like the app. */
const rows = rowsOf;

/**
 * Photo → {receipt, text, photo, ms, turns, angle, tries}. receipt is parseReceipt's result, with item.flag set when the item is
 * worth a second look (low OCR confidence, no name, or a zero price).
 * photo is a re-encoded JPEG (max 1200 px): smaller, and the location data in the original is dropped.
 * onStage: 'prep', 'read', then 'turn' / 'straighten' when the photo needs another pass.
 */
export async function readReceipt(file, onStage = () => {}) {
  const t0 = performance.now();
  const bmp = await bitmap(file);
  await loadOcr();
  onStage('prep');
  const c = draw(bmp, 2000);
  const { data, width, height } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  onStage('read');
  const aligned = await call({ data, width, height }, onStage); // the worker aligns (js/align.js) and reads
  let lines = rows(aligned.texts), text = lines.map(l => l.text).join('\n'), receipt = parseReceipt(text), tries = aligned.tries || 1, zoomed = false;
  // Items that don't add up (not a card slip with no items): one closer look at the paper, kept only if that one adds up.
  if (!receipt.check.ok && (receipt.items.length || receipt.total == null)) {
    const z = await call({ data, width, height }, onStage, true), zl = rows(z.texts), zt = zl.map(l => l.text).join('\n'), zr = parseReceipt(zt);
    tries += z.tries || 1;
    if (zr.check.ok) { lines = zl; text = zt; receipt = zr; zoomed = true; }
  }
  // The photo as it was read (turned and straightened like js/align.js did): upright on screen, and each item knows the
  // band of it that it came from (item.crop: top and bottom as shares of the height), so the review can show it.
  const up = aligned.turns || aligned.angle ? straightened(c, aligned.turns, aligned.angle) : c;
  for (const it of receipt.items) {
    const line = !zoomed && lines.find(l => it.name && l.text.includes(it.name));   // a zoomed read's rows aren't in the photo's coordinates
    it.flag = !it.name || (line && line.conf < 0.85) || it.cents === 0;
    if (line) it.crop = { t: Math.max(0, (line.y - line.h) / up.height), b: Math.min(1, (line.y + line.h) / up.height) };
  }
  const small = up === c ? draw(bmp, 1200) : shrink(up, 1200);
  const photo = await new Promise(r => small.toBlob(r, 'image/jpeg', 0.8));
  bmp.close?.();
  return { receipt, text, photo, ms: performance.now() - t0, turns: aligned.turns, angle: aligned.angle, tries };
}
