import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./candidate/js/views/review.js',import.meta.url),'utf8').catch(()=>readFile(new URL('../js/views/review.js',import.meta.url),'utf8'));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setImmediate(r));};
function fixture({ready=true,native=true}={}){
 let gen='book-a',id=0,heldSave=null,heldWrite=null;const pending=[],events=[],photos=new Map(),kv={},ledger=[{id:'stored',receiptId:'user-photo'}];photos.set('user-photo',new Blob(['original']));
 const S={tx:ledger,accounts:[],kv:{bookGeneration:gen,settings:{}}};
 const context={console,Blob,Set,Map,Promise,structuredClone,performance,URL:{createObjectURL:()=>`blob:${++id}`,revokeObjectURL:()=>{}},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},
  S,bookGeneration:()=>gen,isNative:native,ocrSaved:()=>Promise.resolve(ready),ocrProgress(){},ocrReady:()=>ready,loadOcr:()=>{const d=deferred();pending.push({kind:'load',...d});return d.promise;},cancelOcr:()=>events.push('cancel'),
  readReceipt:(file,stage)=>{const d=deferred();pending.push({kind:'read',file,stage,...d});return d.promise;},
  savePhoto:async(key,blob,{generation})=>{if(heldSave){const d=heldSave;heldSave=null;await d.promise;}if(gen!==generation)return false;photos.set(key,blob);events.push('photo:'+key);return true;},
  db:{all:async()=>structuredClone(ledger),writeAtomic:async spec=>{if(heldWrite){const d=heldWrite;heldWrite=null;await d.promise;}spec.beforeWrite();assert.equal(spec.expected.kv[0].value.value,gen);for(const row of spec.put?.kv||[])kv[row.key]=row.value;for(const key of spec.del?.receipts||[])photos.delete(key);events.push('write');}},
  getPhoto:async k=>photos.get(k),setKv:async(k,v)=>{kv[k]=v;S.kv[k]=v;},deletePhotos:async keys=>keys.forEach(k=>photos.delete(k)),
  document:{addEventListener(){},querySelector:()=>true,getElementById:()=>null},location:{hash:'#/review'},render:()=>events.push('render'),go:path=>events.push('go:'+path),announce:x=>events.push('announce:'+x),toast:x=>events.push('toast:'+x),
  t:(s,...args)=>s.replace(/\{(\d+)\}/g,(_,i)=>args[i]),esc:x=>String(x??''),uid:k=>k+(++id),ICON:{},itemKey:x=>x,shopCategory:()=> 'other',categorize:()=> 'other',on:()=>false,defaultAccount:()=> 'cash',today:()=> '2026-10-04',nowTime:()=> '12:00',fmtRM:x=>String(x),reduced:()=>true};
 vm.createContext(context);vm.runInContext(source.replace(/^import .*;\r?$/gm,'').replace(/\bexport /g,'')+`;globalThis.api={enqueue,cancelReading,resetReview,pump,readAhead,reviewView,act,fixCorners,snapshot:()=>({current,queue:[...queue],reading}),setCurrent:p=>current=p,reread:p=>{rereadPrevious=p;current={...p,status:'reading'};reading=true;},persist,editExisting};`,context);
 return {api:context.api,context,S,photos,kv,pending,events,holdSave:()=>heldSave=deferred(),holdWrite:()=>heldWrite=deferred(),generation:()=>{gen='book-b';S.kv.bookGeneration=gen;context.api.resetReview();},result:{receipt:{items:[],total:100,merchant:'Owned fixture'},photo:new Blob(['decoded']),ms:10,tries:1}};
}
test('cancel all during model preparation suppresses late read/draft/navigation and fresh scan works',async()=>{
 const f=fixture({ready:false});await f.api.enqueue([new Blob(['a']),new Blob(['b'])]);assert.equal(f.pending[0].kind,'load');await f.api.cancelReading(true);const marker=f.events.length;f.pending[0].resolve();await flush();assert.equal(f.pending.length,1);assert.equal(f.api.snapshot().current,null);assert.equal(f.kv.reviewDraft,null);assert.ok(!f.events.slice(marker).some(x=>x.startsWith('go:')||x.startsWith('photo:')));assert.ok(f.photos.has('user-photo'));
 await f.api.enqueue([new Blob(['new'])]);assert.equal(f.pending.length,2);await f.api.cancelReading(true);
});
test('cancel this photo skips active read and starts next; stale result cannot replace next draft',async()=>{
 const f=fixture();await f.api.enqueue([new Blob(['a']),new Blob(['b'])]);await flush();const old=f.pending[0];await f.api.cancelReading(false);await flush();assert.equal(f.pending.length,2);old.resolve(f.result);await flush();assert.equal(f.api.snapshot().current.status,'reading');assert.equal(f.kv.reviewDraft,null);f.pending[1].resolve(f.result);await flush();assert.equal(f.api.snapshot().current.status,'ready');assert.equal(f.kv.reviewDraft.draft.total,100);
});
test('cancel after decoding while guarded photo write pending removes late orphan, preserves ledger and originals',async()=>{
 const f=fixture();await f.api.enqueue([new Blob(['a'])]);await flush();const save=f.holdSave();f.pending[0].resolve(f.result);await flush();await f.api.cancelReading(true);save.resolve();await flush();assert.deepEqual([...f.photos.keys()],['user-photo']);assert.equal(f.api.snapshot().current,null);assert.equal(f.kv.reviewDraft,null);assert.equal(f.S.tx.length,1);
});
test('cancel while encrypted draft commit pending blocks late metadata via beforeWrite',async()=>{
 const f=fixture();await f.api.enqueue([new Blob(['a'])]);await flush();const write=f.holdWrite();f.pending[0].resolve(f.result);await flush();await f.api.cancelReading(true);write.resolve();await flush();assert.equal(f.kv.reviewDraft,null);assert.equal(f.api.snapshot().current,null);assert.deepEqual([...f.photos.keys()],['user-photo']);
});
test('readAhead invalidated with cancel all, pending next result cannot survive cancellation',async()=>{
 const f=fixture();await f.api.enqueue([new Blob(['a']),new Blob(['b'])]);await flush();f.pending[0].resolve(f.result);await flush();assert.equal(f.pending.length,2);
 const saved=f.api.snapshot().current;f.api.reread(saved);await f.api.cancelReading(true);f.pending[1].resolve(f.result);await flush();assert.equal(f.api.snapshot().queue.length,0);assert.equal(f.api.snapshot().current.draft.receiptId,saved.draft.receiptId);assert.ok(f.photos.has(saved.draft.receiptId));assert.ok(f.photos.has('user-photo'));
});
test('restore generation invalidates active and late save without touching new-book photo collisions',async()=>{
 const f=fixture();await f.api.enqueue([new Blob(['a'])]);await flush();const save=f.holdSave();f.pending[0].resolve(f.result);await flush();f.generation();f.photos.set('new-book-photo',new Blob(['new']));save.resolve();await flush();assert.equal(f.api.snapshot().current,null);assert.ok(f.photos.has('new-book-photo'));assert.equal(f.kv.reviewDraft,undefined);
});
test('cancel reread keeps previous valid draft including edited lines, both scopes',async()=>{
 for(const all of [false,true]){const f=fixture();const previous={id:'existing',status:'ready',existing:true,draft:{receiptId:'user-photo',items:[{name:'Edited',cents:99}],total:99},thumb:'blob:old',base:f.S.tx[0]};f.api.reread(previous);await f.api.cancelReading(all);assert.equal(f.api.snapshot().current.draft,previous.draft);assert.equal(f.kv.reviewDraft.draft,previous.draft);assert.ok(f.photos.has('user-photo'));assert.ok(!f.events.includes('go:home'));}
});
test('late queue photo persistence cleans own copies after cancel, leaves original ledger untouched',async()=>{
 const f=fixture();const hold=f.holdSave();const enqueue=f.api.enqueue([new Blob(['a'])]);await flush();await f.api.cancelReading(true);hold.resolve();await enqueue;await flush();assert.deepEqual([...f.photos.keys()],['user-photo']);assert.equal(f.api.snapshot().queue.length,0);assert.equal(f.pending.length,0);
});
test('native starting screen never claims network download; both cancel actions visible',()=>{
 for(const native of [false,true]){const f=fixture({ready:false,native});f.api.reread({id:'x',draft:{receiptId:'user-photo'},status:'ready'});const html=f.api.reviewView.render();assert.ok(html.includes('rv-cancel-one')&&html.includes('rv-cancel-all'));assert.equal(html.includes('first time downloads'),!native);assert.equal(html.includes('Use Tally while it downloads'),!native);}
});
test('actual corner reread handler cancelled during photo write restores edited draft and deletes only new orphan',async()=>{
 const f=fixture(),handlers={},nodes=new Map();const g={drawImage(){},beginPath(){},moveTo(){},lineTo(){},closePath(){},stroke(){},arc(){},fill(){},fillText(){}};
 const canvas={style:{},setAttribute(){},getContext:()=>g,addEventListener:(event,fn)=>handlers[event]=fn};
 const sheet={querySelector:s=>{if(!nodes.has(s))nodes.set(s,{append(){},textContent:'',disabled:false});return nodes.get(s);},addEventListener:(_,fn)=>handlers.corner=fn};
 f.context.document.createElement=()=>canvas;f.context.Image=class{naturalWidth=10;naturalHeight=20;decode(){return Promise.resolve();}};f.context.confirmSheet=async()=>true;f.context.openSheet=()=>sheet;f.context.closeSheet=()=>{};f.context.validCorners=p=>p.length===4;
 const previous={id:'r-old',status:'ready',file:new Blob(['original']),thumb:'blob:original',draft:{receiptId:'user-photo',accountId:'cash',items:[{name:'Edited valid line',cents:99}],total:99}};f.api.setCurrent(previous);await f.api.fixCorners();
 for(let i=0;i<4;i++)handlers.keydown({key:'Enter',preventDefault(){}});
 const reading=handlers.corner({target:{closest:()=>({dataset:{corner:'read'}})}});await flush();assert.equal(f.api.snapshot().current.status,'reading');const hold=f.holdSave();f.pending[0].resolve(f.result);await flush();await f.api.cancelReading(true);hold.resolve();await reading;await flush();
 assert.equal(f.api.snapshot().current.draft,previous.draft);assert.equal(f.kv.reviewDraft.draft,previous.draft);assert.deepEqual([...f.photos.keys()],['user-photo']);assert.equal(f.S.tx[0].receiptId,'user-photo');
});
test('corner preparation decode cannot open a late sheet after review is reset',async()=>{
 const f=fixture(),decode=deferred();let sheets=0;f.context.confirmSheet=async()=>true;f.context.Image=class{decode(){return decode.promise;}};f.context.openSheet=()=>sheets++;
 f.api.setCurrent({id:'r-old',status:'ready',file:new Blob(['original']),thumb:'blob:original',draft:{receiptId:'user-photo'}});const preparing=f.api.fixCorners();await flush();f.api.resetReview();decode.resolve();await preparing;assert.equal(sheets,0);assert.ok(f.photos.has('user-photo'));
});
test('native bundled reader failures give restart guidance, browser retains truthful first-download recovery',async()=>{
 for(const native of [false,true]){const f=fixture({native});f.context.console={error(){}};await f.api.enqueue([new Blob(['owned'])]);await flush();f.pending[0].reject(new Error('model fetch load failed'));await flush();assert.equal(f.api.snapshot().current.status,'error');const copy=f.api.snapshot().current.error;assert.equal(copy.includes('downloads once'),!native);assert.equal(copy.includes('Close Tally and try again'),native);}
});
test('cancel one before first selected file persists preserves, persists and reads the second selected file',async()=>{
 const f=fixture(),hold=f.holdSave(),first=new Blob(['first']),second=new Blob(['second']);const enqueue=f.api.enqueue([first,second]);await flush();assert.equal(f.api.snapshot().queue.length,2);
 await f.api.cancelReading(false);await flush();assert.equal(f.pending.length,1);assert.equal(f.pending[0].file,second);hold.resolve();await enqueue;await flush();
 const current=f.api.snapshot().current;assert.equal(current.file,second);assert.ok(f.photos.has('q_'+current.id));assert.equal(f.kv.scanQueue.length,1);assert.equal(f.kv.scanQueue[0],current.id);assert.equal([...f.photos.keys()].filter(x=>x.startsWith('q_')).length,1);
 f.pending[0].resolve(f.result);await flush();assert.equal(f.api.snapshot().current.status,'ready');assert.equal(f.kv.reviewDraft.draft.total,100);assert.ok(f.photos.has('user-photo'));
});
test('cancel all and replacement while first batch persistence waits reject every remaining selected photo',async()=>{
 for(const replace of [false,true]){const f=fixture(),hold=f.holdSave();const enqueue=f.api.enqueue([new Blob(['first']),new Blob(['second'])]);await flush();if(replace)f.generation();else await f.api.cancelReading(true);hold.resolve();await enqueue;await flush();assert.equal(f.pending.length,0);assert.equal(f.api.snapshot().queue.length,0);assert.equal(f.api.snapshot().current,null);assert.ok(f.photos.has('user-photo'));assert.equal([...f.photos.keys()].filter(x=>x.startsWith('q_')).length,0);}
});
