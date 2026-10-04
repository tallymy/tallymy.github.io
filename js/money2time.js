// Money2Time Android JSON v3, validated before any storage write. No DOM/network/storage access.
import { MAX_SEN, validIso, nextColor } from './engine.js';
import { cleanText, sameCategory, LIMITS } from './io.js';

const TABLES = ['accounts','account_groups','categories','transactions','transaction_splits','exchange_rates','recurring_rules','settings','monthly_wage_settings','albums','album_transactions','items','budget_templates','budget_template_categories','monthly_budgets','monthly_budget_categories','receipt_splits','receipt_split_items','receipt_split_item_shares'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const obj = x => !!x && typeof x === 'object' && !Array.isArray(x);
const nonempty = x => x !== null && x !== undefined && x !== '';
const fail = message => { throw new Error('Money2Time: ' + message); };
const id = value => { if (typeof value !== 'string' || !UUID.test(value)) fail('Invalid record ID.'); return value.toLowerCase(); };
const prefixed = (prefix,value) => prefix + id(value);
const money = value => { if (typeof value !== 'number' || !Number.isFinite(value)) fail('Invalid amount.'); const n=Math.round(value*100); if (!Number.isSafeInteger(n)||Math.abs(n)>MAX_SEN||Math.abs(value*100-n)>1e-6) fail('Amounts must fit two decimal places.'); return n; };
const stamp = value => {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/.test(value)||!validIso(value.slice(0,10)))fail('Invalid timestamp.');
  const ms=Date.parse(value);if(!Number.isFinite(ms))fail('Invalid timestamp.');return ms;
};
const local = value => { const d=new Date(stamp(value)),pad=n=>String(n).padStart(2,'0');const date=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;if(!validIso(date))fail('Invalid local date.');return {date,time:`${pad(d.getHours())}:${pad(d.getMinutes())}`}; };
const currency = value => { if(value!=='MYR')fail('Only MYR books are supported by this reader.'); };
function records(rows,name,max=200000) {
 if(!Array.isArray(rows)||rows.length>max)fail(`Invalid or oversized ${name} table.`);
 const seen=new Set();for(const row of rows){if(!obj(row))fail(`Invalid ${name} row.`);const key=id(row.id);if(seen.has(key))fail(`Duplicate ${name} ID.`);seen.add(key);if(nonempty(row.deleted_at))stamp(row.deleted_at);}
 return rows;
}
/** Detection is a routing hint only; readMoney2Time performs complete validation. */
export function isMoney2TimeExport(d) { return obj(d)&&Object.keys(d).every(k=>['version','exportedAt','userAssets','tables'].includes(k))&&d.version===3&&obj(d.tables)&&Array.isArray(d.userAssets)&&['accounts','categories','transactions','transaction_splits'].every(k=>Array.isArray(d.tables[k])); }

function jpeg(bytes) {
 if(bytes.length<4||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)fail('Invalid receipt JPEG.');
 for(let p=2;p+4<=bytes.length;){if(bytes[p++]!==255)fail('Invalid receipt JPEG.');while(bytes[p]===255)p++;const marker=bytes[p++];if(marker===217||marker===218)break;const len=(bytes[p]<<8)|bytes[p+1];if(len<2||p+len>bytes.length)fail('Invalid receipt JPEG.');
  if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){if(len<8)fail('Invalid receipt JPEG.');const height=(bytes[p+3]<<8)|bytes[p+4],width=(bytes[p+5]<<8)|bytes[p+6];if(!width||!height||width*height>LIMITS.pixels)fail('Receipt dimensions exceed the limit.');return {width,height};}p+=len;
 }fail('Receipt JPEG has no supported dimensions.');
}

/** Text or parsed object -> validated {accounts,tx,customCats,photos,warnings,...}; caller must preview and atomically commit. */
export function readMoney2Time(input,{now=Date.now()}={}) {
 let d=input;if(typeof input==='string'){if(new TextEncoder().encode(input).length>LIMITS.backupJson)fail('JSON exceeds the size limit.');try{d=JSON.parse(input);}catch{fail('Invalid JSON.');}}
 if(!isMoney2TimeExport(d))fail('Unsupported export root or version; expected Money2Time JSON v3.');stamp(d.exportedAt);
 if(Object.keys(d.tables).some(k=>!TABLES.includes(k))||TABLES.some(k=>!Array.isArray(d.tables[k])))fail('Unsupported table layout.');
 for(const [name,rows]of Object.entries(d.tables))if(rows.length>200000)fail(`Oversized ${name} table.`);
 for(const name of ['recurring_rules','monthly_wage_settings','albums','album_transactions','items','budget_templates','budget_template_categories','monthly_budgets','monthly_budget_categories','receipt_splits','receipt_split_items','receipt_split_item_shares'])if(d.tables[name].some(r=>!obj(r)||!r.deleted_at))fail(`Unsupported ${name}; nothing imported.`);
 const allAccounts=records(d.tables.accounts,'accounts',200),allCats=records(d.tables.categories,'categories',2000),allTx=records(d.tables.transactions,'transactions'),allSplits=records(d.tables.transaction_splits,'splits');
 const liveTx=allTx.filter(r=>!r.deleted_at),references=new Set(liveTx.flatMap(r=>[r.account_id,r.from_account_id,r.to_account_id]).filter(nonempty).map(id));
 const accounts=allAccounts.filter(a=>!a.deleted_at||references.has(id(a.id))).map(a=>{
  currency(a.currency);if(!['debit','credit'].includes(a.type))fail('Unsupported account type.');
  if(Object.entries(a).some(([k,v])=>(k.startsWith('loan_')||k.startsWith('goal_'))&&nonempty(v)))fail('Loan/goal accounts are not supported.');
  const opening=money(a.starting_balance);if(a.type==='credit'&&opening!==0)fail('Nonzero credit starting balances need verified sign mapping.');
  const name=cleanText(a.name,60);if(!name)fail('Missing account name.');const kind=a.type==='credit'?'card':a.account_group==='Bank Accounts'?'bank':/digital|e.?wallet/i.test(name)?'ewallet':'cash';
  return {id:prefixed('m2a_',a.id),name,kind,opening,createdAt:stamp(a.created_at)};
 });
 const accountMap=new Map(accounts.map(a=>[a.id.slice(4),a]));
 const cats=new Map(allCats.map(c=>[id(c.id),c])),customCats=[],catIds=new Map();
 for(const c of allCats){if(!['expense','income'].includes(c.type)||!cleanText(c.name,40))fail('Invalid category.');if(nonempty(c.parent_id)){const parent=cats.get(id(c.parent_id));if(!parent||parent===c||nonempty(parent.parent_id)||parent.type!==c.type)fail('Unsupported category parent or cycle.');}}
 for(const c of allCats.filter(c=>!nonempty(c.parent_id))){const name=cleanText(c.name,40),income=c.type==='income';let category=sameCategory(name,[],income);if(!category){if(customCats.length>=50)fail('Too many custom categories.');category=prefixed('c_m_',c.id);customCats.push({id:category,name,color:nextColor(customCats.map(x=>x.color)),...(income?{kind:'income'}:{})});}catIds.set(id(c.id),category);}
 const subcats=Object.create(null);
 for(const c of allCats.filter(c=>nonempty(c.parent_id))){const key=catIds.get(id(c.parent_id)),name=cleanText(c.name,30);if(name!==cleanText(c.name,40))fail('Subcategory name exceeds the limit.');const list=subcats[key]||=[];if(!list.includes(name))list.push(name);if(list.length>30)fail('Too many subcategories.');}
 const txById=new Map(liveTx.map(r=>[id(r.id),r])),splitCounts=new Map();let settledSplits=0,deleted=allTx.length-liveTx.length;
 for(const s of allSplits.filter(r=>!r.deleted_at)){
  const owner=txById.get(id(s.transaction_id));if(!owner)fail('Split refers to a missing transaction.');if(![0,1].includes(s.is_self)||money(s.amount)<0)fail('Invalid split.');
  if(nonempty(s.paid_transaction_id))fail('Linked split repayments need verified mapping.');
  if(s.is_self===0){if(!nonempty(s.paid_at))fail('Active splits are not supported; nothing imported.');stamp(s.paid_at);if(id(s.payback_account_id)!==id(owner.account_id))fail('Split repayments to another account need verified mapping.');settledSplits++;}
  splitCounts.set(id(owner.id),(splitCounts.get(id(owner.id))||0)+1);
 }
 const assets=new Map();let photoBytes=0;
 if(d.userAssets.length>2000)fail('Too many receipt assets.');
 for(const a of d.userAssets){if(!obj(a)||Object.keys(a).some(k=>!['path','base64'].includes(k))||typeof a.path!=='string'||!/^receipts\/[0-9a-f-]{36}\.jpg$/i.test(a.path)||!UUID.test(a.path.slice(9,-4))||assets.has(a.path))fail('Invalid or duplicate receipt asset path.');
  if(typeof a.base64!=='string'||!a.base64||a.base64.length>Math.ceil(LIMITS.photoBytes/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(a.base64))fail('Invalid receipt base64.');
  const raw=atob(a.base64),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));photoBytes+=bytes.length;if(photoBytes>LIMITS.photoBytes)fail('Receipt assets exceed the size limit.');const dimensions=jpeg(bytes);
  assets.set(a.path,{path:a.path,receiptId:'m2p_'+a.path.slice(9,-4).toLowerCase(),bytes,mime:'image/jpeg',...dimensions,txIds:[]});
 }
 const tx=liveTx.map(r=>{
  if(!['expense','income','transfer'].includes(r.type))fail('Unsupported transaction type.');currency(r.currency);if(nonempty(r.reporting_currency))currency(r.reporting_currency);
  const amount=money(r.amount);if(amount<=0)fail('Transaction amounts must be positive.');
  if(nonempty(r.account_amount)&&money(r.account_amount)!==amount||nonempty(r.reporting_amount)&&money(r.reporting_amount)!==amount||nonempty(r.fx_rate)&&r.fx_rate!==1)fail('Unsupported currency conversion.');
  if(r.reimbursable!==0&&nonempty(r.reimbursable)||['reimbursed_at','reimbursement_account_id','reimbursement_transaction_id','reimbursement_of_id'].some(k=>nonempty(r[k])))fail('Reimbursements need verified mapping.');
  if(nonempty(r.recurrence_pattern)&&r.recurrence_pattern!=='none'||nonempty(r.recurrence_parent_id)||nonempty(r.recurrence_end_date))fail('Recurring transactions are not supported.');
  const accountId=r.type==='transfer'?prefixed('m2a_',r.from_account_id):prefixed('m2a_',r.account_id);if(!accountMap.has(accountId.slice(4)))fail('Transaction account is missing.');
  const row={id:prefixed('m2t_',r.id),type:r.type,amount,accountId,...local(r.date),category:'other',merchant:'',note:cleanText(r.note,200),source:'import',createdAt:stamp(r.created_at)};
  if(r.type==='transfer'){row.toAccountId=prefixed('m2a_',r.to_account_id);if(row.toAccountId===row.accountId||!accountMap.has(row.toAccountId.slice(4)))fail('Transfer endpoint is missing or identical.');if(nonempty(r.to_amount)&&money(r.to_amount)!==amount)fail('Unsupported transfer conversion.');if(splitCounts.has(id(r.id)))fail('Split transfer is not supported.');}
  else{if(nonempty(r.from_account_id)||nonempty(r.to_account_id)||nonempty(r.to_amount))fail('Unexpected non-transfer endpoints.');const c=cats.get(id(r.category_id));if(!c||c.type!==r.type)fail('Transaction category is missing or incompatible.');const root=nonempty(c.parent_id)?cats.get(id(c.parent_id)):c;row.category=catIds.get(id(root.id));if(c!==root){const sub=cleanText(c.name,30);if(sub!==cleanText(c.name,40))fail('Subcategory name exceeds the limit.');row.sub=sub;}}
  if(nonempty(r.receipt_uri)){const photo=assets.get(r.receipt_uri);if(!photo)fail('Receipt asset is missing.');row.receiptId=photo.receiptId;photo.txIds.push(row.id);}
  return row;
 });
 if([...assets.values()].some(a=>!a.txIds.length))fail('Unlinked receipt assets are not supported.');
 const warnings=['Money2Time settings, account groups, category icons and exchange-rate cache are not imported.'];if(settledSplits)warnings.push('Settled split history is not recreated. Saved transaction amounts are kept; no repayment is added.');if(deleted)warnings.push('Deleted transactions are not imported.');
 return {app:'money2time',version:3,accounts,tx,customCats,subcats,photos:[...assets.values()],warnings,settledSplits,deleted,skipped:0,adjustments:0,otherCurrency:[],transfers:tx.filter(t=>t.type==='transfer').length,transfersSkipped:0};
}
