// Security guarantees that are easy to lose in a later edit: the page policy, what goes over the network,
// the pdf.js hardening, and parsers that must not freeze on hostile input. (Crafted backups: io.test.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCSV, sheetCsvUrl, imageInfo } from '../js/io.js';
import { parseReceipt } from '../js/parse.js';
import { parseStatement, linesFromItems } from '../js/statement.js';
import { ics, billEvent, habitEvent, safeId } from '../js/calendar.js';
import { clockParams } from '../js/state.js';
import { own } from '../js/ui.js';
import { post } from '../js/feedback.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = f => readFileSync(join(ROOT, f), 'utf8');
const jsFiles = dir => readdirSync(join(ROOT, dir)).flatMap(f => { const p = join(dir, f); return statSync(join(ROOT, p)).isDirectory() ? jsFiles(p) : p.endsWith('.js') ? [p] : []; });
const csp = html => html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] || '';

test('page policy: no eval, no inline or third-party scripts, network limited to Google Forms/Sheets and the tap-only rate lookup', () => {
  const d = Object.fromEntries(csp(read('index.html')).split(';').map(s => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.deepEqual(d['script-src'], ["'self'", "'wasm-unsafe-eval'"]);   // WebAssembly for OCR/sql.js, never JS eval
  assert.deepEqual(d['object-src'], ["'none'"]);
  assert.deepEqual(d['form-action'], ["'none'"]);
  assert.deepEqual(d['base-uri'], ["'self'"]);
  assert.deepEqual(d['connect-src'], ["'self'", 'https://docs.google.com', 'https://*.googleusercontent.com', 'https://api.frankfurter.dev']);
});

test('no inline scripts in any page', () => {
  for (const f of ['index.html', 'connect.html', 'privacy.html', 'terms.html', '404.html']) assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(read(f)), f);
});

test('network calls: explicit feedback/import/rate actions and local computer pairing only', () => {
  const calls = jsFiles('js').flatMap(f => [...read(f).matchAll(/\bfetch\(([^,)]+)/g)].map(m => `${f.replace(/\\/g, '/')}:${m[1].trim()}`));
  assert.deepEqual(calls.sort(), ['js/desk-client.js:address + path', 'js/feedback.js:FORM', 'js/native.js:url.href', 'js/scan.js:url', "js/views/setup.js:'./build.txt'", 'js/views/setup.js:rateUrl', 'js/views/setup.js:url']);   // build.txt: this site's own file
  const desk = read('js/desk-client.js');
  assert.match(desk, /phoneAddress\(input\)/);
  assert.match(desk, /JSON\.stringify\(\{ sdp \}\)/); // Only SDP goes through HTTP; book messages use DTLS.
  assert.match(desk, /credentials: 'omit'/);
  assert.ok(!/\b(localStorage|sessionStorage|indexedDB)\s*[.(]/.test(desk));
  for (const file of ['js/desk-client.js', 'js/desk-host.js']) assert.match(read(file), /iceServers: \[\]/); // No STUN/TURN/cloud relay.
  assert.ok(read('js/views/setup.js').includes("const RATE_API = 'https://api.frankfurter.dev/v1/latest';"));   // one rate, no data about the person
  assert.ok(read('js/views/setup.js').includes("'rate-get': async () => {"));   // only from the button
  // the reader's own files, from this site only
  assert.match(read('js/scan.js'), /\.map\(\(\[p, n\]\) => \[new URL\(p, import\.meta\.url\)\.href, n\]\)/);
  assert.ok(!/https?:/.test(read('js/scan.js').match(/const FILES = \[[\s\S]*?\]\.map/)[0]));
  assert.match(read('js/feedback.js'), /const FORM = 'https:\/\/docs\.google\.com\/forms\//);
  assert.match(read('js/views/setup.js'), /const url = sheetCsvUrl\(/);
  assert.match(read('js/views/setup.js'), /credentials: 'omit'/);
  for (const bad of ['https://evil.example/spreadsheets/d/abc', 'javascript:alert(1)', 'https://docs.google.com.evil.io/spreadsheets/d/abc'])
    assert.equal(sheetCsvUrl(bad), null, bad);
});

test('feedback never reads money data', () => {
  const src = read('js/feedback.js');
  assert.ok(!/S\.(tx|accounts|recurring)|engine\.js|getPhoto/.test(src));
  assert.equal([...src.matchAll(/entry\.\d+/g)].length, 4);   // type, message, contact, app info
});

test('pdf.js: scripts inside a PDF are never evaluated, and the vendored build is past CVE-2024-4367', () => {
  const calls = jsFiles('js').flatMap(f => [...read(f).matchAll(/getDocument\(\{[^}]*\}/g)].map(m => m[0]));
  assert.ok(calls.length > 0);
  for (const c of calls) assert.match(c, /isEvalSupported: false/);
  const v = read('vendor/pdf.min.mjs').match(/"(\d+)\.(\d+)\.(\d+)"/);
  assert.ok(v && (+v[1] > 4 || (+v[1] === 4 && +v[2] >= 2)), `pdf.js ${v?.[0]}`);   // fixed in 4.2.67
});

test('frame-busting runs before any data loads', () => {
  const app = read('js/app.js');
  assert.ok(app.indexOf('window.top !== window.self') < app.indexOf('await load()'));
});

test('hostile input cannot freeze the parsers', () => {
  const huge = ['1'.repeat(50000), '"'.repeat(50000), 'RM' + ' 1.'.repeat(20000), ('TOTAL ' + '9'.repeat(40) + '\n').repeat(2000), '01/01/2026 '.repeat(8000)];
  for (const s of huge) {
    const t0 = performance.now();
    parseCSV(s);
    parseReceipt(s);
    parseStatement(s.split('\n'));
    assert.ok(performance.now() - t0 < 1500, `took ${Math.round(performance.now() - t0)} ms on ${s.slice(0, 20)}…`);
  }
});

test('every page has a CSP that defaults to self, and no tracked page loads a script from another site', () => {
  const pages = readdirSync(ROOT).filter(f => f.endsWith('.html'));
  assert.ok(pages.length >= 4);
  for (const f of pages) {
    assert.match(csp(read(f)), /default-src 'self'/, f);
    assert.ok(!/<script[^>]+src=["']?https?:/i.test(read(f)), f);
  }
});

test('the service worker only clears its own caches (the site root is shared)', () => {
  assert.match(read('sw.js'), /k\.startsWith\('tally-'\)/);
});

test('no other way out: no sendBeacon, WebSocket, XMLHttpRequest or EventSource in the app code', () => {
  for (const f of ['sw.js', ...jsFiles('js')]) assert.ok(!/sendBeacon|WebSocket|XMLHttpRequest|EventSource/.test(read(f)), f);
});

test('feedback posts exactly the 4 form fields, whatever else the item holds', async () => {
  const sent = [], real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { sent.push({ url, body: opts.body }); return new Response(null); };
  try { await post({ type: 'Bug', message: 'hi', contact: '', info: 'Tally 0.3.0', amount: 1250, merchant: 'Tesco', accounts: [{ name: 'Maybank' }] }); } finally { globalThis.fetch = real; }
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /^https:\/\/docs\.google\.com\/forms\//);
  assert.equal([...sent[0].body.keys()].length, 4);
  assert.ok([...sent[0].body.keys()].every(k => /^entry\.\d+$/.test(k)));
  assert.ok(![...sent[0].body.values()].some(v => /1250|Tesco|Maybank/.test(v)));
});

test('routes and actions only match their own names: #/constructor shows Home', () => {
  const VIEWS = { home: 'Home' };
  for (const r of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.equal(own(VIEWS, r), undefined, r);
  assert.equal(own(VIEWS, 'home'), 'Home');
  const app = read('js/app.js');
  for (const x of ['own(VIEWS, r)', 'own(ACT, ', 'own(INPUT, ']) assert.ok(app.includes(x), x);
  assert.ok(!/\b(VIEWS|ACT|INPUT)\[(?!r\])/.test(app));   // VIEWS[r] only after the own() check
});

test('?today= and ?now= move the clock only on this computer (tests and simulations)', () => {
  assert.equal(clockParams({ hostname: 'localhost', search: '?today=2026-01-02&now=09:00' }).get('today'), '2026-01-02');
  assert.equal(clockParams({ hostname: '127.0.0.1', search: '?now=09:00' }).get('now'), '09:00');
  for (const hostname of ['fir1412.github.io', 'localhost.evil.example', 'example.com']) assert.equal(clockParams({ hostname, search: '?today=2020-01-01' }).get('today'), null, hostname);
  assert.equal(clockParams(undefined).get('today'), null);
});

test('calendar files: text from a category or bill cannot start a new line', () => {
  const evil = 'Food\r\nATTACH:https://evil.example/x\rX-EVIL:1\nEND:VCALENDAR';
  const text = ics([habitEvent({ category: evil, days: evil, at: '12:00', title: evil, details: evil }), billEvent({ id: evil, day: 5, title: evil, details: evil })]);
  const lines = text.split('\r\n');
  assert.ok(!/\r(?!\n)|(?<!\r)\n/.test(text));   // CRLF line ends only
  assert.ok(!lines.some(l => /^(ATTACH|X-EVIL)/.test(l)));
  assert.equal(lines.filter(l => l === 'END:VCALENDAR').length, 1);
  for (const l of lines.filter(l => l.startsWith('UID:'))) assert.match(l, /^UID:[\w-]+@tally$/);
  assert.equal(safeId('../a b\r\n.ics'), 'abics');
});

test('PDF text: a page of 50,000 scattered items is grouped in linear time and capped', () => {
  const items = Array.from({ length: 50_000 }, (_, i) => ({ str: `w${i}`, transform: [0, 0, 0, 0, i % 7, i * 3.7] }));
  const t0 = performance.now();
  const lines = linesFromItems(items);
  assert.ok(performance.now() - t0 < 500, `took ${Math.round(performance.now() - t0)} ms`);
  assert.equal(lines.length, 20_000);
  assert.deepEqual(linesFromItems([{ str: 'a', transform: [0, 0, 0, 0, 5, 100] }, { str: 'b', transform: [0, 0, 0, 0, 1, 102.9] }, { str: 'c', transform: [0, 0, 0, 0, 1, 103.2] }, { str: 'x', transform: [0, 0, 0, 0, NaN, NaN] }]), ['c', 'b  a']);   // c is 3.2 above a: its own row
});

test('images: pixel size read from the JPEG or PNG header before any decoding', () => {
  const png = new Uint8Array(24); png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(png.buffer).setUint32(16, 30000); new DataView(png.buffer).setUint32(20, 20000);
  assert.deepEqual(imageInfo(png), { type: 'image/png', w: 30000, h: 20000 });
  // JPEG: SOI, an APP1 segment of 6 bytes, then SOF0 with height 3000 and width 4000.
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 6, 1, 2, 3, 4, 0xff, 0xc0, 0, 17, 8, 0x0b, 0xb8, 0x0f, 0xa0, 3, 0, 0, 0, 0]);
  assert.deepEqual(imageInfo(jpg), { type: 'image/jpeg', w: 4000, h: 3000 });
  for (const bad of [new Uint8Array(0), new TextEncoder().encode('<svg onload=alert(1)>'), jpg.slice(0, 8), new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0, 0, 0, 0, 0])]) assert.equal(imageInfo(bad), null);
});

test('app lock keeps only a salted PBKDF2 hash of the PIN, never the PIN', async () => {
  const L = await import('../js/lock.js');
  const a = await L.makeLock('482915'), b = await L.makeLock('482915');
  assert.ok(!JSON.stringify(a).includes('482915'));
  assert.notEqual(a.hash, b.hash);                        // own salt each time
  assert.ok(a.iter >= 100_000);
  assert.equal(await L.checkPin('482915', a), true);
  assert.equal(await L.checkPin('482916', a), false);
  assert.equal(await L.checkPin('482915', null), false);
  assert.deepEqual(['1234', '123456', '12345', '123', '1234567', '12a4'].map(L.validPin), [true, true, true, false, false, false]);
  assert.match(read('js/lock.js'), /userVerification: 'required'/);
  // Settings go into backups only through backupSettings, which never keeps the lock.
  assert.ok(/settings: backupSettings\(/.test(read('js/views/setup.js')) && !/settings: settings\(\)/.test(read('js/views/setup.js')));
  const IO = await import('../js/io.js');
  assert.equal(IO.backupSettings({ lock: a, monthStart: 5 }).lock, undefined);
});
test('app lock: one try per PIN entered (auto-submit then Unlock is one), a wait after 5 real tries', async () => {
  const { pinGuard } = await import('../js/lock.js');
  let clock = 1000, release;
  const st = { fails: 0, until: 0 }, slow = () => new Promise(r => { release = r; });
  const guard = pinGuard(() => slow().then(() => false), st, () => clock);
  const first = guard('1111'), again = await guard('1111');   // Unlock tapped while the auto-submitted PIN is checked
  assert.equal(again, 'ignored'); release(); assert.equal(await first, 'wrong'); assert.equal(st.fails, 1);
  assert.equal(await guard(''), 'ignored'); assert.equal(st.fails, 1);   // the field was cleared: Unlock on nothing is no try
  const quick = pinGuard(async p => p === '4821', st, () => clock);
  for (const p of ['2222', '3333', '4444']) assert.equal(await quick(p), 'wrong');
  assert.equal(st.until, 0);                                            // 4 wrong: no wait yet
  assert.equal(await quick('5555'), 'wrong'); assert.equal(st.fails, 5); assert.equal(st.until, 31_000);
  assert.equal(await quick('4821'), 'wait');                            // even the right PIN waits
  clock = 31_000; assert.equal(await quick('4821'), 'ok'); assert.deepEqual(st, { fails: 0, until: 0 });
});

test('crafted imports and receipt text finish quickly (no pattern slows down on a huge cell or line)', async () => {
  const IO = await import('../js/io.js'), P = await import('../js/parse.js');
  const fast = (label, fn) => { const t = performance.now(); fn(); const ms = performance.now() - t; assert.ok(ms < 800, `${label}: ${Math.round(ms)} ms`); };
  const run = csv => { const [h, ...rows] = IO.parseCSV(csv), map = IO.guessMapping(h); return IO.rowsToTx(rows, map, { accountId: 'a', now: 1 }); };
  fast('a 200 KB quoted whitespace amount cell', () => run(`Date,Description,Amount\n2026-09-01,Kopi,"${' '.repeat(200_000)}5.00"\n`));
  fast('a Transfer row whose text is "to to to…"', () => run(`Date,Type,Description,Amount\n2026-09-01,Transfer,"${'to '.repeat(40_000)}\n",5.00\n`));
  fast('a 60,000-character receipt line', () => P.parseReceipt(`SHOP\n${'A1 '.repeat(20_000)}\nTotal 5.00`));
  fast('a 60,000-character typed line', () => P.parseItemLines(`${'ikan 12 '.repeat(7_500)}`));
  assert.ok(IO.parseCSV(`a\n"${'x'.repeat(10_000)}"\n`)[1][0].length <= 2000, 'quoted cells are capped like the others');
});
