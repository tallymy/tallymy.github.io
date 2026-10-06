// Tiny IndexedDB wrapper with a localStorage fallback.
// Stores: accounts, tx, recurring, receipts (keyed by id) and kv (keyed by key). Adapted from we go gim.
// Never rename NAME: every user's data lives under it (and under this site's address).

const NAME = 'tally', VERSION = 1;
export const STORES = ['accounts', 'tx', 'recurring', 'receipts', 'kv'];

let idb = null;
let mem = null; // fallback: {store: {id: obj}}

// ---- encryption at rest (optional, tied to the lock: js/lock.js) -----------------------------------------------------
// With it on, every record except the settings (language, the lock itself: needed before unlocking) is stored as
// {id or key, iv, ct}: AES-GCM of the record under a random data key that exists only in memory after unlocking.
// Receipt photos are sealed too (their bytes after a JSON header). Old plain records still read, so turning it on or
// off can move the photos a few at a time. IndexedDB only: the localStorage fallback can't hold the bytes.
let dek = null, sealed = false, dekFor = null, plainWrites = false;
/** Turning encryption off: this page saves in the clear while it can still read sealed records with its key. */
export const writePlain = v => { plainWrites = !!v; };
/** The data key for this session (null: none), and the wrapped key (settings.lock.enc.key) it was unwrapped from. */
export const setKey = (k, wrapped = null) => { dek = k; dekFor = k ? wrapped : null; };
export const getKey = () => dek;
/** Is the key in memory the one these settings wrap? Another tab may have turned encryption off, or on with a new key. */
export const keyMatches = enc => !!dek && !!enc && dekFor === enc.key;
/** Whether records must be sealed: then a write without the key is refused rather than stored in the clear. */
export const expectSealed = v => { sealed = !!v; };
const plainRec = (store, obj) => store === 'kv' && obj?.key === 'settings';
const idOf = (store, obj) => (store === 'kv' ? { key: obj.key } : { id: obj.id });
/** One record, sealed with `key` (receipts: the photo's bytes go in too). */
export async function sealRecord(store, obj, key) {
  const { blob, ...rest } = obj;
  const head = new TextEncoder().encode(JSON.stringify(blob instanceof Blob ? { ...rest, blobType: blob.type } : obj));
  const body = blob instanceof Blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array(0);
  const data = new Uint8Array(4 + head.length + body.length);
  new DataView(data.buffer).setUint32(0, head.length); data.set(head, 4); data.set(body, 4 + head.length);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { ...idOf(store, obj), iv, ct: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data) };
}
/** A stored record back as it was; plain records come back as they are. Throws without the right key. */
export async function openRecord(rec, key) {
  if (!rec || !rec.ct || !rec.iv) return rec;
  if (!key) throw new Error('Tally is locked');
  const data = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.ct));
  const n = new DataView(data.buffer).getUint32(0), obj = JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + n)));
  if (obj.blobType == null) return obj;
  const { blobType, ...rest } = obj;
  return { ...rest, blob: new Blob([data.subarray(4 + n)], { type: blobType }) };
}
async function seal(store, obj) {
  if (!idb || plainWrites || plainRec(store, obj)) return obj;
  if (!dek) { if (sealed) throw new Error('Tally is locked'); return obj; }
  return sealRecord(store, obj, dek);
}
const unseal = rec => openRecord(rec, dek);

// Other tabs of the app are told about every write, so two open tabs don't silently overwrite each other.
const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('tally-data') : null;
bc?.unref?.(); // Node only (tests): an open channel must not keep the process alive
const notify = store => { try { bc?.postMessage({ store, at: Date.now() }); } catch {} };
/** Called with the store name when another tab of the app changed data ('erased': everything is gone, reload). */
export const onRemoteChange = cb => bc?.addEventListener('message', e => cb(e.data?.store));
// After an erase, here or in another tab, this page's copies of the old data (a draft, an Undo) must not write it
// back into the fresh store: every write is refused until the page reloads.
let erased = false;
bc?.addEventListener('message', e => { if (e.data?.store === 'erased') erased = true; });
const alive = () => { if (erased) throw new Error("Tally's data was erased. Reload to start again."); };
/** Called when a save failed (for example the fallback storage is full). */
let failHandler = () => {};
export const onSaveFailed = cb => { failHandler = cb; };

function open() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('no indexedDB'));
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: s === 'kv' ? 'key' : 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // A newer version opened in another tab: let it upgrade instead of blocking it, then reload into it.
      db.onversionchange = () => { db.close(); if (typeof location !== 'undefined') location.reload(); };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    // Another tab holds an older version open: don't hang on "Loading…" forever.
    req.onblocked = () => setTimeout(() => reject(new Error('The app is open in another tab. Close it and reload.')), 4000);
  });
}

function lsLoad() {
  mem = {};
  for (const s of STORES) {
    try { mem[s] = JSON.parse(localStorage.getItem(`${NAME}.${s}`) || '{}'); } catch { mem[s] = {}; }
  }
}
/** Fallback write: change a copy of the store, keep it only if localStorage took it; otherwise report and reject. */
function lsWrite(store, change) {
  const next = { ...mem[store] };
  change(next);
  try { localStorage.setItem(`${NAME}.${store}`, JSON.stringify(next)); } catch (e) { console.warn('save failed', e); failHandler(e); throw e; }
  mem[store] = next;
  notify(store);
}

let mode = null;
/** 'indexeddb', or 'localstorage' when the browser's database is unavailable (for example some private windows). */
export const storageMode = () => mode;

export async function init() {
  if (idb) return mode;   // one connection per page (load() runs on every change notice): extra ones held up an erase
  try { idb = await open(); } catch (e) {
    // Only a browser that can't store in IndexedDB at all (some private windows) falls back to localStorage.
    // Any other failure stops at the recovery screen: an empty fallback store would hide the user's real data.
    const unavailable = !('indexedDB' in globalThis) || ['SecurityError', 'InvalidStateError'].includes(e?.name) || /no indexedDB/.test(e?.message || '');
    if (!unavailable) throw e;
    idb = null; lsLoad();
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  mode = idb ? 'indexeddb' : 'localstorage';
  return mode;
}

function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    let t, result;
    try {
      if (mode === 'readwrite') alive();   // a write begun before an erase (its seal can outlast it) must not land in the database the erase reopens
      t = idb.transaction(store, mode);
      Promise.resolve(fn(t.objectStore(store))).then(r => { result = r; }, () => {});
    } catch (e) { if (mode === 'readwrite') failHandler(e); try { t?.abort(); } catch {} return reject(e); } // closed database, a value that can't be stored…
    t.oncomplete = () => resolve(result);
    t.onerror = () => { failHandler(t.error); reject(t.error); };
    t.onabort = () => { failHandler(t.error); reject(t.error); };
  });
}
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** The keys of a store without loading its records (the photos are big). */
export async function keys(store) {
  if (!idb) return Object.keys(mem[store]);
  return tx(store, 'readonly', os => reqP(os.getAllKeys()));
}
export async function all(store) {
  if (!idb) return Object.values(mem[store]);
  return Promise.all((await tx(store, 'readonly', os => reqP(os.getAll()))).map(unseal));
}

export async function put(store, obj) {
  alive();
  if (!idb) { lsWrite(store, m => { m[store === 'kv' ? obj.key : obj.id] = obj; }); return obj; }
  await writeRecs(store, [await seal(store, obj)]);
  notify(store);
  return obj;
}

export async function putMany(store, list) {
  alive();
  if (!idb) return lsWrite(store, m => { for (const o of list) m[store === 'kv' ? o.key : o.id] = o; });
  await writeRecs(store, await Promise.all(list.map(o => seal(store, o))));
  notify(store);
}
/** A sealed record is stored only in a transaction that finds the stored settings still wrapping this page's key: once
 *  another tab turned encryption off (or changed the key), the save is refused, never left where nothing can open it. */
const wrapsMine = s => !!dekFor && s?.value?.lock?.enc?.key === dekFor;
function writeRecs(store, recs) {
  if (!recs.some(r => r?.ct)) return tx(store, 'readwrite', os => { for (const o of recs) os.put(o); });
  return new Promise((resolve, reject) => {
    let t;
    try { alive(); t = idb.transaction([...new Set([store, 'kv'])], 'readwrite'); } catch (e) { failHandler(e); return reject(e); }
    const g = t.objectStore('kv').get('settings');
    g.onsuccess = () => {
      if (!wrapsMine(g.result)) { setKey(null); return t.abort(); }
      const os = t.objectStore(store); for (const o of recs) os.put(o);
    };
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => { const e = t.error || new Error('Tally is locked'); failHandler(e); reject(e); };
  });
}
const sameRec = (a, b) => { const { blob: x, ...ra } = a, { blob: y, ...rb } = b; return JSON.stringify(ra) === JSON.stringify(rb) && (x === y || (x instanceof Blob && y instanceof Blob && x.size === y.size && x.type === y.type)); };   // ponytail: a photo compared by size and type; add a stamp if photos are ever replaced in place
/** Encryption on: every record of `store` still in the clear is sealed in place, one at a time, and only while it is
 *  still that same plain record (a newer save, sealed by its writer, or a delete wins). Never the settings. */
export async function sealStore(store) {
  if (!idb) return;
  let n = 0;
  for (const id of await plainKeys(store)) {
    if (plainRec(store, { key: id })) continue;
    const r = await tx(store, 'readonly', os => reqP(os.get(id)));
    if (!r || r.ct) continue;
    const sealed = await seal(store, r);
    if (!sealed?.ct) continue;
    await new Promise((resolve, reject) => {
      let t;
      try { alive(); t = idb.transaction([...new Set([store, 'kv'])], 'readwrite'); } catch (e) { failHandler(e); return reject(e); }
      const g = t.objectStore('kv').get('settings');
      g.onsuccess = () => {
        if (!wrapsMine(g.result)) { setKey(null); return t.abort(); }
        const c = t.objectStore(store).get(id);
        c.onsuccess = () => { if (c.result && !c.result.ct && sameRec(c.result, r)) t.objectStore(store).put(sealed); };
      };
      t.oncomplete = () => resolve();
      t.onerror = t.onabort = () => { const e = t.error || new Error('Tally is locked'); failHandler(e); reject(e); };
    });
    n++;
  }
  if (n) notify(store);
}
/** Turning encryption off: every record of `store` still sealed is rewritten in the clear with `key`, one at a time
 *  (photos are big), and only while it is still that same sealed record (a newer save wins). */
export async function unsealStore(store, key) {
  let n = 0;
  for (const id of await keys(store)) {
    const r = await tx(store, 'readonly', os => reqP(os.get(id)));
    if (!r?.ct) continue;
    const plain = await openRecord(r, key);
    await tx(store, 'readwrite', os => { const g = os.get(id); g.onsuccess = () => { if (g.result?.ct && String(g.result.iv) === String(r.iv)) os.put(plain); }; });
    n++;
  }
  if (n) notify(store);
}
/** The settings get `lock` (no encryption) only if no record in any store is still sealed, checked in the same
 *  transaction over every store: no sealed save can land between the check and the switch. → the settings, or null.
 *  ponytail: reads every record (photos too) in one transaction and saves wait meanwhile; fine for a rare switch. */
export function commitPlain(lock) {
  return new Promise((resolve, reject) => {
    let t, left = false, open = STORES.length, next = null;
    try { alive(); t = idb.transaction(STORES, 'readwrite'); } catch (e) { return reject(e); }
    for (const s of STORES) {
      const c = t.objectStore(s).openCursor();
      c.onsuccess = () => {
        const cur = c.result;
        if (cur && !left && !cur.value?.ct) return cur.continue();
        if (cur?.value?.ct) left = true;
        if (--open || left) return;
        const g = t.objectStore('kv').get('settings');
        g.onsuccess = () => { next = { ...(g.result?.value || {}), lock }; t.objectStore('kv').put({ key: 'settings', value: next }); };
      };
    }
    t.oncomplete = () => { if (next) notify('all'); resolve(next); };
    t.onerror = t.onabort = () => reject(t.error);
  });
}

export async function del(store, key) {
  alive();
  if (!idb) return lsWrite(store, m => { delete m[key]; });
  await tx(store, 'readwrite', os => { os.delete(key); });
  notify(store);
}

export async function clear(store) {
  alive();
  if (!idb) return lsWrite(store, m => { for (const k in m) delete m[k]; });
  await tx(store, 'readwrite', os => { os.clear(); });
  notify(store);
}

/** One key from the kv store, read directly (never the whole store). */
export async function getKv(key, fallback = null) {
  if (!idb) { const hit = mem.kv[key]; return hit ? hit.value : fallback; }
  const hit = await unseal(await tx('kv', 'readonly', os => reqP(os.get(key))));
  return hit ? hit.value : fallback;
}
export const setKv = (key, value) => put('kv', { key, value });

/** Keys of the kv store starting with a prefix, without loading every value. */
export async function kvKeys(prefix) {
  if (!idb) return Object.keys(mem.kv).filter(k => k.startsWith(prefix));
  const keys = await tx('kv', 'readonly', os => reqP(os.getAllKeys()));
  return keys.filter(k => String(k).startsWith(prefix));
}

/** One record by key from any store (receipt photos are read one at a time, never all at once). */
export async function get(store, key) {
  if (!idb) return mem[store][key] ?? null;
  return (await unseal(await tx(store, 'readonly', os => reqP(os.get(key))))) ?? null;
}
/** Keys of the records stored in the clear (a cursor: the photos are read one at a time). */
export async function plainKeys(store) {
  if (!idb) return [];
  return tx(store, 'readonly', os => new Promise((res, rej) => {
    const out = [], r = os.openCursor();
    r.onsuccess = () => { const c = r.result; if (!c) return res(out); if (!c.value?.ct) out.push(c.key); c.continue(); };
    r.onerror = () => rej(r.error);
  }));
}

/** Close and delete the whole database (leaving the old address). */
export async function destroy() {
  try { idb?.close(); } catch {}
  idb = null;
  await new Promise(res => { try { const r = indexedDB.deleteDatabase(NAME); r.onsuccess = r.onerror = r.onblocked = () => res(); } catch { res(); } });
}
/** Erase: the whole database in one step. Every other tab's connection gets versionchange, closes and reloads (open()),
 *  so a write it had pending fails instead of landing in a half-cleared store. The fallback clears every store at once. */
export async function wipe() {
  if (!idb) { if (mem) await writeAtomic({ clear: STORES }); } else await destroy();
  erased = true;
  notify('erased');   // the fallback has no versionchange: other tabs learn it here
}
/** Delete many keys in one transaction with one change notice (undo of a big import). */
export async function delMany(store, keys) {
  alive();
  if (!idb) return lsWrite(store, m => { for (const k of keys) delete m[k]; });
  await tx(store, 'readwrite', os => { for (const k of keys) os.delete(k); });
  notify(store);
}

/**
 * All-or-nothing write across stores (restore): `clear` empties those stores, `del` removes {store: [keys]}, then `put`
 * writes {store: [objects]}.
 * One IndexedDB transaction, so a crash or full disk mid-way leaves the old data untouched.
 */
export async function writeAtomic({ clear = [], del = {}, put = {}, expected = {}, expectedKeys = {}, beforeWrite = () => {}, snapshotGuard = null }) {
  alive();
  const snapshot = snapshotGuard ? syncSnapshots.get(snapshotGuard) : null;
  if (snapshotGuard && (!idb || !snapshot || !sameSyncContext(snapshot.context))) throw Object.assign(new Error('Sync snapshot expired'), {code:'STALE'});
  if (snapshotGuard) syncSnapshots.delete(snapshotGuard); // One attempt; cancellation or a stale plan needs a fresh preview.
  const stores = [...new Set([...clear, ...Object.keys(del), ...Object.keys(put), ...Object.keys(expected), ...Object.keys(expectedKeys), ...(snapshot ? STORES : [])])];
  const stable = value => JSON.stringify(value, (_, v) => v instanceof ArrayBuffer ? Array.from(new Uint8Array(v)) : ArrayBuffer.isView(v) ? Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
  const stale = () => Object.assign(new Error('The entry changed on your phone. Refresh and try again.'), { code: 'STALE' });
  const guards = [];
  for (const [store, list] of Object.entries(expected)) for (const { id, value } of list) {
    const raw = idb ? await tx(store, 'readonly', os => reqP(os.get(id))) : mem[store][id];
    if (stable(await unseal(raw)) !== stable(value)) throw stale();
    guards.push({ store, id, raw });
  }
  const keyGuards=Object.entries(expectedKeys).map(([store,keys])=>({store,keys:[...keys].sort()}));
  if (snapshot) for (const store of STORES) {
    keyGuards.push({store, keys:snapshot.raw[store].map(r=>store==='kv'?r.key:r.id).sort()});
    for (const raw of snapshot.raw[store]) guards.push({store,id:store==='kv'?raw.key:raw.id,raw,blobHash:snapshot.hashes.get(raw),sync:true});
  }
  if (!idb) {
    beforeWrite();
    if(keyGuards.some(g=>stable(Object.keys(mem[g.store]).sort())!==stable(g.keys)))throw stale();
    if (guards.some(g => stable(mem[g.store][g.id]) !== stable(g.raw))) throw stale();
    const backup = structuredClone(mem);
    try {
      for (const s of clear) mem[s] = {};
      for (const [s, keys] of Object.entries(del)) for (const k of keys) delete mem[s][k];
      for (const [s, list] of Object.entries(put)) for (const o of list) mem[s][s === 'kv' ? o.key : o.id] = o;
      for (const s of stores) localStorage.setItem(`${NAME}.${s}`, JSON.stringify(mem[s]));
    } catch (e) { mem = backup; for (const s of stores) try { localStorage.setItem(`${NAME}.${s}`, JSON.stringify(mem[s])); } catch {} failHandler(e); throw e; }
    notify('all'); return;
  }
  const sealedPut = Object.fromEntries(await Promise.all(Object.entries(put).map(async ([s, list]) => [s, await Promise.all(list.map(o => seal(s, o)))])));   // before the transaction: it would close while waiting
  // Sealed records need settings that wrap this page's key: its own settings in this write, else the stored ones (writeRecs).
  const anySealed = Object.values(sealedPut).some(l => l.some(r => r?.ct)), own = (put.kv || []).find(r => r.key === 'settings');
  if (anySealed && own && !wrapsMine(own)) throw new Error('Tally is locked');
  const check = anySealed && !own;
  await new Promise((resolve, reject) => {
    let t, changed = false, guardError = null;
    const write = () => {
      if(snapshot){
        try{alive();if(!sameSyncContext(snapshot.context))throw stale();beforeWrite();}
        catch(error){guardError=error;t.abort();return;}
      }
      for (const s of clear) t.objectStore(s).clear();
      for (const [s, keys] of Object.entries(del)) for (const k of keys) t.objectStore(s).delete(k);
      for (const [s, list] of Object.entries(sealedPut)) { const os = t.objectStore(s); for (const o of list) os.put(o); }
    };
    const checkedWrite = () => {
      if (!guards.length && !keyGuards.length) return write();
      let left = guards.length + keyGuards.length;
      const photoChecks=[];let pulseRunning=false,hashing=false,hashResult=null;
      const deadline=performance.now()+30000;
      const pulse = () => {
        if(changed||guardError)return;
        try{
          alive();if(snapshot&&!sameSyncContext(snapshot.context))throw stale();beforeWrite();
          if(performance.now()>deadline)throw Object.assign(new Error('Photo verification timed out; reconnect and retry'),{code:'STALE'});
          if(hashResult){
            if(!hashResult.match){changed=true;t.abort();return;}
            hashResult=null;hashing=false;if(--left===0){write();return;}
          }
          if(!hashing&&photoChecks.length){
            const check=photoChecks.shift();hashing=true;
            storedBlobHash(check.record).then(digest=>{hashResult={match:digest===check.hash};},()=>{hashResult={match:false};});
          }
          if(!hashing&&!photoChecks.length){pulseRunning=false;return;}
          const request=t.objectStore('kv').get('__tally_sync_keepalive__');request.onsuccess=pulse;
        }catch(error){guardError=error;try{t.abort();}catch{}}
      };
      for(const g of keyGuards){const request=t.objectStore(g.store).getAllKeys();request.onsuccess=()=>{if(changed)return;if(stable(request.result.sort())!==stable(g.keys)){changed=true;t.abort();return;}if(--left===0)write();};}
      for (const g of guards) {
        const request = t.objectStore(g.store).get(g.id);
        request.onsuccess = () => {
          if (changed) return;
          if (g.sync ? !sameSyncRecord(request.result,g.raw,stable) : stable(request.result)!==stable(g.raw)) { changed = true; t.abort(); return; }
          if (!g.blobHash) { if (--left === 0) write(); return; }
          // Blob's JSON shape is empty. Compare its actual bytes while this transaction
          // holds the write lock; a same-id, same-size photo replacement must be stale.
          photoChecks.push({record:request.result,hash:g.blobHash});
          if(!pulseRunning){pulseRunning=true;const request=t.objectStore('kv').get('__tally_sync_keepalive__');request.onsuccess=pulse;}
        };
      }
    };
    try {
      alive();   // the seal above can outlast an erase on this page
      beforeWrite();   // sheet cancellation may happen while encryption is awaited
      if(snapshot&&!sameSyncContext(snapshot.context))throw stale();
      t = idb.transaction(check ? [...new Set([...stores, 'kv'])] : stores, 'readwrite');
      if (!check) checkedWrite();
      else { const g = t.objectStore('kv').get('settings'); g.onsuccess = () => { if (!wrapsMine(g.result)) { setKey(null); return t.abort(); } checkedWrite(); }; }
    } catch (e) { try { t?.abort(); } catch {} if(!e?.cancelled && e?.code!=='STALE')failHandler(e); return reject(e); } // abort: a half-written restore must not commit
    t.oncomplete = resolve;
    t.onerror = t.onabort = () => { const e = guardError || (changed ? stale() : t.error || new Error('Tally is locked')); if (!changed && !e?.cancelled && e?.code!=='STALE') failHandler(e); reject(e); };
  });
  notify('all');
}

// Complete local snapshot for offline sync. Opaque guards never leave this device.
// The ordinary localStorage fallback is intentionally ineligible for two-device commits.
const syncSnapshots = new WeakMap();
const syncContext = () => ({connection:idb,dek,dekFor,sealed,plainWrites});
const sameSyncContext = c => c.connection===idb&&c.dek===dek&&c.dekFor===dekFor&&c.sealed===sealed&&c.plainWrites===plainWrites;
function sameSyncRecord(a,b,stable) {
  if(!a||!b)return a===b;
  const buffer=value=>value instanceof ArrayBuffer?new Uint8Array(value):ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):null;
  for(const key of ['iv','ct']){
    const x=buffer(a[key]),y=buffer(b[key]);if(!!x!==!!y)return false;
    if(x){if(x.length!==y.length)return false;for(let i=0;i<x.length;i++)if(x[i]!==y[i])return false;}
  }
  if(a.blob instanceof Blob||b.blob instanceof Blob){
    if(!(a.blob instanceof Blob)||!(b.blob instanceof Blob)||a.blob.size!==b.blob.size||a.blob.type!==b.blob.type)return false;
  }
  const strip=record=>Object.fromEntries(Object.entries(record).filter(([key])=>!['iv','ct','blob'].includes(key)));
  return stable(strip(a))===stable(strip(b));
}
function boundSyncRecord(store,record,usage) {
  const limits={accounts:200,tx:200000,recurring:500,receipts:200000,kv:10000};
  if(++usage.counts[store]>limits[store])throw Object.assign(new Error('Book exceeds sync record limits'),{code:'BOUNDS'});
  if(record.blob instanceof Blob){if(record.blob.size>40*1024*1024)throw Object.assign(new Error('Receipt exceeds sync limit'),{code:'BOUNDS'});usage.photos+=record.blob.size;}
  if(record.ct instanceof ArrayBuffer){if(store==='receipts'){if(record.ct.byteLength>40*1024*1024+65536)throw Object.assign(new Error('Receipt exceeds sync limit'),{code:'BOUNDS'});usage.photos+=record.ct.byteLength;}else usage.metadata+=record.ct.byteLength;}
  else usage.metadata+=new TextEncoder().encode(JSON.stringify(Object.fromEntries(Object.entries(record).filter(([key])=>key!=='blob')))).byteLength;
  if(usage.metadata>64*1024*1024||usage.photos>200*1024*1024)throw Object.assign(new Error('Book exceeds sync safety limits'),{code:'BOUNDS'});
}
async function storedBlobHash(record) {
  if (!(record?.blob instanceof Blob)) return null;
  const digest=await crypto.subtle.digest('SHA-256',await record.blob.arrayBuffer());
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function captureAtomicSnapshot() {
  alive();
  if(!idb)throw Object.assign(new Error('Sync requires the app database'),{code:'UNSUPPORTED'});
  const context=syncContext();
  const raw=await new Promise((resolve,reject)=>{
    let transaction, result={},failure=null;
    const usage={counts:Object.fromEntries(STORES.map(s=>[s,0])),metadata:0,photos:0};
    try{
      transaction=idb.transaction(STORES,'readonly');
      for(const store of STORES){
        result[store]=[];const request=transaction.objectStore(store).openCursor();
        request.onsuccess=()=>{
          if(failure)return;const cursor=request.result;if(!cursor)return;
          try{boundSyncRecord(store,cursor.value,usage);result[store].push(cursor.value);cursor.continue();}
          catch(error){failure=error;transaction.abort();}
        };
      }
    }catch(error){try{transaction?.abort();}catch{}reject(error);return;}
    transaction.oncomplete=()=>resolve(result);
    transaction.onerror=transaction.onabort=()=>reject(failure||transaction.error||new Error('Snapshot interrupted'));
  });
  const hashes=new Map(), records={};
  for(const store of STORES){
    records[store]=[];
    for(const record of raw[store]){const digest=await storedBlobHash(record);if(digest)hashes.set(record,digest);records[store].push(structuredClone(await unseal(record)));}
  }
  alive();
  if(!sameSyncContext(context))throw Object.assign(new Error('Tally lock changed during snapshot'),{code:'STALE'});
  const guard={};syncSnapshots.set(guard,{raw,hashes,context});
  return {records,guard};
}
