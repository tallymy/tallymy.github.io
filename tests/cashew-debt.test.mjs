import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {readRealbyte} from '../js/mmimport.js';
import {balances} from '../js/engine.js';
process.env.TZ='Asia/Kuala_Lumpur';
const vendor=fileURLToPath(new URL('../vendor/',import.meta.url)),mod={exports:{}};
new Function('module','exports','require','__dirname',readFileSync(vendor+'sql-wasm.js','utf8'))(mod,mod.exports,createRequire(import.meta.url),vendor);
const SQL=await mod.exports({wasmBinary:readFileSync(vendor+'sql-wasm.wasm')});
const fixture=name=>readFileSync(new URL(`./fixtures/cashew/${name}`,import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const importFile=bytes=>readRealbyte(bytes,SQL,{now:1791072000000});
const refused=async bytes=>assert.rejects(importFile(bytes),e=>e.code==='UNSUPPORTED_CASHEW_DEBT'&&/Nothing was imported/.test(e.message)&&/Keep the original backup/.test(e.message));
const rows=(bytes,sql)=>{const db=new SQL.Database(bytes);try{const r=db.exec(sql)[0];return r?r.values.map(v=>Object.fromEntries(r.columns.map((c,i)=>[c,v[i]]))):[];}finally{db.close();}};
const mutate=(bytes,sql)=>{const db=new SQL.Database(bytes);try{db.exec(sql);return db.export();}finally{db.close();}};
test('actual original Cashew6.7.2 split-loan SQLite fails closed with actionable message; source bytes unchanged',async()=>{
  const name='actual-owned-split-loan.sql',bytes=fixture(name),before=sha(bytes);
  const debt=rows(bytes,'select type,objective_loan_fk,amount from transactions where type=3 or objective_loan_fk is not null');
  assert.ok(debt.some(r=>r.type===3&&r.objective_loan_fk===null),'actual original loan is identified by type3 before collection creates its objective link');
  await refused(bytes);assert.equal(sha(fixture(name)),before);
});
test('actual partially collected loan retains nonnull objective link when type clears and is refused',async()=>{
  const bytes=fixture('actual-owned-partial-loan.sql');
  const debt=rows(bytes,'select type,objective_loan_fk,amount from transactions where objective_loan_fk is not null');
  assert.ok(debt.some(r=>r.type===null&&r.objective_loan_fk),'actual Collect1 cleared type but retained debt objective');
  await refused(bytes);
  await refused(mutate(bytes,'update transactions set type=null;'));
});
test('type3 alone refuses even when debt objective link is absent (derived actual fixture)',async()=>{
  await refused(mutate(fixture('actual-owned-split-loan.sql'),'update transactions set objective_loan_fk=null;'));
});
test('loan markers are checked before planned/zero-value skips, not silently ignored',async()=>{
  await refused(mutate(fixture('actual-owned-split-loan.sql'),'update transactions set paid=0,amount=0 where type=3 or objective_loan_fk is not null;'));
});
test('actual ordinary expense still preserves600senMYR and source balance',async()=>{
  const r=await importFile(fixture('actual-owned-single-expense.sql'));
  assert.equal(r.app,'cashew');assert.equal(r.tx.length,1);assert.equal(r.tx[0].type,'expense');assert.equal(r.tx[0].amount,600);
  assert.equal(Object.values(balances(r.accounts,r.tx).by).reduce((a,b)=>a+b,0),-600);
});
test('actual unilateral paired transfer remains one transfer and preserves both account balances',async()=>{
  const r=await importFile(fixture('actual-owned-transfer.sql'));
  assert.equal(r.transfers,1);assert.equal(r.tx.filter(t=>t.type==='transfer').length,1);assert.equal(r.tx.find(t=>t.type==='transfer').amount,200);
  assert.equal(r.tx.filter(t=>t.type==='expense').reduce((n,t)=>n+t.amount,0),600);
  assert.deepEqual(Object.values(balances(r.accounts,r.tx).by).sort((a,b)=>a-b),[-400,-200]);
});
test('actual owned nonnull subcategory remains parent-linked rather than becoming another category',async()=>{
  const r=await importFile(fixture('actual-owned-subcategory.sql'));
  assert.ok(r.tx.some(t=>t.sub==='OwnedLunchSub'&&t.amount===600));assert.equal(r.customCats.some(c=>c.name==='OwnedLunchSub'),false);assert.equal(r.transfers,1);
});
test('full-table debt probe refuses debt after the200000-row projection boundary',async()=>{
  const db=new SQL.Database();
  try{
    db.exec(`create table wallets(wallet_pk,name);create table categories(category_pk,name);create table transactions(transaction_pk,amount,category_fk,wallet_fk,date_created,type,objective_loan_fk);insert into wallets values('w','Cash');insert into categories values('f','Dining');with recursive n(x) as(select1 union all select x+1 from n where x<200000)insert into transactions select cast(x as text),-1,'f','w',1791072000,null,null from n;insert into transactions values('last-debt',-3,'f','w',1791072000,null,'loan');`.replace('select1','select 1'));
    assert.equal(db.exec('select count(*) from transactions')[0].values[0][0],200001);await refused(db.export());
  }finally{db.close();}
});
test('legacy synthetic Cashew schema without debt columns preserves expense/FX transfer/subcategory compatibility',async()=>{
  const db=new SQL.Database();try{
    db.exec(`create table wallets(wallet_pk,name,currency);create table categories(category_pk,name,income,main_category_pk);create table transactions(transaction_pk,amount,category_fk,wallet_fk,date_created,paid,paired_transaction_fk,sub_category_fk);insert into wallets values('m','Cash','MYR'),('u','USD','USD');insert into categories values('f','Dining',0,null),('s','Lunch',0,'f');insert into transactions values('meal',-6,'f','m',1791072000,1,null,'s'),('out',-10,'f','m',1791072000,1,'in',null),('in',2,'f','u',1791072000,1,'out',null);`);
    const r=await importFile(db.export());assert.equal(r.transfers,1);assert.ok(r.tx.some(t=>t.amount===600&&t.sub==='Lunch'));assert.ok(r.tx.some(t=>t.type==='transfer'&&t.amount===1000&&t.toAmount===200));
  }finally{db.close();}
});
test('actionable unsupported debt copy is localized in allfive locale tables',()=>{
  const key='This Cashew backup contains loans or split debts that Tally cannot import safely. Nothing was imported. Keep the original backup and use Cashew for these debts.';
  for(const lang of ['ms','zh','zh-Hant','ja','ta']){
    const code=readFileSync(new URL(`../js/i18n/${lang}.js`,import.meta.url),'utf8');
    const dict=vm.runInNewContext(code.replace('export default','globalThis.dict=')+';globalThis.dict;');assert.ok(typeof dict[key]==='string'&&dict[key].trim());
  }
});
