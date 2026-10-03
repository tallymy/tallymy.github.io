// In-app feedback, delivered to the developer's Google Form (pattern from we go gim). Only what the user types plus
// app version, device type and current screen is sent; never amounts, receipts, shops or accounts.
import { settings, setKv, S } from './state.js';
import { esc, openSheet, closeSheet, toast } from './ui.js';
import { t, getLang } from './i18n.js';
import { isNative } from './native.js';

const FORM = 'https://docs.google.com/forms/d/e/1FAIpQLSdBFMgKhs2fdfxXI-YDY5Y_f8bZOkZuzWj5TLr9e3Q76j9qQQ/formResponse';
const F = { type: 'entry.1958468497', message: 'entry.150873038', contact: 'entry.2067027879', info: 'entry.60151135' };
const TYPES = ['Bug', 'Idea', 'Question', 'Other'];   // must match the form's option text exactly (sent in English)

const save = patch => setKv('settings', { ...S.kv.settings, ...patch });

/** "Tally 0.1.0 · Android · Chrome · installed · 412px · #/review · ms" */
export function appInfo(version) {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Other';
  const br = /EdgA?\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /CriOS|Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Other';
  const installed = isNative ? 'app' : matchMedia('(display-mode: standalone)').matches || navigator.standalone ? 'installed' : 'browser';
  const screen = location.hash.replace(/^#\/?/, '').split('/')[0] || 'home';
  return `Tally ${version} · ${os} · ${br} · ${installed} · ${innerWidth}px · #/${screen} · ${getLang()}`;
}

export async function post(item) {
  const body = new URLSearchParams({ [F.type]: item.type, [F.message]: item.message, [F.contact]: item.contact || '', [F.info]: item.info });
  // Google Forms can't be read cross-site (opaque reply); a network error is the only failure we can see.
  await fetch(FORM, { method: 'POST', mode: 'no-cors', body });
}

/** Send anything written while offline. */
let flushing = false;
export async function flushFeedback() {
  const q = settings()?.feedbackQueue || [];
  if (flushing || !q.length || !navigator.onLine) return;
  flushing = true;
  const sent = new Set();
  try { for (const item of q) { try { await post(item); sent.add(item.at); } catch {} } }
  finally { flushing = false; }
  await save({ feedbackQueue: (settings().feedbackQueue || []).filter(x => !sent.has(x.at)) });   // re-read: keep anything queued meanwhile
  const left = q.filter(x => !sent.has(x.at));
  if (left.length < q.length) toast(t('Sent your saved feedback'), { k: 'good', icon: 'check' });
}
if (typeof window !== 'undefined') window.addEventListener('online', () => { flushFeedback().catch(() => {}); });

export function openFeedback(version, preset = 'Idea') {
  let type = preset;
  const info = appInfo(version);
  const sheet = openSheet(`<h2 class="sh-title">${esc(t('Send feedback'))}</h2>
    <p class="sh-body">${esc(t('Found a bug or have an idea? It goes straight to the developer.'))}</p>
    <div class="segs" role="group" aria-label="${esc(t('Feedback type'))}">${TYPES.map(k => `<button class="seg${k === type ? ' on' : ''}" data-fb="${k}" aria-pressed="${k === type}">${esc(t(k))}</button>`).join('')}</div>
    <label class="field"><span>${esc(t('Message'))}</span><textarea id="fb-msg" rows="5" maxlength="4000" placeholder="${esc(t('What happened, or what would make Tally better?'))}" autofocus></textarea></label>
    <label class="field"><span>${esc(t('Contact (optional)'))}</span><input id="fb-contact" maxlength="200" placeholder="${esc(t('Email or handle, if you would like a reply'))}" autocomplete="email"></label>
    <p class="fine">${esc(t("Sent to the developer through Google Forms (Google may store it outside Malaysia): your message, the contact you add (optional) and {0}. Used only to fix Tally and reply to you; kept 12 months. Don't include IC or account numbers.", info))} <a class="link" href="privacy.html" target="_blank" rel="noopener">${esc(t('Privacy policy'))}</a></p>
    <div class="row2"><button class="btn ghost" data-fb-x="cancel">${esc(t('Cancel'))}</button><button class="btn" data-fb-x="send">${esc(t('Send'))}</button></div>`, { label: t('Send feedback') });
  sheet.addEventListener('click', async e => {
    const b = e.target.closest('[data-fb]');
    if (b) {
      type = b.dataset.fb;
      for (const s of sheet.querySelectorAll('[data-fb]')) { s.classList.toggle('on', s === b); s.setAttribute('aria-pressed', s === b); }
      return;
    }
    const x = e.target.closest('[data-fb-x]');
    if (!x) return;
    if (x.dataset.fbX === 'cancel') return closeSheet();
    const message = sheet.querySelector('#fb-msg').value.trim();
    if (message.length < 3) return toast(t('Write a short message first'));
    // Spam guard: one message a minute, ten a day (per device).
    const now = Date.now(), sent = (settings().feedbackSent || []).filter(ts => now - ts < 864e5);
    if (sent.length && now - sent.at(-1) < 60000) return toast(t('Thanks! Please wait a minute before sending another.'));
    if (sent.length >= 10) return toast(t("That's the limit for today. Thank you for all the feedback!"));
    x.disabled = true;
    const item = { type, message, contact: sheet.querySelector('#fb-contact').value.trim(), info, at: new Date().toISOString() };
    await save({ feedbackSent: [...sent, now] });
    try {
      if (!navigator.onLine) throw new Error('offline');
      await post(item);
      closeSheet();
      toast(t('Thanks! Feedback sent.'), { k: 'good', icon: 'check' });
    } catch {
      await save({ feedbackQueue: [...(settings().feedbackQueue || []), item].slice(-20) });
      closeSheet();
      toast(t("You're offline. It will send when you're back online."));
    }
  });
}
