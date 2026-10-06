// Durable old-session plan binding. No book/photo data or device secrets belong here.
export const CONTEXT_SCHEMA='tally.sync-context/1',CONTEXT_BYTES=8192;
const fail=()=>{throw Object.assign(new Error('This pending sync cannot be resumed safely. Keep both safety copies.'),{code:'CONTEXT'});};
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function exact(v,keys){if(!v||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))fail();}
export async function validateControllerContext(core,value,binding){
  exact(value,['schema','descriptor','planHash']);if(value.schema!==CONTEXT_SCHEMA||!sha(value.planHash))fail();const d=value.descriptor;
  exact(d,['schema','session','mode','source','bookId','computer','phone','baseRevision','nextRevision']);if(d.schema!=='tally.sync-plan/1'||!id(d.session)||!id(d.bookId)||!sha(d.nextRevision)||!['initial','reconcile'].includes(d.mode))fail();
  for(const who of ['computer','phone']){const v=d[who];exact(v,['bookId','deviceId','revision']);if(!id(v.bookId)||!id(v.deviceId)||!sha(v.revision))fail();}
  if(d.computer.deviceId===d.phone.deviceId)fail();if(d.mode==='initial'){if(!['computer','phone'].includes(d.source)||d.baseRevision!==null||d.bookId!==d[d.source].bookId||d.nextRevision!==d[d.source].revision)fail();}
  else if(d.source!==null||!sha(d.baseRevision)||d.computer.bookId!==d.bookId||d.phone.bookId!==d.bookId)fail();
  if(new TextEncoder().encode(core.canonical(value)).length>CONTEXT_BYTES||await core.hash(d)!==value.planHash)fail();
  if(binding){const role=d.computer.deviceId===binding.deviceId?'computer':d.phone.deviceId===binding.deviceId?'phone':null,other=role==='computer'?'phone':'computer';
    if(!role||value.planHash!==binding.planId||d.bookId!==binding.bookId||d[other].deviceId!==binding.peerDeviceId||d.nextRevision!==binding.nextRevision||(binding.expectedRevision!==undefined&&d[role].revision!==binding.expectedRevision)||(binding.initial!==undefined&&(d.mode==='initial')!==binding.initial))fail();
  }return structuredClone(value);
}
