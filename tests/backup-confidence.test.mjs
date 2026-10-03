import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import{readFile}from'node:fs/promises';
const setup=await readFile(new URL('../js/views/setup.js',import.meta.url),'utf8');
const source=setup.slice(setup.indexOf('function backupEvidence()'),setup.indexOf('// ---- actions',setup.indexOf('function backupEvidence()')));
const actions=setup.slice(setup.indexOf("  'bk-share': async"),setup.indexOf("  'joint-share':")).trim().replace(/,$/,'');
const fmt=(s,...a)=>s.replace(/\{(\d+)\}/g,(_,i)=>a[i]);
function harness({native=true,result={cancelled:false},fail=false,share=true}={}){
 const S={kv:{lastBackup:'2026-10-03T11:00',backupReceipt:{when:'2026-10-03T11:00'}},tx:[]},events=[],b={disabled:false,isConnected:true};
 const context=vm.createContext({S,isNative:native,bookGeneration:()=> 'bookA',today:()=> '2026-10-04',nowTime:()=> '12:00',fmtDate:s=>s,t:fmt,
 esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),ICON:{x:'',upload:''},firstWord:()=>null,
 $:()=>null,putAll:async ({kv})=>{events.push(['atomic',structuredClone(kv)]);Object.assign(S.kv,kv);},setKv:async(k,v)=>{S.kv[k]=v;},
 closeSheet:()=>events.push('close'),render:()=>events.push('render'),toast:m=>events.push(['toast',m]),migrationGuide(){},openSheet:html=>events.push(['sheet',html]),
 sealedBackup:async()=>({name:'tally-backup.zip',blob:new Blob(['backup']),missing:2,details:{transactions:12,photos:3,missing:2,protected:true,generation:'bookA'}}),
 shareFile:async()=>{if(fail)throw new DOMException('cancel','AbortError');return share;},download:async()=>{if(fail)throw Error('disk');return result;},warnMissingPhotos:n=>events.push(['missing',n]),Blob,DOMException});
 vm.runInContext(source+'\nvar act={'+actions+'};globalThis.api={act,backupEvidence,restoreHelp};',context);
 return{api:context.api,S,events,b};
}
test('native successful save atomically records evidence and exact generated contents',async()=>{
 const h=harness();await h.api.act['bk-save'](h.b);assert.equal(h.b.disabled,false);
 const kv=h.events.find(x=>x[0]==='atomic')[1];assert.equal(kv.lastBackup,kv.backupReceipt.when);assert.equal(kv.backupReceipt.kind,'native-save');assert.equal(kv.backupReceipt.photos,3);
 const html=h.api.backupEvidence();assert.match(html,/save confirmed/);assert.match(html,/12 entries and 3 receipt photos/);assert.match(html,/does not know its location/);assert.match(html,/2 receipt photos could not be included/);
});
test('native cancel/failure preserve both existing timestamp and evidence',async()=>{
 for(const options of [{result:{cancelled:true}},{fail:true},{result:null}]){const h=harness(options),old=structuredClone(h.S.kv);await h.api.act['bk-save'](h.b);assert.deepEqual(h.S.kv,old);assert.equal(h.b.disabled,false);}
});
test('browser download and share completion never claim confirmed disk or recipient save',async()=>{
 const browser=harness({native:false});await browser.api.act['bk-save'](browser.b);assert.match(browser.api.backupEvidence(),/download started/);assert.doesNotMatch(browser.api.backupEvidence(),/save confirmed/);
 const shared=harness();await shared.api.act['bk-share']();assert.equal(shared.S.kv.backupReceipt.kind,'share');assert.match(shared.api.backupEvidence(),/Check the file arrived/);
 const cancel=harness({fail:true});const old=structuredClone(cancel.S.kv);await cancel.api.act['bk-share']();assert.deepEqual(cancel.S.kv,old);
});
test('legacy timestamp and replaced book do not infer contents; suggested name is escaped',async()=>{
 const h=harness();assert.match(h.api.backupEvidence(),/backup or restore/);
 await h.api.act['bk-save'](h.b);h.S.kv.backupReceipt.name='<img src=x>';
 assert.match(h.api.backupEvidence(),/&lt;img/);h.S.kv.backupReceipt.generation='oldBook';assert.doesNotMatch(h.api.backupEvidence(),/Contents:/);
});
test('restore help is optional and contains actual picker action without writing the book',()=>{
 const h=harness();const old=structuredClone(h.S.kv);h.api.restoreHelp();assert.deepEqual(h.S.kv,old);
 const html=h.events.at(-1)[1];assert.match(html,/data-act="backup-help-pick"/);assert.match(html,/Cancel leaves it unchanged/);assert.match(html,/Merge \(keep both, recommended\) keeps both books/);
});
test('actual backup builder counts included photos and carries protection without storing its password',async()=>{
 const builders=setup.slice(setup.indexOf('async function backupBlob('),setup.indexOf('/** Ask for a protected backup'));
 const context=vm.createContext({S:{tx:[{receiptId:'one'},{receiptId:'missing'},{receiptId:'one'}],accounts:[],recurring:[],kv:{}},TextEncoder,Blob,Uint8Array,
 backupFile:()=>({name:'book.json',text:'{}',details:{transactions:4,generation:'bookA'}}),getPhoto:async id=>id==='one'?new Blob(['photo']):null,
 BACKUP_JSON:'backup.json',zipStore:files=>new Blob(files.map(x=>x.data)),backupFits:()=>true,overCap:()=>false,
 $:id=>id==='#bk-photos'?{checked:true}:id==='#bk-pass'?{value:'secret-123456'}:{},sealBackup:async()=>'{"protected":true}',t:fmt});
 vm.runInContext(builders+'\nglobalThis.api={sealedBackup,backupBlob};',context);
 const zip=await context.api.sealedBackup();assert.equal(zip.details.photos,1);assert.equal(zip.details.missing,1);assert.equal(zip.details.protected,true);assert.equal(zip.details.transactions,4);
 assert.doesNotMatch(JSON.stringify(zip.details),/secret/);
 const json=await context.api.backupBlob(false);assert.equal(json.details.photos,0);assert.equal(json.details.protected,false);
});
