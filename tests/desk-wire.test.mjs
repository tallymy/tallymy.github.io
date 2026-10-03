import test from 'node:test';
import assert from 'node:assert/strict';
import { deskWire, approvedDesk } from '../js/desk-wire.js';
import { phoneAddress } from '../js/desk-pair.js';
class Channel extends EventTarget {
  readyState = 'open'; bufferedAmount = 0;
  send(data) { queueMicrotask(() => { if (this.other.readyState === 'open') this.other.dispatchEvent(new MessageEvent('message', { data })); }); }
  close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; this.dispatchEvent(new Event('close')); this.other.close(); }
}
const pair = () => { const a = new Channel(), b = new Channel(); a.other = b; b.other = a; return [a, b]; };
const turn = () => new Promise(r => setTimeout(r, 5));
test('expense messages require approval from both devices', async () => {
  const [a, b] = pair(); let opened = 0, received;
  const phone = approvedDesk(a, '1234 5678', () => {}, () => opened++, () => {});
  const pc = approvedDesk(b, '1234 5678', v => { received = v; }, () => opened++, () => {});
  await assert.rejects(phone.send({ kind: 'book' })); await phone.approve(); await turn();
  assert.equal(opened, 0); await assert.rejects(pc.send({ kind: 'write' }));
  await pc.approve(); await turn(); assert.equal(opened, 2);
  await phone.send({ kind: 'book', amount: 1000 }); await turn(); assert.equal(received.amount, 1000); phone.close();
});
test('mismatched pairing numbers close the connection without exposing the book', async () => {
  const [a, b] = pair(); let authorized = 0;
  const phone = approvedDesk(a, '1234 5678', () => {}, () => authorized++, () => {});
  const pc = approvedDesk(b, '8765 4321', () => {}, () => authorized++, () => {});
  await pc.approve(); await turn(); assert.equal(authorized, 0); assert.equal(a.readyState, 'closed'); phone.close();
});
test('fragmented Unicode book messages arrive complete and oversized frames fail closed', async () => {
  const [a, b] = pair(); let got, failed = 0;
  const sender = deskWire(a, () => {}), receiver = deskWire(b, v => { got = v; }, () => failed++);
  const book = { text: '茶🍜'.repeat(20000) }; await sender.send(book); await turn(); assert.deepEqual(got, book);
  a.send('x'.repeat(12001)); await turn(); assert.equal(failed, 1); sender.stop(); receiver.stop();
});
test('financial messages before approval and out-of-order fragments fail closed', async () => {
  const [a, b] = pair(); const phone = approvedDesk(a, '1234 5678', () => assert.fail(), () => assert.fail(), () => {});
  const rogue = deskWire(b, () => {}); await rogue.send({ kind: 'write' }); await turn(); assert.equal(a.readyState, 'closed'); phone.close(); rogue.stop();
  const [c, d] = pair(); let failed = 0; const receiver = deskWire(d, () => assert.fail(), () => failed++);
  c.send(JSON.stringify({ v: 1, id: 1, n: 2, i: 1, text: '{}' })); await turn(); assert.equal(failed, 1); receiver.stop();
});
test('signaling addresses must be literal private addresses, without credentials or paths', () => {
  assert.equal(phoneAddress('192.168.1.5:49123'), 'http://192.168.1.5:49123');
  for (const address of ['https://evil.test', '8.8.8.8:4000', '192.168.999.2:4000', 'user@192.168.1.2:4000', '192.168.1.2:80', '192.168.1.2:4000/private', '192.168.1.2:4000?x=1']) assert.throws(() => phoneAddress(address));
});
