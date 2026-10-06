// Pairing numbers identify the two DTLS certificates; no account data belongs here.
export const sdpFingerprint = sdp => {
  const values = [...new Set([...String(sdp).matchAll(/^a=fingerprint:sha-256 ([A-F0-9:]+)\r?$/gmi)].map(m => m[1].toUpperCase()))];
  if (values.length !== 1 || !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(values[0])) throw Error('Invalid connection fingerprint');
  return values[0];
};
// Short authentication string (SAS), ZRTP style commit-then-reveal. The 6-digit joining code is only an access gate (it is public on the LAN);
// the SAS is the authentication. Each side commits to H(role|fingerprint|nonce) BEFORE it sees the other side's nonce, then reveals.
// A man in the middle fixes its nonce first on both legs, so the two screens match only by chance (about 2^-40 per attempt).
const SAS_CTX = 'tally-sas-v2', FP = /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/, NONCE = /^[a-f0-9]{32}$/, HASH = /^[a-f0-9]{64}$/;
export const SAS_WINDOW_MS = 60000;
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
export async function sasCommit(role, fp, nonce) {
  if (!['offer', 'answer'].includes(role) || !FP.test(fp) || !NONCE.test(nonce)) throw Error('Invalid commitment');
  return hex(await sha(`${SAS_CTX}|commit|${role}|${fp}|${nonce}`));
}
// 12 decimal digits (about 39.9 bits), grouped 4-4-4. offer = the phone, answer = the computer.
export async function sasCode(offerFp, answerFp, offerNonce, answerNonce) {
  if (!FP.test(offerFp) || !FP.test(answerFp) || !NONCE.test(offerNonce) || !NONCE.test(answerNonce)) throw Error('Invalid pairing values');
  const hash = await sha(`${SAS_CTX}|code|${offerFp}|${answerFp}|${offerNonce}|${answerNonce}`);
  return String(new DataView(hash.buffer).getBigUint64(0) % 1000000000000n).padStart(12, '0').replace(/(.{4})(.{4})(.{4})/, '$1 $2 $3');
}
export const SAS_FORMAT = /^\d{4} \d{4} \d{4}$/;
// Phone (role 'offer') commits first, the computer commits after it, the phone reveals, the computer verifies and reveals, the phone verifies.
// Messages are exact JSON, v:2. An old peer (v:1 framing, 8 digits) fails closed: nothing is accepted that is not the next expected step.
export function sasHandshake(channel, { role, offer, answer, timeout = 15000, random = () => crypto.getRandomValues(new Uint8Array(16)) }) {
  if (!['offer', 'answer'].includes(role)) throw Error('Invalid role');
  const fps = { offer: sdpFingerprint(offer), answer: sdpFingerprint(answer) }, peerRole = role === 'offer' ? 'answer' : 'offer', mine = hex(random());
  return new Promise((resolve, reject) => {
    let step = role === 'offer' ? 'peer-commit' : 'first-commit', myCommit, peerCommit, peerNonce, done = false;
    const finish = error => { if (done) return; done = true; clearTimeout(timer); channel.removeEventListener('message', onMessage); if (error) { try { channel.close(); } catch {} reject(error); } };
    const timer = setTimeout(() => finish(Error('Pairing timed out')), timeout);
    const send = value => channel.send(JSON.stringify({ v: 2, ...value }));
    const parse = (data, type, keys) => {
      if (typeof data !== 'string' || data.length > 400) throw Error('Pairing message rejected');
      const value = JSON.parse(data);
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== 2 || value.t !== type || Object.keys(value).sort().join() !== ['t', 'v', ...keys].sort().join()) throw Error('Pairing message rejected');
      return value;
    };
    const onMessage = event => (async () => {
      try {
        if (step === 'first-commit') { // computer: wait for the phone's commit, then commit
          peerCommit = parse(event.data, 'sas-commit', ['c']).c; if (!HASH.test(peerCommit)) throw Error('Pairing message rejected');
          myCommit = await sasCommit(role, fps[role], mine); send({ t: 'sas-commit', c: myCommit }); step = 'peer-reveal';
        } else if (step === 'peer-commit') { // phone: wait for the computer's commit, then reveal
          peerCommit = parse(event.data, 'sas-commit', ['c']).c; if (!HASH.test(peerCommit) || peerCommit === myCommit) throw Error('Pairing message rejected');
          step = 'peer-reveal'; send({ t: 'sas-reveal', f: fps[role], n: mine });
        } else if (step === 'peer-reveal') {
          const value = parse(event.data, 'sas-reveal', ['f', 'n']);
          if (value.f !== fps[peerRole] || !NONCE.test(value.n) || value.n === mine || await sasCommit(peerRole, value.f, value.n) !== peerCommit) throw Error('Pairing commitment mismatch');
          peerNonce = value.n; step = 'done';
          if (role === 'answer') send({ t: 'sas-reveal', f: fps[role], n: mine });
          const code = role === 'offer' ? await sasCode(fps.offer, fps.answer, mine, peerNonce) : await sasCode(fps.offer, fps.answer, peerNonce, mine);
          finish(); resolve(code);
        } else throw Error('Pairing message rejected');
      } catch (error) { finish(error); }
    })();
    channel.addEventListener('message', onMessage);
    if (role === 'offer') sasCommit(role, fps[role], mine).then(c => { if (done) return; myCommit = c; send({ t: 'sas-commit', c }); }).catch(finish);
  });
}
export function phoneAddress(input) {
  const match = /^(?:http:\/\/)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})\/?$/.exec(String(input).trim());
  if (!match) throw Error('Copy the phone address exactly, including the colon and last number.');
  const octets = match[1].split('.').map(Number), port = Number(match[2]);
  if (octets.some(n => n > 255) || port < 1024 || port > 65535 || !(octets[0] === 10 || octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 127)) throw Error('Use the address shown on your phone.');
  return `http://${octets.join('.')}:${port}`;
}
export function validSdp(sdp) {
  if (typeof sdp !== 'string' || sdp.length > 64000 || !sdp.startsWith('v=0\r\n') || !/m=application /.test(sdp) || /m=(audio|video) /.test(sdp)) throw Error('Invalid connection');
  sdpFingerprint(sdp); return sdp;
}
export async function gather(peer) {
  if (peer.iceGatheringState === 'complete') return;
  await new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', change); };
    const change = () => { if (peer.iceGatheringState === 'complete') { done(); resolve(); } };
    const timer = setTimeout(() => { done(); reject(Error('Could not prepare the connection. Try again.')); }, 12000);
    peer.addEventListener('icegatheringstatechange', change); change();
  });
}
