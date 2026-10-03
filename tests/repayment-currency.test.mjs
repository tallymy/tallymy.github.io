import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=process.env.TALLY_WEB_ROOT?resolve(process.env.TALLY_WEB_ROOT):fileURLToPath(new URL('../',import.meta.url));
const source=fs.readFileSync(resolve(root,'js/views/splitbill.js'),'utf8');
const engineRoot=process.env.TALLY_ENGINE_ROOT || fileURLToPath(new URL('../',import.meta.url));
const engine=await import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(resolve(engineRoot,'js/engine.js'),'utf8')).toString('base64'));
const body=source.slice(source.indexOf('export function repayRows('),source.indexOf('/** The debt and payments')).replace('export ','');
const context=vm.createContext({isFx:engine.isFx,validIso:engine.validIso,typedShift:()=>({}),uid:()=> 't',t:s=>s});
vm.runInContext(body+'\nglobalThis.repay=repayRows;',context);
const args={kind:'iowe',name:'Ali',amount:3000,total:3000,boxId:'owed',accountId:'bank',date:'2026-10-04',today:'2026-10-04',now:1,txs:[],note:'Treat'};
const accounts=[{id:'owed',kind:'iowe'},{id:'bank',kind:'bank'}];
test('RM repayment keeps equal RM legs in both directions and a partial/treat',()=>{
 const out=context.repay({...args,accounts});assert.equal(out.tx[0].amount,3000);assert.equal(out.tx[0].accountId,'bank');assert.equal(out.tx[0].toAccountId,'owed');
 const incoming=context.repay({...args,kind:'owedme',amount:1000,treat:true,accounts:[{...accounts[0],kind:'owedme'},accounts[1]]});assert.equal(incoming.tx.length,3);assert.equal(incoming.tx[0].amount,1000);assert.equal(incoming.tx[1].amount,2000);assert.equal(incoming.tx[2].amount,2000);
});
test('foreign payment accounts and foreign debt boxes fail closed without guessed exchange rates',()=>{
 for(const currency of ['SGD','USD']) {
  assert.throws(()=>context.repay({...args,accounts:[accounts[0],{...accounts[1],currency}]}),/Invalid repayment account/);
  assert.throws(()=>context.repay({...args,accounts:[{...accounts[0],currency},accounts[1]]}),/Invalid repayment account/);
 }
 assert.equal(context.repay({...args,accounts:[accounts[0],{...accounts[1],currency:'MYR'}]}).tx[0].amount,3000);
});
test('actual sheet restricts accounts to RM and provides a no-account explanation',()=>{
 const home=fs.readFileSync(resolve(root,'js/views/home.js'),'utf8');
 assert.match(home,/const accts = S\.accounts\.filter\(a => !owing\(a\) && !isFx\(a\)\)/);
 assert.match(home,/currency: 'MYR'/);assert.match(home,/if \(!accts\.length\).*Add an RM account/);
});
