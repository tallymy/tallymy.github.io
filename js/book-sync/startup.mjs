// Single owner for optional host initialization. Quiet starts are never memoized.
export function createHostStartup(create) {
 if(typeof create!=='function')throw Error('Missing host factory');
 let current=null,pending=null,epoch=0,closed=false;
 function start(){if(closed)return Promise.reject(Error('Host startup closed'));if(current)return Promise.resolve(current);if(pending)return pending;
  const ticket=++epoch;
  const own=Promise.resolve().then(async()=>{const value=await create(()=>!closed&&ticket===epoch);
   if(closed||ticket!==epoch){await value?.dispose?.();return null;}
   if(value?.started===true)current=value;else await value?.dispose?.();return value;
  }).finally(()=>{if(pending===own)pending=null;});pending=own;return own;
 }
 function invalidate(reason){if(pending)epoch++;current?.invalidate(reason);}
 async function close(){closed=true;epoch++;const owner=current;current=null;await owner?.dispose?.();}
 return Object.freeze({start,current:()=>current,invalidate,close});
}
