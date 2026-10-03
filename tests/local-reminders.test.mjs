import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile, mkdtemp, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

// Defaults are relative to this file after installation in repository tests/.
const webRoot=process.env.TALLY_WEB_ROOT?resolve(process.env.TALLY_WEB_ROOT):fileURLToPath(new URL('../',import.meta.url));
const androidRoot=process.env.TALLY_ANDROID_ROOT?resolve(process.env.TALLY_ANDROID_ROOT):resolve(webRoot,'android-wrapper');
const javaRoot=resolve(androidRoot,'android/app/src/main/java/io/github/tallymy');
const read=p=>readFile(resolve(webRoot,p),'utf8').then(s=>s.replace(/\r\n/g,'\n'));
const readJava=name=>readFile(resolve(javaRoot,name),'utf8');
const nativeSource=await read('js/native.js'), stateSource=await read('js/state.js');
const clean=s=>s.replace(/^import .*;\n/gm,'').replace(/\bexport /g,'');
function bridge(native, plugin) {
 const context=vm.createContext({globalThis:null,Promise,URL,document:{addEventListener(){}},window:{open(){}},navigator:{},Capacitor:{isNativePlatform:()=>native,Plugins:{TallyReminders:plugin,App:{addListener(){}}}}});
 context.globalThis=context;
 vm.runInContext(clean(nativeSource)+'\nglobalThis.api={reminderStatus,configureReminder,mirrorReminderDay};',context);
 return context.api;
}
test('browser and old native plugin remain unsupported, with no permission or storage call',async()=>{
 for(const api of [bridge(false,{}),bridge(true,undefined)]){
  assert.equal((await api.reminderStatus()).supported,false);
  assert.equal((await api.configureReminder({enabled:true,time:'21:00'})).supported,false);
  assert.equal((await api.mirrorReminderDay({day:'2026-10-04',logged:false})).supported,false);
 }
});
test('bridge serializes marker before enable and passes only bounded date-level fields',async()=>{
 const calls=[];let release;const wait=new Promise(r=>release=r);
 const api=bridge(true,{mirrorReminderDay:async p=>{calls.push(['mirror',p]);await wait;return {supported:true};},configureReminder:async p=>{calls.push(['configure',p]);return {enabled:false,permission:'denied'};}});
 const mirror=api.mirrorReminderDay({day:'2026-10-04',logged:true,eligible:true,lang:'ms',amount:999,accounts:['private']});
 const enable=api.configureReminder({enabled:true,time:'22:10'});
 await Promise.resolve();assert.equal(calls.length,1);release();await mirror;
 assert.equal((await enable).enabled,false);
 assert.deepEqual(Object.keys(calls[0][1]).sort(),['day','eligible','lang','logged']);
 assert.equal(calls[1][1].time,'22:10');
});
test('failed native marker disables reminder without rejecting a committed book write',async()=>{
 const calls=[];const api=bridge(true,{mirrorReminderDay:async()=>{throw Error('disk full');},configureReminder:async p=>calls.push(p)});
 assert.equal((await api.mirrorReminderDay({day:'2026-10-04',logged:true})).error,true);
 assert.equal(calls[0].enabled,false);
});
function stateHarness(){
 const records={accounts:[{id:'cash',kind:'cash',scope:'me'}],tx:[],recurring:[],kv:[{key:'settings',value:{lang:'ms'}}]},markers=[];
 let fail=false;
 const db={init:async()=> 'indexeddb',getKv:async(k,d)=>records.kv.find(x=>x.key===k)?.value??d,getKey:()=>null,keyMatches:()=>true,expectSealed(){},
 all:async s=>structuredClone(records[s]),put:async(s,x)=>{if(fail)throw Error('disk');records[s]=[...records[s].filter(y=>y.id!==x.id),x];},
 putMany:async(s,xs)=>{if(fail)throw Error('disk');for(const x of xs)await db.put(s,x);},delMany:async(s,ids)=>{if(fail)throw Error('disk');records[s]=records[s].filter(x=>!ids.includes(x.id));},
 setKv:async(k,value)=>{records.kv=[...records.kv.filter(x=>x.key!==k),{key:k,value}];},writeAtomic:async({clear=[],put={},del={}})=>{if(fail)throw Error('disk');for(const s of clear)records[s]=[];for(const [s,ids]of Object.entries(del))records[s]=records[s].filter(x=>!ids.includes(s==='kv'?x.key:x.id));for(const [s,rows]of Object.entries(put))for(const x of rows){const key=s==='kv'?'key':'id';records[s]=[...records[s].filter(y=>y[key]!==x[key]),x];}},
 del:async(s,id)=>db.delMany(s,[id]),storageMode(){return'indexeddb';},onRemoteChange(){},onSaveFailed(){},setKey(){},wipe:async()=>{for(const s of Object.keys(records))records[s]=[];}};
 const context=vm.createContext({db,isNative:true,mirrorReminderDay:async p=>markers.push(p),URLSearchParams,location:{hostname:'localhost',search:'?today=2026-10-04'},Date,Map,WeakMap,Set,Event,document:{documentElement:{lang:'en'},dispatchEvent(){}},
 ownCategories(){},movedCategories(){},isFx:()=>false,owing:()=>false,CATEGORIES:[],INCOME_CATEGORIES:[],CAPS:{},CAT_CODE:{},keepReceiptUntil:()=>false});
 vm.runInContext(clean(stateSource)+'\nglobalThis.api={S,load,saveTx,saveTxs,deleteTxs,saveAccount,deleteAccount,replaceAll,addAll,putAll,setSetting,syncReminderDay};',context);
 return{api:context.api,markers,records,fail:()=>fail=true};
}
const expense=(id='e',date='2026-10-04',extra={})=>({id,accountId:'cash',date,type:'expense',amount:100,...extra});
test('single/batch saves, delete/undo, PC atomic edits, import and restore mirror committed state',async()=>{
 const h=stateHarness(),a=h.api;await a.load();assert.equal(h.markers.at(-1).logged,false);
 await a.saveTx(expense());assert.equal(h.markers.at(-1).logged,true);
 const undo=await a.deleteTxs(['e']);assert.equal(h.markers.at(-1).logged,false);
 await undo();assert.equal(h.markers.at(-1).logged,true);
 await a.replaceAll({accounts:[{id:'cash',kind:'cash'}],tx:[expense('future','2026-10-05')],recurring:[],kv:{settings:{lang:'ja'}}});assert.equal(h.markers.at(-1).logged,false);
 await a.putAll({tx:[expense('pc')]});assert.equal(h.markers.at(-1).logged,true);
 await a.addAll({accounts:[],tx:[expense('imported')],recurring:[],kv:{}});assert.equal(h.markers.at(-1).logged,true);
 await a.saveTxs([expense('past','2026-10-03')]);assert.equal(h.markers.at(-1).logged,true);
 await a.setSetting('lang','ta');assert.equal(h.markers.at(-1).lang,'ta');
});
test('income/transfer/sample rows do not count; sample book pauses; encrypted locked load retains marker',async()=>{
 const h=stateHarness(),a=h.api;await a.load();
 await a.saveTxs([expense('income',undefined,{type:'income'}),expense('transfer',undefined,{type:'transfer'}),expense('sample',undefined,{sample:true})]);assert.equal(h.markers.at(-1).logged,false);
 await a.setSetting('sample',true);assert.equal(h.markers.at(-1).eligible,false);
 await a.setSetting('lock',{enc:{}});const n=h.markers.length;await a.load();assert.equal(h.markers.length,n);
});
test('failed book commit produces no new marker',async()=>{
 const h=stateHarness();await h.api.load();const n=h.markers.length;h.fail();await assert.rejects(h.api.saveTx(expense()),/disk/);assert.equal(h.markers.length,n);
});
test('account creation/deletion update reminder eligibility without expense data',async()=>{
 const h=stateHarness(),a=h.api;await a.load();assert.equal(h.markers.at(-1).eligible,true);
 await a.deleteAccount('cash');assert.equal(h.markers.at(-1).eligible,false);
 await a.saveAccount({id:'new',kind:'cash'});assert.equal(h.markers.at(-1).eligible,true);assert.equal(h.markers.at(-1).logged,false);
 assert.deepEqual(Object.keys(h.markers.at(-1)).sort(),['day','eligible','lang','logged']);
});
test('actual Settings helpers keep permission denial off and offer disable after revocation',async()=>{
 const setup=await read('js/views/setup.js');
 const code=setup.slice(setup.indexOf('async function updateLocalReminder('),setup.indexOf('export const settingsView ='));
 const status={isConnected:true,textContent:''},time={value:'22:15'},enable={},disable={},calls=[],toasts=[];
 const nodes={'#local-remind-status':status,'#local-remind-at':time,'[data-act="local-remind-enable"]':enable,'[data-act="local-remind-disable"]':disable};
 const context=vm.createContext({$:key=>nodes[key],$$:()=>[enable,disable],settings:()=>({}),t:s=>s,
 reminderStatus:async()=>({supported:true,enabled:false,configured:true,permission:'denied',time:'22:15'}),
 syncReminderDay:async()=>calls.push('mirror'),configureReminder:async p=>{calls.push(p);return {supported:true,enabled:false,configured:false,permission:'denied',time:p.time};},toast:message=>toasts.push(message)});
 vm.runInContext(code+'\nglobalThis.api={updateLocalReminder,changeLocalReminder};',context);
 await context.api.updateLocalReminder();assert.equal(disable.disabled,false,'revoked permission does not prevent cancellation');
 await context.api.changeLocalReminder(true);assert.equal(calls[0],'mirror');assert.equal(calls[1].enabled,true);
 assert.match(status.textContent,/Notifications are off/);assert.equal(disable.disabled,true);assert.match(toasts[0],/not enabled/);
 await context.api.changeLocalReminder(false);assert.equal(calls.at(-1).enabled,false);
});
test('actual Java clock handles enable-after-time, midnight, zone change, DST and deduplication',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tally-reminder-clock-'));
 const source=await readJava('TallyReminderClock.java');await writeFile(join(dir,'TallyReminderClock.java'),source);
 await writeFile(join(dir,'ClockTest.java'),`package io.github.tallymy;
 import java.util.*;import java.time.*;
 public class ClockTest {static void ok(boolean x){if(!x)throw new AssertionError();}static long at(String s){return Instant.parse(s).toEpochMilli();}
 public static void main(String[]args){TimeZone my=TimeZone.getTimeZone("Asia/Kuala_Lumpur"),ny=TimeZone.getTimeZone("America/New_York");int minute=TallyReminderClock.minute("21:00");
 for(String bad:new String[]{"24:00","9:00","21:60","",null}){try{TallyReminderClock.minute(bad);throw new AssertionError();}catch(IllegalArgumentException expected){}}
 long now=at("2026-10-04T14:00:00Z");ok(TallyReminderClock.day(TallyReminderClock.next(now,minute,my),my).equals("2026-10-05"));
 ok(TallyReminderClock.due(now,minute,my,"2026-10-04","2026-10-03","2026-10-03",""));
 ok(!TallyReminderClock.due(now,minute,my,"2026-10-04","2026-10-04","2026-10-04",""));
 ok(!TallyReminderClock.due(now,minute,my,"2026-10-04","2026-10-04","","2026-10-04"));
 ok(!TallyReminderClock.due(now,minute,my,"2026-10-03","2026-10-03","",""));
 ok(!TallyReminderClock.due(now,minute,my,"2026-10-04","","",""));
 ok(TallyReminderClock.day(at("2026-10-04T17:00:00Z"),my).equals("2026-10-05"));
 ok(TallyReminderClock.day(at("2026-10-04T17:00:00Z"),ny).equals("2026-10-04"));
 long spring=at("2026-03-08T05:00:00Z");ok(TallyReminderClock.next(spring,150,ny)>spring);
 ok(TallyReminderClock.next(at("2026-03-08T07:45:00Z"),150,ny)==at("2026-03-09T06:30:00Z"));
 long fall=at("2026-11-01T04:00:00Z");ok(TallyReminderClock.next(fall,90,ny)>fall);
 System.out.println("clock edge cases passed");}}
 `);
 const home=process.env.JAVA_HOME,tool=name=>home?join(home,'bin',name+(process.platform==='win32'?'.exe':'')):name;
 execFileSync(tool('javac'),['-d',dir,join(dir,'TallyReminderClock.java'),join(dir,'ClockTest.java')],{timeout:20000});
 assert.match(execFileSync(tool('java'),['-cp',dir,'io.github.tallymy.ClockTest'],{timeout:10000}).toString(),/passed/);
});
