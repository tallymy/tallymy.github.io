// Only the ordinary app's completed boot/resume/reload calls ready().
// Privacy unlock alone is insufficient: the encrypted cached book may still be reloading.
export function createReadyRetry({approved,unlocked,privacyLocked,getGeneration,start,invalidate,onPrivacyChange,document:doc,window:win}){
 if([approved,unlocked,privacyLocked,getGeneration,start,invalidate,onPrivacyChange].some(f=>typeof f!=='function')||!doc||!win)throw Error('Missing ready lifecycle');
 const releaseApproved=()=>{try{return approved()===true;}catch{return false;}};
 if(!releaseApproved())return Object.freeze({ready:()=>Promise.resolve(null),dispose:()=>{}});
 let closed=false,epoch=0,pending=null;
 const eligible=()=>{try{return !closed&&releaseApproved()&&doc.hidden===false&&unlocked()===true&&privacyLocked()===false;}catch{return false;}};
 const lose=reason=>{if(closed)return;epoch++;try{invalidate(reason);}catch{}};
 const privacy=value=>{if(value!==false)lose('PRIVACY');};
 const visible=()=>{if(doc.hidden)lose('HIDDEN');};
 const pagehide=()=>lose('PAGEHIDE');
 const unsubscribe=onPrivacyChange(privacy);if(typeof unsubscribe!=='function')throw Error('Invalid privacy subscription');
 doc.addEventListener('visibilitychange',visible);win.addEventListener('pagehide',pagehide);
 function ready(){if(!eligible())return Promise.resolve(null);if(pending){if(pending.epoch===epoch)return pending.work;return pending.work.catch(()=>null).then(()=>eligible()?ready():null);}const ownEpoch=epoch,generation=getGeneration();
  const work=Promise.resolve().then(async()=>{if(!eligible()||epoch!==ownEpoch||generation!==getGeneration())return null;const result=await start();
   if(!eligible()||epoch!==ownEpoch||generation!==getGeneration()){if(epoch===ownEpoch)lose('STALE_READY');return null;}return result;
  }).finally(()=>{if(pending?.work===work)pending=null;});pending={work,epoch:ownEpoch};return work;
 }
 function dispose(){if(closed)return;lose('READY_DISPOSE');closed=true;try{unsubscribe();}finally{doc.removeEventListener('visibilitychange',visible);win.removeEventListener('pagehide',pagehide);}}
 return Object.freeze({ready,dispose});
}
