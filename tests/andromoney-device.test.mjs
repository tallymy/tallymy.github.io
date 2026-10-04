import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as IO from '../js/io.js';
import {detectPreset} from '../js/presets.js';
const fixture=new URL('./fixtures/andromoney-device-owned.csv',import.meta.url);
const bytes=readFileSync(fixture);
// Immutable native AndroMoney export from a deliberately fictional book.
assert.equal(createHash('sha256').update(bytes).digest('hex'),'6d3b6c7911cc92ed754ab09fdd4dc017faff37b03254309aa64d63c163681797');
function run(raw=bytes){
 const rows=IO.parseCSV(IO.decodeBytes(raw)),h=IO.headerRow(rows),header=rows[h],body=rows.slice(h+1);
 const preset=detectPreset(header,'actual-andromoney.csv');assert.equal(preset.id,'andromoney');
 const {names}=IO.accountNames(body,preset.map,{preset,header});
 const accounts=Object.fromEntries(names.map(n=>[n.toLowerCase(),n.toLowerCase()]));
 return IO.rowsToTx(body,preset.map,{preset,header,accountId:'default',accounts,now:1,strictCurrency:true});
}
test('actual AndroMoney expense retains Breakfast child, source time and MYR amount',()=>{
 const r=run(),expense=r.txs.find(t=>t.type==='expense');
 assert.equal(r.skipped.length,0);assert.equal(expense.amount,700);
 assert.equal(expense.date,'2026-10-04');assert.equal(expense.time,'12:51');
 assert.equal(expense.accountId,'cash');assert.equal(expense.sub,'Breakfast');
 assert.equal(expense.merchant,'OwnedAndroLunch');
});
test('same actual file preserves paired transfer and excludes transfer from spending',()=>{
 const r=run(),t=r.txs.find(t=>t.type==='transfer');
 assert.equal(r.txs.length,2);assert.equal(r.transfers,1);assert.equal(r.loose,0);
 assert.deepEqual([t.accountId,t.toAccountId,t.amount,t.time],['cash','credit card',200,'13:05']);
 assert.equal(r.txs.filter(t=>t.type==='expense').reduce((n,t)=>n+t.amount,0),700);
 assert.equal(t.sub,undefined);
});
test('foreign currency remains refused instead of relabelled MYR',()=>{
 const r=run(Buffer.from(bytes.toString('utf8').replaceAll('"MYR"','"GBP"')));
 assert.equal(r.txs.length,0);assert.equal(r.skipped.length,2);
 assert.ok(r.skipped.every(s=>s.why==='currency'));
});
test('Tally CSV export and re-read retain imported child',()=>{
 const original=run().txs.find(t=>t.type==='expense');
 const rows=IO.parseCSV(IO.toCSV([original],[{id:'cash',name:'Cash'}])),h=IO.headerRow(rows),header=rows[h];
 const preset=detectPreset(header,'tally.csv');assert.equal(preset.id,'tally');
 const r=IO.rowsToTx(rows.slice(h+1),preset.map,{preset,header,accountId:'cash',accounts:{cash:'cash'},now:2});
 assert.equal(r.txs.length,1);assert.equal(r.txs[0].sub,'Breakfast');assert.equal(r.txs[0].amount,700);
});
