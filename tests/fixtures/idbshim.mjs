// Minimal in-memory IndexedDB for tests, plus "tabs": separate copies of state.js/db.js sharing it and the BroadcastChannel.
// Transactions run one at a time in creation order (a legal schedule). deleteDatabase tells every open connection
// (versionchange) and a closed connection refuses new transactions, as in a browser.
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const dbs = {}, conns = {};
let chain = Promise.resolve();
const later = f => setTimeout(f, 0);
function makeTx(data, conn) {
  if (conn.closed) throw Object.assign(new Error('The database connection is closing.'), { name: 'InvalidStateError' });
  const t = { ops: [], error: null };
  t.objectStore = n => {
    const st = data[n], op = f => { const r = {}; t.ops.push(() => { r.result = f(); r.onsuccess?.({ target: r }); }); return r; };
    return {
      put: v => op(() => { const c = structuredClone(v); st.map.set(c[st.keyPath], c); return c[st.keyPath]; }),
      delete: k => op(() => { st.map.delete(k); }),
      clear: () => op(() => { st.map.clear(); }),
      get: k => op(() => structuredClone(st.map.get(k))),
      getAll: () => op(() => [...st.map.values()].map(v => structuredClone(v))),
      getAllKeys: () => op(() => [...st.map.keys()]),
      openCursor: () => {   // walks a copy of the store; continue() moves to the next record
        const r = {};
        t.ops.push(() => {
          const all = [...st.map.entries()];
          let i = 0;
          const step = () => { r.result = i < all.length ? { key: all[i][0], value: structuredClone(all[i][1]), continue: () => { i++; step(); } } : null; r.onsuccess?.({ target: r }); };
          step();
        });
        return r;
      },
    };
  };
  t.abort = () => { t.aborted = true; };
  chain = chain.then(() => new Promise(res => later(() => {
    if (t.aborted) { t.onabort?.(); return res(); }
    const before = Object.fromEntries(Object.entries(data).map(([k, s]) => [k, new Map(s.map)]));   // an abort from a callback undoes what ran
    while (t.ops.length && !t.aborted) t.ops.shift()();
    if (t.aborted) { for (const [k, m] of Object.entries(before)) if (data[k]) data[k].map = m; t.onabort?.(); return res(); }
    later(() => { t.oncomplete?.(); res(); });
  })));
  return t;
}
export const indexedDB = {
  open(name) {
    const req = {};
    later(() => {
      const fresh = !dbs[name], data = (dbs[name] ||= {});
      const conn = { closed: false, onversionchange: null, objectStoreNames: { contains: n => n in data },
        createObjectStore: (n, o) => { data[n] = { keyPath: o.keyPath, map: new Map() }; }, transaction: () => makeTx(data, conn), close() { conn.closed = true; } };
      (conns[name] ||= new Set()).add(conn);
      req.result = conn;
      if (fresh) req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req;
  },
  deleteDatabase(name) {
    const r = {};
    later(() => {
      for (const c of conns[name] || []) if (!c.closed) c.onversionchange?.({});
      for (const c of conns[name] || []) c.closed = true;   // ponytail: no 'blocked' state; a browser waits for them to close
      delete dbs[name]; conns[name] = new Set();
      r.onsuccess?.();
    });
    return r;
  },
};
globalThis.indexedDB = indexedDB;
/** The raw stored records of a store (sealed ones have ct). */
export const rows = (store, name = 'tally') => [...(dbs[name]?.[store]?.map.values() || [])];
export const reset = () => { for (const k in dbs) delete dbs[k]; for (const k in conns) delete conns[k]; };

const JS = fileURLToPath(new URL('../../js/', import.meta.url)), FILES = ['native.js', 'state.js', 'db.js', 'io.js', 'engine.js', 'caticons.js', 'lock.js', 'ui.js', 'i18n.js'];
let n = 0;
/** Another tab (or a restart): its own state.js and db.js, sharing the database and change notices. */
export async function tab() {
  const dir = join(mkdtempSync(join(tmpdir(), 'tally-tab-')), `t${n++}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  for (const f of FILES) copyFileSync(join(JS, f), join(dir, f));
  const at = f => import(pathToFileURL(join(dir, f)).href);
  return { S: await at('state.js'), db: await at('db.js'), lock: () => at('lock.js') };   // the lock screen's code, on this tab's state
}
