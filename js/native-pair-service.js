import {createNativePairOwner} from './native-pair-owner.js';

// Instantiate once in the app. Both pairing features must use this service.
export function createNativePairService({native,privacyLocked,onPrivacyChange,document,window,onFault=()=>{}}) {
  if(typeof privacyLocked!=='function'||typeof onPrivacyChange!=='function'||!document||!window||typeof native?.addListener!=='function') throw TypeError('Native lifecycle dependencies required');
  let holder=null,disposed=false,ready=false,listener=null;
  const permitted=()=>{try{return !disposed&&ready&&!document.hidden&&privacyLocked()===false;}catch{return false;}};
  const broker=createNativePairOwner({native,authorized:permitted,onFault});
  const unavailable=()=>Object.assign(Error('Unlock Tally and disconnect the current computer session first.'),{code:'PAIRING'});
  function lose(reason) {
    const current=holder;if(!current)return;
    holder=null;current.closed=true;
    current.lease.close().catch(()=>onFault('CLEANUP'));
    try{const result=current.onLost(reason);result?.catch?.(()=>{});}catch{}
  }
  const hidden=()=>{if(document.hidden)lose('hidden');};
  const pagehide=()=>lose('pagehide');
  const replacement=()=>lose('book-replaced');
  const unsubscribe=onPrivacyChange(value=>{if(value!==false)lose('locked');});
  document.addEventListener('visibilitychange',hidden);
  document.addEventListener('tally:book-replaced',replacement);
  window.addEventListener('pagehide',pagehide);
  const whenReady=Promise.resolve().then(()=>native.addListener('deskStopped',()=>lose('native-stopped'))).then(async handle=>{
    if(!handle||typeof handle.remove!=='function')throw unavailable();
    if(disposed){await handle.remove();return false;}
    listener=handle;ready=true;return true;
  }).catch(()=>{ready=false;lose('native-listener');onFault('LISTENER');return false;});
  function acquire(role,onLost=()=>{}) {
    if(!permitted()||typeof onLost!=='function')throw unavailable();
    const lease=broker.acquire(role),current={lease,onLost,closed:false};holder=current;
    const check=()=>{if(holder!==current||current.closed||!permitted())throw unavailable();};
    const call=async(method,args)=>{check();const result=await lease[method](args);check();return result;};
    return {
      startLanPair:args=>call('startLanPair',args),
      lanPairStatus:()=>call('lanPairStatus'),
      stopLanPair:args=>args?.keepAwake===true?call('stopLanPair',args):close(),
      close,active:()=>holder===current&&!current.closed&&permitted()&&lease.active(),
    };
    function close(){current.closed=true;if(holder===current)holder=null;return lease.close();}
  }
  return {whenReady,acquire,busy:()=>broker.busy(),available:permitted,
    async dispose(){if(disposed)return;disposed=true;ready=false;const current=holder;lose('disposed');unsubscribe();document.removeEventListener('visibilitychange',hidden);document.removeEventListener('tally:book-replaced',replacement);window.removeEventListener('pagehide',pagehide);await whenReady;await listener?.remove();if(current)await current.lease.close();},
  };
}
