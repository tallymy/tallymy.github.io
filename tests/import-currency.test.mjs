import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parseCSV,headerRow,guessMapping,currencyReview,rowCurrency,rowsToTx,openingFromBalance,splitDups} from '../js/io.js';
import {detectPreset} from '../js/presets.js';
const setup=await readFile(new URL('../js/views/setup.js',import.meta.url),'utf8');
const owned=await readFile(new URL('./fixtures/expense-manager-unlabelled-owned.csv',import.meta.url),'utf8');
const parsed=parseCSV(owned),h=headerRow(parsed),header=parsed[h],rows=parsed.slice(h+1),map=guessMapping(header);
const convert=(body=rows,mapping=map,head=header,extra={})=>rowsToTx(body,mapping,{header:head,strictCurrency:true,accountId:'cash',accounts:{'personal expense':'personal'},...extra});
test('Actual owned Expense Manager USD export has no currency; Account wins over earlier Payment Method',()=>{
 assert.equal(header[map.account],'Account');assert.equal(map.account,10);
 assert.deepEqual(currencyReview(rows,map,{header}),{myr:0,unknown:1,other:0});
 const r=convert();assert.equal(r.txs.length,0);assert.equal(Object.keys(r.opening).length,0);assert.equal(r.skipped[0].why,'currency-unconfirmed');
});
test('Explicit human MYR choice enables only unlabelled MYR rows; OTHER leaves them out',()=>{
 const r=convert(rows,map,header,{sourceCurrency:'MYR'});assert.equal(r.txs.length,1);assert.equal(r.txs[0].amount,600);assert.equal(r.txs[0].accountId,'personal');
 assert.equal(convert(rows,map,header,{sourceCurrency:'OTHER'}).txs.length,0);
});
test('Mixed blank/MYR/USD/unknown codes cannot use MYR evidence from another row',()=>{
 const hd=['Date','Amount','Currency'],m=guessMapping(hd),rs=[['2026-10-04','5','MYR'],['2026-10-04','6',''],['2026-10-04','7','USD'],['2026-10-04','8','XYZ']];
 assert.deepEqual(currencyReview(rs,m,{header:hd}),{myr:1,unknown:1,other:2});
 assert.equal(convert(rs,m,hd).txs.length,1);
 assert.equal(convert(rs,m,hd,{sourceCurrency:'MYR'}).txs.length,2);
 assert.equal(convert(rs,m,hd,{sourceCurrency:'OTHER'}).txs.length,1);
});
test('Positive selected-cell MYR/RM evidence bypasses confirmation; foreign headers and symbols cannot be overridden',()=>{
 for(const [head,value]of[['Amount (MYR)','6'],['Amount RM','6'],['Amount','MYR 6'],['Amount','RM6']]){const hd=['Date',head],m={date:0,amount:1};assert.equal(rowCurrency(['2026-10-04',value],m,hd),'MYR');assert.equal(convert([['2026-10-04',value]],m,hd).txs.length,1);}
 for(const [head,value]of[['Amount (USD)','6'],['Amount (ZAR)','6'],['Amount','USD 6'],['Amount','€6'],['Amount','SGD 6']]){const hd=['Date',head],m={date:0,amount:1};assert.equal(rowCurrency(['2026-10-04',value],m,hd),'other');assert.equal(convert([['2026-10-04',value]],m,hd,{sourceCurrency:'MYR'}).txs.length,0);}
});
test('Unused credit evidence does not establish a nonzero unlabelled debit currency',()=>{
 const hd=['Date','Debit','Credit MYR'],m={date:0,debit:1,credit:2};assert.equal(rowCurrency(['2026-10-04','6','2'],m,hd),'unknown');
 assert.equal(convert([['2026-10-04','6','2']],m,hd).txs.length,0);
 assert.equal(rowCurrency(['2026-10-04','0','2'],m,hd),'MYR');
});
test('Recognised Realbyte missing-currency rows still require confirmation; documented MYR header needs none',()=>{
 const hd=['Period','Accounts','Category','Subcategory','Income/Expense','Amount'],preset=detectPreset(hd),rs=[['10/04/2026','Cash','Food','Meal','Exp.','6']];assert.equal(preset.id,'realbyte');
 assert.equal(currencyReview(rs,preset.map,{header:hd,preset}).unknown,1);
 assert.equal(convert(rs,preset.map,hd,{preset}).txs.length,0);
 assert.equal(convert(rs,preset.map,hd,{preset,sourceCurrency:'MYR',accounts:{cash:'cash'}}).txs.length,1);
 hd[5]='MYR';const labelled=detectPreset(hd);assert.equal(currencyReview(rs,labelled.map,{header:hd,preset:labelled}).unknown,0);
 assert.equal(convert(rs,labelled.map,hd,{preset:labelled,accounts:{cash:'cash'}}).txs.length,1);
});
test('Existing FX target and other side of transfer reject MYR values before transactions/opening adjustments',()=>{
 assert.equal(convert(rows,map,header,{sourceCurrency:'MYR',accountCurrencies:{personal:'USD'}}).skipped[0].why,'currency-target');
 const hd=['Date','Amount','Account','Type','Note','Currency'],m=guessMapping(hd),rs=[['2026-10-04','-6','Cash','Transfer','to Dollar','MYR']];
 const r=convert(rs,m,hd,{accounts:{cash:'cash',dollar:'fx'},accountCurrencies:{fx:'USD'}});assert.equal(r.txs.length,0);assert.equal(r.skipped[0].why,'currency-target');
 const adjustment={adjust:()=>true,type:()=> 'expense'};
 assert.equal(Object.keys(convert(rows,map,header,{preset:adjustment}).opening).length,0);
 assert.equal(Object.keys(convert(rows,map,header,{preset:adjustment,sourceCurrency:'MYR',accountCurrencies:{personal:'USD'}}).opening).length,0);
});
test('Actual final import handler rechecks unconfirmed currency even if button was forged enabled',async()=>{
 const start=setup.indexOf("  'imp-go': async b => {"),end=setup.indexOf("  'm2-go':",start),handler=setup.slice(start,end).replace(/^\s*'imp-go':/,'').replace(/,\s*$/,'');
 let redraw=0,error='';const IMP={rows,map,header,sourceCurrency:null};
 const context={IMP,currencyReview,showMapping:()=>redraw++,impErr:m=>error=m,t:s=>s};const run=vm.runInNewContext('('+handler+')',context);const b={disabled:false};await run(b);
 assert.equal(redraw,1);assert.match(error,/Choose a currency/);assert.equal(b.disabled,false);
});
test('Confirmation is transient, reset on new source/mapping; inferred opening excludes unproven balance currency',()=>{
 assert.match(setup,/sourceCurrency:null, map:chosenMap/);assert.match(setup,/'imp-map': el => \{ IMP.sourceCurrency = null/);
 assert.match(setup,/amount:IMP\.map\.balance,currency:IMP\.map\.currency/);
 const start=setup.indexOf('const nextSettings =',setup.indexOf("'imp-go':")),end=setup.indexOf('const known =',start);
 assert.ok(!setup.slice(start,end).includes('sourceCurrency'));
});
test('Actual impPlan never infers opening from foreign/unlabelled Balance even with verified MYR transactions',()=>{
 const code=setup.slice(setup.indexOf('function impPlan()'),setup.indexOf('function showMapping()'));
 const S={accounts:[],tx:[],kv:{customCats:[]}},IMP={accountId:'new',newId:'new-account',rows:[['2026-10-04','-6','100']],map:{date:0,amount:1,balance:2},header:['Date','Amount MYR','Balance'],skipFuture:true,sourceCurrency:null};
 const context={S,IMP,accPlan:()=>({values:[],lookup:{}}),rowsToTx,currencyReview,openingFromBalance,splitDups,impAccount:()=>IMP.newId,catChoices:()=>({}),today:()=> '2026-10-04',newAccName:()=> 'Own account',unsetTarget:()=>false};
 const run=vm.runInNewContext(code+';impPlan',context);assert.equal(run().fresh.length,1);assert.equal(run().opening,null);
 IMP.sourceCurrency='MYR';assert.equal(typeof run().opening,'number');
 IMP.header[2]='Balance USD';assert.equal(run().opening,null);
 IMP.sourceCurrency=null;IMP.header[2]='Balance MYR';assert.equal(typeof run().opening,'number');
 assert.match(setup,/const blind = m.balance == null \|\| \(m.account == null && opening == null/);
});
test('All five locale strings preserve placeholders, are nonempty, and include existing Currency label',async()=>{
 const strings=JSON.parse(await readFile(new URL('./fixtures/import-currency-text.json',import.meta.url),'utf8'));
 for(const lang of['ms','zh','zh-Hant','ja','ta']){const dict=(await import(`../js/i18n/${lang}.js`)).default;
 assert.ok(dict.Currency);for(const[key,values]of Object.entries(strings)){assert.equal(dict[key],values[lang]);assert.ok(values[lang]);assert.deepEqual(values[lang].match(/\{\d+\}/g)||[],key.match(/\{\d+\}/g)||[]);}}
});
