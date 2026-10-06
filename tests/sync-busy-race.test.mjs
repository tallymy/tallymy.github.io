// Round 2, task 2: peer-request BUSY must never end a device in phase 'error'. Real sync-controller + real sync-rpc + real book-transfer + real
// sync-core over an in-memory loopback, a fake store (identity/capture/prepare/commit/ack with latency and a concurrency probe).
// 200 seeded interleavings of the real call patterns from both sides at once. SYNC_CONTROLLER overrides the controller (used once to show the
// pre-fix controller fails this test). Importers: none. API: createSyncController, createSyncRpc, core. User quote: "shows neither side ever
// ends in error with code BUSY, and that data operations are still exclusive (no double apply: commit exactly once)".
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const core = await import('../js/book-sync/sync-core.mjs');
const { createSyncRpc } = await import('../js/book-sync/sync-rpc.mjs');
const { createSyncController, CONTROLLER_SCHEMA } = await import(process.env.SYNC_CONTROLLER || '../js/book-sync/sync-controller.mjs');

const mulberry = a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const hex = n => n.toString(16).padStart(64, '0');
const sleepTicks = async rnd => { const n = Math.floor(rnd() * 4); if (rnd() < 0.15) await new Promise(r => setImmediate(r)); for (let i = 0; i < n; i++) await Promise.resolve(); };

function bookFor(role) {
  const acc = { id: 'cash_' + role, name: role, kind: 'cash', opening: 1000, typed: false, currency: 'MYR' };
  return core.validateBook({ schema: core.SCHEMA, accounts: [acc], tx: role === 'computer' ? [{ id: 't1', type: 'expense', amount: 100, date: '2026-10-04', accountId: acc.id, category: 'dining', note: 'x' }] : [], recurring: [], receipts: [], kv: { settings: {} } });
}
function fakeStore(role, rnd, probe = { max: 0 }) {
  const book = bookFor(role), ids = { bookId: 'book_' + role, deviceId: 'dev_' + role };
  let applied = 0, commitCalls = 0, preparedPlan = null, committed = false, inside = 0;
  const guard = async fn => { inside++; probe.max = Math.max(probe.max, inside); try { await sleepTicks(rnd); return await fn(); } finally { inside--; } };
  const snap = async () => { await sleepTicks(rnd); return { generation: 'g_' + role, revision: await core.bookRevision(book), book: structuredClone(book), photos: new Map(), local: { ...ids, baseRevision: null, peerDeviceId: null, pending: null, base: null, generation: 'g_' + role } }; };
  return {
    identity: snap, capture: snap,
    async safetyBackup() { const s = await snap(); return { snapshot: { revision: s.revision, generation: s.generation }, evidence: { snapshotHash: s.revision, archiveSha: hex(7), bytes: 10, confirmed: true } }; },
    async prepare({ candidate, planId }) { return guard(async () => { preparedPlan = { planId, revision: await core.bookRevision(candidate) }; }); },
    async stagePhotos(planId) { return guard(async () => ({ planId, revision: preparedPlan.revision, durable: true, photosDurable: true, status: 'prepared' })); },
    async commit({ planId }) { return guard(async () => { commitCalls++; if (!committed) { committed = true; applied++; } return { planId, revision: preparedPlan.revision, durable: true }; }); },
    async acknowledge({ planId, revision }) { return guard(async () => ({ planId, revision, acknowledged: true })); },
    stats: () => ({ applied, commitCalls }),
  };
}
function pair(seed, { retry } = {}) {
  const rnd = mulberry(seed), sid = 'sess_' + seed, sides = {};
  const lane = { computer: Promise.resolve(), phone: Promise.resolve() };   // FIFO per direction, random latency
  for (const role of ['computer', 'phone']) {
    const other = role === 'computer' ? 'phone' : 'computer', s = sides[role] = { role, busyAnswers: 0, errors: [], surfaced: 0 };
    s.probe = { max: 0 }; s.store = fakeStore(role, rnd, s.probe);
    s.rpc = createSyncRpc({
      send: m => { lane[role] = lane[role].then(async () => { await sleepTicks(rnd); sides[other].rpc.receive(structuredClone(m)).catch(() => {}); }); return Promise.resolve(); },
      authorized: () => true, newIdentity: () => 'rpc_' + role + '_' + seed, validateHello: () => {},
      onHello: h => s.ctl.acceptHello(h), handle: (m, a) => s.ctl.handle(m, a),
    });
    const rpc = { request: (m, a) => s.rpc.request(m, a).catch(e => { if (e.code === 'BUSY') s.busyAnswers++; throw e; }), budget: () => s.rpc.budget() };
    s.ctl = createSyncController({ role, sessionId: sid, store: s.store, core, rpc, authorized: () => true, onChange: () => { if (s.ctl?.state().phase === 'error') s.sawError = (s.sawError || 0) + 1; }, ...(retry ? { busyRetryMs: retry } : {}) });
  }
  return { rnd, sid, sides };
}
// a user clicking again after a local "busy" refusal (the panel disables buttons while busy; this is the same thing)
async function act(s, rnd, fn) {
  for (let i = 0; i < 400; i++) {
    const before = s.busyAnswers;
    try { return await fn(); } catch (e) { s.errors.push(e.code); if (e.code !== 'BUSY') throw e; if (s.busyAnswers > before) s.surfaced++; /* a BUSY the PEER answered, not retried away */ await sleepTicks(rnd); await new Promise(r => setImmediate(r)); }
  }
  throw new Error('stuck busy');
}

async function drive(seed, retry) {
  const { rnd, sid, sides } = pair(seed, { retry }), { computer: c, phone: p } = sides, both = [c, p];
  const shuffled = () => (rnd() < 0.5 ? both : [p, c]);
  const status = s => s.rpc.request('controller_status', { schema: CONTROLLER_SCHEMA, session: sid }).catch(e => { s.errors.push('raw:' + e.code); });
  await Promise.all(both.map(s => s.ctl.hello()));
  await Promise.all(shuffled().map(async s => { await sleepTicks(rnd); await s.rpc.start({ ...(await s.ctl.hello()) }); }));
  for (const s of both) while (!s.rpc.ready()) await new Promise(r => setImmediate(r));   // the panel opens only once the peer's hello is in
  // inspect: both pull the other's book at the same moment
  await Promise.all(shuffled().map(async s => { await sleepTicks(rnd); await act(s, rnd, () => s.ctl.inspect()); }));
  for (const s of both) assert.equal(s.ctl.state().phase, 'choose', `seed ${seed} ${s.role} after inspect`);
  for (const s of both) s.ctl.choose('computer');
  // backups + refresh + raw status from both sides, interleaved randomly, until both have a plan
  for (let round = 0; round < 8 && !both.every(s => s.ctl.state().phase === 'review'); round++) {
    await Promise.all(shuffled().map(async s => {
      await sleepTicks(rnd);
      if (!s.ctl.state().backups.local) await act(s, rnd, () => s.ctl.makeBackup());
      const extra = []; if (rnd() < 0.7) extra.push(status(s));
      await Promise.all([act(s, rnd, () => s.ctl.refreshPeer()), ...extra]);
    }));
  }
  for (const s of both) assert.equal(s.ctl.state().phase, 'review', `seed ${seed} ${s.role} review (${JSON.stringify(s.errors)})`);
  // approve on both at once while refreshing
  for (let round = 0; round < 8 && !both.every(s => s.ctl.state().peerApproved); round++) {
    await Promise.all(shuffled().map(async s => {
      await sleepTicks(rnd);
      const st = s.ctl.state(), token = st.planHash;
      const ops = [];
      if (!st.approved) ops.push(act(s, rnd, () => s.ctl.approve(token)));
      if (rnd() < 0.8) ops.push(act(s, rnd, () => s.ctl.refreshPeer()));
      if (rnd() < 0.5) ops.push(status(s));
      await Promise.all(ops);
    }));
  }
  for (const s of both) { const st = s.ctl.state(); assert.ok(st.approved && st.peerApproved, `seed ${seed} ${s.role} approvals ${JSON.stringify(s.errors)}`); assert.notEqual(st.phase, 'error'); }
  // exchange: the computer coordinates (prepare/commit/ack/finish) while both sides keep reading, the phone also refreshes when its own
  // panel would allow it (gated on phase at call time, as main-book-sync does)
  const stop = { v: false };
  const noise = async s => { while (!stop.v) { await sleepTicks(rnd); const ph = s.ctl.state().phase; if (rnd() < 0.5) await status(s); else if (s.role === 'phone' && ['review', 'approved'].includes(ph) && rnd() < 0.5) await s.ctl.refreshPeer().catch(e => { s.errors.push('noise:' + e.code); if (e.code !== 'BUSY') throw e; }); await new Promise(r => setTimeout(r, 3)); /* a person does not click every microtask */ } };
  const noisy = Promise.all(both.map(noise));
  const first = act(c, rnd, () => c.ctl.coordinate());
  const second = rnd() < 0.5 ? c.ctl.coordinate().catch(e => { c.errors.push('2nd:' + e.code); }) : null;   // a double tap
  try { await first; } finally { stop.v = true; await noisy; }
  await second;
  return { sides };
}

test('200 seeded interleavings: BUSY from the peer is retried, never ends in phase error; commit applied exactly once; operations exclusive', async () => {
  let peerBusy = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const { sides } = await drive(seed, [1, 2, 4, 8, 16, 32, 64, 128]);
    for (const s of Object.values(sides)) {
      const st = s.ctl.state();
      assert.equal(s.sawError || 0, 0, `seed ${seed} ${s.role} was in phase error at some point`);
      assert.equal(s.surfaced, 0, `seed ${seed} ${s.role} a peer BUSY reached the caller`);
      assert.equal(st.phase, 'ready', `seed ${seed} ${s.role} ended in ${st.phase} ${JSON.stringify(s.errors)}`);
      assert.deepEqual(s.store.stats().applied, 1, `seed ${seed} ${s.role} commit applied once`);
      assert.equal(s.probe.max, 1, `seed ${seed} ${s.role}: at most one operation inside the store at once`);
      peerBusy += s.busyAnswers;
    }
  }
  assert.ok(peerBusy > 0, 'the race was actually exercised (some request got a BUSY answer and was retried)');
});

test('mutating handlers are exclusive: two concurrent prepare requests, one wins, the other is BUSY, the store sees one at a time', async () => {
  const { sides, sid } = pair(7, { retry: [1] }), { phone: p, computer: c } = sides;
  await Promise.all([p, c].map(s => s.ctl.hello()));
  await Promise.all([p, c].map(async s => s.rpc.start(await s.ctl.hello()))); for (const s of [p, c]) while (!s.rpc.ready()) await new Promise(r => setImmediate(r));
  await Promise.all([p, c].map(s => s.ctl.inspect())); [p, c].forEach(s => s.ctl.choose('computer'));
  for (let i = 0; i < 3; i++) await Promise.all([p, c].map(async s => { if (!s.ctl.state().backups.local) await s.ctl.makeBackup(); await s.ctl.refreshPeer(); }));
  await Promise.all([p, c].map(s => s.ctl.approve(s.ctl.state().planHash))); await Promise.all([p, c].map(s => s.ctl.refreshPeer()));
  const args = { schema: CONTROLLER_SCHEMA, session: sid, planHash: p.ctl.state().planHash };
  const res = await Promise.allSettled([p.ctl.handle('controller_prepare', args), p.ctl.handle('controller_prepare', args)]);
  assert.deepEqual(res.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(res.find(r => r.status === 'rejected').reason.code, 'BUSY');
  assert.equal(p.ctl.state().phase, 'prepared');   // the refused duplicate did not move the phase to error
  assert.equal(p.probe.max, 1);
});

test('a peer that stays BUSY surfaces BUSY after the bounded retries and the device never leaves phase error (a durable step makes it recovery-required)', async () => {
  const { sides } = pair(11, { retry: [1, 1] }), { phone: p, computer: c } = sides, both = [p, c];
  await Promise.all(both.map(s => s.ctl.hello())); await Promise.all(both.map(async s => s.rpc.start(await s.ctl.hello()))); for (const s of both) while (!s.rpc.ready()) await new Promise(r => setImmediate(r));
  await Promise.all(both.map(s => s.ctl.inspect())); both.forEach(s => s.ctl.choose('computer'));
  for (let i = 0; i < 3; i++) await Promise.all(both.map(async s => { if (!s.ctl.state().backups.local) await s.ctl.makeBackup(); await s.ctl.refreshPeer(); }));
  await Promise.all(both.map(s => s.ctl.approve(s.ctl.state().planHash))); await Promise.all(both.map(s => s.ctl.refreshPeer()));
  let release; const gate = new Promise(r => { release = r; }), orig = p.store.safetyBackup;
  p.store.safetyBackup = async () => { await gate; return orig(); };
  const held = p.ctl.makeBackup();                     // the phone is inside a long run
  await assert.rejects(c.ctl.coordinate(), e => e.code === 'BUSY');
  // the computer had already prepared durably, so the existing recoverable state applies (resume via recovery), never 'error'
  assert.equal(c.ctl.state().phase, 'recovery-required');
  assert.equal(c.store.stats().applied, 0); assert.equal(p.store.stats().applied, 0);   // nothing applied twice, nothing applied at all
  release(); await held;
  assert.notEqual(p.ctl.state().phase, 'error');
});

test('round 3: a refresh never rewinds a later phase (recovery-required after a BUSY at the durable step stays recovery-required)', async () => {
  const { sides } = pair(13, { retry: [1, 1] }), { phone: p, computer: c } = sides, both = [p, c];
  await Promise.all(both.map(s => s.ctl.hello())); await Promise.all(both.map(async s => s.rpc.start(await s.ctl.hello()))); for (const s of both) while (!s.rpc.ready()) await new Promise(r => setImmediate(r));
  await Promise.all(both.map(s => s.ctl.inspect())); both.forEach(s => s.ctl.choose('computer'));
  for (let i = 0; i < 3; i++) await Promise.all(both.map(async s => { if (!s.ctl.state().backups.local) await s.ctl.makeBackup(); await s.ctl.refreshPeer(); }));
  await Promise.all(both.map(s => s.ctl.approve(s.ctl.state().planHash))); await Promise.all(both.map(s => s.ctl.refreshPeer()));
  let release; const gate = new Promise(r => { release = r; }), orig = p.store.safetyBackup;
  p.store.safetyBackup = async () => { await gate; return orig(); };
  const held = p.ctl.makeBackup();
  await assert.rejects(c.ctl.coordinate(), e => e.code === 'BUSY');
  assert.equal(c.ctl.state().phase, 'recovery-required');
  release(); await held;
  await c.ctl.refreshPeer(); await p.ctl.refreshPeer();
  assert.equal(c.ctl.state().phase, 'recovery-required', 'refresh must not rewind to approved/review');
  assert.equal(c.store.stats().applied, 0); assert.equal(p.store.stats().applied, 0);
});
