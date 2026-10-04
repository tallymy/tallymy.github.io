import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseCSV,guessMapping,rowsToTx,makeBackup,readBackup} from '../js/io.js';
function row(date,time){return rowsToTx([[date,time,'1.23','Expense','Owned']],{date:0,time:1,amount:2,type:3,note:4},{accountId:'cash',now:1}).txs[0];}
test('owned actual KTW export preserves afternoon time through Tally JSON roundtrip',()=>{
 const [head,...rows]=parseCSV(readFileSync(new URL('./fixtures/ktw-owned-expense.csv',import.meta.url),'utf8'));
 const result=rowsToTx(rows,guessMapping(head),{accountId:'cash',now:1});assert.equal(result.skipped.length,0);assert.equal(result.txs.length,1);
 const tx=result.txs[0];assert.equal(tx.date,'2026-10-04');assert.equal(tx.amount,900);assert.equal(tx.time,'16:07');
 const back=readBackup(makeBackup({accounts:[{id:'cash',name:'Cash',kind:'cash',opening:0}],tx:result.txs,recurring:[],kv:{}}));assert.equal(back.tx[0].time,'16:07');
});
test('12-hour combined and separate columns retain midnight, noon and suffix variants',()=>{
 for(const [value,expected] of [['12:00 AM','00:00'],['12:00 PM','12:00'],['4:07pm','16:07'],['4:07 p.m.','16:07'],['04:07 P.M.','16:07'],['1:09:59 am','01:09'],['11:59PM','23:59']]){
  assert.equal(row('04/10/2026',value).time,expected,value);assert.equal(row('04/10/2026 '+value,'').time,expected,value);
 }
});
test('24-hour, compact numeric and Excel time handling remain supported',()=>{
 for(const [value,expected]of [['00:00','00:00'],['16:07','16:07'],['23:59:59','23:59'],['12:40:00.000','12:40'],['1607','16:07'],['46300.5','12:00']])assert.equal(row('04/10/2026',value).time,expected,value);
 assert.equal(row('04/10/2026 12:40:00.000','').time,'12:40');
});
test('invalid explicit 12-hour or malformed times do not silently become valid clock values',()=>{
 for(const value of ['00:07 AM','13:07 PM','24:07','16:60','16:07:99','160:07','4:07pmm','4:07 pmm','4:07 pmjunk','4:07 p.m.x'])assert.equal(row('04/10/2026',value).time,undefined,value);
});
