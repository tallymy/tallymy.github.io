// Read-only complete-book pull over an already approved, consented paired RPC channel.
export const TRANSFER_SCHEMA = 'tally.book-pull/1';
export const TRANSFER_LIMITS = Object.freeze({chunk:128*1024,book:16*1024*1024,photo:40*1024*1024,photos:200*1024*1024,requests:4096,headroom:64});
const L=TRANSFER_LIMITS, enc=new TextEncoder(), SHA=/^[a-f0-9]{64}$/, ID=/^[A-Za-z0-9_-]{1,128}$/;
const fail=code=>{throw Object.assign(new Error(`Book transfer: ${code}`),{code});};
const plain=v=>v&&Object.getPrototypeOf(v)===Object.prototype;
const opaque=v=>typeof v==='string'&&ID.test(v)&&!['constructor','prototype','__proto__'].includes(v);
function exact(v,keys){if(!plain(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))fail('SCHEMA');}
function budget(fn){const n=fn();if(!Number.isInteger(n)||n<0||n>L.requests)fail('BOUNDS');return n;}
function countChunks(bytes){return Math.ceil(bytes/L.chunk);}
function identity(v){exact(v,['bookId','deviceId','baseRevision']);if(!opaque(v.bookId)||!opaque(v.deviceId)||(v.baseRevision!==null&&(typeof v.baseRevision!=='string'||!SHA.test(v.baseRevision))))fail('SCHEMA');return {...v};}
// Count before cloning/canonicalizing a provider book; no aggregate JSON/string allocation.
function jsonPreflight(value){let n=0;const seen=new Set();const add=x=>{n+=x;if(n>L.book)fail('BOUNDS');};
  function visit(v,d=0){if(d>24)fail('BOUNDS');if(v===null||typeof v==='boolean'||typeof v==='number'){if(typeof v==='number'&&!Number.isFinite(v))fail('SCHEMA');add(JSON.stringify(v).length);return;}
    if(typeof v==='string'){if(v.length>100000)fail('BOUNDS');add(enc.encode(JSON.stringify(v)).length);return;}
    if(!v||(!Array.isArray(v)&&!plain(v))||seen.has(v))fail('SCHEMA');seen.add(v);add(2);const keys=Object.keys(v);if(keys.length>(Array.isArray(v)?200000:10000))fail('BOUNDS');
    if(Array.isArray(v)){for(let i=0;i<v.length;i++){if(i)add(1);visit(v[i],d+1);}}
    else for(const k of keys){if(v[k]===undefined)continue;if(['__proto__','constructor','prototype'].includes(k))fail('SCHEMA');add(enc.encode(JSON.stringify(k)).length+2);visit(v[k],d+1);}
    seen.delete(v);
  }visit(value);return n;
}
function layout(book,photos,bookBytes){let photoBytes=0,totalChunks=countChunks(bookBytes);const files=[{id:null,bytes:bookBytes,start:0,chunks:totalChunks}];
  const used=new Set(book.tx.map(t=>t.receiptId).filter(Boolean));
  for(const m of book.receipts){if(!used.has(m.id))fail('RECEIPTS');const blob=photos?.get(m.id);if(!(blob instanceof Blob)||blob.size!==m.bytes||blob.type!==m.mime||m.bytes<1||m.bytes>L.photo)fail('RECEIPTS');
    photoBytes+=m.bytes;if(photoBytes>L.photos)fail('BOUNDS');const chunks=countChunks(m.bytes);files.push({id:m.id,bytes:m.bytes,start:totalChunks,chunks,blob,manifest:m});totalChunks+=chunks;
    if(totalChunks+2>L.requests-L.headroom)fail('BOUNDS');
  }return {files,photoBytes,totalChunks};
}
function base64(bytes){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);}
function decode(s){if(typeof s!=='string'||s.length>Math.ceil(L.chunk/3)*4||s.length%4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s))fail('SCHEMA');const raw=atob(s),b=Uint8Array.from(raw,c=>c.charCodeAt(0));if(base64(b)!==s)fail('SCHEMA');return b;}
export function createBookTransferService({store,core,authorized,sessionId,remainingRequests,newIdentity=()=>crypto.randomUUID(),now=()=>Date.now(),ttlMs=120000}){
  if(!store||typeof store.identity!=='function'||!core||typeof authorized!=='function'||typeof remainingRequests!=='function'||!opaque(sessionId)||!Number.isInteger(ttlMs)||ttlMs<1000||ttlMs>300000)fail('SCHEMA');
  let held=null,busy=false,closed=false,epoch=0,timer=null;
  function drop(){held=null;epoch++;clearTimeout(timer);timer=null;}
  function close(){closed=true;drop();}
  function check(e=epoch){let allowed=false;try{allowed=authorized()===true;}catch{}if(closed||!allowed){close();fail('CANCELLED');}if(e!==epoch)fail('STALE');if(held&&now()>=held.deadline){drop();fail('STALE');}}
  function envelope(args,keys){exact(args,['schema','session',...keys]);if(args.schema!==TRANSFER_SCHEMA||args.session!==sessionId)fail('SCHEMA');}
  async function handle(method,args){check();
    if(method==='book_pull_release'){envelope(args,['transferId']);if(!opaque(args.transferId))fail('SCHEMA');if(!held||held.id!==args.transferId)fail('STALE');drop();return {schema:TRANSFER_SCHEMA,session:sessionId,transferId:args.transferId,released:true};}
    if(method==='book_pull_open'){
      envelope(args,[]);if(busy)fail('BUSY');if(held)drop(); /* one peer, stop-and-wait: a new open means the last pull was abandoned (a lost release would otherwise hold BUSY until the TTL) */ if(budget(remainingRequests)<L.headroom+2)fail('BOUNDS');busy=true;const e=epoch,deadline=now()+ttlMs;
      timer=setTimeout(()=>drop(),ttlMs);timer.unref?.();
      try{const snapshot=await store.identity();check(e);const local=snapshot.local,captureRevision=snapshot.revision;if(!local||local.generation!==snapshot.generation)fail('STALE');
        const exportedIdentity=identity({bookId:local.bookId,deviceId:local.deviceId,baseRevision:local.baseRevision});
        jsonPreflight(snapshot.book);const book=core.validateBook(snapshot.book),bookBytes=enc.encode(core.canonical(book));if(bookBytes.length<1||bookBytes.length>L.book)fail('BOUNDS');
        const plan=layout(book,snapshot.photos,bookBytes.length);if(plan.totalChunks+1+L.headroom>budget(remainingRequests))fail('BOUNDS');
        const revision=await core.sha256(bookBytes);check(e);if(revision!==captureRevision)fail('HASH');
        // Recheck immutable Blob provenance; one bounded photo buffer at a time, never all photos.
        for(const f of plan.files.slice(1)){check(e);const bytes=new Uint8Array(await f.blob.arrayBuffer());check(e);if(await core.sha256(bytes)!==f.manifest.sha256)fail('HASH');check(e);}
        const expiresInMs=Math.floor(deadline-now());if(expiresInMs<1000)fail('STALE');const id=newIdentity();if(!opaque(id))fail('SCHEMA');held={id,bookBytes,...plan,identity:exportedIdentity,revision,last:null,next:0,deadline};
        return {schema:TRANSFER_SCHEMA,session:sessionId,transferId:id,identity:{...exportedIdentity},revision,bookBytes:bookBytes.length,bookChunks:countChunks(bookBytes.length),totalChunks:plan.totalChunks,photoBytes:plan.photoBytes,photoCount:book.receipts.length,expiresInMs};
      }catch(error){drop();throw error;}finally{busy=false;}
    }
    if(method!=='book_pull_chunk')fail('METHOD');envelope(args,['transferId','index']);if(!opaque(args.transferId)||!Number.isInteger(args.index))fail('SCHEMA');
    if(!held||held.id!==args.transferId)fail('STALE');if(busy)fail('BUSY');if(budget(remainingRequests)<=L.headroom)fail('BOUNDS');
    if(held.last&&args.index===held.last.index)return {...held.last};
    if(args.index!==held.next||args.index<0||args.index>=held.totalChunks)fail('REPLAY');busy=true;const e=epoch,h=held;
    try{const f=h.files.find(f=>args.index>=f.start&&args.index<f.start+f.chunks),offset=(args.index-f.start)*L.chunk;
      const bytes=f.id===null?h.bookBytes.subarray(offset,Math.min(offset+L.chunk,f.bytes)):new Uint8Array(await f.blob.slice(offset,offset+L.chunk).arrayBuffer());check(e);
      if(bytes.length!==Math.min(L.chunk,f.bytes-offset))fail('BOUNDS');const sha256=await core.sha256(bytes);check(e);const reply={schema:TRANSFER_SCHEMA,session:sessionId,transferId:h.id,index:args.index,receiptId:f.id,offset,totalBytes:f.bytes,data:base64(bytes),sha256};
      if(enc.encode(JSON.stringify(reply)).length>=256*1024)fail('BOUNDS');h.last=Object.freeze(reply);h.next++;return {...reply};
    }finally{busy=false;}
  }
  return Object.freeze({handle,close});
}
// Receiver returns data only. Host must decode images and enforce its atomic book-choice/backup gates.
export async function pullBook({request,core,authorized,sessionId,remainingRequests,onProgress=()=>{},now=()=>Date.now()}){
  if(typeof request!=='function'||typeof authorized!=='function'||typeof remainingRequests!=='function'||typeof now!=='function'||!opaque(sessionId))fail('SCHEMA');
  let deadline=now()+300000;const check=()=>{let allowed=false;try{allowed=authorized()===true;}catch{}if(!allowed)fail('CANCELLED');if(now()>=deadline)fail('TIMEOUT');};let open=null;
  const args=extra=>({schema:TRANSFER_SCHEMA,session:sessionId,...extra});
  async function receive(index,id,offset,totalBytes){check();const f=await request('book_pull_chunk',args({transferId:open.transferId,index}));check();exact(f,['schema','session','transferId','index','receiptId','offset','totalBytes','data','sha256']);
    if(f.schema!==TRANSFER_SCHEMA||f.session!==sessionId||f.transferId!==open.transferId||f.index!==index||f.receiptId!==id||f.offset!==offset||f.totalBytes!==totalBytes||typeof f.sha256!=='string'||!SHA.test(f.sha256))fail('SCHEMA');
    const b=decode(f.data);if(b.length!==Math.min(L.chunk,totalBytes-offset))fail('BOUNDS');if(await core.sha256(b)!==f.sha256)fail('HASH');check();onProgress({receivedChunks:index+1,totalChunks:open.totalChunks});return b;
  }
  try{check();if(budget(remainingRequests)<L.headroom+2)fail('BOUNDS');open=await request('book_pull_open',args({}));check();
    exact(open,['schema','session','transferId','identity','revision','bookBytes','bookChunks','totalChunks','photoBytes','photoCount','expiresInMs']);
    if(open.schema!==TRANSFER_SCHEMA||open.session!==sessionId||!opaque(open.transferId)||typeof open.revision!=='string'||!SHA.test(open.revision))fail('SCHEMA');identity(open.identity);
    for(const k of ['bookBytes','bookChunks','totalChunks','photoBytes','photoCount','expiresInMs'])if(!Number.isSafeInteger(open[k])||open[k]<0)fail('BOUNDS');
    if(open.bookBytes<1||open.bookBytes>L.book||open.bookChunks!==countChunks(open.bookBytes)||open.totalChunks<open.bookChunks||open.totalChunks+2>L.requests-L.headroom||open.photoBytes>L.photos||open.photoCount>open.totalChunks-open.bookChunks||open.expiresInMs<1000||open.expiresInMs>300000||open.totalChunks+1+L.headroom>budget(remainingRequests))fail('BOUNDS');
    deadline=Math.min(deadline,now()+open.expiresInMs);check();const bytes=new Uint8Array(open.bookBytes);let index=0;for(let offset=0;offset<bytes.length;offset+=L.chunk)bytes.set(await receive(index++,null,offset,bytes.length),offset);
    if(await core.sha256(bytes)!==open.revision)fail('HASH');check();let book;try{book=core.validateBook(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}catch(e){fail(e.code||'SCHEMA');}
    if(core.canonical(book)!==new TextDecoder().decode(bytes))fail('SCHEMA');const photos=new Map();
    const used=new Set(book.tx.map(t=>t.receiptId).filter(Boolean));let total=0,chunks=open.bookChunks;
    for(const m of book.receipts){if(!used.has(m.id)||m.bytes>L.photo)fail('RECEIPTS');total+=m.bytes;chunks+=countChunks(m.bytes);if(total>L.photos||chunks>open.totalChunks)fail('BOUNDS');}
    if(total!==open.photoBytes||chunks!==open.totalChunks||book.receipts.length!==open.photoCount)fail('SCHEMA');
    for(const m of book.receipts){const parts=[];for(let offset=0;offset<m.bytes;offset+=L.chunk)parts.push(await receive(index++,m.id,offset,m.bytes));const blob=new Blob(parts,{type:m.mime});const b=new Uint8Array(await blob.arrayBuffer());if(await core.sha256(b)!==m.sha256)fail('HASH');check();photos.set(m.id,blob);}
    check();return {book,revision:open.revision,identity:identity(open.identity),photos};
  }finally{if(open&&opaque(open.transferId)){try{await request('book_pull_release',args({transferId:open.transferId}));}catch{ /* Channel lock/close also releases the sender; TTL is the final bound. */ }}}
}
