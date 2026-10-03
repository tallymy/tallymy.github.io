// Reading a receipt photo on the phone: PaddleOCR (vendored, ~30 MB, loaded on first scan and cached offline),
// then the Malaysian receipt parser. Nothing is uploaded.
import { isNative } from './native.js';
import { imageInfo, LIMITS } from './io.js';
import { readSize } from './receipt-image.js';

// OCR runs in a worker (js/ocr-worker.js): the screen stays responsive, and the page keeps a strict CSP.
let worker = null, loading = null, ready = false, seq = 0;
const pending = new Map();
/** One OCR request. A worker that doesn't answer within 2 minutes (first run includes the 30 MB download) is reset. */
function call(raw, onStage = () => {}, corners = null) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reset(); reject(new Error('The receipt reader stopped responding. Try again.')); }, 120_000);
    pending.set(id, { stage: onStage, resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    // Hand ownership of OCR pixels to the worker instead of cloning them.
    worker.postMessage({ id, raw, corners }, raw ? [raw.data.buffer] : []);
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
/**
 * Photo → {receipt, text, photo, ms, turns, angle, tries}. receipt is parseReceipt's result, with item.flag set when the item is
 * worth a second look (low OCR confidence, no name, or a zero price).
 * photo is a re-encoded JPEG (max 1200 px): smaller, and the location data in the original is dropped.
 * onStage: 'prep', 'read', then 'turn' / 'straighten' when the photo needs another pass.
 */
export async function readReceipt(file, onStage = () => {}, { corners = null } = {}) {
  const t0 = performance.now();
  const bmp = await bitmap(file);
  let pixels;
  try {
  await loadOcr();
  onStage('prep');
  const size = readSize(bmp.width, bmp.height), c = document.createElement('canvas');
  c.width = size.width; c.height = size.height; c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  } finally { bmp.close?.(); }
  const { data, width, height } = pixels;
  onStage('read');
  const aligned = await call({ data, width, height }, onStage, corners);
  const { receipt, text, tries } = aligned;
  const up = document.createElement('canvas'); up.width = aligned.raw.width; up.height = aligned.raw.height;
  up.getContext('2d').putImageData(new ImageData(aligned.raw.data, up.width, up.height), 0, 0);
  // Keep more vertical detail in long saved receipts so the correction strip stays legible.
  const long = Math.max(up.width, up.height), short = Math.min(up.width, up.height);
  const maxSide = long / short > 2.2 ? Math.min(6000, long * Math.min(1, 1000 / short)) : 1600;
  const ratio = Math.min(1, maxSide / long), small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(up.width * ratio)); small.height = Math.max(1, Math.round(up.height * ratio));
  small.getContext('2d').drawImage(up, 0, 0, small.width, small.height);
  const photo = await new Promise(r => small.toBlob(r, 'image/jpeg', 0.8));
  return { receipt, text, photo, ms: performance.now() - t0, turns: aligned.turns, angle: aligned.angle, tries };
}
