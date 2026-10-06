// Bounded messages over an ordered, encrypted RTCDataChannel. Never persist them on the PC.
export function deskWire(channel, receive, failed = () => {}) {
  const pieces = new Map(); let sequence = 0, stopped = false, queue = Promise.resolve();
  const stop = () => { stopped = true; for (const p of pieces.values()) clearTimeout(p.timer); pieces.clear(); channel.removeEventListener('message', message); };
  const fail = () => { if (stopped) return; stop(); channel.close(); failed(Error('Connection lost')); };
  function message(event) {
    try {
      if (stopped || typeof event.data !== 'string' || event.data.length > 12000) throw Error();
      const p = JSON.parse(event.data);
      if (p.v !== 1 || !Number.isInteger(p.id) || p.id < 1 || !Number.isInteger(p.n) || p.n < 1 || p.n > 256 || !Number.isInteger(p.i) || p.i < 0 || p.i >= p.n || typeof p.text !== 'string' || p.text.length > 8000) throw Error();
      let item = pieces.get(p.id);
      if (!item) {
        if (pieces.size >= 4 || p.i !== 0) throw Error();
        item = { n: p.n, parts: [], size: 0, timer: setTimeout(fail, 10000) }; pieces.set(p.id, item);
      }
      if (item.n !== p.n || item.parts.length !== p.i) throw Error();
      item.parts.push(p.text); item.size += p.text.length; if (item.size > 2_000_000) throw Error();
      if (item.parts.length === item.n) { clearTimeout(item.timer); pieces.delete(p.id); const value = JSON.parse(item.parts.join('')); Promise.resolve(receive(value)).catch(fail); }
    } catch { fail(); }
  }
  channel.addEventListener('message', message);
  return { stop, send(value) {
    const operation = async () => {
      const text = JSON.stringify(value); if (text.length > 2_000_000) throw Error('Too much data');
      const id = ++sequence, n = Math.max(1, Math.ceil(text.length / 8000));
      for (let i = 0; i < n; i++) {
        const start = Date.now();
        while (channel.bufferedAmount > 128000) { if (Date.now() - start > 5000 || stopped || channel.readyState !== 'open') throw Error('Connection lost'); await new Promise(r => setTimeout(r, 20)); }
        if (stopped || channel.readyState !== 'open') throw Error('Connection lost');
        channel.send(JSON.stringify({ v: 1, id, n, i, text: text.slice(i * 8000, (i + 1) * 8000) }));
      }
    };
    const result = queue.then(operation); queue = result.catch(() => {}); return result;
  } };
}
export function approvedDesk(channel, code, receive, ready, lost, windowMs = 60000) {
  let mine = false, theirs = false, authorized = false, dead = false;
  // Both devices must approve within the window after the numbers appear; otherwise the session is invalidated.
  const expiry = setTimeout(() => { if (!authorized) fail(); }, windowMs); expiry?.unref?.();
  const fail = () => { if (dead) return; dead = true; clearTimeout(expiry); wire.stop(); channel.close(); lost(); };
  const check = () => { if (!authorized && mine && theirs) { authorized = true; clearTimeout(expiry); ready(); } };
  const wire = deskWire(channel, async value => {
    if (!value || typeof value !== 'object') return fail();
    if (value.kind === 'approve') { if (value.code !== code) return fail(); theirs = true; check(); return; }
    if (!authorized) return fail();
    await receive(value);
  }, fail);
  channel.addEventListener('close', fail, { once: true }); channel.addEventListener('error', fail, { once: true });
  return { approve: async () => { if (dead) throw Error('Connection lost'); mine = true; await wire.send({ kind: 'approve', code }); check(); },
    send: value => authorized && !dead ? wire.send(value) : Promise.reject(Error('Connection is not approved')), close: fail, authorized: () => authorized && !dead };
}
