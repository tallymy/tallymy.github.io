// PaddleOCR in a worker: the page stays responsive while a receipt is read, and OpenCV's Emscripten glue (which
// needs `new Function`) runs here instead of loosening the page's Content Security Policy.
// The browser OCR build draws through document.createElement('canvas'); a worker has OffscreenCanvas instead.
self.document = { createElement: () => new OffscreenCanvas(1, 1) };
import { readAligned, zoomPaper } from './align.js';

let ocr = null;
async function ready() {
  if (ocr) return ocr;
  const { Ocr, env } = await import('../vendor/ocr.js');
  env.wasm.wasmPaths = new URL('../vendor/', import.meta.url).href;
  // Several cores once the page is cross-origin isolated (sw.js adds the headers GitHub Pages can't); one otherwise.
  // Android WebView's new isolation API does not yet reliably start nested WASM pthread workers.
  // Keep OCR in this background worker, but use a single WASM thread inside the Android app.
  env.wasm.numThreads = new URL(self.location.href).searchParams.get('threads') === '1' ? 1 : self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  ocr = await Ocr.create({ models: {
    detectionPath: new URL('../models/ch_PP-OCRv4_det_infer.onnx', import.meta.url).href,
    recognitionPath: new URL('../models/ch_PP-OCRv4_rec_infer.onnx', import.meta.url).href,
    dictionaryPath: new URL('../models/ppocr_keys_v1.txt', import.meta.url).href,
  } });
  return ocr;
}
// One read at a time: a read-ahead of the next photo and a retry must not run the model at once.
let chain = Promise.resolve();
self.onmessage = e => { chain = chain.then(() => read(e.data)); };
async function read({ id, raw, zoom }) {
  try {
    const o = await ready();
    if (!raw) return self.postMessage({ id, texts: [] });
    // Straighten first (sideways/upside-down turns, big tilts): the pixel work stays off the page's thread.
    if (zoom) self.postMessage({ id, stage: 'zoom' });
    const r = await readAligned(x => o.detect(x), zoom ? zoomPaper(raw) : raw, stage => self.postMessage({ id, stage }));   // zoom: the second look (align.js)
    self.postMessage({ id, texts: r.texts.map(({ text, mean, box }) => ({ text, mean, box })), turns: r.turns, angle: r.angle, tries: r.tries });
  } catch (e) { self.postMessage({ id, error: String(e?.message || e) }); }
}
