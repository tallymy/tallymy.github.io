// Main-app integration boundary; no alternate book, transport or UI is created here.
export async function createMainBookHost({state,load,locked,privacyLocked,onPrivacyChange,isNative,approved,loadDependencies,openSheet,closeSheet,t,render,document:doc,window:win}){
 if(!state||[load,locked,privacyLocked,onPrivacyChange,approved,loadDependencies,openSheet,closeSheet,t,render].some(f=>typeof f!=='function')||!doc||!win)throw Error('Missing main host lifecycle');
 let active=true,adapter=null,runtime=null,ready=false,safety=null;const registrars=new Set();
 const allowed=()=>{try{return active&&approved()===true&&(doc.hidden===false||runtime?.graceHidden?.()===true)&&locked()===false&&privacyLocked()===false;}catch{return false;}};
 const quiet=Object.freeze({started:false,card:()=>'',open:()=>false,available:()=>false,invalidate(){},dispose(){active=false;},safety:()=>null});
 // Gate false performs no imports, capture, identity writes, listener acquisition or native calls.
 if(!allowed())return quiet;
 let stopPrivacy=null,replaced=null,hidden=null,leave=null,cleaned=false;
 async function cleanup(){if(cleaned)return;cleaned=true;active=false;ready=false;registrars.clear();
  if(replaced)doc.removeEventListener('tally:book-replaced',replaced);if(hidden)doc.removeEventListener('visibilitychange',hidden);if(leave)win.removeEventListener('pagehide',leave);
  try{stopPrivacy?.();}catch{}try{safety?.dispose?.();}catch{}try{adapter?.destroy?.();}catch{}
  try{await runtime?.dispose?.();}catch{}
 }
 try {
 const dependencies=await loadDependencies();if(!allowed())return quiet;
 const generation=()=>state.kv?.bookGeneration??null;
 const invalid=reason=>{if(reason==='HIDDEN'&&runtime?.graceHidden?.()===true)return;adapter?.invalidate(reason);safety?.cancel?.();safety?.access?.cancel();safety?.restore?.cancel();safety?.exporter?.cancel();try{Promise.resolve(runtime?.cancel(reason)).catch(()=>{});}catch{}};
 const strictRefresh=async()=>{const owner=runtime?.controller(),before=generation();await load();if(!allowed()||generation()!==before)throw Error('Book changed during refresh');if(ready&&runtime?.controller()===owner)render();};
 async function owned(event){if(!allowed()||event?.kind!=='sync-commit'||generation()!==event.expectedGeneration)throw Error('Unverified owned reload');
  await load();const controller=runtime?.controller(),view=controller?.state();
  if(!allowed()||generation()!==event.actualGeneration||view?.schema!=='tally.sync-controller/1'||view.role!==(isNative?'phone':'computer')||view.planHash!==event.planId)throw Error('Wrong owned plan or generation');
  for(const fn of [...registrars])fn(event);if(ready)render();
 }
 const register=fn=>{if(typeof fn!=='function')throw Error('Invalid registrar');registrars.add(fn);return()=>registrars.delete(fn);};
 adapter=dependencies.createUi({state,locked,privacyLocked,onPrivacyChange,approvedProvider:allowed,bindOwnedCommit:register,document:doc,window:win,openSheet,dismissSheet:()=>closeSheet(),leaf:dependencies.leaf,t,onAvailability:()=>{if(ready)render();}});
 runtime=dependencies.createRuntime({role:isNative?'phone':'computer',state,db:dependencies.db,core:dependencies.core,codec:dependencies.codec,verifyImage:dependencies.verifyImage,createPair:dependencies.createPair,createRpc:dependencies.createRpc,createStore:dependencies.createStore,createController:dependencies.createController,privacyLocked:()=>!allowed(),onPrivacyChange,getBookGeneration:generation,onOwnedCommit:owned,onDataChange:strictRefresh,canonicalPhoneAddress:dependencies.phoneAddress,nativeService:dependencies.nativeService,document:doc,window:win});
 if(!allowed()){await cleanup();return quiet;}adapter.install(runtime);ready=true;
 // Local recovery uses the actual raw DB; a trusted provider builds its UI separately.
 safety=dependencies.createSafety?.({allowed,load,render,document:doc})||null;
 replaced=()=>invalid('BOOK_REPLACED');doc.addEventListener('tally:book-replaced',replaced);
 stopPrivacy=onPrivacyChange(value=>{if(value!==false)invalid('LOCKED');});hidden=()=>{if(doc.hidden)invalid('HIDDEN');else if(active&&ready)render();/* the Sync card is repainted when the page is visible again */};leave=()=>invalid('PAGEHIDE');doc.addEventListener('visibilitychange',hidden);win.addEventListener('pagehide',leave);
 return Object.freeze({started:true,card:()=>allowed()?adapter.card():'',open:()=>allowed()&&adapter.open(),available:()=>allowed()&&adapter.available(),invalidate:invalid,graceHidden:()=>runtime?.graceHidden?.()===true,safety:()=>allowed()?safety:null,dispose:cleanup});
 } catch(error) {
  await cleanup();
  throw error;
 }
}
