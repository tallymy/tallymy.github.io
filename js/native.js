// The Android app (Capacitor): the same Tally, run from files inside the app, with the app's own private storage instead of
// the browser's. Outside the app (the website, the installed web app, tests) nothing here does anything, so those behave as
// before. Capacitor puts window.Capacitor on the page before it loads and its plugins are used through it: no bundler.
const cap = globalThis.Capacitor;
export const isNative = !!cap?.isNativePlatform?.();
const plugin = name => cap?.Plugins?.[name];

/** The https address to open outside the app, or null when the link belongs inside it. The landing pages aren't in the app. */
export function external(href) {
  let u; try { u = new URL(href, globalThis.location?.href); } catch { return null; }
  if (u.origin === globalThis.location?.origin) return /\/start(\.[\w-]+)?\.html$/.test(u.pathname) ? new URL(u.pathname.split('/').pop(), 'https://tallymy.github.io/').href : null;
  return u.href;
}
/** A web page, a mail or a calendar link in the phone's own app. */
export async function openExternal(url) {
  try { await plugin('App').openUrl({ url }); return true; } catch { return false; }
}

const b64 = async blob => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
/** A file in the app's cache, written 3 MB at a time (a whole backup with photos can be hundreds of MB). → {uri} */
async function toCache(name, blob) {
  const fs = plugin('Filesystem'), CH = 3 * 1024 * 1024;   // a multiple of 3: every chunk is whole base64 groups
  const path = `out/${Date.now()}-${String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(-100)}`;
  for (let o = 0; o === 0 || o < blob.size; o += CH) {
    const data = await b64(blob.slice(o, o + CH));
    await (o === 0 ? fs.writeFile({ path, data, directory: 'CACHE', recursive: true }) : fs.appendFile({ path, data, directory: 'CACHE' }));
  }
  return fs.getUri({ path, directory: 'CACHE' });
}
/** "Download": the phone's own Save as screen (Downloads, Drive…). Resolves when it is saved or cancelled. */
export async function saveFile(name, blob, type = 'application/octet-stream') {
  const { uri } = await toCache(name, blob);
  return plugin('TallyNative').saveToDevice({ uri, name, mime: type || 'application/octet-stream' });
}

/** Files other apps sent to Tally (Share → Tally), already copied into the app. */
export async function sharedFiles() {
  if (!isNative) return [];
  const { files = [] } = (await plugin('TallyNative').takeShared().catch(() => null)) || {};
  const out = [];
  for (const f of files) {
    try { out.push(new File([await (await fetch(cap.convertFileSrc(f.uri))).blob()], f.name || 'shared', { type: f.type || '' })); } catch { /* one unreadable file: skip it */ }
  }
  return out;
}
/** Files shared while Tally is already open. */
export function onShared(callback) {
  if (isNative) plugin('TallyNative').addListener('shared', async () => { const files = await sharedFiles(); if (files.length) callback(files); });
}

if (isNative) {
  // The phone's share sheet, for the pages that already ask the browser for it. A closed sheet is an AbortError, as in a browser.
  navigator.canShare = d => !!d && !!(d.files?.length || d.text || d.url);
  navigator.share = async d => {
    const files = [];
    for (const f of d.files || []) files.push((await toCache(f.name, f)).uri);
    try { await plugin('Share').share({ title: d.title, text: d.text, url: d.url, ...(files.length ? { files } : {}), dialogTitle: d.title }); }
    catch (e) { throw /cancel/i.test(e?.message || '') ? new DOMException('Share canceled', 'AbortError') : e; }
  };
  // Links that leave the app go to the phone's browser, mail or calendar; the app never turns into a web browser.
  document.addEventListener('click', e => {
    const a = e.target.closest?.('a[href]');
    if (!a || a.hasAttribute('download') || /^(blob|data|javascript):/i.test(a.getAttribute('href'))) return;
    const url = external(a.href);
    if (url) { e.preventDefault(); openExternal(url); }
  }, true);
  const open = window.open.bind(window);
  window.open = (url, ...rest) => { const out = url && external(String(url)); if (out) { openExternal(out); return null; } return open(url, ...rest); };
}
