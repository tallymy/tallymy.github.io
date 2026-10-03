// Fictional receipts with explicit ground truth. Usable in a browser or Node; no customer data.
export const receiptCases = () => {
  const plain = { merchant: 'TEST CAFE', date: '2026-10-03', items: [{ name: 'NASI LEMAK', cents: 1200 }, { name: 'TEH AIS', cents: 300 }], total: 1500 };
  const long = { ...plain, merchant: 'TEST MART', items: Array.from({ length: 45 }, (_, n) => ({ name: n % 2 ? 'SUSU SEGAR' : 'ROTI PUTIH', cents: n % 2 ? 450 : 300 })), total: 16800 };
  const fees = { ...plain, tax: 90, service: 150, total: 1740 };
  const discount = { ...plain, items: [...plain.items, { name: 'Discount', cents: -200 }], total: 1300 };
  const columns = { ...plain, items: [{ name: 'NASI LEMAK', cents: 2400, qty: 2, unit: 1200 }, { name: 'TEH AIS', cents: 900, qty: 3, unit: 300 }], total: 3300 };
  return [
    { id: 'plain', ...plain }, { id: 'long-repeated-items', ...long }, { id: 'tax-service', ...fees }, { id: 'discount', ...discount },
    { id: 'quantity-columns', ...columns, columns: true }, { id: 'faded', ...plain, ink: '#888' },
    { id: 'shadow', ...plain, shadow: true }, { id: 'blurred', ...plain, blur: 0.7 },
    { id: 'tilted', ...plain, tilt: 6 }, { id: 'perspective', ...plain, perspective: true },
    { id: 'comma-decimals', ...plain, comma: true }, { id: 'rounding', ...plain, items: [{ name: 'BISKUT', cents: 312 }], rounding: -2, total: 310 },
    { id: 'not-a-receipt', merchant: '', date: null, items: [], total: null, negative: true },
  ];
};
export function receiptLines(c) {
  if (c.negative) return ['ACCOUNT OVERVIEW', 'Available balance RM 880.00', 'Rewards points 1200', 'Welcome back'];
  const money = n => (n / 100).toFixed(2).replace('.', c.comma ? ',' : '.');
  return [c.merchant, '03/10/2026', '-------------------------', ...(c.columns ? ['QTY DESCRIPTION UNIT TOTAL'] : []),
    ...c.items.map(i => c.columns ? `${i.qty} ${i.name} ${money(i.unit)} ${money(i.cents)}` : `${i.name.padEnd(20)} ${money(i.cents)}`),
    ...(c.tax || c.service ? [`SUBTOTAL ${money(c.items.reduce((s, i) => s + i.cents, 0))}`] : []),
    ...(c.service ? [`SERVICE CHARGE ${money(c.service)}`] : []), ...(c.tax ? [`SST ${money(c.tax)}`] : []),
    ...(c.rounding ? [`ROUNDING ${money(c.rounding)}`] : []), `TOTAL ${money(c.total)}`, `CASH ${money(Math.ceil(c.total / 100) * 100)}`, 'THANK YOU'];
}
export function drawReceipt(canvas, c) {
  const lines = receiptLines(c), width = 1000, height = Math.max(720, 100 + lines.length * 64);
  canvas.width = width; canvas.height = height; const g = canvas.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, width, height); g.save();
  if (c.tilt) { g.translate(width / 2, height / 2); g.rotate(c.tilt * Math.PI / 180); g.translate(-width / 2, -height / 2); }
  if (c.perspective) { g.transform(0.8, 0.08, 0.08, 0.9, 50, 20); }
  if (c.blur) g.filter = `blur(${c.blur}px)`;
  g.fillStyle = c.ink || '#111'; g.font = '30px monospace';
  lines.forEach((line, n) => g.fillText(line, 50, 60 + n * 64)); g.restore();
  if (c.shadow) { const gradient = g.createLinearGradient(0, 0, width, 0); gradient.addColorStop(0, 'rgba(0,0,0,0.4)'); gradient.addColorStop(0.65, 'rgba(0,0,0,0)'); g.fillStyle = gradient; g.fillRect(0, 0, width, height); }
  return canvas;
}
