// Straighten a receipt before reading it: sideways / upside-down photos, and small tilts that make rows drift into
// each other. Pure pixel maths on raw RGBA ({data, width, height}), shared by the app and the benchmark.
import { toGray, otsu } from './camcheck.js';

/** Rotate by quarter turns clockwise (1 = 90°, 2 = 180°, 3 = 270°). */
export function rotate90(raw, turns) {
  turns = ((turns % 4) + 4) % 4;
  if (!turns) return raw;
  const { data, width: w, height: h } = raw;
  const W = turns % 2 ? h : w, H = turns % 2 ? w : h;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [X, Y] = turns === 1 ? [h - 1 - y, x] : turns === 2 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x];
    const s = (y * w + x) * 4, d = (Y * W + X) * 4;
    out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
  }
  return { data: out, width: W, height: H };
}

/** Rotate by `deg` clockwise (image coordinates, y down) around the centre, on a white background, same size. */
export function rotateBy(raw, deg) {
  const { data, width: w, height: h } = raw;
  const out = new Uint8ClampedArray(w * h * 4).fill(255);
  const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), cx = (w - 1) / 2, cy = (h - 1) / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // Source of this output pixel: rotate back by -t.
    const dx = x - cx, dy = y - cy;
    const sx = c * dx + s * dy + cx, sy = -s * dx + c * dy + cy;
    const x0 = Math.floor(sx), y0 = Math.floor(sy);
    if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue;
    const fx = sx - x0, fy = sy - y0, d = (y * w + x) * 4, a = y0 * w + x0;
    for (let k = 0; k < 3; k++) {
      const p = i => data[i * 4 + k];
      out[d + k] = p(a) * (1 - fx) * (1 - fy) + p(a + 1) * fx * (1 - fy) + p(a + w) * (1 - fx) * fy + p(a + w + 1) * fx * fy;
    }
  }
  return { data: out, width: w, height: h };
}

const edge = b => { const [p0, p1, , p3] = b.box; return { w: Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), h: Math.hypot(p3[0] - p0[0], p3[1] - p0[1]), a: Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) * 180 / Math.PI }; };
/** Median tilt (degrees, clockwise positive) of wide text boxes; 0 when there is too little text to tell. */
export function skewAngle(boxes) {
  const as = boxes.map(edge).filter(e => e.w > 2.5 * e.h && e.w > 40).map(e => e.a).sort((x, y) => x - y);
  return as.length < 3 ? 0 : as[Math.floor(as.length / 2)];
}
/** Share of text boxes taller than wide (a sideways photo). */
export const verticalShare = boxes => (boxes.length ? boxes.filter(b => {
  const xs = b.box.map(p => p[0]), ys = b.box.map(p => p[1]);
  return Math.max(...ys) - Math.min(...ys) > 1.3 * (Math.max(...xs) - Math.min(...xs)); // bounding box: detector boxes are axis-aligned
}).length / boxes.length : 0);
/** A sideways slip on a wide photo: the detector merges its columns into a few big blocks (55-250 characters a box on
 *  the owner's photos) instead of lines (upright slips: 23 at most). */
export const blocky = boxes => boxes.length > 0 && boxes.reduce((s, b) => s + (String(b.text).match(/[\p{L}\p{N}]/gu) || []).length, 0) / boxes.length > 40;
/** How well a reading went: confident characters that look like receipt text. */
export const readScore = boxes => boxes.reduce((s, b) => s + (b.mean ?? 0) * (String(b.text).match(/[\p{L}\p{N}]/gu) || []).length, 0);
const meanConf = boxes => (boxes.length ? boxes.reduce((s, b) => s + (b.mean ?? 0), 0) / boxes.length : 0);

// The longest run of indexes whose share is at least `min`.
function longestRun(share, min) {
  let best = [0, -1], s = -1;
  for (let i = 0; i <= share.length; i++) {
    if (i < share.length && share[i] >= min) { if (s < 0) s = i; } else if (s >= 0) { if (i - 1 - s > best[1] - best[0]) best = [s, i - 1]; s = -1; }
  }
  return best;
}
/** Where the paper is: {x, y, w, h}, or null when it can't be told from the background or already fills the picture. */
export function paperBox(gray, w, h) {
  const hist = new Uint32Array(256); for (const v of gray) hist[v]++;
  const cut = otsu(hist, w * h);
  let pN = 0, pS = 0, dS = 0; for (let i = 0; i < 256; i++) if (i > cut) { pN += hist[i]; pS += i * hist[i]; } else dS += i * hist[i];
  const sep = pN && pN < w * h ? pS / pN - dS / (w * h - pN) : 0;
  if (sep < 25 || pN / (w * h) > 0.85) return null;
  const col = new Float32Array(w); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (gray[y * w + x] > cut) col[x] += 1 / h;
  const [x0, x1] = longestRun(col, 0.35 * Math.max(...col));
  const row = new Float32Array(h); for (let y = 0; y < h; y++) { let c = 0; for (let x = x0; x <= x1; x++) if (gray[y * w + x] > cut) c++; row[y] = c / (x1 - x0 + 1); }
  const [y0, y1] = longestRun(row, 0.35 * Math.max(...row));
  const px = Math.round(w * 0.02), py = Math.round(h * 0.02), x = Math.max(0, x0 - px), y = Math.max(0, y0 - py);
  const box = { x, y, w: Math.min(w, x1 + px + 1) - x, h: Math.min(h, y1 + py + 1) - y };
  return box.w * box.h > 0.9 * w * h ? null : box;
}
/**
 * A second look at a photo that didn't add up: the paper cut out, scaled up (small print from far away gets bigger) and
 * its grey stretched from the 1st to the 99th percentile (faded thermal print). Tuned on 95 phone photos: far-away,
 * faded slips read on retry; always cropping loses rows on light tables, so this is only the retry.
 * ponytail: at most 3000 px long and 4.5 MP (about 1.5x a normal read) to stay inside a phone's memory.
 */
export function zoomPaper(raw, { long = 3000, maxUp = 4, pixels = 4.5e6 } = {}) {
  const { data, width: w, height: h } = raw, gray = toGray(data), b = paperBox(gray, w, h) || { x: 0, y: 0, w, h };
  const s = Math.min(maxUp, long / Math.max(b.w, b.h), Math.sqrt(pixels / (b.w * b.h))), W = Math.round(b.w * s), H = Math.round(b.h * s);
  const hist = new Uint32Array(256); for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) hist[gray[y * w + x]]++;
  const n = b.w * b.h; let lo = 0, hi = 255, a = 0;
  for (lo = 0; lo < 255 && (a += hist[lo]) < n * 0.01; lo++); a = 0; for (hi = 255; hi > 0 && (a += hist[hi]) < n * 0.01; hi--);
  if (hi - lo < 20) { lo = 0; hi = 255; }
  const k = 255 / (hi - lo), out = new Uint8ClampedArray(W * H * 4);
  for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
    const sx = Math.min(b.w - 1.001, X / s) + b.x, sy = Math.min(b.h - 1.001, Y / s) + b.y, x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0, d = (Y * W + X) * 4, a0 = y0 * w + x0;
    for (let c = 0; c < 3; c++) {
      const p = i => data[i * 4 + c];
      out[d + c] = (p(a0) * (1 - fx) * (1 - fy) + p(a0 + 1) * fx * (1 - fy) + p(a0 + w) * (1 - fx) * fy + p(a0 + w + 1) * fx * fy - lo) * k;
    }
    out[d + 3] = 255;
  }
  return { data: out, width: W, height: H };
}

/**
 * Read with alignment: detect once; if the text looks sideways or reads badly, try the other quarter turns; then
 * straighten a tilt over 3°. detect(raw) → {texts}. Returns {texts, turns, angle, tries}. onStage('turn'|'straighten') before
 * each extra pass, so the screen can say why the read is taking longer.
 * ponytail: rotation only, no perspective correction (a receipt photographed at a steep angle stays trapezoid).
 */
export async function readAligned(detect, raw, onStage = () => {}) {
  let tries = 1;
  let best = { raw, turns: 0, texts: (await detect(raw)).texts };
  best.score = readScore(best.texts);
  // Each try is a whole detect + read. Tall boxes: a quarter turn either way. Level boxes that read badly: only
  // upside down is left (a quarter turn would stand the lines on end). Too few boxes to tell: every turn.
  // Blocks: sideways too, even though each block reads about as well as its lines would; a turn that gives lines wins
  // unless it reads much worse.
  const few = best.texts.length < 4, blocks = blocky(best.texts), sideways = blocks || verticalShare(best.texts) > 0.5, poor = few || meanConf(best.texts) < 0.8;
  if (sideways || poor) {
    onStage('turn');
    // A read that is level but poor can still be sideways (synthetic bench: 70 of 189 photos turned 270° were only ever
    // tried upside down): every turn, the best kept. ponytail: two more reads for poor photos only.
    for (const turns of sideways ? [1, 3] : [2, 1, 3]) {
      const r = rotate90(raw, turns), texts = (await detect(r)).texts, score = readScore(texts);
      tries++;
      if (score > best.score * 1.15 || (blocky(best.texts) && !blocky(texts) && score > best.score * 0.8)) best = { raw: r, turns, texts, score };
    }
  }
  const angle = skewAngle(best.texts);
  if (Math.abs(angle) > 3 && Math.abs(angle) < 30) { // small tilts: PaddleOCR copes, resampling only blurs (A/B on real photos)
    onStage('straighten');
    const texts = (await detect(rotateBy(best.raw, -angle))).texts;
    tries++;
    if (readScore(texts) >= best.score * 0.95) return { raw: rotateBy(best.raw, -angle), texts, turns: best.turns, angle, tries };
  }
  return { raw: best.raw, texts: best.texts, turns: best.turns, angle: 0, tries };
}
