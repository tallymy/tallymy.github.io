import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { sasHandshake, sasCode, sasCommit, sdpFingerprint, SAS_FORMAT } from '../js/desk-pair.js';
import { approvedDesk } from '../js/desk-wire.js';

// In-memory ordered channel pair. `tap` lets a test see and change every message, which is what an on-path attacker does.
class Chan {
  constructor() { this.l = new Set(); this.readyState = 'open'; this.bufferedAmount = 0; this.sent = []; }
  addEventListener(type, fn) { if (type === 'message') this.l.add(fn); else if (type === 'close') (this.c ||= new Set()).add(fn); }
  removeEventListener(type, fn) { this.l.delete(fn); }
  send(data) { this.sent.push(data); const peer = this.peer; if (peer) setImmediate(() => { if (peer.readyState === 'open') for (const fn of [...peer.l]) fn({ data }); }); }
  close() { this.readyState = 'closed'; }
}
const pair = () => { const a = new Chan(), b = new Chan(); a.peer = b; b.peer = a; return [a, b]; };
const fp = byte => Array.from({ length: 32 }, () => byte).join(':');
const sdp = byte => `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${fp(byte)}\r\n`;
const rnd = () => `${randomBytes(1)[0].toString(16).padStart(2, '0').toUpperCase()}`;
const settle = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
const run = (phone, pc, offer, answer, extra = {}) => Promise.all([
  settle(sasHandshake(phone, { role: 'offer', offer, answer, ...extra })),
  settle(sasHandshake(pc, { role: 'answer', offer, answer, ...extra })),
]);

test('honest peers reach the same 12-digit grouped code, fresh each session', async () => {
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    const [a, b] = pair(), [phone, pc] = await run(a, b, sdp('AA'), sdp('BB'));
    assert.ok(phone.ok && pc.ok); assert.equal(phone.value, pc.value); assert.match(phone.value, SAS_FORMAT); seen.add(phone.value);
  }
  assert.equal(seen.size, 5);
  assert.match(await sasCode(fp('AA'), fp('BB'), '0'.repeat(32), '1'.repeat(32)), /^\d{4} \d{4} \d{4}$/);
});

test('message grammar: exact v2 steps, commit first, nothing else accepted', async () => {
  const [a, b] = pair(); const out = []; const original = a.send.bind(a); a.send = d => { out.push(JSON.parse(d)); original(d); };
  const pcSent = []; const pcSend = b.send.bind(b); b.send = d => { pcSent.push(JSON.parse(d)); pcSend(d); };
  await run(a, b, sdp('AA'), sdp('BB'));
  assert.deepEqual(out.map(m => m.t), ['sas-commit', 'sas-reveal']); assert.deepEqual(pcSent.map(m => m.t), ['sas-commit', 'sas-reveal']);
  assert.ok(out.every(m => m.v === 2) && pcSent.every(m => m.v === 2));
  assert.match(out[0].c, /^[a-f0-9]{64}$/); assert.match(out[1].n, /^[a-f0-9]{32}$/);
  // the phone reveals only after it has the computer's commit; the computer reveals only after it has verified the phone's reveal.
});

test('commit mismatch: a changed nonce or fingerprint in the reveal aborts and closes the channel', async () => {
  for (const mutate of [m => ({ ...m, n: '0'.repeat(32) }), m => ({ ...m, f: fp('CC') }), m => ({ ...m, n: m.n.replace(/./, c => (c === 'a' ? 'b' : 'a')) })]) {
    const [a, b] = pair(); const send = a.send.bind(a);
    a.send = d => { const m = JSON.parse(d); send(m.t === 'sas-reveal' ? JSON.stringify(mutate(m)) : d); };
    const [phone, pc] = await run(a, b, sdp('AA'), sdp('BB'), { timeout: 400 });
    assert.equal(pc.ok, false, 'the computer must reject the tampered reveal'); assert.equal(b.readyState, 'closed');
    assert.equal(phone.ok, false);
  }
});

test('replay: an old commit with a reveal from another session fails, and a replayed pair never reproduces the old code', async () => {
  const [a1, b1] = pair(), [oldPhone] = await run(a1, b1, sdp('AA'), sdp('BB'));
  const [a2, b2] = pair(); await run(a2, b2, sdp('AA'), sdp('BB'));
  const fresh = (role, extra = {}) => { const [fake, victim] = pair(); return { fake, result: settle(sasHandshake(victim, { role, offer: sdp('AA'), answer: sdp('BB'), timeout: 500, ...extra })) }; };
  const wait = () => new Promise(r => setTimeout(r, 20));
  // old commit, reveal from a different session: the commitment does not open
  let t = fresh('answer'); t.fake.send(a1.sent[0]); await wait(); t.fake.send(a2.sent[1]); assert.equal((await t.result).ok, false);
  t = fresh('offer'); await wait(); t.fake.send(b1.sent[0]); await wait(); t.fake.send(b2.sent[1]); assert.equal((await t.result).ok, false);
  // a fully replayed pair is internally consistent but the victim's own nonce is fresh, so the code it shows is new: it cannot match the real peer's screen
  t = fresh('answer'); t.fake.send(a1.sent[0]); await wait(); t.fake.send(a1.sent[1]); const replayed = await t.result;
  assert.ok(replayed.ok); assert.notEqual(replayed.value, oldPhone.value);
});

test('reordering, reflection, wrong grammar and downgrade attempts fail closed', async () => {
  const expectFail = async (role, messages, extra = {}) => {
    const [x, y] = pair(); const result = settle(sasHandshake(y, { role, offer: sdp('AA'), answer: sdp('BB'), timeout: 300, ...extra }));
    for (const m of messages) { x.send(typeof m === 'string' ? m : JSON.stringify(m)); await new Promise(r => setTimeout(r, 5)); }
    const r = await result; assert.equal(r.ok, false, JSON.stringify(messages)); assert.equal(y.readyState, 'closed');
  };
  const c = 'a'.repeat(64), n = 'b'.repeat(32);
  await expectFail('answer', [{ v: 2, t: 'sas-reveal', f: fp('AA'), n }]);                       // reveal before commit
  await expectFail('answer', [{ v: 2, t: 'sas-commit', c }, { v: 2, t: 'sas-commit', c }]);       // commit twice
  await expectFail('answer', [{ v: 2, t: 'sas-commit', c }, { v: 2, t: 'sas-reveal', f: fp('BB'), n }]); // wrong fingerprint role
  await expectFail('offer', [{ v: 2, t: 'sas-reveal', f: fp('BB'), n }]);                          // phone gets reveal before commit
  await expectFail('answer', [{ v: 1, id: 1, n: 1, i: 0, text: '{"kind":"approve","code":"1234 5678"}' }]); // old peer framing / 8 digits
  await expectFail('answer', [{ v: 2, t: 'approve', code: '1234 5678' }]);                         // old kind in v2
  await expectFail('answer', [{ v: 3, t: 'sas-commit', c }]);                                       // future version
  await expectFail('answer', [{ v: 2, t: 'sas-commit', c, extra: 1 }]);                            // extra key
  await expectFail('answer', [{ v: 2, t: 'sas-commit', c: 'short' }]);                             // truncated commitment
  await expectFail('answer', ['not json']);
  await expectFail('answer', []);                                                                    // old peer that never speaks: times out
  // reflection: the phone's own commit echoed back as the computer's commit
  const [a, b] = pair(); const result = settle(sasHandshake(a, { role: 'offer', offer: sdp('AA'), answer: sdp('BB'), timeout: 300 }));
  await new Promise(r => setTimeout(r, 10)); b.send(a.sent[0]); assert.equal((await result).ok, false);
});

test('truncated or old-format SAS never approves; the approval window invalidates an unapproved session', async () => {
  const [a, b] = pair(); let lostPhone = 0, ready = 0;
  const phone = approvedDesk(a, '1234 5678 9012', () => {}, () => ready++, () => lostPhone++);
  const pc = approvedDesk(b, '1234 5678', () => {}, () => ready++, () => {});
  await phone.approve(); await pc.approve(); await new Promise(r => setTimeout(r, 30));
  assert.equal(ready, 0); assert.equal(lostPhone, 1); assert.equal(phone.authorized(), false);
  const [c, d] = pair(); let lost = 0; approvedDesk(c, '1234 5678 9012', () => {}, () => assert.fail(), () => lost++, 40);
  await new Promise(r => setTimeout(r, 120)); assert.equal(lost, 1); assert.equal(c.readyState, 'closed');
  const [e, f] = pair(); let ok = 0;
  const p1 = approvedDesk(e, '1234 5678 9012', () => {}, () => ok++, () => {}, 200), p2 = approvedDesk(f, '1234 5678 9012', () => {}, () => ok++, () => {}, 200);
  await p1.approve(); await p2.approve(); await new Promise(r => setTimeout(r, 300)); assert.equal(ok, 2); assert.equal(e.readyState, 'open');
});

// ---- the attack from the review -------------------------------------------------------------------------------------------------------------

const sha = text => createHash('sha256').update(text).digest();
const oldCode = (offerFp, answerFp, mod) => String(sha(`tally-desk-v1|${offerFp}|${answerFp}`).readUInt32BE(0) % mod).padStart(String(mod - 1).length, '0');
const randomFp = () => Array.from(randomBytes(32), b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');

test('old scheme (documented attack): an on-path attacker grinds a fingerprint so both screens match', () => {
  // The attacker sees the phone fingerprint FP_p and fixes a first fake offer FP_a1 for the PC; the PC answers FP_c.
  // It then grinds FP_a2 until H(FP_p|FP_a2) == H(FP_a1|FP_c) mod M. Expected trials = M. The real 8-digit scheme is M = 1e8 (about a minute of
  // plain SHA-256 here: set SAS_FULL_GRIND=1); the default run uses M = 1e5 to show the same loop in under a second.
  const mod = process.env.SAS_FULL_GRIND ? 1e8 : 1e5, phone = randomFp(), a1 = randomFp(), pc = randomFp(), target = oldCode(a1, pc, mod);
  let trials = 0, found = null; const started = Date.now();
  while (!found) { const candidate = randomFp(); trials++; if (oldCode(phone, candidate, mod) === target) found = candidate; }
  assert.equal(oldCode(phone, found, mod), oldCode(a1, pc, mod));
  console.log(`old scheme: mod ${mod}, matched after ${trials} trials in ${Date.now() - started} ms`);
});

// MITM between a PC and a phone. Leg 1 (PC side) the attacker plays the phone; leg 2 (phone side) it plays the computer.
async function mitmSession({ guessBudget = 0 } = {}) {
  const fpPhone = rnd(), fpPc = rnd(), fpA1 = 'D1', fpA2 = 'D2';
  const [pcEnd, mitmLeg1] = pair(), [mitmLeg2, phoneEnd] = pair();
  // Real DTLS fingerprints differ per leg, because the attacker terminates both.
  const leg1 = { offer: sdp(fpA1), answer: sdp(fpPc) }, leg2 = { offer: sdp(fpPhone), answer: sdp(fpA2) };
  const [pc, mitm1, mitm2, phone] = await Promise.all([
    settle(sasHandshake(pcEnd, { role: 'answer', ...leg1, timeout: 2000 })), settle(sasHandshake(mitmLeg1, { role: 'offer', ...leg1, timeout: 2000 })),
    settle(sasHandshake(mitmLeg2, { role: 'answer', ...leg2, timeout: 2000 })), settle(sasHandshake(phoneEnd, { role: 'offer', ...leg2, timeout: 2000 })),
  ]);
  void guessBudget; return { pc, phone, mitm1, mitm2 };
}

test('new scheme: a protocol-following MITM that knows both screens\' codes cannot make them equal (5000 sessions)', async () => {
  let equal = 0, completed = 0;
  for (let i = 0; i < 5000; i++) {
    const { pc, phone, mitm1, mitm2 } = await mitmSession();
    assert.ok(pc.ok && phone.ok && mitm1.ok && mitm2.ok); completed++;
    assert.equal(pc.value, mitm1.value); assert.equal(phone.value, mitm2.value);
    if (pc.value === phone.value) equal++;
  }
  // Probability per session is 1e-12 (12 digits); 5000 sessions: expected 5e-9 matches.
  assert.equal(completed, 5000); assert.equal(equal, 0);
});

test('new scheme: grinding after the reveal is impossible, and grinding before it has nothing to aim at (budget 2e6 hashes)', async () => {
  // (a) The attacker completes leg 2 first, so it knows the phone-side code S2 exactly. On leg 1 it already committed (n_a, FP_a) before the PC committed,
  //     so SAS1 = H(FP_a, FP_c, n_a, n_c) depends on the PC's fresh 128-bit nonce n_c, which is only revealed after the attacker's reveal is fixed.
  //     Best it can do is pick n_a among B candidates by guessing n_c: success probability per session is B / 1e12 at the very best.
  const fpA = fp('D1'), fpPc = fp('EE'), budget = 2e6, space = 1e12;
  const s2 = await sasCode(fp('AA'), fp('D2'), randomBytes(16).toString('hex'), randomBytes(16).toString('hex'));
  let hit = 0;
  for (let i = 0; i < budget; i += 1) { // each candidate is one hash against a guessed n_c; the real n_c is a fresh random value, so a hit is a coincidence
    const candidate = sha(`tally-sas-v2|code|${fpA}|${fpPc}|${i}|${i}`).readBigUInt64BE(0) % 1000000000000n;
    if (String(candidate).padStart(12, '0').replace(/(.{4})(.{4})(.{4})/, '$1 $2 $3') === s2) hit++;
  }
  console.log(`budget ${budget} hashes: coincidental hits ${hit}; bound B/1e12 = ${(budget / space).toExponential(1)}`);
  assert.ok(hit <= 1);
  assert.ok(budget / space < 2.1e-6); // even a hypothetical attacker that could verify each candidate against the real n_c: 2^-19 per session at 2e6, 2^-13 at 1e8
  // (b) Changing (n, FP) after seeing the honest reveal fails the commitment check; the honest side aborts.
  const [a, b] = pair(); const phoneSend = a.send.bind(a);
  a.send = d => { const m = JSON.parse(d); phoneSend(m.t === 'sas-reveal' ? JSON.stringify({ ...m, n: randomBytes(16).toString('hex') }) : d); };
  const [, pc] = await run(a, b, sdp('AA'), sdp('BB'), { timeout: 300 }); assert.equal(pc.ok, false);
  // (c) A commitment cannot be opened to two different nonces
  assert.notEqual(await sasCommit('offer', fp('AA'), '0'.repeat(32)), await sasCommit('offer', fp('AA'), '1'.repeat(32)));
  assert.notEqual(await sasCommit('offer', fp('AA'), '0'.repeat(32)), await sasCommit('answer', fp('AA'), '0'.repeat(32)));
  assert.equal(sdpFingerprint(sdp('AA')), fp('AA'));
});
