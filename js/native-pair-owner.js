// One shared broker must wrap BOTH the legacy editor and the complete-book host.
// Retain ownership until asynchronous native cleanup finishes.
export function createNativePairOwner({native,authorized,onFault=()=>{}}) {
  if (!native || !['startLanPair','lanPairStatus','stopLanPair'].every(k=>typeof native[k]==='function') || typeof authorized!=='function') throw new TypeError('Native pairing owner dependencies required');
  let owner=null,tail=Promise.resolve();
  const permitted=()=>{try{return authorized()===true;}catch{return false;}};
  const fault=code=>Object.assign(new Error('Disconnect the current computer session, then try again.'),{code});
  const queued=fn=>{const task=tail.then(fn);tail=task.catch(()=>{});return task;};
  function acquire(label){
    if(typeof label!=='string'||!['legacy-editor','book-sync'].includes(label))throw fault('OWNER');
    if(owner)throw fault('BUSY');if(!permitted())throw fault('LOCKED');
    const lease={label,closed:false,started:false,closing:null};owner=lease;
    const check=()=>{if(owner!==lease||lease.closed||!permitted())throw fault('LOCKED');};
    function close(){
      if(lease.closing)return lease.closing;lease.closed=true;
      lease.closing=queued(async()=>{
        try{if(lease.started){await native.stopLanPair();lease.started=false;}if(owner===lease)owner=null;}
        catch(error){onFault('CLEANUP');throw fault('CLEANUP');} // quarantine singleton on failure
      });return lease.closing;
    }
    return {
      async startLanPair(args){
        check();return queued(async()=>{
          check();if(lease.started)throw fault('OWNER');
          // Native start may change its singleton before rejecting; cleanup is required.
          lease.started=true;
          try{const result=await native.startLanPair(args);check();return result;}
          catch(error){close().catch(()=>{});throw error?.code?error:fault('START');}
        });
      },
      async lanPairStatus(){check();const result=await queued(async()=>{check();if(!lease.started)throw fault('OWNER');return native.lanPairStatus();});check();return result;},
      async stopLanPair(options={}){
        check();if(Object.keys(options).some(k=>k!=='keepAwake')||options.keepAwake!==true)return close();
        // Stop discovery while the approved RTC channel retains the native lease.
        return queued(async()=>{check();if(!lease.started)throw fault('OWNER');await native.stopLanPair({keepAwake:true});check();});
      },
      close,active:()=>owner===lease&&!lease.closed&&permitted(),
    };
  }
  return {acquire,busy:()=>owner!==null};
}
