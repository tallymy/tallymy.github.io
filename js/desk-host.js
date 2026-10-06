import { S, settings, today, load, putAll, expenseCats, incomeCats, locked, setKv } from './state.js';
import { deskAccount, deskEditable, deskWrite, recordVersion } from './desk-protocol.js';
import { sasHandshake, validSdp, gather } from './desk-pair.js';
import { approvedDesk } from './desk-wire.js';
import { balances } from './engine.js';
import { literalT as t, getLang } from './i18n.js';
import { esc, openSheet, closeSheet, toast, ICON } from './ui.js';
import { render } from './app.js';
import { get } from './db.js';
import { privacyLocked } from './lock.js';

let session;
const native = () => globalThis.Capacitor?.Plugins?.TallyNative;
const allowed = () => !document.hidden && !locked() && privacyLocked() === false;
const categories = () => [...expenseCats().map(c => ({ id: c.id, name: t(c.name), type: 'expense' })), ...incomeCats().map(c => ({ id: c.id, name: t(c.name), type: 'income' }))];
export function deskSnapshot() {
  const accounts = S.accounts.filter(deskAccount), ids = new Set(accounts.map(a => a.id)), by = balances(S.accounts, S.tx, today()).by;
  return { kind: 'book', today: today(), lang: getLang(), place: S.kv.deskPlace || null, accounts: accounts.map(a => ({ id: a.id, name: a.name, balance: by[a.id] || 0 })), categories: categories(),
    tx: S.tx.filter(x => ids.has(x.accountId)).sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 200).map(x => ({ id: x.id, type: x.type, amount: x.amount, date: x.date, accountId: x.accountId, category: x.category, merchant: x.merchant || '', note: x.note || '', editable: deskEditable(x), base: deskEditable(x) ? recordVersion(x) : null })) };
}
function stop(message = '') {
  const s = session; session = null; if (!s) return;
  clearInterval(s.timer); clearTimeout(s.expiry); s.link?.close(); s.peer?.close(); s.badge?.remove();
  s.native?.close().catch(() => {}); if (message) toast(message);
  if (s.sheet?.isConnected && !s.sheet.closest('.scrim')?.classList.contains('out')) paintStopped(s.sheet);   // never leave the old address and code visible
}
async function push(s) {
  const link = s.link;
  if (session !== s || link?.authorized() !== true) return;
  if (!allowed() || S.kv.bookGeneration !== s.generation) { stop(); return; }
  const generationRecord = await get('kv', 'bookGeneration');
  if (session !== s || s.link !== link || link.authorized() !== true) return;
  if (!allowed() || S.kv.bookGeneration !== s.generation || generationRecord?.value !== s.generation) { stop(); return; }
  const book = deskSnapshot(), version = JSON.stringify(book);
  if (version === s.last) return;
  s.last = version; await link.send(book);
}
async function command(s, request) {
  if (session !== s) return;
  if (!allowed() || S.kv.bookGeneration !== s.generation) return stop();
  if (Date.now() - (s.rateStart || 0) > 1000) { s.rateStart = Date.now(); s.rateCount = 0; }
  if (++s.rateCount > 40) throw Error('Too many requests');
  if (request?.kind === 'ping') { await s.link.send({ kind: 'pong' }); return; }
  if (request?.kind === 'place') {
    if (s.placeSaving || Date.now() - (s.placedAt || 0) < 1000) return;
    const validId = id => id == null || typeof id === 'string' && id.length <= 60 && S.tx.some(x => x.id === id && deskAccount(S.accounts.find(a => a.id === x.accountId)));
    if (!validId(request.topId) || !validId(request.editId)) throw Error('Invalid place');
    s.placeSaving = true; s.placedAt = Date.now();
    try { await setKv('deskPlace', { topId: request.topId || null, editId: request.editId || null }); } catch { /* Optional position memory must not hide saved expenses. */ }
    finally { s.placeSaving = false; }
    return;
  }
  if (!request || request.kind !== 'write' || typeof request.requestId !== 'string' || !/^[\w-]{1,60}$/.test(request.requestId)) throw Error('Invalid request');
  if (s.seen.has(request.requestId)) { await s.link.send(s.seen.get(request.requestId)); return; }
  if (++s.waiting > 8) throw Error('Too many changes');
  const link = s.link;
  s.queue = s.queue.then(async () => {
    let reply;
    try {
      if (session !== s || !s.link.authorized() || !allowed()) return;
      if (s.seen.has(request.requestId)) { await s.link.send(s.seen.get(request.requestId)); return; }
      await load();
      if (session !== s || !allowed()) return;
      if (S.kv.bookGeneration !== s.generation) { stop(); return; }
      const [settingsRecord, catsRecord, generationRecord] = await Promise.all([get('kv', 'settings'), get('kv', 'customCats'), get('kv', 'bookGeneration')]);
      if (session !== s || !allowed() || s.link !== link || link.authorized() !== true) return;
      if (recordVersion(settingsRecord?.value || {}) !== recordVersion(settings())) throw Object.assign(Error(), { code: 'STALE' });
      if (generationRecord?.value !== s.generation) { stop(); return; }
      const catShape = list => (list || []).map(c => [c.id, c.kind || 'expense']);
      if (recordVersion(catShape(catsRecord?.value)) !== recordVersion(catShape(S.kv.customCats))) throw Object.assign(Error(), { code: 'STALE' });
      const write = deskWrite({ accounts: S.accounts, tx: S.tx, settings: settings(), categories: categories(), guardKv: [{ id: 'settings', value: settingsRecord || undefined }, { id: 'customCats', value: catsRecord || undefined }, { id: 'bookGeneration', value: generationRecord || undefined }] }, request.change, today());
      const beforeWrite = () => {
        if (session !== s || !allowed() || s.link !== link || link.authorized() !== true) throw Object.assign(Error('Connection ended'), { code: 'CANCELLED' });
      };
      await putAll({ ...write, beforeWrite });
      if (session === s && allowed()) render();
      reply = { kind: 'result', requestId: request.requestId, ok: true };
    } catch (error) { reply = { kind: 'result', requestId: request.requestId, ok: false, code: error.code === 'STALE' ? 'STALE' : 'SAVE', message: error.code === 'STALE' ? t('The entry changed on your phone. Refresh and try again.') : t('Could not save. Check the entry and free space on your phone, then try again.') }; }
    finally { s.waiting--; }
    if (!reply || session !== s) return;
    s.seen.set(request.requestId, reply); if (s.seen.size > 64) s.seen.delete(s.seen.keys().next().value);
    await s.link.send(reply); s.last = ''; await push(s);
  });
  await s.queue;
}
function pairingSheet(s) {
  const ready = s.link?.authorized(), code = s.code;
  const box = openSheet(`<div class="sheethead"><h2 class="sh-title">${esc(t('Use Tally on your computer'))}</h2><button class="icon-btn" data-desk="close" aria-label="${esc(t('Close'))}">${ICON.x}</button></div>
    ${ready ? `<p>${esc(t('Connected. Changes you save on the computer are saved on this phone.'))}</p><p class="fine">${esc(t('Keep Tally open. Switching apps or locking your phone ends the connection.'))}</p>` : code ? `<p>${esc(t('Do these numbers match the computer?'))}</p><p class="desk-code num" aria-label="${esc(code.replace(/\D/g, '').replace(/(\d)/g, '$1 '))}">${esc(code)}</p><p class="fine">${esc(t('Only tap Yes if both screens show the same 12 digits. You have 1 minute. If they differ, disconnect and start again.'))}</p><button class="btn wide" data-desk="approve"${s.approved ? ' disabled' : ''}>${esc(t('Yes, they match'))}</button><p class="fine" id="desk-wait">${s.approved ? esc(t('Waiting for the computer to approve.')) : ''}</p>` : `<ol class="desk-steps"><li>${esc(t('Put your phone and computer on the same Wi-Fi. Or connect the computer to your phone hotspot.'))}</li><li>${esc(t('On the computer, open'))} <b>https://tallymy.github.io/connect.html</b></li><li>${esc(t('Type this phone address and joining code on the computer.'))}<p class="fine">${esc(t('Phone address'))}</p><p class="desk-code num">${esc(s.address)}</p><p class="fine">${esc(t('Joining code'))}</p><p class="desk-code num">${esc(s.pin)}</p></li></ol><p class="fine">${esc(t('If the computer asks to find devices on your network, choose Allow.'))}</p>`}
    <p class="fine">${esc(t('Your book stays on your phone. This computer keeps no saved copy.'))}</p><button class="btn ghost danger wide" data-desk="stop">${esc(t('Disconnect'))}</button>`);
  s.sheet = box;
  box.querySelector('[data-desk="close"]').onclick = () => { closeSheet(); if (!ready) stop(); };
  box.querySelector('[data-desk="stop"]').onclick = () => { closeSheet(); stop(t('Disconnected')); };
  box.querySelector('[data-desk="approve"]')?.addEventListener('click', async event => {
    event.target.disabled = true;
    try { s.approved = true; box.querySelector('#desk-wait').textContent = t('Waiting for the computer to approve.'); await s.link.approve(); }
    catch { stop(t('Connection ended. Start again on your phone.')); closeSheet(); }
  });
}
async function start() {
  if (!allowed() || !native() || session) return;
  const s = { generation: S.kv.bookGeneration, queue: Promise.resolve(), waiting: 0, seen: new Map() }; session = s;
  try {
    const service = await (await import('./native-pair-singleton.js')).getNativePairService();   // native app only: not fetched by the web build
    if (session !== s) return;
    if (!allowed()) { stop(); return; }
    s.native = service.acquire('legacy-editor', () => { if (session === s) stop(t('Disconnected')); });
    const peer = s.peer = new RTCPeerConnection({ iceServers: [] }), channel = s.channel = peer.createDataChannel('tally-book', { ordered: true });
    await peer.setLocalDescription(await peer.createOffer()); await gather(peer);
    if (session !== s) return;
    s.offer = validSdp(peer.localDescription.sdp);
    const details = await s.native.startLanPair({ offer: s.offer });
    if (session !== s) { await s.native.close(); return; }
    Object.assign(s, details); pairingSheet(s);
    s.expiry = setTimeout(() => { if (session === s && !s.link?.authorized()) { stop(t('Connection ended. Start again on your phone.')); closeSheet(); } }, 600000);
    const connected = async () => {
      if (session !== s || s.link || !s.answer || channel.readyState !== 'open') return;
      s.code = await sasHandshake(channel, { role: 'offer', offer: s.offer, answer: s.answer }); if (session !== s) return;
      s.link = approvedDesk(channel, s.code, request => command(s, request), () => {
        if (session !== s) return;
        if (!allowed()) return stop();
        closeSheet(); s.badge = document.createElement('button'); s.badge.className = 'desk-status'; s.badge.textContent = t('Computer connected'); s.badge.onclick = () => pairingSheet(s); document.body.append(s.badge);
        push(s).catch(() => { if (session === s) stop(); });
      }, () => { if (session === s) { stop(t('Disconnected')); if (s.sheet?.isConnected) closeSheet(); } });
      pairingSheet(s);
    };
    channel.addEventListener('open', () => connected().catch(() => { if (session === s) stop(); }));
    peer.addEventListener('connectionstatechange', () => { if (['failed', 'closed', 'disconnected'].includes(peer.connectionState) && session === s) stop(t('Disconnected')); });
    let polling = false;
    s.timer = setInterval(async () => {
      if (session !== s) return;
      if (!allowed()) return stop();
      if (s.link?.authorized()) { try { await push(s); } catch { if (session === s) stop(); } return; }
      if (!s.sheet?.isConnected) return stop();
      if (s.answer || polling) return;
      polling = true;
      try {
        const details = await s.native.lanPairStatus(); if (session !== s) return;
        if (!details.active) { stop(t('Connection ended. Start again on your phone.')); closeSheet(); return; }
        if (details.answer) { s.answer = validSdp(details.answer); await peer.setRemoteDescription({ type: 'answer', sdp: s.answer }); await s.native.stopLanPair({ keepAwake: true }); await connected(); }
      } catch { if (session === s) { stop(t('Connection ended. Start again on your phone.')); closeSheet(); } }
      finally { polling = false; }
    }, 1000);
  } catch (error) { if (session === s) stop(); toast(t('Could not connect. Check Wi-Fi, keep Tally open and try again.'), { k: 'bad' }); }
}
// The intro (Start) content. Also painted over a stale pairing sheet when the connection stops, so no old address or code stays on screen.
const introHtml = notice => `<div class="sheethead"><h2 class="sh-title">${esc(t('Use Tally on your computer'))}</h2><button class="icon-btn" data-act="sheet-close" aria-label="${esc(t('Close'))}">${ICON.x}</button></div>${notice ? `<p role="status" id="desk-stopped">${esc(notice)}</p>` : ''}<p>${esc(t('A bigger screen for your expenses. Nothing to install on the computer.'))}</p><p class="fine">${esc(t('Your book stays on your phone. This computer keeps no saved copy.'))}</p><p class="fine">${esc(t('Keep Tally open. Switching apps or locking your phone ends the connection.'))}</p><button class="btn wide" id="desk-start">${esc(t('Start connection'))}</button>`;
function bindIntro(box) {
  const trust = document.createElement('p'); trust.className = 'fine'; trust.textContent = t('Use a computer you trust. Anyone using it can copy information shown on its screen.'); box.querySelector('#desk-start').before(trust);
  box.querySelector('#desk-start').onclick = async event => { event.target.disabled = true; await start(); if (event.target.isConnected) event.target.disabled = false; };
}
function paintStopped(box) {
  for (const node of [...box.children]) if (!node.classList.contains('grab')) node.remove();
  box.insertAdjacentHTML('beforeend', introHtml(t('Connection stopped. Start again to connect.'))); bindIntro(box);
  box.querySelector('[data-act="sheet-close"]').onclick = () => closeSheet();
}
export function openDesk() {
  if (session) return pairingSheet(session);
  bindIntro(openSheet(introHtml('')));
}
document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
// Native stop, lock and pagehide are observed by the shared pairing service.
