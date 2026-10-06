import {mergeLearnedRules} from './learned-rules.mjs';
import {readBackup,cleanText} from '../io.js';
import {CAT_ICONS} from '../caticons.js';
// Pure planning only. No storage, network, UI, wall-clock arbitration or partial writes.
export const SCHEMA = 'tally.complete-book/1';
export const LIMITS = Object.freeze({ accounts: 200, tx: 200000, recurring: 500, receipts: 200000,
  snapshotBytes: 64 * 1024 * 1024, receiptBytes: 40 * 1024 * 1024, totalReceiptBytes: 200 * 1024 * 1024,
  journalEntries: 20000, mergeChanges: 2000, conflicts: 1000, chunkBytes: 128 * 1024, depth: 24 });
export const KV_KEYS = ['budgets','rules','customCats','dismissed','catColors','catIcons','jointGone','shopNames','itemNames','goals','subcats','subRules'];
export const SETTINGS_KEYS = ['quickAccount','monthStart','weekStart','myName','friends','ownCats','movedCats','sample'];
const LOCAL_KV = ['lastBackup','backupReceipt','reviewDraft','scanQueue','deskPlace','bookGeneration','offlineSync','localSyncRecoveryBefore','localSyncRecoverySource'];
const FIELDS = {
  accounts: ['id','name','kind','opening','createdAt','updatedAt','scope','currency','rate','outside','typed','sample'],
  tx: ['id','date','time','type','amount','accountId','toAccountId','toAmount','rate','category','cat','sub','merchant','note','source','createdAt','updatedAt','items','split','splitOf','owedBy','owedTo','repaidBy','repaidTo','tax','service','rounding','receiptId','refundOf','warranty','returnBy','by','spouse','relief','bill','sample'],
  recurring: ['id','name','amount','category','accountId','day','key','freq','auto','count','start','until','last','createdAt','updatedAt','sample'],
};
const RESERVED = new Set(['__proto__','prototype','constructor']);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA = /^[a-f0-9]{64}$/;
const enc = new TextEncoder();
function fail(code, message) { throw Object.assign(new Error(message), {code}); }
function id(s) { if (typeof s !== 'string' || !ID.test(s) || RESERVED.has(s)) fail('SCHEMA','Invalid opaque ID'); return s; }
function object(v) { return v && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null); }
function normalize(v, depth = 0) {
  if (depth > LIMITS.depth) fail('BOUNDS','JSON nesting limit');
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') { if (!Number.isFinite(v)) fail('SCHEMA','Nonfinite number'); return v; }
  if (typeof v === 'string') { if (v.length > 100000) fail('BOUNDS','String too long'); return v; }
  if (Array.isArray(v)) { if (v.length > LIMITS.tx) fail('BOUNDS','Array too large'); return v.map(x => normalize(x,depth+1)); }
  if (!object(v)) fail('SCHEMA','Only plain JSON values are portable');
  const out = {};
  const keys = Object.keys(v).sort();
  if (keys.length > 10000) fail('BOUNDS','Object too large');
  for (const k of keys) { if (RESERVED.has(k)) fail('SCHEMA','Reserved key'); if(v[k]===undefined)continue;out[k] = normalize(v[k],depth+1); }
  return out;
}
export const canonical = v => JSON.stringify(normalize(v));
export async function sha256(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('SCHEMA','Expected bytes');
  if (!globalThis.crypto?.subtle) fail('UNSUPPORTED','Secure-context SHA-256 unavailable');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export const hash = v => sha256(enc.encode(canonical(v)));
export const recordVersion = record => hash(record);
export function newIdentity() {
  if (!globalThis.crypto?.randomUUID) fail('UNSUPPORTED','Secure random identity unavailable');
  return crypto.randomUUID();
}
function records(rows, kind) {
  if (!Array.isArray(rows) || rows.length > LIMITS[kind]) fail('BOUNDS',`Invalid ${kind} count`);
  const ids = new Set();
  return rows.map(r => {
    if (!object(r)) fail('SCHEMA','Invalid record');
    id(r.id); if (ids.has(r.id)) fail('SCHEMA','Duplicate record ID'); ids.add(r.id);
    for (const k of Object.keys(r)) if (!FIELDS[kind].includes(k)) fail('SCHEMA',`Unsupported ${kind} field: ${k}`);
    return normalize(r);
  }).sort((a,b)=>a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function manifests(rows) {
  if (!Array.isArray(rows) || rows.length > LIMITS.receipts) fail('BOUNDS','Invalid receipt count');
  const seen = new Set(); let total = 0;
  return rows.map(r => {
    if (!object(r) || Object.keys(r).some(k=>!['id','sha256','bytes','mime'].includes(k))) fail('SCHEMA','Invalid receipt manifest');
    id(r.id); if (seen.has(r.id)) fail('SCHEMA','Duplicate receipt ID'); seen.add(r.id);
    if (!SHA.test(r.sha256) || !Number.isSafeInteger(r.bytes) || r.bytes < 1 || r.bytes > LIMITS.receiptBytes || !['image/jpeg','image/png','image/webp'].includes(r.mime)) fail('BOUNDS','Invalid receipt metadata');
    total += r.bytes; if (total > LIMITS.totalReceiptBytes) fail('BOUNDS','Receipt aggregate quota exceeded');
    return normalize(r);
  }).sort((a,b)=>a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
// Deliberately drops local settings/status at the export boundary. Wire snapshots are strict below.
export function projectBook(state, receiptManifest = []) {
  if (!object(state) || !object(state.kv || {})) fail('SCHEMA','Invalid book');
  for(const k of Object.keys(state.kv))if(k!=='settings'&&!KV_KEYS.includes(k)&&!LOCAL_KV.includes(k))fail('SCHEMA',`Unclassified book metadata: ${k}`);
  const kv = {};
  for (const k of KV_KEYS) if (state.kv[k] != null) kv[k] = normalize(state.kv[k]);
  const settings = {};
  for (const k of SETTINGS_KEYS) if (state.kv.settings?.[k] != null) settings[k] = normalize(state.kv.settings[k]);
  kv.settings = settings;
  return validateBook({schema:SCHEMA, accounts:records(state.accounts,'accounts'),tx:records(state.tx,'tx'),recurring:records(state.recurring,'recurring'),kv,receipts:manifests(receiptManifest)});
}
// A remote book gets the strictness of a backup restore: io.js readBackup is the one validator (amount ranges and integers,
// nested split/paid/items money, real dates and times, id format, text caps, record caps, known categories). It sanitizes, so
// the book passes only if the sanitized copy kept every field exactly (nothing dropped, clamped, truncated or replaced).
const STRICT = new WeakSet(); // validateBook outputs already proven strict: revalidating one skips the second pass
const OMITTED_OK = {currency: 'MYR', scope: 'personal', freq: 'monthly'}; // defaults the app stores and readBackup leaves out
function kept(inp, san) {
  if (Array.isArray(inp)) return Array.isArray(san) && san.length === inp.length && inp.every((x,i) => kept(x, san[i]));
  if (inp && typeof inp === 'object') {
    if (!san || typeof san !== 'object' || Array.isArray(san)) return false;
    return Object.keys(inp).every(k => san[k] === undefined ? inp[k] == null || OMITTED_OK[k] === inp[k] : kept(inp[k], san[k]));
  }
  if (typeof inp === 'string') return typeof san === 'string' && !/[\u0000-\u001f\u007f-\u009f]/.test(inp) && cleanText(inp, 100000) === san;
  return inp === san;
}
function strictRestore(b) {
  let s;
  try { s = readBackup(JSON.stringify({app: 'tally', v: 1, accounts: b.accounts, tx: b.tx, recurring: b.recurring, kv: b.kv})); }
  catch (e) { fail('SCHEMA', 'Rejected by restore validation: ' + e.message); }
  if (!kept({accounts: b.accounts, tx: b.tx, recurring: b.recurring, kv: b.kv}, {accounts: s.accounts, tx: s.tx, recurring: s.recurring, kv: {...s.kv, settings: s.settings}})) fail('SCHEMA', 'Book field fails restore validation');
}
// Leftovers the app itself leaves behind (restore would drop them too), removed here on every device so the book is identical:
// - a colour, icon, budget line (own, joint, business) or learned rule that names an own category (c_...) no longer in customCats
//   (state.js removeCategory moves these, but a palette Undo or an import Undo puts old ones back; a merge can cross a removal);
// - a savings goal linked to an account that was deleted (deleteAccount does not touch goals).
// Nothing else is tolerated: unknown non-c_ category ids, bad values and every other field still reach readBackup unchanged.
const OWN_CAT = /^c_[\w-]{1,40}$/;
function dropOrphans(kv, accounts) {
  const own = new Set(Array.isArray(kv.customCats) ? kv.customCats.map(c => c?.id) : []);
  const gone = k => typeof k === 'string' && OWN_CAT.test(k) && !own.has(k);
  const prune = (o, test) => { if (object(o)) for (const [k, v] of Object.entries(o)) if (test(k, v)) delete o[k]; };
  // only entries whose value is itself valid: a bad value under an orphan key still reaches readBackup and is refused
  prune(kv.catColors, (k, v) => gone(k) && /^#[0-9a-f]{6}$/i.test(v)); prune(kv.catIcons, (k, v) => gone(k) && typeof v === 'string' && Object.hasOwn(CAT_ICONS, v)); prune(kv.rules, (k, v) => gone(v) && cleanText(k, 70) === k);
  if (object(kv.budgets)) for (const b of [kv.budgets, kv.budgets.joint, kv.budgets.business]) if (object(b)) prune(b.byCat, (k, v) => gone(k) && Number.isInteger(v) && v >= 0 && v <= 100_000_000_00);
  if (Array.isArray(kv.goals)) for (const g of kv.goals) if (object(g) && typeof g.accountId === 'string' && /^[\w-]{1,60}$/.test(g.accountId) && !RESERVED.has(g.accountId) && !accounts.has(g.accountId)) delete g.accountId;
}
export function validateBook(book) {
  if (!object(book) || book.schema !== SCHEMA || Object.keys(book).some(k=>!['schema','accounts','tx','recurring','kv','receipts'].includes(k))) fail('SCHEMA','Unsupported sync schema');
  if (!object(book.kv) || Object.keys(book.kv).some(k=>!KV_KEYS.includes(k) && k !== 'settings')) fail('SCHEMA','Unsupported book metadata');
  if (!object(book.kv.settings) || Object.keys(book.kv.settings).some(k=>!SETTINGS_KEYS.includes(k))) fail('SCHEMA','Device settings cannot sync');
  const out = {schema:SCHEMA,accounts:records(book.accounts,'accounts'),tx:records(book.tx,'tx'),recurring:records(book.recurring,'recurring'),kv:normalize(book.kv),receipts:manifests(book.receipts)};
  dropOrphans(out.kv, new Set(out.accounts.map(a => a.id)));
  if (enc.encode(canonical(out)).length > LIMITS.snapshotBytes) fail('BOUNDS','Snapshot too large');
  if (!STRICT.has(book)) strictRestore(out);
  const accounts = new Set(out.accounts.map(a=>a.id)), tx = new Map(out.tx.map(t=>[t.id,t])), receipts = new Set(out.receipts.map(r=>r.id));
  for (const a of out.accounts) if (!Number.isSafeInteger(a.opening) || (a.typed != null && typeof a.typed !== 'boolean') || (a.currency != null && !/^[A-Z]{3}$/.test(a.currency))) fail('SCHEMA','Invalid account monetary fields');
  for (const t of out.tx) {
    if (!accounts.has(t.accountId) || !['expense','income','transfer'].includes(t.type) || !Number.isSafeInteger(t.amount) || t.amount < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(t.date)) fail('RELATION','Invalid transaction/account');
    if (t.type === 'transfer' && (!accounts.has(t.toAccountId) || t.toAccountId === t.accountId)) fail('RELATION','Invalid transfer');
    if (t.toAmount != null && (!Number.isSafeInteger(t.toAmount) || t.toAmount <= 0)) fail('SCHEMA','Invalid FX amount');
    if (t.splitOf && !tx.get(t.splitOf)?.split) fail('RELATION','Orphan split row');
    // A refund may legitimately point to historical deleted source; preserve it rather than inventing a source row.
    if (t.receiptId && !receipts.has(t.receiptId)) fail('RECEIPTS','Missing receipt bytes manifest');
    if (t.split?.acc && !accounts.has(t.split.acc)) fail('RELATION','Missing split payment account');
  }
  for (const r of out.recurring) if (!accounts.has(r.accountId) || !Number.isSafeInteger(r.amount) || r.amount <= 0) fail('RELATION','Invalid recurring account/amount');
  STRICT.add(out);
  return out;
}
export const bookRevision = book => hash(validateBook(book));
function table(book) {
  const m = new Map();
  for (const k of ['accounts','tx','recurring','receipts']) for (const r of book[k]) m.set(`${k}/${r.id}`,r);
  for (const k of Object.keys(book.kv)) m.set(`kv/${k}`,book.kv[k]);
  return m;
}
function equal(a,b) { return a === undefined ? b === undefined : b !== undefined && canonical(a) === canonical(b); }
function changed(base,next) { return new Set([...new Set([...base.keys(),...next.keys()])].filter(k=>!equal(base.get(k),next.get(k)))); }
function assemble(m) {
  const b = {schema:SCHEMA,accounts:[],tx:[],recurring:[],receipts:[],kv:{}};
  for (const [key,value] of m) { const p=key.indexOf('/'), kind=key.slice(0,p), k=key.slice(p+1); if (kind==='kv') b.kv[k]=value; else b[kind].push(value); }
  return validateBook(b);
}
// Resource intersections prevent merging independent-looking halves of one compound ledger operation.
function resources(key, tables) {
  const s = new Set([key]);
  if (key.startsWith('tx/')) for (const table of tables) {
    const t=table.get(key); if (!t) continue;
    for (const link of ['splitOf','refundOf']) if (t[link]) s.add(`tx/${t[link]}`);
    if (t.receiptId) s.add(`receipts/${t.receiptId}`);
    if (t.bill) s.add(`recurring/${t.bill}`);
    for (const tag of ['owedBy','repaidBy','owedTo','repaidTo']) if (t[tag]) s.add(`debt/${['owedBy','repaidBy'].includes(tag)?'owed':'owe'}/${t[tag]}`);
  }
  return s;
}
function dependencyGroups(tables) {
  const parent=new Map();
  const find=k=>{if(!parent.has(k))parent.set(k,k);let root=k;while(parent.get(root)!==root)root=parent.get(root);while(parent.get(k)!==k){const next=parent.get(k);parent.set(k,root);k=next;}return root;};
  const join=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent.set(a<b?b:a,a<b?a:b);};
  for(const table of tables)for(const key of table.keys())if(key.startsWith('tx/'))for(const resource of resources(key,[table]))join(key,resource);
  return find;
}
// Generated, non-semantic differences (F3). Both devices post the same due auto-bill independently (js/engine.js dueBillTxs:
// id rec-BILL-DATE, createdAt: now) and every open of the app moves an auto bill's high-water mark `last` to today
// (js/views/money.js postBills). Neither is a user edit: they merge instead of conflicting. Any other field still conflicts.
const without=(o,...ks)=>{const c={...o};for(const k of ks)delete c[k];return c;};
const autoBill=t=>t&&t.source==='recurring'&&typeof t.bill==='string'&&t.id===`rec-${t.bill}-${t.date}`;
const earliest=(a,b)=>(a.createdAt??0)!==(b.createdAt??0)?((a.createdAt??0)<(b.createdAt??0)?a:b):(canonical(a)<=canonical(b)?a:b);
const withLast=(o,x,y)=>{const m=[x,y].filter(v=>typeof v==='string').sort().at(-1);return m?{...o,last:m}:without(o,'last');};
// bv/lv/rv are one key's base/local/remote values; returns the merged value or undefined when it is a real conflict.
function softMerge(k,bv,lv,rv) {
  if(!lv||!rv)return undefined;
  if(k.startsWith('tx/')&&autoBill(lv)&&autoBill(rv)&&equal(without(lv,'createdAt','updatedAt'),without(rv,'createdAt','updatedAt')))return earliest(lv,rv);
  if(k.startsWith('recurring/')){
    const nl=without(lv,'last'),nr=without(rv,'last'),nb=bv&&without(bv,'last');
    if(equal(nl,nr))return withLast(lv,lv.last,rv.last);
    if(nb&&equal(nl,nb))return withLast(rv,lv.last,rv.last);
    if(nb&&equal(nr,nb))return withLast(lv,lv.last,rv.last);
  }
  return undefined;
}
// A bill whose only change on this side is its `last` mark.
const lastOnly=(b,side,k)=>k.startsWith('recurring/')&&b.has(k)&&side.has(k)&&equal(without(b.get(k),'last'),without(side.get(k),'last'));
// A change that is only generated bookkeeping: a newly posted auto-bill payment, or a bill's `last` mark.
const soft=(b,side,k)=>lastOnly(b,side,k)||(k.startsWith('tx/')&&!b.has(k)&&autoBill(side.get(k)));
// A bill's `last` mark is the date auto-posting resumes after. A peer could push it into the future and silently stop a bill, so a REMOTE mark later than this
// device's own today + 1 day is refused (the book is not merged, recoverable: fix the date and try again) rather than clamped; the 1 day tolerates clock
// and timezone differences between the two devices. Genuine marks (both <= today + 1) merge as the later of the two and are never lowered.
const localDay=(d=new Date())=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const dayAfter=d=>{const t=new Date(`${d}T00:00:00Z`);t.setUTCDate(t.getUTCDate()+1);return t.toISOString().slice(0,10);};
export async function reconcile({base,local,remote,bookId,baseRevision,today=localDay()}) {
  id(bookId); base=validateBook(base);local=validateBook(local);remote=validateBook(remote);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(today))fail('SCHEMA','Invalid date');
  const latest=dayAfter(today);for(const r of remote.recurring)if(typeof r.last==='string'&&r.last>latest)fail('DATES',"The other device's bill dates look wrong. Check its date and try again")
  if (!SHA.test(baseRevision) || await hash(base) !== baseRevision) fail('BASE','Unacknowledged/mismatched base');
  const b=table(base),l=table(local),r=table(remote),lc=changed(b,l),rc=changed(b,r), merged=new Map(b), conflicts=[];
  if(lc.size>LIMITS.mergeChanges || rc.size>LIMITS.mergeChanges)fail('BOUNDS','Too many offline changes for this bounded merge; explicit whole-book recovery required');
  const conflictIds=new Set();
  const add=(kind,keys)=>{ const unique=[...new Set(keys)].sort(), cid=`${kind}:${unique.join('|')}`; if (!conflictIds.has(cid)) { if(conflicts.length>=LIMITS.conflicts)fail('BOUNDS','Too many conflicts; explicit whole-book recovery required');conflictIds.add(cid);conflicts.push({id:cid,kind,keys:unique}); } };
  const ruleResult=(lc.has('kv/rules')||rc.has('kv/rules'))?mergeLearnedRules(base,local,remote,LIMITS.mergeChanges):null;
  if(ruleResult?.changed&&(lc.size-(lc.has('kv/rules')?1:0)+ruleResult.changed.left>LIMITS.mergeChanges||rc.size-(rc.has('kv/rules')?1:0)+ruleResult.changed.right>LIMITS.mergeChanges))fail('BOUNDS','Too many total offline changes including learned rules');
  if(ruleResult?.error)add('rules-schema',['kv/rules']);
  for(const key of ruleResult?.conflicts||[])add('learned-rule',['kv/rules',key]);
  for (const k of new Set([...lc,...rc])) {
    if(k==='kv/rules'&&ruleResult){if(!ruleResult.error&&!ruleResult.conflicts.length){if(ruleResult.value===undefined)merged.delete(k);else merged.set(k,ruleResult.value);}continue;}
    if (lc.has(k) && rc.has(k) && !equal(l.get(k),r.get(k))) { const m=softMerge(k,b.get(k),l.get(k),r.get(k)); if(m===undefined)add('record',[k]);else merged.set(k,m); continue; }
    const v=rc.has(k)?r.get(k):l.get(k); if (v===undefined) merged.delete(k);else merged.set(k,v);
  }
  const tables=[b,l,r];
  const group=dependencyGroups(tables), remoteGroups=new Map();
  for(const k of rc){const g=group(k);if(!remoteGroups.has(g))remoteGroups.set(g,[]);remoteGroups.get(g).push(k);}
  for (const a of lc) for (const z of remoteGroups.get(group(a))||[]) {
    if (a===z || (equal(l.get(a),r.get(a)) && equal(l.get(z),r.get(z))) || (soft(b,l,a) && soft(b,r,z))) continue;
    add('compound',[a,z]);
  }
  // Opening/typed/currency changes cannot race ledger changes on that account; categories and automatic bills similarly remain one operation.
  for (const [changes,others,side] of [[lc,rc,r],[rc,lc,l]]) for (const key of changes) {
    if (key.startsWith('accounts/')) {
      const aid=key.slice(9);
      for (const k of others) if ((k.startsWith('tx/') || k.startsWith('recurring/')) && !lastOnly(b,side,k)) {
        if (tables.some(m=>{const t=m.get(k);return t && [t.accountId,t.toAccountId,t.split?.acc].includes(aid);})) add('account-ledger',[key,k]);
      }
    }
    if (key.startsWith('kv/') && !(key==='kv/rules'&&ruleResult&&!ruleResult.error&&!ruleResult.conflicts.length) && !equal(l.get(key),r.get(key))) for (const k of others) if ((k.startsWith('tx/') || k.startsWith('recurring/')) && !lastOnly(b,side,k)) add('metadata-ledger',[key,k]);
  }
  let candidate=null;
  if (!conflicts.length) { try { candidate=assemble(merged); } catch(e) { add('relationship',[e.code]); } }
  conflicts.sort((a,z)=>a.id.localeCompare(z.id));
  return {schema:SCHEMA,bookId,baseRevision,status:conflicts.length?'conflicts':'ready',conflicts,candidate,nextRevision:candidate?await hash(candidate):null};
}
export async function initialJoin({source,computer,phone,bookId,computerDeviceId,phoneDeviceId,backupEvidence}) {
  if (!['computer','phone'].includes(source)) fail('CHOICE','Choose an existing book explicitly');
  id(bookId);id(computerDeviceId);id(phoneDeviceId);if(computerDeviceId===phoneDeviceId)fail('IDENTITY','Devices must differ');
  computer=validateBook(computer);phone=validateBook(phone);
  const hashes={computer:await hash(computer),phone:await hash(phone)};
  for (const who of ['computer','phone']) if (backupEvidence?.[who]?.snapshotHash!==hashes[who] || backupEvidence[who].confirmed!==true) fail('BACKUP','Verified current safety backup evidence required for both books');
  const candidate=source==='computer'?computer:phone;
  return {schema:SCHEMA,status:'ready',source,bookId,computerDeviceId,phoneDeviceId,expected:hashes,candidate,nextRevision:hashes[source],replaces:source==='computer'?'phone':'computer'};
}
export async function makeJournal({base,next,bookId,deviceId,baseRevision,sequence=0}) {
  id(bookId);id(deviceId);base=validateBook(base);next=validateBook(next);
  if (await hash(base)!==baseRevision || !Number.isSafeInteger(sequence) || sequence<0) fail('BASE','Invalid journal base/sequence');
  const b=table(base),n=table(next), keys=[...changed(b,n)].sort();
  if(keys.length>LIMITS.journalEntries || sequence+keys.length>Number.MAX_SAFE_INTEGER) fail('BOUNDS','Journal requires a new shared checkpoint');
  const entries=[];
  for(const k of keys){const v=n.get(k);entries.push({id:`${deviceId}:${++sequence}`,key:k,before:b.has(k)?await hash(b.get(k)):null,after:v===undefined?null:await hash(v),tombstone:v===undefined,value:v===undefined?null:v});}
  return {schema:SCHEMA,bookId,deviceId,baseRevision,nextRevision:await hash(next),sequence,entries};
}
export async function replayJournal({base,journal,bookId,deviceId}) {
  base=validateBook(base);id(bookId);id(deviceId);
  if (!object(journal) || journal.schema!==SCHEMA || journal.bookId!==bookId || journal.deviceId!==deviceId || !SHA.test(journal.baseRevision) || !SHA.test(journal.nextRevision) || !Number.isSafeInteger(journal.sequence) || journal.sequence<0 || !Array.isArray(journal.entries) || journal.entries.length>LIMITS.journalEntries) fail('BASE','Invalid journal envelope');
  const revision=await hash(base);
  if(revision===journal.nextRevision)return base; // Lost acknowledgement/repeated delivery cannot apply a change twice.
  if(revision!==journal.baseRevision)fail('BASE','Journal requires its acknowledged base');
  const m=table(base), seen=new Set();let previous=0;
  for(const e of journal.entries){
    if(!object(e) || typeof e.id!=='string' || !e.id.startsWith(`${deviceId}:`) || typeof e.key!=='string' || !/^(accounts|tx|recurring|receipts|kv)\/[A-Za-z0-9_-]{1,128}$/.test(e.key) || seen.has(e.key))fail('SCHEMA','Invalid journal entry');
    const seq=Number(e.id.slice(deviceId.length+1));if(!Number.isSafeInteger(seq)||seq<=previous)fail('SCHEMA','Journal sequence order');previous=seq;seen.add(e.key);
    if((m.has(e.key)?await hash(m.get(e.key)):null)!==e.before || typeof e.tombstone!=='boolean')fail('BASE','Journal precondition failed');
    if(e.tombstone){if(e.after!==null||e.value!==null)fail('SCHEMA','Invalid tombstone');m.delete(e.key);}else{if(await hash(e.value)!==e.after)fail('HASH','Journal value hash mismatch');if(!e.key.startsWith('kv/') && e.value?.id!==e.key.slice(e.key.indexOf('/')+1))fail('SCHEMA','Journal key/value mismatch');m.set(e.key,e.value);}
  }
  const result=assemble(m);
  if(journal.entries.length && previous!==journal.sequence)fail('SCHEMA','Journal sequence mismatch');
  if(await hash(result)!==journal.nextRevision)fail('HASH','Journal revision mismatch');
  return result; // Replaying against the same acknowledged base is deterministic/idempotent. Never append entries twice.
}
export function receiptTransferPlan(target,available) {
  target=manifests(target);available=manifests(available);const have=new Map(available.map(x=>[x.id,x]));
  return target.filter(x=>!equal(have.get(x.id),x)).map(x=>({...x,chunks:Math.ceil(x.bytes/LIMITS.chunkBytes),chunkBytes:LIMITS.chunkBytes}));
}
export async function verifyReceipt(manifest,bytes) {
  const [m]=manifests([manifest]);
  if(!(bytes instanceof Uint8Array)||bytes.byteLength!==m.bytes||await sha256(bytes)!==m.sha256)fail('HASH','Receipt transfer is incomplete or corrupt');
  return true; // Host must ALSO decode/validate image before guarded receipt+book transaction; hashes are not authentication.
}
export const WIRE_SCHEMA='tally.complete-book-chunks/1';
export function schemaContract(){return normalize({schema:SCHEMA,wireSchema:WIRE_SCHEMA,recordFields:FIELDS,bookKvKeys:KV_KEYS,bookSettingsKeys:SETTINGS_KEYS,localKvExcluded:LOCAL_KV,limits:LIMITS,
  identity:{bookId:'opaque random UUID persisted with book',deviceId:'opaque random UUID persisted only on this installation',revision:'SHA-256 of canonical validateBook output'},
  apis:['newIdentity','canonical','sha256','hash','recordVersion','bookRevision','projectBook','validateBook','initialJoin','reconcile','makeJournal','replayJournal','receiptTransferPlan','verifyReceipt','snapshotFrames','snapshotReceiver'],
  result:{ready:'planner candidate only; not durable synchronized state',conflicts:'entire candidate null; no partial ledger apply'},
  snapshotFrameFields:['schema','bookId','transferId','revision','totalBytes','totalChunks','index','data'],journalEntryFields:['id','key','before','after','tombstone','value']});}
function base64(bytes) {
  let s=''; for(let p=0;p<bytes.length;p+=8192)s+=String.fromCharCode(...bytes.subarray(p,p+8192));return btoa(s);
}
function unbase64(s) {
  if(typeof s!=='string'||s.length>Math.ceil(LIMITS.chunkBytes/3)*4||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s))fail('BOUNDS','Invalid bounded chunk encoding');
  const raw=atob(s), bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
  if(base64(bytes)!==s)fail('SCHEMA','Noncanonical chunk encoding');return bytes;
}
// Async iterator: caller sends and awaits acknowledgement/backpressure per frame. Never materialize all frames.
export async function* snapshotFrames(book,{bookId,transferId}) {
  id(bookId);id(transferId);book=validateBook(book);
  const bytes=enc.encode(canonical(book)),revision=await hash(book),totalBytes=bytes.length,totalChunks=Math.ceil(totalBytes/LIMITS.chunkBytes);
  for(let index=0;index<totalChunks;index++)yield {schema:WIRE_SCHEMA,bookId,transferId,revision,totalBytes,totalChunks,index,data:base64(bytes.subarray(index*LIMITS.chunkBytes,(index+1)*LIMITS.chunkBytes))};
}
export function snapshotReceiver({bookId,transferId,revision,totalBytes,totalChunks}) {
  id(bookId);id(transferId);
  if(!SHA.test(revision)||!Number.isSafeInteger(totalBytes)||totalBytes<1||totalBytes>LIMITS.snapshotBytes||totalChunks!==Math.ceil(totalBytes/LIMITS.chunkBytes))fail('BOUNDS','Invalid transfer envelope');
  const chunks=new Map();let aborted=false,receivedBytes=0;
  const assertActive=()=>{if(aborted)fail('CANCELLED','Transfer cancelled');};
  return {
    accept(frame) {
      assertActive();
      if(!object(frame)||Object.keys(frame).some(k=>!['schema','bookId','transferId','revision','totalBytes','totalChunks','index','data'].includes(k))||frame.schema!==WIRE_SCHEMA||frame.bookId!==bookId||frame.transferId!==transferId||frame.revision!==revision||frame.totalBytes!==totalBytes||frame.totalChunks!==totalChunks||!Number.isInteger(frame.index)||frame.index<0||frame.index>=totalChunks)fail('SCHEMA','Chunk session/envelope mismatch');
      const bytes=unbase64(frame.data),size=frame.index===totalChunks-1?totalBytes-frame.index*LIMITS.chunkBytes:LIMITS.chunkBytes;
      if(bytes.length!==size)fail('BOUNDS','Chunk size mismatch');
      const old=chunks.get(frame.index);
      if(old){if(old.some((v,i)=>v!==bytes[i]))fail('HASH','Conflicting repeated chunk');}
      else{chunks.set(frame.index,bytes);receivedBytes+=bytes.length;}
      return {receivedChunks:chunks.size,totalChunks,receivedBytes,totalBytes};
    },
    async finish() {
      assertActive();if(chunks.size!==totalChunks||receivedBytes!==totalBytes)fail('INCOMPLETE','Snapshot transfer incomplete');
      const bytes=new Uint8Array(totalBytes);for(const [i,b]of chunks)bytes.set(b,i*LIMITS.chunkBytes);
      let book;try{book=validateBook(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}catch(e){fail(e.code||'SCHEMA',e.message);}
      if(await hash(book)!==revision)fail('HASH','Snapshot revision mismatch');assertActive();return book;
    },
    cancel(){aborted=true;chunks.clear();receivedBytes=0;},
  };
}
