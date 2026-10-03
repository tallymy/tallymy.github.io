import { phoneAddress, pairingCode, validSdp, gather } from './desk-pair.js';
import { approvedDesk } from './desk-wire.js';
import { literalT as t, setLang, pickLang } from './i18n.js';
// This page never opens the app database and never writes expenses to browser storage.
const root = document.querySelector('#desk');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = cents => `RM ${(cents / 100).toFixed(2)}`;
let peer, link, book, draft, pending, generation = 0, timer, connecting = false, heartbeat, scrollTimer;
const fresh = () => ({ id: `dt_${crypto.randomUUID()}`, base: null, type: 'expense', amount: '', date: book.today, accountId: book.accounts[0]?.id || '', category: book.categories.find(c => c.type === 'expense')?.id || '', merchant: '', note: '' });
function close() { generation++; clearTimeout(timer); clearTimeout(scrollTimer); clearInterval(heartbeat); const oldLink = link, oldPeer = peer; link = null; peer = null; book = null; draft = null; pending = null; connecting = false; oldLink?.close(); oldPeer?.close(); }
function home(message = '') {
  root.innerHTML = `<section class="card start"><h1>${esc(t('Use Tally on your computer'))}</h1><p>${esc(t('A bigger screen for your expenses. Nothing to install on the computer.'))}</p><ol><li>${esc(t('Put your phone and computer on the same Wi-Fi. Or connect the computer to your phone hotspot.'))}</li><li>${esc(t('On your phone, open Tally → Settings → Use Tally on your computer → Start connection.'))}</li><li>${esc(t('Copy the phone address and joining code below.'))}</li></ol>${message ? `<p class="error" role="alert">${esc(message)}</p>` : ''}<form id="join" autocomplete="off"><label>${esc(t('Phone address'))}<input id="address" required placeholder="192.168.1.5:49213" spellcheck="false" autocomplete="off"></label><label>${esc(t('Joining code'))}<input id="pin" required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off"></label><button id="connect">${esc(t('Connect'))}</button></form><p class="fine">${esc(t('If the computer asks to find devices on your network, choose Allow.'))}</p><p class="fine">${esc(t('Your book stays on your phone. This computer keeps no saved copy.'))}</p><details><summary>${esc(t('Cannot connect?'))}</summary><p>${esc(t('Use an up-to-date Chrome or Edge browser. Check both devices are on the same Wi-Fi. Guest Wi-Fi may block devices from talking; try your phone hotspot instead.'))}</p><p>${esc(t('Keep Tally open on your phone. If the code expired, tap Disconnect and Start connection again.'))}</p></details></section>`;
  const trust = document.createElement('p'); trust.className = 'fine'; trust.textContent = t('Use a computer you trust. Anyone using it can copy information shown on its screen.'); root.querySelector('#join').before(trust);
  root.querySelector('#join').onsubmit = event => { event.preventDefault(); connect(root.querySelector('#address').value, root.querySelector('#pin').value); };
}
function lost() {
  if (!peer && !connecting) return;
  const uncertain = !!pending; close();
  home(uncertain ? t('Connection lost while saving. Check your phone to see whether the change saved before trying again.') : t('Disconnected. Your saved changes are on your phone. Reconnect to keep editing.'));
}
async function signal(address, path, pin, sdp) {
  const response = await fetch(address + path, { method: sdp ? 'POST' : 'GET', headers: { 'X-Tally-Code': pin, ...(sdp ? { 'Content-Type': 'application/json' } : {}) }, ...(sdp ? { body: JSON.stringify({ sdp }) } : {}), credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', targetAddressSpace: address.includes('127.0.0.1') ? 'loopback' : 'local', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw Error('Pairing failed');
  const text = await response.text(); if (text.length > 65000) throw Error('Invalid connection'); return JSON.parse(text);
}
async function connect(input, pin) {
  if (connecting) return;
  let address;
  try { address = phoneAddress(input); if (!/^\d{6}$/.test(pin) || !isSecureContext || !window.RTCPeerConnection) throw Error(); }
  catch { home(t('Copy the phone address and joining code exactly. Use an up-to-date Chrome or Edge browser.')); return; }
  close(); const gen = generation; connecting = true; root.querySelector('#connect').disabled = true; root.querySelector('#connect').textContent = t('Connecting…');
  try {
    const offer = validSdp((await signal(address, '/offer', pin)).sdp); if (gen !== generation) return;
    peer = new RTCPeerConnection({ iceServers: [] }); const activePeer = peer;
    timer = setTimeout(lost, 45000);
    peer.addEventListener('connectionstatechange', () => { if (peer === activePeer && ['failed', 'disconnected', 'closed'].includes(activePeer.connectionState)) lost(); });
    peer.addEventListener('datachannel', event => {
      const channel = event.channel; if (channel.label !== 'tally-book' || link || channel.ordered !== true) { channel.close(); return; }
      const opened = async () => {
        if (gen !== generation || link) return;
        try {
          const code = await pairingCode(offer, activePeer.localDescription.sdp); if (gen !== generation) return;
          clearTimeout(timer); timer = setTimeout(lost, 600000);
          link = approvedDesk(channel, code, receive, () => { connecting = false; root.querySelector('#wait').textContent = t('Opening your phone book…'); }, lost);
          root.innerHTML = `<section class="card start"><h1>${esc(t('Do these numbers match the phone?'))}</h1><p class="code">${esc(code)}</p><p>${esc(t('Only tap Yes if both screens show the same numbers. If they differ, disconnect and start again.'))}</p><button id="approve">${esc(t('Yes, they match'))}</button><p id="wait" role="status"></p><button class="ghost" id="stop">${esc(t('Disconnect'))}</button></section>`;
          root.querySelector('#stop').onclick = () => { close(); home(); };
          root.querySelector('#approve').onclick = async event => { event.target.disabled = true; root.querySelector('#wait').textContent = t('Waiting for the phone to approve.'); try { await link.approve(); } catch { lost(); } };
        } catch { lost(); }
      };
      channel.addEventListener('open', opened, { once: true }); if (channel.readyState === 'open') opened();
    });
    await peer.setRemoteDescription({ type: 'offer', sdp: offer }); await peer.setLocalDescription(await peer.createAnswer()); await gather(peer);
    if (gen !== generation) return; await signal(address, '/answer', pin, validSdp(peer.localDescription.sdp));
  } catch { if (gen === generation) { close(); home(t('Could not connect. Check Wi-Fi, keep Tally open and try again.')); } }
}
async function receive(value) {
  if (value.kind === 'book') {
    if (!Array.isArray(value.accounts) || !Array.isArray(value.categories) || !Array.isArray(value.tx) || value.accounts.length > 1000 || value.categories.length > 1000 || value.tx.length > 200 || !/^\d{4}-\d{2}-\d{2}$/.test(value.today)) throw Error();
    const first = !book; book = value; if (first) { const gen = generation; clearTimeout(timer); await setLang(value.lang); if (gen !== generation || !book) return; const resume = book.tx.find(x => x.id === book.place?.editId && x.editable); draft = resume ? { ...resume, amount: (resume.amount / 100).toFixed(2) } : fresh(); draw(); requestAnimationFrame(() => { if (gen === generation) [...root.querySelectorAll('[data-row]')].find(el => el.dataset.row === book?.place?.topId)?.scrollIntoView({ block: 'start' }); }); }
    else lists();
    clearInterval(heartbeat); heartbeat = setInterval(() => { if (Date.now() - lastMessage > 8000) lost(); else link?.send({ kind: 'ping' }).catch(lost); }, 2000);
    lastMessage = Date.now(); return;
  }
  if (value.kind === 'pong') { lastMessage = Date.now(); return; }
  if (value.kind !== 'result' || !pending || pending.id !== value.requestId || typeof value.ok !== 'boolean') throw Error();
  clearTimeout(timer); pending = null;
  if (value.ok) { draft = fresh(); draw(t('Saved on your phone.')); }
  else { draw(value.message || t('Could not save. Check the entry and free space on your phone, then try again.'), true); }
}
let lastMessage = 0;
function lists() {
  if (!book || !root.querySelector('#entries')) return;
  root.querySelector('#balances').innerHTML = book.accounts.map(a => `<p>${esc(a.name)}<b>${esc(money(a.balance))}</b></p>`).join('');
  root.querySelector('#entries').innerHTML = book.tx.map(x => `<li data-row="${esc(x.id)}"><span class="grow"><b>${esc(x.merchant || book.categories.find(c => c.id === x.category && c.type === x.type)?.name || x.type)}</b><small>${esc(x.date)} · ${esc(book.accounts.find(a => a.id === x.accountId)?.name || '')}</small></span><span class="amount">${x.type === 'income' ? '+' : '−'}${esc(money(x.amount))}</span>${x.editable ? `<button class="ghost" data-edit="${esc(x.id)}"${pending ? ' disabled' : ''}>${esc(t('Edit'))}</button>` : `<small>${esc(t('Edit on phone'))}</small>`}</li>`).join('');
  for (const button of root.querySelectorAll('[data-edit]')) button.onclick = () => { const x = book.tx.find(x => x.id === button.dataset.edit); if (!x || pending) return; draft = { ...x, amount: (x.amount / 100).toFixed(2) }; draw(); root.querySelector('#merchant').focus(); remember(); };
  const original = draft?.base && book.tx.find(x => x.id === draft.id);
  const stale = !!draft?.base && (!original || original.base !== draft.base);
  root.querySelector('#stale').hidden = !stale;
}
function draw(message = '', error = false) {
  if (!book) return;
  root.innerHTML = `<header><div><h1>Tally</h1><span class="fine">${esc(t('Connected to your phone'))}</span></div><button class="ghost" id="stop">${esc(t('Disconnect'))}</button></header><section class="card"><div class="balance" id="balances"></div></section><div class="grid"><section class="card"><h2>${esc(draft.base ? t('Edit entry') : t('Add entry'))}</h2>${message ? `<p class="${error ? 'error' : 'notice'}" role="status">${esc(message)}</p>` : ''}<p class="error" id="stale" hidden>${esc(t('This entry changed on your phone. Tap Refresh entry before saving.'))}<button class="ghost" id="refresh">${esc(t('Refresh entry'))}</button></p><form id="entry" autocomplete="off"><label>${esc(t('Type'))}<select id="type"><option value="expense">${esc(t('Expense'))}</option><option value="income">${esc(t('Income'))}</option></select></label><label>${esc(t('Amount (RM)'))}<input id="amount" required inputmode="decimal" value="${esc(draft.amount)}"></label><label>${esc(t('Date'))}<input id="date" type="date" required max="${esc(book.today)}" value="${esc(draft.date)}"></label><label>${esc(t('Account'))}<select id="accountId">${book.accounts.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select></label><label>${esc(t('Category'))}<select id="category"></select></label><label>${esc(t('Shop or name'))}<input id="merchant" maxlength="80" value="${esc(draft.merchant)}"></label><label>${esc(t('Note'))}<textarea id="note" maxlength="200">${esc(draft.note)}</textarea></label><button id="save"${pending || !book.accounts.length ? ' disabled' : ''}>${esc(t('Save on phone'))}</button></form><div class="row"><button class="ghost" id="new"${pending ? ' disabled' : ''}>${esc(t('New entry'))}</button>${draft.base ? `<button class="danger" id="delete"${pending ? ' disabled' : ''}>${esc(t('Delete'))}</button>` : ''}</div><p class="fine">${esc(t('Receipt items, split bills and transfers can be viewed here. Edit their details on your phone.'))}</p></section><section class="card"><h2>${esc(t('Latest 200 entries'))}</h2><ul class="entries" id="entries"></ul></section></div><p class="fine">${esc(t('Your book stays on your phone. This computer keeps no saved copy.'))}</p>`;
  const guidance = document.createElement('p'); guidance.className = 'fine'; guidance.textContent = t('Unsaved typing is cleared when the connection ends. Tap Save on phone to keep your changes.'); root.append(guidance);
  for (const key of ['type', 'accountId']) root.querySelector('#' + key).value = draft[key];
  const cats = () => { root.querySelector('#category').innerHTML = book.categories.filter(c => c.type === draft.type).map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join(''); root.querySelector('#category').value = draft.category; };
  cats();
  root.querySelector('#stop').onclick = () => { const busy = !!pending; close(); home(busy ? t('Connection lost while saving. Check your phone to see whether the change saved before trying again.') : ''); };
  root.querySelector('#new').onclick = () => { if (!pending) { draft = fresh(); draw(); remember(); } };
  root.querySelector('#refresh').onclick = () => { if (pending) return; const x = book.tx.find(x => x.id === draft.id && x.editable); draft = x ? { ...x, amount: (x.amount / 100).toFixed(2) } : fresh(); draw(); };
  root.querySelector('#entry').oninput = event => { if (pending) return; draft[event.target.id] = event.target.value; if (event.target.id === 'type') { draft.category = book.categories.find(c => c.type === draft.type)?.id || ''; cats(); } };
  root.querySelector('#entry').onsubmit = event => { event.preventDefault(); save(false); };
  root.querySelector('#delete')?.addEventListener('click', () => { if (confirm(t('Delete this entry from your phone?'))) save(true); });
  lists();
}
function save(remove) {
  if (pending || !link?.authorized()) return;
  let amount = 0;
  if (!remove) { const match = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(String(draft.amount).trim()); if (!match) return draw(t('Enter a positive amount with up to two decimal places.'), true); amount = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0')); if (amount <= 0) return draw(t('Enter a positive amount with up to two decimal places.'), true); }
  const change = { kind: remove ? 'delete' : 'save', id: draft.id, base: draft.base, ...(!remove ? { value: { type: draft.type, amount, date: draft.date, accountId: draft.accountId, category: draft.category, merchant: draft.merchant, note: draft.note } } : {}) };
  pending = { id: crypto.randomUUID() }; draw(t('Saving on your phone…'));
  for (const control of root.querySelectorAll('#entry input,#entry select,#entry textarea')) control.disabled = true;
  timer = setTimeout(lost, 15000);
  link.send({ kind: 'write', requestId: pending.id, change }).catch(lost);
}
window.addEventListener('pagehide', () => { const uncertain = !!pending; close(); home(uncertain ? t('Connection lost while saving. Check your phone to see whether the change saved before trying again.') : ''); });
function remember() {
  if (!book || !link?.authorized()) return;
  const top = [...root.querySelectorAll('[data-row]')].find(el => el.getBoundingClientRect().bottom > 100);
  link.send({ kind: 'place', topId: top?.dataset.row || null, editId: draft?.base ? draft.id : null }).catch(lost);
}
window.addEventListener('scroll', () => { if (!scrollTimer) scrollTimer = setTimeout(() => { scrollTimer = null; remember(); }, 1200); }, { passive: true });
if (window.top !== window.self) { root.textContent = 'Open Tally in its own tab.'; } else { await setLang(pickLang(navigator.languages)); home(); }
