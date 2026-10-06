import {CATEGORIES,INCOME_CATEGORIES} from '../engine.js';
// This exception covers only the incumbent learned merchant/item -> category map.
// Other metadata remains an indivisible, conservatively conflicting record.
const plain=v=>!!v&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
const reserved=new Set(['__proto__','prototype','constructor']);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function categories(book){
  const custom=book.kv.customCats??[];
  if(!Array.isArray(custom)||custom.length>50)throw Error('Invalid category definitions');
  const ids=new Set([...CATEGORIES,...INCOME_CATEGORIES].map(c=>c.id));
  for(const c of custom){if(!plain(c)||typeof c.id!=='string'||!/^c_[\w-]{1,40}$/.test(c.id)||ids.has(c.id))throw Error('Invalid custom category');ids.add(c.id);}
  return ids;
}
function rules(v,ids){
  if(v===undefined)return {};
  if(!plain(v)||Object.keys(v).length>5000)throw Error('Invalid learned rules');
  for(const [k,value]of Object.entries(v))if(!k||k.length>70||reserved.has(k)||/[\u0000-\u001f\u007f]/.test(k)||k.trim()!==k||typeof value!=='string'||!ids.has(value))throw Error('Invalid learned rule/category');
  return v;
}
export function mergeLearnedRules(base,local,remote,maxChanges=2000){
  try{
    // A simultaneous category-definition/reclassification change needs the old
    // metadata+ledger conflict boundary, not a rules-only exception.
    for(const key of ['customCats','settings'])if(!same(base.kv[key],local.kv[key])||!same(base.kv[key],remote.kv[key]))return {error:true,conflicts:[]};
    const ids=categories(base),b=rules(base.kv.rules,ids),l=rules(local.kv.rules,ids),r=rules(remote.kv.rules,ids),keys=new Set([...Object.keys(b),...Object.keys(l),...Object.keys(r)]),value={},conflicts=[];
    let left=0,right=0;
    for(const k of [...keys].sort()){
      const bv=Object.hasOwn(b,k)?b[k]:undefined,lv=Object.hasOwn(l,k)?l[k]:undefined,rv=Object.hasOwn(r,k)?r[k]:undefined,lc=lv!==bv,rc=rv!==bv;
      if(lc)left++;if(rc)right++;
      if(lc&&rc&&lv!==rv){conflicts.push(k);continue;}
      const next=rc?rv:lv;if(next!==undefined)value[k]=next;
    }
    if(left>maxChanges||right>maxChanges||Object.keys(value).length>5000)return {error:true,conflicts:[]};
    return {conflicts,changed:{left,right},value:base.kv.rules===undefined&&local.kv.rules===undefined&&remote.kv.rules===undefined?undefined:value};
  }catch{return {error:true,conflicts:[]};}
}
