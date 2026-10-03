// The Android app (Capacitor): the same Tally, run from files inside the app, with the app's own private storage instead of
// the browser's. Outside the app (the website, the installed web app, tests) nothing here does anything, so those behave as
// before. Capacitor puts window.Capacitor on the page before it loads and its plugins are used through it: no bundler.
const cap = globalThis.Capacitor;
export const isNative = !!cap?.isNativePlatform?.();
const plugin = name => cap?.Plugins?.[name];
const CACHE_LIMIT = 300 * 1024 * 1024, IMAGE_LIMIT = 40 * 1024 * 1024, FILE_LIMIT = 8;
let outputBytes = 0, outputCount = 0, consumeShared;
async function sharedError(message) {
  const [{ toast }, { t }] = await Promise.all([import('./ui.js'), import('./i18n.js')]);
  toast(t(message), { k: 'bad' });
}

/** The https address to open outside the app, or null when the link belongs inside it. The landing pages aren't in the app. */
export function external(href) {
  let u; try { u = new URL(href, globalThis.location?.href); } catch { return null; }
  if (u.origin === globalThis.location?.origin) return /\/start(\.[\w-]+)?\.html$/.test(u.pathname) ? new URL(u.pathname.split('/').pop(), 'https://tallymy.github.io/').href : null;
  return u.href;
}
/** A web page, a mail or a calendar link in the phone's own app. */
export async function openExternal(url) {
  try { await plugin('TallyNative').openExternal({ url }); return true; } catch { return false; }
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
  if (outputCount >= FILE_LIMIT || blob.size > CACHE_LIMIT - outputBytes) throw new Error('Too many files to share at once. Try one file at a time.');
  outputCount++; outputBytes += blob.size;
  let uri, path;
  try {
  ({ uri, path } = await plugin('TallyNative').reserveOutput({ name: String(name || 'file'), size: blob.size }));
  if (!/^out\/[\w-]+-[^/\\]+$/.test(path) || !uri?.startsWith('file:')) throw new Error('Invalid cache reservation');
  for (let o = 0; o === 0 || o < blob.size; o += CH) {
    const data = await b64(blob.slice(o, o + CH));
    await (o === 0 ? fs.writeFile({ path, data, directory: 'CACHE', recursive: true }) : fs.appendFile({ path, data, directory: 'CACHE' }));
  }
  return { uri, path, size: blob.size };
  } catch (error) {
    if (path) await fs.deleteFile({ path, directory: 'CACHE' }).catch(() => {});
    if (uri) await plugin('TallyNative').releaseOutput({ uri }).catch(() => {});
    outputCount--; outputBytes -= blob.size; throw error;
  }
}
async function clearOutput(file, retain = false) {
  try { if (!retain) await plugin('Filesystem').deleteFile({ path: file.path, directory: 'CACHE' }); } catch { /* native save may have removed it */ }
  finally { await plugin('TallyNative').releaseOutput({ uri: file.uri, retain }).catch(() => {}); outputCount--; outputBytes -= file.size; }
}
/** "Download": the phone's own Save as screen (Downloads, Drive…). Resolves when it is saved or cancelled. */
export async function saveFile(name, blob, type = 'application/octet-stream') {
  const cached = await toCache(name, blob);
  try { return await plugin('TallyNative').saveToDevice({ uri: cached.uri, name, mime: type || 'application/octet-stream' }); }
  finally { await clearOutput(cached); }
}

/** Files other apps sent to Tally (Share → Tally), already copied into the app. */
export async function sharedFiles() {
  if (!isNative) return [];
  // Reentrant listener/startup calls do not duplicate or buffer parallel batches.
  while (consumeShared) await consumeShared;
  consumeShared = readShared();
  try { return await consumeShared; } finally { consumeShared = null; }
}
async function readShared() {
  const { files = [], error } = (await plugin('TallyNative').takeShared().catch(() => null)) || {};
  const out = [];
  let total = 0, failed = files.length > FILE_LIMIT;
  try {
  if (error) await sharedError(error);
  for (const f of files) {
    try {
      if (failed) break;
      const limit = Math.min(CACHE_LIMIT - total, /^image\//i.test(f.type || '') ? IMAGE_LIMIT : CACHE_LIMIT);
      if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > limit) { failed = true; break; }
      const url = new URL(cap.convertFileSrc(f.uri), location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith('/_capacitor_file_')) { failed = true; break; }
      const response = await fetch(url.href);
      if (!response.ok) { failed = true; break; }
      // Native owns and bounds the immutable copy. Check again before retaining it.
      const blob = await response.blob();
      if (blob.size !== f.size || blob.size > limit) { failed = true; break; }
      total += blob.size;
      out.push(new File([blob], f.name || 'shared', { type: f.type || '' }));
    } catch { failed = true; break; }
  }
  } finally { await plugin('TallyNative').releaseShared({ uris: files.map(f => f.uri) }).catch(() => {}); }
  if (failed) { await sharedError('Could not open shared files. Send up to 8 files, at most 300 MB total and 40 MB per image, then try again.'); return []; }
  return out;
}
/** Files shared while Tally is already open. */
export function onShared(callback) {
  if (!isNative) return;
  let running = false, requested = false;
  plugin('TallyNative').addListener('shared', async () => {
    requested = true; if (running) return; running = true;
    try {
      while (requested) {
        requested = false;
        const files = await sharedFiles(); if (files.length) await callback(files);
      }
    } finally { running = false; }
  });
}

if (isNative) {
  // Back follows Tally's sheet/screen history; at its root it returns to the launcher.
  plugin('App')?.addListener?.('backButton', () => {
    if ((globalThis.history?.state?.depth || 0) > 0) history.back();
    else plugin('App').minimizeApp();
  });
  // The phone's share sheet, for the pages that already ask the browser for it. A closed sheet is an AbortError, as in a browser.
  navigator.canShare = d => !!d && !!(d.files?.length || d.text || d.url);
  navigator.share = async d => {
    const cached = []; let handedOff = false;
    try {
      for (const f of d.files || []) cached.push(await toCache(f.name, f));
      const files = cached.map(f => f.uri);
      await plugin('Share').share({ title: d.title, text: d.text, url: d.url, ...(files.length ? { files } : {}), dialogTitle: d.title });
      // Chooser resolution is not recipient read completion. Keep selected
      // attachments for the native 24-hour TTL, including across app restarts.
      handedOff = true;
    }
    catch (e) { throw /cancel/i.test(e?.message || '') ? new DOMException('Share canceled', 'AbortError') : e; }
    finally { for (const f of cached) await clearOutput(f, handedOff); }
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

// Optional Android-local logging reminder. No platform/browser fallback prompt.
let reminderQueue = Promise.resolve();
const reminderBridge = () => isNative && plugin('TallyReminders');
const queueReminder = fn => { const task = reminderQueue.then(fn); reminderQueue = task.catch(() => {}); return task; };
export function reminderStatus() {
  const p = reminderBridge();
  return !p ? Promise.resolve({ supported: false }) : queueReminder(() => p.reminderStatus()).catch(() => ({ supported: false }));
}
export function configureReminder({ enabled, time }) {
  const p = reminderBridge();
  return !p ? Promise.resolve({ supported: false }) : queueReminder(() => p.configureReminder({ enabled: !!enabled, time }));
}
/** Only a day key and booleans cross the bridge; locked books retain their last known marker. */
export function mirrorReminderDay({ day, logged, eligible, lang }) {
  const p = reminderBridge();
  if (!p) return Promise.resolve({ supported: false });
  return queueReminder(async () => {
    try { return await p.mirrorReminderDay({ day, logged: !!logged, eligible: !!eligible, lang }); }
    catch (error) {
      // A stale/failed mirror must not silently leave a potentially false reminder active.
      await p.configureReminder({ enabled: false, time: '21:00' }).catch(() => {});
      return { supported: true, error: true };
    }
  });
}
