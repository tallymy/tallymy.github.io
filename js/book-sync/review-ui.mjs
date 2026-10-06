// Presentation of the actual immutable controller review, never a merge engine.
const SHA=/^[a-f0-9]{64}$/,KINDS=['accounts','tx','recurring','receipts','kv'];
const plain=v=>v&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,keys)=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const fail=()=>{throw Error('The current review is unavailable.');};
export const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function validateReview(diff,summary,planHash){
 if(typeof planHash!=='string'||!SHA.test(planHash)||!exact(diff,['planHash','mode','source','targetRevision','changes'])||!exact(summary,['planHash','mode','targetRevision','counts']))fail();
 if(diff.planHash!==planHash||summary.planHash!==planHash||typeof diff.targetRevision!=='string'||!SHA.test(diff.targetRevision)||diff.targetRevision!==summary.targetRevision||diff.mode!==summary.mode||!['initial','reconcile'].includes(diff.mode))fail();
 if(diff.mode==='initial'?!['computer','phone'].includes(diff.source):diff.source!==null)fail();
 if(!exact(diff.changes,KINDS)||!exact(summary.counts,KINDS)||new TextEncoder().encode(JSON.stringify(diff)).length>32*1024*1024)fail();
 let total=0;
 for(const kind of KINDS){const rows=diff.changes[kind],counts=summary.counts[kind],ids=new Set(),actual={added:0,changed:0,deleted:0};if(!Array.isArray(rows)||rows.length>200000||!exact(counts,['added','changed','deleted']))fail();
  for(const row of rows){if(!exact(row,['id','kind','before','after'])||typeof row.id!=='string'||!row.id||row.id.length>256||ids.has(row.id)||!['added','changed','deleted'].includes(row.kind))fail();if(row.kind==='added'?(row.before!==null||row.after===null):row.kind==='deleted'?(row.before===null||row.after!==null):(row.before===null||row.after===null))fail();ids.add(row.id);actual[row.kind]++;}
  for(const key of Object.keys(actual))if(!Number.isSafeInteger(counts[key])||counts[key]!==actual[key])fail();total+=rows.length;
 }
 if(total>500000)fail();return diff;
}
const labels={accounts:'Accounts',tx:'Entries',recurring:'Regular payments',receipts:'Receipt photos',kv:'Book settings'};
const fields={name:'Name',merchant:'Merchant',note:'Note',date:'Date',type:'Type',currency:'Currency',accountId:'Account',category:'Category',amount:'Amount',opening:'Opening balance',bytes:'File size',mime:'File type'};
export function reviewHtml(diff,{page=0,pageSize=20,t=(x,...a)=>x.replace(/\{(\d+)\}/g,(_,i)=>a[i]??''),accounts=[],recovery=false}={}){
 if(!Number.isInteger(pageSize)||pageSize<1||pageSize>50)throw Error('Invalid review page size');
 const rows=KINDS.flatMap(kind=>diff.changes[kind].map(row=>({kind,row}))),pages=Math.max(1,Math.ceil(rows.length/pageSize));page=Math.max(0,Math.min(pages-1,Number.isInteger(page)?page:0));
 const own=new Map(accounts.map(a=>[a.id,a])),next=new Map(own);for(const r of diff.changes.accounts){if(r.before)own.set(r.id,r.before);if(r.after)next.set(r.id,r.after);else next.delete(r.id);}
 function value(v,key,record,by){if(key==='accountId')return by.get(v)?.name||v;
  if(key==='amount'||key==='opening'){const currency=record.currency||by.get(record.accountId)?.currency||'';return `${currency} ${typeof v==='number'?(v/100).toFixed(2):v}`.trim();}
  return typeof v==='object'?JSON.stringify(v):String(v??'');}
 function side(record,label,by){if(record===null)return `<div><h4>${escape(t(label))}</h4><p class="fine">${escape(t('Not present'))}</p></div>`;
  const obj=plain(record)?record:{value:record};return `<div><h4>${escape(t(label))}</h4><dl>${Object.entries(obj).filter(([k])=>Object.hasOwn(fields,k)).map(([k,v])=>`<dt class="fine">${escape(t(fields[k]))}</dt><dd>${escape(value(v,k,obj,by))}</dd>`).join('')}</dl><details><summary>${escape(t('All fields'))}</summary><pre class="sync-fields" tabindex="0">${escape(JSON.stringify(record,null,2))}</pre></details></div>`;}
 const totals=rows.reduce((o,{row})=>(o[row.kind]++,o),{added:0,changed:0,deleted:0});
 return `<section class="sync-review" tabindex="-1" aria-label="${escape(t('Review changes'))}" data-reviewed-plan="${escape(diff.planHash)}"><p class="fine">${escape(t(recovery?'{0} only in checkpoint · {1} different · {2} only in current book':'{0} added · {1} changed · {2} deleted',totals.added,totals.changed,totals.deleted))}</p>${rows.length?rows.slice(page*pageSize,(page+1)*pageSize).map(({kind,row})=>`<article class="sync-change"><h3>${escape(t(labels[kind]))}: ${escape(row.after?.merchant||row.after?.name||row.before?.merchant||row.before?.name||row.id)}</h3><p class="fine">${escape(t((recovery?{added:'Only in checkpoint',changed:'Different',deleted:'Only in current book'}:{added:'Added',changed:'Changed',deleted:'Deleted'})[row.kind]))}</p><div class="grid2">${side(row.before,recovery?'Current book':'Before',own)}${side(row.after,recovery?'Agreed checkpoint':'After',next)}</div></article>`).join(''):`<p>${escape(t('No changes on this device.'))}</p>`}<nav class="row2" aria-label="${escape(t('Review pages'))}"><button class="btn ghost" data-review-page="${page-1}"${page===0?' disabled':''}>${escape(t('Previous'))}</button><button class="btn ghost" data-review-page="${page+1}"${page===pages-1?' disabled':''}>${escape(t('Next'))}</button></nav><p class="fine" role="status">${escape(t('Page {0} of {1}',page+1,pages))}</p></section>`;
}
