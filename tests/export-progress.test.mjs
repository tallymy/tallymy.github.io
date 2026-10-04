import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
const source=await readFile(new URL('../js/views/setup.js',import.meta.url),'utf8');
const root=process.env.TALLY_WEB_ROOT||fileURLToPath(new URL('../',import.meta.url));
const io=await import(pathToFileURL(root+'/js/io.js'));
const body=source.slice(source.indexOf('async function backupBlob('),source.indexOf('/** Ask for a protected backup'));
function harness({photos={},pw='',cancelAt='',seal=io.sealBackup}={}) {
 const stages=[],controls=[{disabled:false,isConnected:true}],owner={busy:false,getAttribute(){return this.busy?'true':null;},querySelectorAll(){return controls;}},work={owner},fields={'#bk-pass':{value:pw,focus(){}},'#bk-photos':{checked:true},'#bk-err':{textContent:''}};
 let stopped=false,finished=0,started=0;
 const abort=()=>{throw Object.assign(Error('Cancelled'),{cancelled:true});};
 const context=vm.createContext({Blob,TextEncoder,Uint8Array,Set,S:{tx:[{receiptId:'one'},{receiptId:'one'},{receiptId:'missing'},{receiptId:'two'}],accounts:[],recurring:[],kv:{customCats:[]}},
  $:s=>fields[s],t:(key,...args)=>key.replace(/\{(\d)\}/g,(_,i)=>args[i]),document:{querySelectorAll:()=>[owner]},
  backupFile:()=>({name:'tally.json',text:'{"test":true}',details:{transactions:4}}),BACKUP_JSON:io.BACKUP_JSON,zipStore:io.zipStore,
  getPhoto:async id=>photos[id],backupFits:()=>true,overCap:()=>false,sealBackup:seal,
  beginBackupWork:()=>{started++;owner.busy=true;return work;},checkBackupWork:()=>{if(stopped)abort();},
  backupStage:async(w,k,...args)=>{if(stopped)abort();stages.push([k,...args]);await Promise.resolve();if(k===cancelAt){stopped=true;abort();}},
  finishBackupWork:()=>{finished++;owner.busy=false;}
 });
 vm.runInContext(body+';globalThis.api={backupBlob,sealedBackup};',context);
 return {api:context.api,stages,controls,owner,fields,stop:()=>{stopped=true;},counts:()=>({started,finished})};
}
test('actual photo collection counts unique links and missing photos; ZIP has valid bytes',async()=>{
 const h=harness({photos:{one:new Blob(['first']),two:new Blob(['second'])}}),r=await h.api.sealedBackup();
 assert.equal(r.missing,1);assert.equal(r.entries,3);assert.equal(r.details.photos,2);
 const zip=await io.unzip(await r.blob.arrayBuffer(),()=>true);assert.equal(new TextDecoder().decode(zip['photos/one.jpg']),'first');assert.equal(new TextDecoder().decode(zip['photos/two.jpg']),'second');
 assert.deepEqual(h.stages.map(x=>x[0]),['Preparing the backup…','Collecting receipt photos… {0} of {1}','Collecting receipt photos… {0} of {1}','Creating the backup ZIP…','Backup file ready.']);
 assert.deepEqual(h.stages[1].slice(1),[0,3]);assert.deepEqual(h.stages[2].slice(1),[3,3]);assert.deepEqual(h.counts(),{started:1,finished:1});assert.equal(h.controls[0].disabled,false);
});
test('photo preparation cancellation prevents ZIP and file handoff and clears busy',async()=>{
 const h=harness({cancelAt:'Collecting receipt photos… {0} of {1}'});assert.equal(await h.api.sealedBackup(),null);assert.equal(h.owner.busy,false);assert.equal(h.controls[0].disabled,false);assert.ok(!h.stages.some(x=>x[0]==='Creating the backup ZIP…'));
});
test('existing real password format still decrypts and cancellation after sealing prevents handoff',async()=>{
 const h=harness({pw:'long-password',photos:{one:new Blob(['photo'])}}),r=await h.api.sealedBackup();assert.equal(r.name,'tally.locked.json');assert.equal(r.details.protected,true);
 const clear=await io.openBackup(await r.blob.text(),'long-password'),zip=await io.unzip(clear.buffer.slice(clear.byteOffset,clear.byteOffset+clear.byteLength),()=>true);assert.ok(zip['photos/one.jpg']);assert.ok(h.stages.some(x=>x[0]==='Protecting the backup with your password…'));
 let cancelled;const c=harness({pw:'long-password',seal:async()=>{cancelled.stop();return 'sealed';}});cancelled=c;assert.equal(await c.api.sealedBackup(),null);assert.equal(c.owner.busy,false);assert.equal(c.controls[0].disabled,false);
});
test('short password fails before heavy work; concurrent preparation cannot start twice',async()=>{
 const h=harness({pw:'short'});assert.equal(await h.api.sealedBackup(),null);assert.deepEqual(h.counts(),{started:0,finished:0});assert.match(h.fields['#bk-err'].textContent,/10/);
 const c=harness();c.owner.busy=true;assert.equal(await c.api.sealedBackup(),null);assert.deepEqual(c.counts(),{started:0,finished:0});
});
test('unexpected photo or encryption failure restores controls and clears busy',async()=>{
 const h=harness({pw:'long-password',seal:async()=>{throw Error('storage failed');}});await assert.rejects(h.api.sealedBackup(),/storage failed/);assert.equal(h.owner.busy,false);assert.equal(h.controls[0].disabled,false);
});
