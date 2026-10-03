// Reproducible local OCR benchmark; generated fixtures only. Results and browser cache go on D:.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.env.TALLY_BENCH_OUTPUT || 'D:/tally-android/verification/receipt-bench';
const profile = process.env.TALLY_BENCH_PROFILE || 'D:/tally-android/temp/receipt-bench-browser';
await mkdir(output, { recursive: true });
const compare = process.argv.includes('--compare');
let baselineScan, baselineWorker;
if (compare) {
  // Fixed local pre-change implementation; never fetched from the network.
  baselineScan = execFileSync('git', ['show', '0a2b087:js/scan.js'], { cwd: root, encoding: 'utf8' }).replace("'./ocr-worker.js'", "'./benchmark-baseline-worker.js'");
  baselineWorker = execFileSync('git', ['show', '0a2b087:js/ocr-worker.js'], { cwd: root, encoding: 'utf8' });
}
const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.onnx': 'application/octet-stream', '.txt': 'text/plain' };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    res.setHeader('Cache-Control', 'no-store');
    if (pathname === '/bench') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><title>Generated receipt benchmark</title><h1>Receipt benchmark</h1>'); }
    if (compare && pathname === '/js/benchmark-baseline-scan.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(baselineScan); }
    if (compare && pathname === '/js/benchmark-baseline-worker.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(baselineWorker); }
    if (!/^\/(js|vendor|models)\//.test(pathname) && pathname !== '/tests/receipt-synthetic.mjs') throw Error('Not a benchmark asset');
    const target = resolve(root, '.' + pathname); if (!target.startsWith(resolve(root) + sep)) throw Error('Outside project');
    res.setHeader('Content-Type', mime[extname(target)] || 'application/octet-stream'); res.end(await readFile(target));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let context;
const results = [];
try {
  context = await chromium.launchPersistentContext(profile, { headless: true, executablePath: process.env.TALLY_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const page = await context.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}/bench`);
  await page.evaluate(async () => { const fixtures = await import('/tests/receipt-synthetic.mjs'); window.fixtures = fixtures; });
  const cases = await page.evaluate(() => window.fixtures.receiptCases().map(c => c.id));
  for (const engine of compare ? ['baseline', 'current'] : ['current']) for (const id of cases) {
    const result = await page.evaluate(async ({ engine, id }) => {
      const fixture = window.fixtures.receiptCases().find(c => c.id === id), canvas = window.fixtures.drawReceipt(document.createElement('canvas'), fixture);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const scan = await import(engine === 'baseline' ? '/js/benchmark-baseline-scan.js' : '/js/scan.js');
      const r = await scan.readReceipt(new File([blob], id + '.png', { type: 'image/png' }));
      return { engine, id, total: r.receipt.total, expectedTotal: fixture.total, amounts: r.receipt.items.map(i => i.cents), expectedAmounts: fixture.items.map(i => i.cents), flags: r.receipt.items.filter(i => i.flag).length, ms: Math.round(r.ms), text: r.text };
    }, { engine, id });
    result.totalCorrect = result.total === result.expectedTotal;
    result.itemsCorrect = JSON.stringify(result.amounts) === JSON.stringify(result.expectedAmounts);
    results.push(result); console.log(`${engine} ${id}: total=${result.totalCorrect} items=${result.itemsCorrect} ${result.ms}ms`);
    await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2));
  }
} finally { await context?.close(); server.close(); }
console.log('Results:', resolve(output, 'results.json'));
