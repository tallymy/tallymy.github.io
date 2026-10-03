// Pairing numbers identify the two DTLS certificates; no account data belongs here.
export const sdpFingerprint = sdp => {
  const values = [...new Set([...String(sdp).matchAll(/^a=fingerprint:sha-256 ([A-F0-9:]+)\r?$/gmi)].map(m => m[1].toUpperCase()))];
  if (values.length !== 1 || !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(values[0])) throw Error('Invalid connection fingerprint');
  return values[0];
};
export async function pairingCode(offer, answer) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`tally-desk-v1|${sdpFingerprint(offer)}|${sdpFingerprint(answer)}`));
  return String(new DataView(hash).getUint32(0) % 100000000).padStart(8, '0').replace(/(.{4})(.{4})/, '$1 $2');
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
