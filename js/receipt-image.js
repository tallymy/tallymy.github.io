// Receipt pixels and geometry only. No trained model, network or device state.
export const readSize = (w, h) => {
  const long = Math.max(w, h), short = Math.min(w, h);
  const s = long / short > 2.2 ? Math.min(1, 1400 / short, 12000 / long, Math.sqrt(8e6 / (w * h))) : Math.min(1, 2000 / long);
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
};
export function cropPixels(raw, area) {
  const x = Math.max(0, Math.floor(area.x)), y = Math.max(0, Math.floor(area.y));
  const width = Math.min(raw.width - x, Math.ceil(area.w)), height = Math.min(raw.height - y, Math.ceil(area.h));
  if (width < 1 || height < 1) throw Error('Empty receipt crop');
  const data = new Uint8ClampedArray(width * height * 4);
  for (let j = 0; j < height; j++) data.set(raw.data.subarray(((y + j) * raw.width + x) * 4, ((y + j) * raw.width + x + width) * 4), j * width * 4);
  return { data, width, height };
}
// Adjacent sections overlap so a line cut by one edge is complete in the next section.
export function sections(w, h, side = 2000, overlap = 200) {
  const vertical = h >= w, long = vertical ? h : w;
  if (long <= side) return [{ x: 0, y: 0, w, h }];
  const n = Math.ceil((long - side) / (side - overlap)) + 1;
  if (n > 12) throw Error('Too many receipt sections');
  return Array.from({ length: n }, (_, i) => {
    const start = Math.round(i * (long - side) / (n - 1));
    return vertical ? { x: 0, y: start, w, h: side } : { x: start, y: 0, w: side, h };
  });
}
const bounds = b => { const xs = b.box.map(p => p[0]), ys = b.box.map(p => p[1]); return { l: Math.min(...xs), r: Math.max(...xs), t: Math.min(...ys), b: Math.max(...ys) }; };
// Deduplicate by position as well as text: two identical purchases on different rows are real items.
export function mergeSections(groups) {
  const out = [];
  for (const { texts, area } of groups) for (const t of texts) {
    const box = t.box.map(([x, y]) => [x + area.x, y + area.y]);
    const item = { ...t, box }, a = bounds(item);
    const index = out.findIndex(v => {
      const b = bounds(v), intersection = Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
      const smaller = Math.min((a.r - a.l) * (a.b - a.t), (b.r - b.l) * (b.b - b.t));
      return smaller > 0 && intersection / smaller > 0.65 && (v.text.trim() === item.text.trim() || intersection / smaller > 0.9);
    });
    if (index < 0) out.push(item); else if ((item.mean || 0) > (out[index].mean || 0)) out[index] = item;
  }
  return out;
}
function sample(raw, x, y, out, at) {
  if (x < 0 || y < 0 || x > raw.width - 1 || y > raw.height - 1) return;
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(raw.width - 1, x0 + 1), y1 = Math.min(raw.height - 1, y0 + 1), fx = x - x0, fy = y - y0;
  for (let c = 0; c < 3; c++) {
    const p = (X, Y) => raw.data[(Y * raw.width + X) * 4 + c];
    out[at + c] = p(x0, y0) * (1 - fx) * (1 - fy) + p(x1, y0) * fx * (1 - fy) + p(x0, y1) * (1 - fx) * fy + p(x1, y1) * fx * fy;
  }
}
// Four corners in order: top-left, top-right, bottom-right, bottom-left. Reject crossed/degenerate selections.
export function validCorners(points) {
  if (!Array.isArray(points) || points.length !== 4 || points.some(p => !Array.isArray(p) || p.length !== 2 || p.some(v => !Number.isFinite(v) || v < 0 || v > 1))) return false;
  const crosses = points.map((p, i) => { const q = points[(i + 1) % 4], r = points[(i + 2) % 4]; return (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]); });
  const area = Math.abs(points.reduce((s, p, i) => { const q = points[(i + 1) % 4]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
  return crosses.every(v => v > 0.0001) && area > 0.01;
}
export function flattenPaper(raw, points) {
  if (!validCorners(points)) throw Error('Invalid receipt corners');
  const [a, b, c, d] = points.map(([x, y]) => [x * (raw.width - 1), y * (raw.height - 1)]);
  const distance = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  let width = Math.max(distance(a, b), distance(d, c)), height = Math.max(distance(a, d), distance(b, c));
  const s = Math.min(1, Math.sqrt(8e6 / (width * height)), 12000 / Math.max(width, height));
  width = Math.max(2, Math.round(width * s)); height = Math.max(2, Math.round(height * s));
  // Projective mapping from the output rectangle to the original quadrilateral.
  const dx1 = b[0] - c[0], dx2 = d[0] - c[0], dx3 = a[0] - b[0] + c[0] - d[0];
  const dy1 = b[1] - c[1], dy2 = d[1] - c[1], dy3 = a[1] - b[1] + c[1] - d[1];
  const det = dx1 * dy2 - dx2 * dy1;
  const g = Math.abs(det) < 1e-8 ? 0 : (dx3 * dy2 - dx2 * dy3) / det, h = Math.abs(det) < 1e-8 ? 0 : (dx1 * dy3 - dx3 * dy1) / det;
  const A = b[0] - a[0] + g * b[0], B = d[0] - a[0] + h * d[0], D = b[1] - a[1] + g * b[1], E = d[1] - a[1] + h * d[1];
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = x / (width - 1), v = y / (height - 1), z = g * u + h * v + 1;
    sample(raw, (A * u + B * v + a[0]) / z, (D * u + E * v + a[1]) / z, data, (y * width + x) * 4);
  }
  return { data, width, height };
}
// Retry a small area at higher resolution. Contrast is optional; the unmodified read remains a candidate.
export function enlarge(raw, factor = 2, contrast = false) {
  const s = Math.min(factor, Math.sqrt(2e6 / (raw.width * raw.height)), 2000 / Math.max(raw.width, raw.height));
  const width = Math.max(1, Math.round(raw.width * s)), height = Math.max(1, Math.round(raw.height * s)), data = new Uint8ClampedArray(width * height * 4).fill(255);
  let lo = 0, hi = 255;
  if (contrast) {
    const hist = new Uint32Array(256); for (let i = 0; i < raw.data.length; i += 4) hist[Math.round((raw.data[i] + raw.data[i + 1] + raw.data[i + 2]) / 3)]++;
    const n = raw.width * raw.height; let sum = 0; while (lo < 255 && (sum += hist[lo]) < n * 0.01) lo++;
    sum = 0; while (hi > 0 && (sum += hist[hi]) < n * 0.01) hi--;
    if (hi - lo < 20) { lo = 0; hi = 255; }
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4; sample(raw, x * (raw.width - 1) / Math.max(1, width - 1), y * (raw.height - 1) / Math.max(1, height - 1), data, at);
    if (contrast) for (let c = 0; c < 3; c++) data[at + c] = (data[at + c] - lo) * 255 / (hi - lo);
  }
  return { data, width, height };
}
