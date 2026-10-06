import {validateControllerContext} from './controller-context.mjs';
// Match the bytes counted by captureAtomicSnapshot, including each AES-GCM body.
export function syncMetadataBytes(records, sealed) {
  const encoder=new TextEncoder();let bytes=0;
  for(const store of ['accounts','tx','recurring','kv'])for(const record of records[store]||[]){
    const {blob,...rest}=record;
    const encrypted=sealed&&!(store==='kv'&&record.key==='settings');
    const head=encrypted&&blob instanceof Blob?{...rest,blobType:blob.type}:rest;
    bytes+=encoder.encode(JSON.stringify(head)).length+(encrypted?20+(blob instanceof Blob?blob.size:0):0);
  }
  return bytes;
}
// Receipts are ciphertext bytes (including their JSON header) in the photo budget.
export function syncReceiptUsage(records,sealed) {
  const encoder=new TextEncoder();let metadata=0,photos=0;
  for(const item of records){const {blob,...rest}=item.record||item,bytes=item.record?item.bytes:(blob?.size||0),mime=item.record?item.mime:blob?.type;
    const head=encoder.encode(JSON.stringify(rest)).length;
    metadata+=sealed?0:head;photos+=bytes+(sealed?encoder.encode(JSON.stringify(mime?{...rest,blobType:mime}:rest)).length+20:0);
  }
  return {metadata,photos};
}
export function syncStorageUsage(records,sealed) {
  const receipts=syncReceiptUsage(records.receipts||[],sealed);
  return {metadata:syncMetadataBytes(records,sealed)+receipts.metadata,photos:receipts.photos+(sealed?0:(records.kv||[]).reduce((n,r)=>n+(r.blob?.size||0),0))};
}
// Complete-book persistence boundary. Network messages cannot call this directly:
// the paired session controller owns explicit book choice, plan approval and peer ACKs.
export function createBookStore({db,core,packRecovery,unpackRecovery,verifyImage,allowed,onChange=()=>{}}) {
  if(typeof allowed!=='function')throw new Error('Sync requires explicit foreground and lock authorization.');
  const error=(code,message)=>Object.assign(new Error(message),{code});
  const check=()=>{if(!allowed())throw error('CANCELLED','Unlock Tally and finish your current entry before syncing.');};
  const localRow=s=>s.records.kv.find(r=>r.key==='offlineSync');
  const generation=s=>s.records.kv.find(r=>r.key==='bookGeneration')?.value??null;
  const metadata=s=>localRow(s)?.value||null;
  const ackContext=p=>p.controllerContext?{controllerContext:p.controllerContext}:{};
  const currentIdentity=s=>{if(!s.local||s.local.generation!==s.generation)throw error('STALE','This book was restored or replaced. Pair it again.');};
  const rows=s=>({accounts:s.records.accounts,tx:s.records.tx,recurring:s.records.recurring,kv:Object.fromEntries(s.records.kv.map(r=>[r.key,r.value]))});
  const smallBook=book=>{if(new TextEncoder().encode(core.canonical(book)).length>16*1024*1024)throw error('BOUNDS','This book exceeds the first sync version’s ledger limit.');};
  const ownSettings=(snapshot,book)=>{const settings={...(rows(snapshot).kv.settings||{})};for(const key of core.SETTINGS_KEYS)delete settings[key];return {...settings,...book.kv.settings};};
  const aliasMarker=(pending,m)=>({v:1,planId:pending.planId,receiptId:m.id,sha256:m.sha256,bytes:m.bytes,mime:m.mime});
  const aliasRecord=(pending,m,blob)=>({id:m.alias,syncPhoto:aliasMarker(pending,m),...(blob instanceof Blob?{blob}:{})});
  function receiptLayout(snapshot,target=null,extra=[],prune=[]) {
    const removed=new Set(prune),out=new Map();
    if(target){const ids=new Set(target.receipts.map(r=>r.id));for(const r of target.receipts)out.set(r.id,{record:{id:r.id},bytes:r.bytes,mime:r.mime});
      for(const r of snapshot.records.receipts)if(!snapshot.photos.has(r.id)&&!ids.has(r.id)&&!removed.has(r.id))out.set(r.id,r);
    }else for(const r of snapshot.records.receipts)if(!removed.has(r.id))out.set(r.id,r);
    for(const r of extra){const id=r.record?.id||r.id;if(out.has(id))throw error('COLLISION','A sync photo identifier is already used. Nothing was replaced.');out.set(id,r);}
    return [...out.values()];
  }
  function budget(snapshot,value,blob=localRow(snapshot)?.blob,target=null,extra=[],prune=[]) {
    const valueBytes=new TextEncoder().encode(core.canonical(value)).length;
    if(valueBytes>32*1024*1024)throw error('BOUNDS','This book exceeds the first sync version’s checkpoint limit.');
    let local=rows(snapshot),kv={...local.kv};delete kv.offlineSync;
    if(target){smallBook(target);for(const key of core.KV_KEYS)delete kv[key];kv={...kv,...target.kv,settings:ownSettings(snapshot,target),bookGeneration:value.generation};local={accounts:target.accounts,tx:target.tx,recurring:target.recurring,kv};}
    else local={...local,kv};
    const sealed=!!kv.settings?.lock?.enc;
    const checkpoint={key:'offlineSync',value,...(blob instanceof Blob?{blob}:{})};
    const existingKv=new Map(snapshot.records.kv.map(r=>[r.key,r]));
    const portableKeys=new Set(target?core.KV_KEYS:[]);
    const kvRecords=Object.entries(kv).map(([key,value])=>({key,value,...(!portableKeys.has(key)&&existingKv.get(key)?.blob instanceof Blob?{blob:existingKv.get(key).blob}:{})}));
    const metadataRecords={accounts:local.accounts,tx:local.tx,recurring:local.recurring,kv:[...kvRecords,checkpoint]};
    const receipts=receiptLayout(snapshot,target,extra,prune),usage=syncStorageUsage({...metadataRecords,receipts},sealed);
    if(receipts.length>200000)throw error('BOUNDS','There are too many photos to keep a safe sync checkpoint.');
    if(usage.metadata>63*1024*1024)throw error('BOUNDS','There is too much data for this sync checkpoint. Make a file backup and keep using this book locally.');
    if(usage.photos>199*1024*1024)throw error('BOUNDS','The book and safety copy exceed this sync version’s photo limit.');
  }
  async function capture() {
    check();const local=await db.captureAtomicSnapshot();check();
    const localKv=rows(local).kv;
    if(localKv.reviewDraft?.draft||localKv.scanQueue?.length)throw error('BUSY','Finish your receipt review before syncing.');
    const used=new Set(local.records.tx.map(r=>r.receiptId).filter(Boolean));
    const manifest=[],photos=new Map();
    for(const record of local.records.receipts){
      if(!used.has(record.id))continue;
      if(!(record.blob instanceof Blob))throw error('RECEIPTS','A receipt photo is missing. Review it before syncing.');
      check();const bytes=new Uint8Array(await record.blob.arrayBuffer());
      manifest.push({id:record.id,sha256:await core.sha256(bytes),bytes:bytes.length,mime:record.blob.type});photos.set(record.id,record.blob);
    }
    const book=core.projectBook(rows(local),manifest),revision=await core.bookRevision(book);check();
    smallBook(book);
    return {...local,book,revision,photos,local:metadata(local),generation:generation(local)};
  }
  async function putLocal(snapshot,value,blob=localRow(snapshot)?.blob) {
    check();budget(snapshot,value,blob);
    await db.writeAtomic({put:{kv:[{key:'offlineSync',value,...(blob instanceof Blob?{blob}:{})}]},snapshotGuard:snapshot.guard,beforeWrite:check});onChange({kind:'sync-metadata'});
  }
  async function identity() {
    let snapshot=await capture(),value=snapshot.local;
    if(value?.v===1&&value.generation===snapshot.generation&&value.bookId&&value.deviceId)return snapshot;
    value={v:1,generation:snapshot.generation,bookId:core.newIdentity(),deviceId:value?.deviceId||core.newIdentity(),peerDeviceId:null,base:null,baseRevision:null,pending:null,safety:null};
    // A restore/erase starts a new book; it can never replay an old base or tombstone.
    await putLocal(snapshot,value,null);snapshot=await capture();return snapshot;
  }
  async function safetyBackup() {
    const snapshot=await identity();check();
    if(snapshot.local.pending)throw error('PENDING','Finish the pending sync before replacing its safety copy.');
    const archive=await packRecovery({book:snapshot.book,photos:snapshot.photos});
    if(!(archive instanceof Blob)||archive.size>40*1024*1024)throw error('BOUNDS','This book needs a file backup before pairing. The saved safety copy exceeds 40 MB.');
    const archiveSha=await core.sha256(new Uint8Array(await archive.arrayBuffer()));
    const verified=await unpackRecovery(archive);
    if(await core.bookRevision(verified.book)!==snapshot.revision)throw error('BACKUP','The safety copy could not be verified.');
    for(const receipt of snapshot.book.receipts){const blob=verified.photos.get(receipt.id);if(!(blob instanceof Blob))throw error('BACKUP','A safety copy photo is missing.');await core.verifyReceipt(receipt,new Uint8Array(await blob.arrayBuffer()));}
    const safety={snapshotHash:snapshot.revision,archiveSha,bytes:archive.size,confirmed:true};
    await putLocal(snapshot,{...snapshot.local,safety},archive);
    const stored=await capture(),saved=localRow(stored)?.blob;
    if(!(saved instanceof Blob)||await core.sha256(new Uint8Array(await saved.arrayBuffer()))!==archiveSha)throw error('BACKUP','The safety copy was not saved correctly.');
    return {snapshot:stored,evidence:safety};
  }

  // Read-only access to the retained historical safety book, not a restore.
  async function savedSafetyCopy() {
    const accessCheck=()=>{let ok=false;try{ok=allowed()===true;}catch{}if(!ok)throw error('CANCELLED','Unlock Tally before opening its safety copy.');};
    const wait=async task=>{accessCheck();const value=await task();accessCheck();return value;};
    const snapshot=await wait(()=>db.captureAtomicSnapshot());
    const local=metadata(snapshot),saved=localRow(snapshot)?.blob,evidence=local?.safety;
    if(!local||local.v!==1||local.generation!==generation(snapshot))throw error('STALE','This safety copy belongs to a replaced book.');
    const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
    if(!evidence||Object.keys(evidence).sort().join(',')!=='archiveSha,bytes,confirmed,snapshotHash'||evidence.confirmed!==true||!sha(evidence.archiveSha)||!sha(evidence.snapshotHash)||!Number.isSafeInteger(evidence.bytes)||evidence.bytes<1||evidence.bytes>40*1024*1024||!(saved instanceof Blob)||saved.size!==evidence.bytes)throw error('BACKUP','A verified safety copy is not available.');
    const bytes=new Uint8Array(await wait(()=>saved.arrayBuffer()));
    if(await wait(()=>core.sha256(bytes))!==evidence.archiveSha)throw error('BACKUP','The stored safety copy changed.');
    const decoded=await wait(()=>unpackRecovery(saved));
    const book=core.validateBook(decoded?.book);smallBook(book);
    if(await wait(()=>core.bookRevision(book))!==evidence.snapshotHash)throw error('BACKUP','The safety copy does not match its saved book.');
    if(!(decoded.photos instanceof Map)||decoded.photos.size!==book.receipts.length)throw error('BACKUP','The safety copy has unexpected or missing photos.');
    const photos=new Map();
    for(const manifest of book.receipts){const blob=decoded.photos.get(manifest.id);photos.set(manifest.id,await wait(()=>verifiedPhoto(manifest,blob)));}
    // Raw all-store guard covers edits/replacement during hash/decode/image awaits.
    await wait(()=>db.writeAtomic({snapshotGuard:snapshot.guard,beforeWrite:accessCheck}));
    const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
    const immutableBook=freeze(structuredClone(book)),immutableEvidence=freeze(structuredClone(evidence));
    return Object.freeze({format:'tally-sync-recovery/1',book:immutableBook,evidence:immutableEvidence,archive:saved,get photos(){return new Map(photos);}});
  }

  async function prepare({candidate,bookId,peerDeviceId,planId,expectedRevision,initial=false,controllerContext}) {
    const snapshot=await identity();check();candidate=core.validateBook(candidate);smallBook(candidate);
    const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id)&&!['__proto__','constructor','prototype'].includes(id);
    if(![peerDeviceId,planId,bookId].every(validId))throw error('IDENTITY','Invalid paired device or plan.');
    const nextRevision=await core.bookRevision(candidate),oldPending=snapshot.local.pending;
    const context=controllerContext===undefined?undefined:await validateControllerContext(core,controllerContext,{planId,bookId,peerDeviceId,deviceId:snapshot.local.deviceId,expectedRevision,nextRevision,initial:!!initial});check();
    if(oldPending){
      if(oldPending.planId!==planId||oldPending.peerDeviceId!==peerDeviceId||oldPending.bookId!==bookId||oldPending.expectedRevision!==expectedRevision||oldPending.nextRevision!==nextRevision||oldPending.initial!==!!initial)throw error('PENDING','Finish the previous sync before preparing a different plan.');
      if(oldPending.status==='prepared'&&snapshot.revision!==expectedRevision)throw error('STALE','This book changed after preparation. Review the sync again.');
      if(oldPending.controllerContext)await validateControllerContext(core,oldPending.controllerContext,{planId,bookId,peerDeviceId,deviceId:snapshot.local.deviceId,expectedRevision,nextRevision,initial:!!initial});
      if(context&&core.canonical(context)!==core.canonical(oldPending.controllerContext||null))throw error('CONTEXT','The old sync context cannot be replaced. Keep both safety copies.');check();
      return {planId,nextRevision,status:oldPending.status};
    }
    if(snapshot.revision!==expectedRevision)throw error('STALE','This book changed. Review the sync again.');
    if(peerDeviceId===snapshot.local.deviceId||!peerDeviceId||!planId||!bookId)throw error('IDENTITY','Invalid paired device or plan.');
    if(!initial&&(snapshot.local.bookId!==bookId||snapshot.local.peerDeviceId!==peerDeviceId))throw error('IDENTITY','Reconnect the device paired with this book.');
    if(initial&&snapshot.local.safety?.snapshotHash!==snapshot.revision)throw error('BACKUP','Make a current safety copy before choosing the starting book.');
    const nextGeneration=initial?core.newIdentity():snapshot.generation;
    const photoAliases=[];
    // q_ is the incumbent durable-review namespace excluded by state.sweepPhotos().
    // Ownership still requires the full pending binding and marker, never this prefix.
    for(const m of candidate.receipts){const alias='q_syncp_'+await core.hash({scope:'tally-sync-photo-v1',planId,receiptId:m.id,sha256:m.sha256});photoAliases.push({...m,alias});}
    const reserved=new Set(photoAliases.map(m=>m.alias));
    if(reserved.size!==photoAliases.length||candidate.receipts.some(m=>reserved.has(m.id))||snapshot.records.receipts.some(r=>reserved.has(r.id)))throw error('COLLISION','A sync photo identifier is already used. Nothing was replaced.');
    const pending={planId,peerDeviceId,bookId,expectedRevision,nextRevision,candidate,status:'prepared',initial:!!initial,nextGeneration,photoAliases,photosDurable:false,...(context?{controllerContext:context}:{})};
    const predicted=photoAliases.map(m=>({record:aliasRecord(pending,m),bytes:m.bytes,mime:m.mime}));
    const committed={...snapshot.local,bookId,peerDeviceId,generation:nextGeneration,pending:{...pending,status:'committed'}};
    const acknowledged={...committed,base:candidate,baseRevision:nextRevision,pending:null,lastAck:{planId,peerDeviceId,revision:nextRevision,...ackContext(pending)}};
    budget(snapshot,{...snapshot.local,pending},localRow(snapshot)?.blob,null,predicted);
    budget(snapshot,committed,localRow(snapshot)?.blob,candidate,predicted);budget(snapshot,acknowledged,localRow(snapshot)?.blob,candidate);
    await putLocal(snapshot,{...snapshot.local,pending});
    return {planId,nextRevision,photosDurable:false};
  }
  async function boundPending(snapshot,planId) {
    check();currentIdentity(snapshot);const p=snapshot.local.pending;
    if(!p||p.planId!==planId||!['prepared','committed'].includes(p.status))throw error('STALE','This sync plan is no longer pending.');
    if(p.controllerContext)await validateControllerContext(core,p.controllerContext,{planId:p.planId,bookId:p.bookId,peerDeviceId:p.peerDeviceId,deviceId:snapshot.local.deviceId,expectedRevision:p.expectedRevision,nextRevision:p.nextRevision,initial:p.initial});check();
    const target=core.validateBook(p.candidate);smallBook(target);
    if(await core.bookRevision(target)!==p.nextRevision)throw error('HASH','The prepared book changed.');
    if(!Array.isArray(p.photoAliases)||p.photoAliases.length!==target.receipts.length)throw error('RECEIPTS','The durable photo checkpoint is incomplete.');
    for(let i=0;i<target.receipts.length;i++){const m=target.receipts[i],a=p.photoAliases[i],alias='q_syncp_'+await core.hash({scope:'tally-sync-photo-v1',planId,receiptId:m.id,sha256:m.sha256});
      if(core.canonical(a)!==core.canonical({...m,alias}))throw error('RECEIPTS','The durable photo checkpoint does not match this plan.');}
    check();return {pending:p,target};
  }
  async function verifiedPhoto(m,blob) {
    check();if(!(blob instanceof Blob)||blob.type!==m.mime||blob.size!==m.bytes)throw error('RECEIPTS','Receipt transfer is incomplete.');
    const {id,sha256,bytes,mime}=m;await core.verifyReceipt({id,sha256,bytes,mime},new Uint8Array(await blob.arrayBuffer()));check();const image=await verifyImage(blob);check();
    if(!image||image.mime!==m.mime||!Number.isSafeInteger(image.width)||!Number.isSafeInteger(image.height)||image.width<1||image.height<1||image.width*image.height>50000000)throw error('RECEIPTS','A receipt image is unreadable or too large.');
    return blob;
  }
  const ownedAlias=(record,p,m)=>record?.id===m.alias&&core.canonical(record.syncPhoto||null)===core.canonical(aliasMarker(p,m));
  async function durablePhotos(snapshot,p) {
    if(p.photosDurable!==true)throw error('RECEIPTS','Receipt transfer has not been saved yet.');
    const records=new Map(snapshot.records.receipts.map(r=>[r.id,r])),photos=new Map();
    for(const m of p.photoAliases){const r=records.get(m.alias);if(!ownedAlias(r,p,m))throw error('RECEIPTS','A durable sync photo is missing or belongs to another plan.');photos.set(m.id,await verifiedPhoto(m,r.blob));}
    return photos;
  }
  // PREPARED may be sent only after this guarded atomic write resolves.
  async function stagePhotos(planId,receivedPhotos=new Map()) {
    const snapshot=await capture(),{pending:p,target}=await boundPending(snapshot,planId);
    const targetIds=new Set(target.receipts.map(m=>m.id));
    if(!(receivedPhotos instanceof Map)||receivedPhotos.size>target.receipts.length||[...receivedPhotos.keys()].some(id=>!targetIds.has(id)))throw error('RECEIPTS','Unexpected receipt transfer.');
    if(p.photosDurable){await durablePhotos(snapshot,p);await db.writeAtomic({snapshotGuard:snapshot.guard,beforeWrite:check});return {planId,revision:p.nextRevision,status:p.status,photosDurable:true,durable:true};}
    if(p.status!=='prepared'||snapshot.revision!==p.expectedRevision)throw error('STALE','This book changed after preparation. Review the sync again.');
    const existing=new Set(snapshot.records.receipts.map(r=>r.id)),receipts=[];
    for(const m of p.photoAliases){if(existing.has(m.alias))throw error('COLLISION','A sync photo identifier is already used. Nothing was replaced.');const blob=await verifiedPhoto(m,receivedPhotos.get(m.id)||snapshot.photos.get(m.id));receipts.push(aliasRecord(p,m,blob));}
    const pending={...p,photosDurable:true},value={...snapshot.local,pending},committed={...value,bookId:p.bookId,peerDeviceId:p.peerDeviceId,generation:p.nextGeneration,pending:{...pending,status:'committed'}};
    budget(snapshot,value,localRow(snapshot)?.blob,null,receipts);budget(snapshot,committed,localRow(snapshot)?.blob,target,receipts);
    budget(snapshot,{...committed,base:target,baseRevision:p.nextRevision,pending:null,lastAck:{planId,peerDeviceId:p.peerDeviceId,revision:p.nextRevision,...ackContext(p)}},localRow(snapshot)?.blob,target);
    await db.writeAtomic({put:{receipts,kv:[{key:'offlineSync',value,...(localRow(snapshot)?.blob instanceof Blob?{blob:localRow(snapshot).blob}:{})}]},snapshotGuard:snapshot.guard,beforeWrite:check});onChange({kind:'sync-photos',planId});
    return {planId,revision:p.nextRevision,status:p.status,photosDurable:true,durable:true};
  }
  async function pendingPhotos(planId) {const snapshot=await capture(),{pending}=await boundPending(snapshot,planId),photos=await durablePhotos(snapshot,pending);await db.writeAtomic({snapshotGuard:snapshot.guard,beforeWrite:check});return photos;}
  async function commit({planId,receivedPhotos=new Map()}) {
    let snapshot=await capture(),pending=snapshot.local?.pending;check();currentIdentity(snapshot);
    if(!pending||pending.planId!==planId)throw error('STALE','This sync plan is no longer prepared.');
    if(!pending.photosDurable){await stagePhotos(planId,receivedPhotos);snapshot=await capture();pending=snapshot.local?.pending;check();currentIdentity(snapshot);}
    const bound=await boundPending(snapshot,planId),photos=await durablePhotos(snapshot,bound.pending);
    if(pending?.planId===planId&&pending.status==='committed'){await db.writeAtomic({snapshotGuard:snapshot.guard,beforeWrite:check});return {planId,revision:pending.nextRevision,durable:true};}
    if(!pending||pending.planId!==planId||pending.status!=='prepared')throw error('STALE','This sync plan is no longer prepared.');
    if(snapshot.revision!==pending.expectedRevision)throw error('STALE','This book changed after preparation. Review the sync again.');
    const target=core.validateBook(pending.candidate);smallBook(target);
    if(await core.bookRevision(target)!==pending.nextRevision)throw error('HASH','The prepared book changed.');
    const receipts=[];
    for(const manifest of target.receipts){
      check();const blob=photos.get(manifest.id);
      receipts.push({id:manifest.id,blob});
    }
    const settings=ownSettings(snapshot,target),nextGeneration=pending.nextGeneration;
    const value={...snapshot.local,bookId:pending.bookId,peerDeviceId:pending.peerDeviceId,generation:nextGeneration,pending:{...pending,status:'committed'}};
    budget(snapshot,value,localRow(snapshot)?.blob,target);
    const receiptIds=new Set(receipts.map(r=>r.id));
    receipts.push(...snapshot.records.receipts.filter(r=>!snapshot.photos.has(r.id)&&!receiptIds.has(r.id)));
    const portable=Object.entries(target.kv).filter(([key])=>key!=='settings').map(([key,value])=>({key,value}));
    await db.writeAtomic({clear:['accounts','tx','recurring','receipts'],del:{kv:core.KV_KEYS},put:{accounts:target.accounts,tx:target.tx,recurring:target.recurring,receipts,kv:[...portable,{key:'settings',value:settings},{key:'bookGeneration',value:nextGeneration},{key:'offlineSync',value,...(localRow(snapshot)?.blob instanceof Blob?{blob:localRow(snapshot).blob}:{})}]},snapshotGuard:snapshot.guard,beforeWrite:check});
    onChange({kind:'sync-commit',planId});return {planId,revision:pending.nextRevision,durable:true};
  }
  async function acknowledge({planId,peerDeviceId,revision}) {
    const snapshot=await capture(),pending=snapshot.local?.pending;check();currentIdentity(snapshot);
    const last=snapshot.local.lastAck;
    if(!pending&&last?.planId===planId&&last.peerDeviceId===peerDeviceId&&last.revision===revision&&snapshot.local.baseRevision===revision){if(last.controllerContext)await validateControllerContext(core,last.controllerContext,{planId:last.planId,bookId:snapshot.local.bookId,peerDeviceId:last.peerDeviceId,deviceId:snapshot.local.deviceId,nextRevision:last.revision});check();await db.writeAtomic({snapshotGuard:snapshot.guard,beforeWrite:check});return {planId,revision,acknowledged:true};}
    if(!pending||pending.status!=='committed'||pending.planId!==planId||pending.peerDeviceId!==peerDeviceId||pending.nextRevision!==revision)throw error('ACK','The other device has not acknowledged this book.');
    // Edits made after the local commit stay in the ledger. The acknowledged base
    // is the agreed target; the next reconciliation sees those edits as local changes.
    const {pending:verified}=await boundPending(snapshot,planId);await durablePhotos(snapshot,verified);
    const used=new Set(snapshot.records.tx.map(r=>r.receiptId).filter(Boolean)),prune=verified.photoAliases.filter(m=>!used.has(m.alias)).map(m=>m.alias);
    const value={...snapshot.local,base:pending.candidate,baseRevision:revision,pending:null,lastAck:{planId,peerDeviceId,revision,...ackContext(pending)}};
    budget(snapshot,value,localRow(snapshot)?.blob,null,[],prune);
    await db.writeAtomic({del:{receipts:prune},put:{kv:[{key:'offlineSync',value,...(localRow(snapshot)?.blob instanceof Blob?{blob:localRow(snapshot).blob}:{})}]},snapshotGuard:snapshot.guard,beforeWrite:check});onChange({kind:'sync-ack',planId});
    return {planId,revision,acknowledged:true};
  }
  // Drop a PREPARED-only checkpoint (the live book was never touched): clears the pending record and the alias photos this plan owns.
  async function discardPrepared({planId}) {
    const snapshot=await capture(),p=snapshot.local?.pending;check();currentIdentity(snapshot);
    if(!p||p.planId!==planId||p.status!=='prepared'||snapshot.revision!==p.expectedRevision)throw error('STALE','This sync plan can no longer be discarded.');
    const aliases=new Set((p.photoAliases||[]).map(m=>m.alias)),owned=snapshot.records.receipts.filter(r=>aliases.has(r.id)&&r.syncPhoto?.planId===planId).map(r=>r.id),value={...snapshot.local,pending:null};
    budget(snapshot,value,localRow(snapshot)?.blob,null,[],owned);
    await db.writeAtomic({del:{receipts:owned},put:{kv:[{key:'offlineSync',value,...(localRow(snapshot)?.blob instanceof Blob?{blob:localRow(snapshot).blob}:{})}]},snapshotGuard:snapshot.guard,beforeWrite:check});onChange({kind:'sync-discard',planId});
    return {planId,discarded:true};
  }
  return {capture,identity,safetyBackup,savedSafetyCopy,prepare,stagePhotos,pendingPhotos,commit,acknowledge,discardPrepared};
}
