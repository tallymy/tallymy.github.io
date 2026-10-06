// Regression for the real-phone first-sync drop: a data refresh (load) started by an earlier prepare/stage event was still reading the book when the commit switched
// the book generation. The refresh saw the NEW generation, the ownership check failed, and the host cancelled the session between the two durable commits.
import test from 'node:test';import assert from 'node:assert/strict';
import * as core from '../js/book-sync/sync-core.mjs';
import {createSyncHostRuntime,BOOT_SCHEMA} from '../js/book-sync/runtime.mjs';
import {createSyncRpc} from '../js/book-sync/sync-rpc.mjs';
import {createBookStore} from '../js/book-sync/book-store.mjs';
import {createSyncController} from '../js/book-sync/sync-controller.mjs';
import * as core2 from '../js/book-sync/sync-core.mjs';
function memoryDB(who){let revision=0;const tables={accounts:[{id:'cash',name:who,opening:0,typed:false,currency:'MYR'}],tx:[{id:'entry',date:'2026-10-04',amount:who==='computer'?600:900,type:'expense',accountId:'cash'}],recurring:[],receipts:[],kv:[{key:'settings',value:{PIN:`${who}-private`,lang:who==='phone'?'ta':'en',myName:who}},{key:'bookGeneration',value:`generation-${who}`}]};let writes=0,hook=null;
 return {tables,writes:()=>writes,setHook:f=>hook=f,edit:fn=>{fn(tables);revision++;},captureAtomicSnapshot:async()=>({records:structuredClone(tables),guard:revision}),writeAtomic:async({snapshotGuard,beforeWrite,clear=[],del={},put={}})=>{if(hook)await hook();beforeWrite?.();if(snapshotGuard!==revision)throw Object.assign(Error('stale'),{code:'STALE'});const next=structuredClone(tables);for(const k of clear)next[k]=[];for(const [k,ids]of Object.entries(del))next[k]=next[k].filter(r=>!ids.includes(r[k==='kv'?'key':'id']));for(const [k,rows]of Object.entries(put))for(const row of rows){const key=k==='kv'?'key':'id';const i=next[k].findIndex(r=>r[key]===row[key]);if(i<0)next[k].push(structuredClone(row));else next[k][i]=structuredClone(row);}beforeWrite?.();Object.assign(tables,next);revision++;writes++;}};
}
const codec={packRecovery:async({book,photos})=>new Blob([JSON.stringify({book,photos:await Promise.all([...photos].map(async([id,b])=>[id,b.type,[...new Uint8Array(await b.arrayBuffer())]]))})]),unpackRecovery:async b=>{const x=JSON.parse(await b.text());return {book:core2.validateBook(x.book),photos:new Map(x.photos.map(([id,type,bytes])=>[id,new Blob([new Uint8Array(bytes)],{type})]))};}};



const pause=()=>new Promise(r=>setTimeout(r,0));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await pause();}assert.fail('runtime did not reach expected state');}
async function fixture(options={}){const hosts={},pairs={},db={},docs={},windows={},generation={},locked={},watchers={},packets=[],changes=[],errors=[];let counter=0,ownedHook=null;
 for(const role of ['computer','phone']){db[role]=options.db?.[role]??memoryDB(role);generation[role]=db[role].tables.kv.find(r=>r.key==='bookGeneration')?.value??null;docs[role]=Object.assign(new EventTarget(),{hidden:false});windows[role]=new EventTarget();locked[role]=false;watchers[role]=new Set();
 const other=role==='computer'?'phone':'computer';
 const createPair=config=>{let approved=false,closed=false;const pair={config,host:async()=>config.onState({phase:'joining',address:'http://192.168.1.2:3456',pin:'123456',expiresAt:Date.now()+60000}),join:async()=>config.onState({phase:'approval',approvalCode:'12345678',expiresAt:Date.now()+60000}),approve:async()=>{pair.localApproved=true;if(pairs[other]?.localApproved){approved=true;pairs[other].setApproved();await config.onReady();await pairs[other].config.onReady();}},setApproved:()=>approved=true,authorized:()=>approved&&!closed&&config.allowed()===true,send:async value=>{if(closed)throw Error('closed');packets.push({role,value:structuredClone(value)});queueMicrotask(()=>Promise.resolve(pairs[other].config.receive(structuredClone(value))).catch(e=>errors.push(e)));},close:()=>{closed=true;},dispose:()=>{closed=true;}};pairs[role]=pair;return pair;};
 hosts[role]=createSyncHostRuntime({role,core,db:db[role],codec,verifyImage:async b=>({mime:b.type,width:1,height:1}),createPair,createRpc:createSyncRpc,createStore:args=>options.decorateStore?.(role,createBookStore(args))??createBookStore(args),createController:createSyncController,privacyLocked:()=>locked[role],onPrivacyChange:fn=>{watchers[role].add(fn);return()=>watchers[role].delete(fn);},getBookGeneration:()=>generation[role],onOwnedCommit:async e=>{assert.equal(e.expectedGeneration,generation[role]);assert.equal(e.actualGeneration,db[role].tables.kv.find(r=>r.key==='bookGeneration').value);if(ownedHook)await ownedHook(role,e);generation[role]=e.actualGeneration;changes.push(e);},onDataChange:e=>{changes.push(e);return options.onDataChange?.(role,e);},canonicalPhoneAddress:a=>{if(a!=='http://192.168.1.2:3456')throw Error('address');return a;},nativeService:options.nativeService??{available:()=>true,acquire:()=>({close:async()=>{}})},document:docs[role],window:windows[role],newIdentity:()=>`${role}-nonce-${++counter}`});}
 return {hosts,pairs,db,docs,windows,packets,changes,errors,generation,lock:r=>{locked[r]=true;for(const fn of watchers[r])fn(true);},ownedHook:f=>ownedHook=f,close:async()=>{await Promise.all(Object.values(hosts).map(h=>h.dispose()));}};
}
async function paired(f){await f.hosts.phone.requestPairing('start');await f.hosts.computer.requestPairing('start');await f.hosts.computer.requestPairing('connect',{address:'http://192.168.1.2:3456',code:'123456',rememberAddress:false});await f.hosts.computer.requestPairing('approve');await f.hosts.phone.requestPairing('approve');await until(()=>f.hosts.computer.getPairingView().sharing.canGrant&&f.hosts.phone.getPairingView().sharing.canGrant);}
async function shared(f){await paired(f);await f.hosts.computer.grantSharing();await f.hosts.phone.grantSharing();await until(()=>f.hosts.computer.controller()&&f.hosts.phone.controller());}

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('a slow data refresh started before the commit cannot overlap the generation switch (real-phone first-sync drop)',async()=>{
 let F;
 // phone-like timing: a refresh (state.load) takes 60 ms and reads the generation at its END; the commit's tail takes 120 ms after the durable write
 const f=await fixture({
  decorateStore:(role,s)=>role==='phone'?{...s,commit:async a=>{const r=await s.commit(a);await sleep(120);return r;}}:s,
  onDataChange:(role,e)=>role==='phone'?(async()=>{await sleep(60);F.generation.phone=F.db.phone.tables.kv.find(r=>r.key==='bookGeneration').value;})():undefined});
 F=f;
 try{await shared(f);const a=f.hosts.computer.controller(),b=f.hosts.phone.controller();await Promise.all([a.inspect(),b.inspect()]);a.choose('computer');b.choose('computer');await a.makeBackup();await b.makeBackup();await a.refreshPeer();await b.refreshPeer();const hash=a.state().planHash;await a.approve(hash);await b.approve(hash);
  await a.coordinate();
  assert.equal(a.state().bothConfirmed,true);assert.equal(b.state().bothConfirmed,true);assert.equal(f.db.phone.tables.tx[0].amount,600);assert.ok(f.hosts.phone.controller(),'phone session must survive the commit');
 }finally{await f.close();}
});
