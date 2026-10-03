import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=process.env.TALLY_WEB_ROOT?resolve(process.env.TALLY_WEB_ROOT):fileURLToPath(new URL('../',import.meta.url));
const source=await readFile(resolve(root,'js/engine.js'),'utf8');
const engine=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const home=await readFile(resolve(root,'js/views/home.js'),'utf8');
const owe=home.slice(home.indexOf('const repaymentStatus ='),home.indexOf('/** Paid back ('));
const debt=(name='Ali',amount=3000,extra={})=>({id:'d',type:'transfer',date:'2026-10-01',amount,accountId:'bank',toAccountId:'owed',owedBy:name,...extra});
const pay=(name='Ali',amount=1000,extra={})=>({id:'p',type:'transfer',date:'2026-10-02',amount,accountId:'owed',toAccountId:'cash',repaidBy:name,...extra});
function card(txs,hidden=false){const context=vm.createContext({S:{tx:txs},cached:(fn,arg)=>fn(arg),shareProgress:engine.shareProgress,fmtRM:engine.fmtRM,MASK:'MASK',
 t:(s,...args)=>s.replace(/\{(\d+)\}/g,(_,n)=>args[n]),esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),accName:id=>({cash:'Cash',bank:'Example bank',other:'<Other>'}[id]||'Unknown account')});
 vm.runInContext(owe+'\nglobalThis.result=oweCards('+hidden+');',context);return context.result;}

test('unpaid, partial and settled progression uses the existing remaining balance',()=>{
 const base=[debt()];assert.equal(engine.shareProgress(base).owedMe[0].status,'unpaid');
 const partial=[...base,pay()];const f=engine.shareProgress(partial).owedMe[0];assert.equal(f.status,'partial');assert.equal(f.sen,engine.openShares(partial).owedMe[0].sen);assert.equal(f.sen,2000);assert.deepEqual(f.repaymentAccounts,['cash']);
 const done=[...partial,pay('Ali',2000,{id:'p2'})];assert.equal(engine.openShares(done).owedMe.length,0);assert.equal(engine.shareProgress(done).owedMe[0].status,'settled');
});
test('outgoing repayments use their source account; same person in opposite directions is not netted',()=>{
 const tx=[debt(),{id:'myshare',type:'expense',amount:5000,date:'2026-10-01',accountId:'iowe',owedTo:'Ali'},
 {id:'repay',type:'transfer',amount:5000,date:'2026-10-02',accountId:'bank',toAccountId:'iowe',repaidTo:'Ali'}];
 const out=engine.shareProgress(tx);assert.equal(out.owedMe[0].sen,3000);assert.equal(out.iOwe[0].status,'settled');assert.deepEqual(out.iOwe[0].repaymentAccounts,['bank']);
});
test('multiple accounts and treat-clearing transfer legs are retained without treating expenses as repayments',()=>{
 const tx=[debt(),pay(),pay('Ali',2000,{id:'treat-transfer',toAccountId:'other'}),{id:'treat-expense',type:'expense',date:'2026-10-02',amount:2000,accountId:'other',merchant:'Ali',note:'My treat'}];
 const out=engine.shareProgress(tx).owedMe[0];assert.equal(out.status,'settled');assert.deepEqual(out.repaymentAccounts,['cash','other']);
 assert.match(card(tx),/Repayment account: Cash, &lt;Other>/);
});
test('orphan repayments do not resurrect deleted debt people; progress is aggregate rather than per bill',()=>{
 assert.deepEqual(engine.shareProgress([pay()]),{owedMe:[],iOwe:[]});
 const tx=[debt('Ali',1000),pay('Ali',1000),debt('Ali',2000,{id:'new',date:'2026-10-03'})];
 const f=engine.shareProgress(tx).owedMe[0];assert.equal(f.sen,2000);assert.equal(f.status,'partial');assert.equal(f.from,'bank');assert.equal(f.since,'2026-10-03');
});
test('actual Home markup shows status/remaining/account and a recording action; settled history has no pay button',()=>{
 const html=card([debt(),pay()]);assert.match(html,/Part paid/);assert.match(html,/remaining/);assert.match(html,/Repayment account: Cash/);assert.match(html,/Record repayment/);assert.match(html,/data-act="owe-back"/);
 const settled=card([debt(),pay('Ali',3000)]);assert.match(settled,/<details><summary>Settled \(1\)/);assert.doesNotMatch(settled,/data-act="owe-back"/);
});
test('hidden balances stay masked and ledger names are escaped',()=>{
 const tx=[debt('<Ali>',3000),pay('<Ali>',1000)];const html=card(tx,true);assert.match(html,/&lt;Ali>/);assert.match(html,/MASK remaining/);assert.doesNotMatch(html,/20\.00|30\.00|<Ali>/);
 const frozen=JSON.stringify(tx);engine.shareProgress(tx);assert.equal(JSON.stringify(tx),frozen);
});
test('all added localized messages preserve placeholders in five language dictionaries',async()=>{
 const keys=['Unpaid','Part paid','Settled','{0} remaining','Repayment account: {0}','Settled ({0})','Record repayment','Saved. {0} remaining.','Saved. Settled.'];
 for(const lang of ['ms','zh','zh-Hant','ja','ta']){const source=await readFile(resolve(root,'js/i18n',lang+'.js'),'utf8'),mod=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 for(const key of keys){assert.equal(typeof mod.default[key],'string',lang+':'+key);if(key.includes('{0}'))assert.ok(mod.default[key].includes('{0}'),lang+':'+key);}}
});
