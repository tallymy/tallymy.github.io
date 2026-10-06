// Explicit local replacement only. No network, automatic rollback or sync ACK.
export const RESTORE_SCHEMA='tally.safety-restore/1';
export const RETAINED_KEYS=Object.freeze(['localSyncRecoveryBefore','localSyncRecoverySource']);
const SHA=/^[a-f0-9]{64}$/,MIB=1024*1024;
const fail=code=>{throw Object.assign(new Error(`Safety restore: ${code}`),{code});};
const sha=v=>typeof v==='string'&&SHA.test(v);
const clone=v=>structuredClone(v);
export function createSafetyRestore({db,core,savedSafetyCopy,packRecovery,unpackRecovery,verifyImage,storageUsage,authorized,document:doc,onReplaced,reload,newIdentity=()=>crypto.randomUUID(),now=()=>Date.now(),ttlMs=120000}){
 if(!db||!core||typeof doc?.dispatchEvent!=='function'||[savedSafetyCopy,packRecovery,unpackRecovery,verifyImage,storageUsage,authorized,onReplaced,reload,newIdentity,now].some(f=>typeof f!=='function')||!Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>300000)fail('CONFIG');
 let epoch=0,busy=false,plan=null,closed=false;
 function check(ticket){let ok=false;try{ok=authorized()===true;}catch{}if(closed||!ok||ticket!==epoch)fail('CANCELLED');}
 const row=(s,k)=>s.records.kv.find(r=>r.key===k);
 const generation=s=>row(s,'bookGeneration')?.value??null;
 function bounds(book){if(new TextEncoder().encode(core.canonical(book)).length>16*MIB)fail('BOUNDS');}
 function proof(v){if(!v||Object.keys(v).sort().join(',')!=='archiveSha,bytes,confirmed,snapshotHash'||!sha(v.snapshotHash)||!sha(v.archiveSha)||v.confirmed!==true||!Number.isSafeInteger(v.bytes)||v.bytes<1||v.bytes>40*MIB)fail('BACKUP');return clone(v);}
 async function photos(book,map,ticket){if(!(map instanceof Map)||map.size!==book.receipts.length)fail('RECEIPTS');let total=0;for(const m of book.receipts){const b=map.get(m.id);if(!(b instanceof Blob)||b.size!==m.bytes||b.type!==m.mime||b.size>40*MIB||(total+=b.size)>200*MIB)fail('RECEIPTS');check(ticket);await core.verifyReceipt(m,new Uint8Array(await b.arrayBuffer()));check(ticket);const image=await verifyImage(b);check(ticket);if(!image||image.mime!==b.type||!Number.isSafeInteger(image.width)||!Number.isSafeInteger(image.height)||image.width<1||image.height<1||image.width*image.height>50000000)fail('RECEIPTS');}}
 async function archive(blob,evidence,ticket){if(!(blob instanceof Blob)||blob.size!==evidence.bytes)fail('BACKUP');check(ticket);if(await core.sha256(new Uint8Array(await blob.arrayBuffer()))!==evidence.archiveSha)fail('HASH');check(ticket);const decoded=await unpackRecovery(blob);check(ticket);const book=core.validateBook(decoded.book);bounds(book);if(await core.bookRevision(book)!==evidence.snapshotHash)fail('HASH');check(ticket);await photos(book,decoded.photos,ticket);return {book,photos:new Map(decoded.photos)};}
 async function currentBook(snapshot,ticket){const manifests=[],map=new Map(),used=new Set(snapshot.records.tx.map(r=>r.receiptId).filter(Boolean));let total=0;for(const r of snapshot.records.receipts){if(!used.has(r.id))continue;if(!(r.blob instanceof Blob)||r.blob.size>40*MIB||(total+=r.blob.size)>200*MIB)fail('RECEIPTS');check(ticket);manifests.push({id:r.id,bytes:r.blob.size,mime:r.blob.type,sha256:await core.sha256(new Uint8Array(await r.blob.arrayBuffer()))});check(ticket);map.set(r.id,r.blob);}
  const all=Object.fromEntries(snapshot.records.kv.map(r=>[r.key,r.value])),kv={settings:all.settings||{}};for(const k of core.KV_KEYS)if(Object.hasOwn(all,k))kv[k]=all[k];const book=core.projectBook({accounts:snapshot.records.accounts,tx:snapshot.records.tx,recurring:snapshot.records.recurring,kv},manifests);bounds(book);await photos(book,map,ticket);return {book,photos:map};}
 function writes(snapshot,target,targetPhotos,beforeArchive,beforeEvidence,sourceArchive,sourceEvidence,nextGeneration){
  const settings={...(row(snapshot,'settings')?.value||{})};for(const k of core.SETTINGS_KEYS)delete settings[k];Object.assign(settings,target.kv.settings);
  const removed=new Set([...core.KV_KEYS,'offlineSync','reviewDraft','scanQueue','deskPlace',...RETAINED_KEYS]);
  const kv=snapshot.records.kv.filter(r=>!removed.has(r.key)&&r.key!=='settings'&&r.key!=='bookGeneration');
  kv.push(...Object.entries(target.kv).filter(([k])=>k!=='settings').map(([key,value])=>({key,value})),{key:'settings',value:settings},{key:'bookGeneration',value:nextGeneration},
   {key:RETAINED_KEYS[0],value:{format:'tally-sync-recovery/1',purpose:'before-replacement',evidence:beforeEvidence},blob:beforeArchive},
   {key:RETAINED_KEYS[1],value:{format:'tally-sync-recovery/1',purpose:'restored-source',evidence:sourceEvidence},blob:sourceArchive});
  const records={accounts:target.accounts,tx:target.tx,recurring:target.recurring,receipts:target.receipts.map(m=>({id:m.id,blob:targetPhotos.get(m.id)})),kv};
  // Preserve older retained copies by refusing, rather than overwriting a user's only recovery path.
  if(RETAINED_KEYS.some(k=>row(snapshot,k)))fail('RETAINED_COPY_EXISTS');
  const usage=storageUsage(records,!!settings.lock?.enc);if(!usage||!Number.isFinite(usage.metadata)||!Number.isFinite(usage.photos)||usage.metadata>63*MIB||usage.photos>199*MIB)fail('BOUNDS');return records;
 }
 async function prepare(){if(busy)fail('BUSY');const ticket=++epoch;plan=null;check(ticket);busy=true;try{
  const snapshot=await db.captureAtomicSnapshot();check(ticket);if(row(snapshot,'reviewDraft')?.value?.draft||row(snapshot,'scanQueue')?.value?.length)fail('BUSY');
  const stored=row(snapshot,'offlineSync'),saved=await savedSafetyCopy();check(ticket);const evidence=proof(saved?.evidence),captured=proof(stored?.value?.safety);
  if(core.canonical(captured)!==core.canonical(evidence)||saved?.format!=='tally-sync-recovery/1')fail('STALE');
  const source=await archive(stored.blob,evidence,ticket);if(await core.bookRevision(core.validateBook(saved.book))!==evidence.snapshotHash)fail('HASH');check(ticket);
  const before=await currentBook(snapshot,ticket),beforeRevision=await core.bookRevision(before.book);check(ticket);const beforeArchive=await packRecovery(before);check(ticket);if(!(beforeArchive instanceof Blob)||beforeArchive.size>40*MIB)fail('BOUNDS');
  const beforeEvidence={snapshotHash:beforeRevision,archiveSha:await core.sha256(new Uint8Array(await beforeArchive.arrayBuffer())),bytes:beforeArchive.size,confirmed:true};check(ticket);await archive(beforeArchive,proof(beforeEvidence),ticket);
  const token=newIdentity(),nextGeneration=newIdentity();if(typeof token!=='string'||typeof nextGeneration!=='string'||token.length<16||nextGeneration.length<16||nextGeneration===generation(snapshot))fail('IDENTITY');
  const records=writes(snapshot,source.book,source.photos,beforeArchive,beforeEvidence,stored.blob,evidence,nextGeneration),expiresAt=now()+ttlMs;
  const descriptor={schema:RESTORE_SCHEMA,token,generation:generation(snapshot),beforeRevision,targetRevision:evidence.snapshotHash,archiveSha:evidence.archiveSha,beforeArchiveSha:beforeEvidence.archiveSha,nextGeneration};const reviewHash=await core.hash(descriptor);check(ticket);
  plan={ticket,snapshot,records,descriptor,reviewHash,expiresAt};return clone({...descriptor,reviewHash,expiresAt,before:before.book,after:source.book,retained:{before:beforeEvidence,source:evidence}});
 }catch(e){plan=null;throw e;}finally{busy=false;}}
 async function restore(input){if(busy)fail('BUSY');const p=plan;plan=null;if(!p)fail('REVIEW');check(p.ticket);if(!input||Object.keys(input).sort().join(',')!=='replace,reviewHash,token'||input.replace!==true||input.token!==p.descriptor.token||input.reviewHash!==p.reviewHash||now()>p.expiresAt)fail('APPROVAL');busy=true;let committed=false;try{
  await db.writeAtomic({clear:['accounts','tx','recurring','receipts','kv'],put:p.records,snapshotGuard:p.snapshot.guard,beforeWrite:()=>{check(p.ticket);if(now()>p.expiresAt)fail('EXPIRED');}});committed=true;
  // Generic event revokes public sessions synchronously; never invoke the owned-sync seam.
  let notified=true;try{doc.dispatchEvent(new Event('tally:book-replaced'));const result=onReplaced({kind:'safety-restore',generation:p.descriptor.nextGeneration});if(result&&typeof result.then==='function'){notified=false;Promise.resolve(result).catch(()=>{});}}catch{notified=false;}
  try{await reload();return {schema:RESTORE_SCHEMA,status:notified?'restored':'restored-reload-required',revision:p.descriptor.targetRevision,generation:p.descriptor.nextGeneration};}catch{return {schema:RESTORE_SCHEMA,status:'restored-reload-required',revision:p.descriptor.targetRevision,generation:p.descriptor.nextGeneration};}
 }finally{busy=false;if(committed)epoch++;}}
 function cancel(){epoch++;plan=null;}
 function close(){closed=true;cancel();}
 return Object.freeze({prepare,restore,cancel,close});
}
