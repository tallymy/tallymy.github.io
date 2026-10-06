// Main local-book host boundary. Transport approval never implies book sharing.
export const HOST_SCHEMA='tally.sync-host/1',BOOT_SCHEMA='tally.sync-bootstrap/1';
const ID=/^[A-Za-z0-9_-]{1,128}$/;
const opaque=v=>typeof v==='string'&&ID.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const fail=code=>{throw Object.assign(new Error('Book connection ended. Your local book stays available.'),{code});};
function exact(v,keys){if(!v||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))fail('SCHEMA');}
export function createSyncHostRuntime({role,core,db,codec,verifyImage,createPair,createRpc,createStore,createController,privacyLocked,onPrivacyChange,getBookGeneration,onOwnedCommit,onDataChange,canonicalPhoneAddress,onRememberAddress=null,nativeService=null,document,window,newIdentity=()=>crypto.randomUUID(),consentTtlMs=120000}){
  if(!['computer','phone'].includes(role)||!core||!db||!codec||![verifyImage,createPair,createRpc,createStore,createController,privacyLocked,onPrivacyChange,getBookGeneration,onOwnedCommit,onDataChange,canonicalPhoneAddress,newIdentity].every(f=>typeof f==='function')||!document||!window||typeof document.addEventListener!=='function'||typeof window.addEventListener!=='function'||!Number.isInteger(consentTtlMs)||consentTtlMs<30000||consentTtlMs>180000||(role==='phone'&&!nativeService))fail('CONFIG');
  const GRACE_MS=10000,other=role==='computer'?'phone':'computer',subscribers=new Set();let current=null,disposed=false,epoch=0,offlinePhase='intro',lastError=null;
  const generation=()=>getBookGeneration()??null;
  // A brief hidden blip (WebView/tab visibility flicker) must not cut a commit/ACK exchange between two durable writes: while an approved exchange is in flight the page may
  // stay hidden for GRACE_MS. Longer than that, or once the exchange ends, the session is cancelled as before (the durable pending commit is then finished by recovery).
  function inFlight(s){try{return s?.controller?.inFlight?.()===true;}catch{return false;}}   // plain flag read: state() would call authorized() and recurse into this check
  function graceHidden(){const s=current;if(!s||s.closed||disposed||document.hidden!==true||!inFlight(s))return false;s.hiddenSince??=Date.now();return Date.now()-s.hiddenSince<GRACE_MS;}
  function basic(){try{return !disposed&&(document.hidden===false||graceHidden())&&privacyLocked()===false;}catch{return false;}}
  const graceDocument={get hidden(){return document.hidden===true&&!graceHidden();},addEventListener:(...a)=>document.addEventListener(...a),removeEventListener:(...a)=>document.removeEventListener(...a)};
  function active(s){if(current!==s||s.closed||!basic())return false;try{const g=generation();return g===s.generation||s.transition?.verified===true&&(g===s.transition.from||g===s.transition.to);}catch{return false;}}
  function consented(s){try{return active(s)&&s.pair?.authorized()===true&&s.approved&&s.localConsent&&s.peerConsent&&s.sessionReady;}catch{return false;}}
  function check(s,share=false){if(!(share?consented(s):active(s))){if(current===s)cancel('INVALIDATED');fail('CANCELLED');}}
  function emit(){const view=getPairingView();for(const fn of [...subscribers])try{fn(view);}catch{}}
  function getPairingView(){const s=current;return {schema:HOST_SCHEMA,role,native:role==='phone',phase:s?.phase||offlinePhase,pairing:{manualRole:role==='phone'?'host':'join',address:s?.details.address||'',joiningCode:s?.details.pin||'',approvalCode:s?.details.approvalCode||'',expiresAt:s?.details.expiresAt??null,canRememberAddress:typeof onRememberAddress==='function'},sharing:{local:s?.localConsent===true,peer:s?.peerConsent===true,canGrant:!!s&&s.approved&&s.sessionReady&&!s.localConsent&&active(s)},busy:s?.busy===true,errorCode:lastError};}
  function controller(){const s=current;return s&&consented(s)&&s.rpc?.ready()===true&&s.helloReceived?s.controller:null;}
  function subscribe(fn){if(typeof fn!=='function')fail('CONFIG');subscribers.add(fn);return ()=>subscribers.delete(fn);}
  async function cancel(reason='CANCELLED'){const s=current;if(!s){if(!disposed){offlinePhase='offline';lastError=reason;emit();}return;}
    current=null;s.closed=true;epoch++;clearTimeout(s.timer);s.localConsent=false;s.peerConsent=false;s.details={};s.earlyHello=null;for(const resource of [s.controller,s.rpc,s.pair])try{awaitableClose(resource);}catch{}offlinePhase='offline';lastError=reason;emit();
    try{await s.lease?.close();}catch{if(!current&&!disposed){lastError='CLEANUP';emit();}}
  }
  function awaitableClose(resource){const result=typeof resource?.dispose==='function'?resource.dispose():resource?.close();if(result&&typeof result.then==='function')result.catch(()=>{});}
  function begin(){if(disposed||!basic())fail('LOCKED');if(current)fail('BUSY');const g=generation();if(g!==null&&(!opaque(g)))fail('GENERATION');const s={epoch:++epoch,closed:false,generation:g,phase:'connect',details:{},approved:false,localConsent:false,peerConsent:false,session:null,sessionReady:false,offerSeen:false,ackSeen:false,consentSeen:false,bootReceived:0,busy:false,starting:null,rpc:null,controller:null,helloReceived:false,earlyHello:null,transition:null};current=s;lastError=null;return s;}
  function sendBoot(s,value){check(s);if(new TextEncoder().encode(JSON.stringify(value)).length>2048)fail('BOUNDS');return Promise.resolve(s.pair.send(value)).then(()=>check(s));}
  async function approved(s){check(s);if(s.approved)fail('REPLAY');s.approved=true;s.phase='sharing';s.timer=setTimeout(()=>{if(current===s)cancel('CONSENT_EXPIRED');},consentTtlMs);s.timer.unref?.();
    if(role==='computer'){s.session=newIdentity();if(!opaque(s.session))fail('CONFIG');await sendBoot(s,{schema:BOOT_SCHEMA,type:'offer',session:s.session,role});}emit();
  }
  function ownedStore(s){const store=createStore({db,core,...codec,verifyImage,allowed:()=>consented(s)&&s.controller?.storageAllowed()===true,onChange:event=>{if(current!==s||s.closed)return;
      if(event?.kind==='sync-commit'){const t=s.transition;if(!t||t.planId!==event.planId||t.planId!==s.controller?.state().planHash||t.seen) {cancel('UNOWNED_COMMIT');return;}t.seen=true;}
      else try{const p=Promise.resolve(onDataChange(event)).catch(()=>{if(current===s)cancel('DATA_REFRESH');});(s.refreshes||=new Set()).add(p);p.then(()=>s.refreshes.delete(p));}catch{if(current===s)cancel('DATA_REFRESH');}
    }});
    const facade={...store};
    for(const name of ['capture','identity'])facade[name]=async(...args)=>{check(s,true);const snap=await store[name](...args);check(s,true);const t=s.transition;if(snap.generation!==s.generation&&!(t?.verified&&snap.generation===t.to)){cancel('STALE');fail('STALE');}return snap;};
    facade.commit=async args=>{check(s,true);if(s.transition)fail('BUSY');
      // A refresh started by an earlier prepare/stage event may still be reading the book. If it overlapped the commit's generation switch it would see the NEW generation, fail the ownership check and drop the channel between the two durable commits (slow phones). Let it finish first.
      while(s.refreshes?.size){await Promise.all([...s.refreshes]);check(s,true);}const before=await facade.capture(),p=before.local?.pending;if(!p||p.planId!==args.planId||args.planId!==s.controller.state().planHash)fail('APPROVAL');
      if(p.status==='committed')return store.commit(args);const t={planId:args.planId,from:before.generation,to:p.nextGeneration,seen:false,verified:false};s.transition=t;
      try{const result=await store.commit(args);check(s,true);if(!t.seen)fail('OWNERSHIP');const after=await store.capture();check(s,true);if(after.generation!==t.to||after.local?.pending?.planId!==t.planId||after.local.pending.status!=='committed'||after.local.pending.nextRevision!==result.revision)fail('OWNERSHIP');
        await db.writeAtomic({snapshotGuard:after.guard,beforeWrite:()=>check(s,true)});check(s,true);t.verified=true;
        await onOwnedCommit({kind:'sync-commit',planId:t.planId,expectedGeneration:t.from,actualGeneration:t.to});check(s,true);if(generation()!==t.to)fail('OWNERSHIP');
        const final=await store.capture();check(s,true);if(final.generation!==t.to||final.local?.pending?.planId!==t.planId||final.local.pending.status!=='committed'||final.local.pending.nextRevision!==result.revision)fail('OWNERSHIP');await db.writeAtomic({snapshotGuard:final.guard,beforeWrite:()=>check(s,true)});check(s,true);s.generation=t.to;return result;
      }catch(e){if(current===s)cancel(e.code||'COMMIT');throw e;}finally{s.transition=null;}
    };return facade;
  }
  async function startController(s){check(s,true);if(s.starting)return s.starting;s.phase='starting';s.busy=true;emit();
    s.starting=(async()=>{s.rpcId=newIdentity();if(!opaque(s.rpcId)||s.rpcId===s.session)fail('CONFIG');
      s.rpc=createRpc({send:value=>{check(s,true);return s.pair.send(value);},authorized:()=>consented(s),newIdentity:()=>s.rpcId,
        validateHello:h=>{exact(h,['schema','session','role','deviceId','capability']);if(h.schema!=='tally.sync-controller/1'||h.session!==s.session||!['computer','phone'].includes(h.role)||!opaque(h.deviceId)||h.capability!=='complete-book-v1')fail('SCHEMA');},
        onHello:h=>{check(s,true);if(h.role!==other)fail('ROLE');if(!s.ownHello||h.deviceId===s.ownHello.deviceId)fail('IDENTITY');s.controller.acceptHello(h);s.helloReceived=true;},
        handle:(method,args)=>{check(s,true);if(!s.helloReceived||!s.rpc.ready())fail('UNREADY');return s.controller.handle(method,args);},
        onClose:()=>{if(current===s)cancel('RPC_CLOSED');}});
      s.store=ownedStore(s);s.controller=createController({role,sessionId:s.session,store:s.store,core,rpc:s.rpc,authorized:()=>consented(s),onChange:()=>{if(current===s){emit();if(document.hidden===true&&!graceHidden())cancel('HIDDEN');}}});
      const ownHello=await s.controller.hello();check(s,true);s.ownHello=ownHello;if(s.earlyHello){const packet=s.earlyHello;s.earlyHello=null;await receiveRpc(s,packet);}await s.rpc.start(ownHello);check(s,true);
      if(s.rpc.ready()&&s.helloReceived){clearTimeout(s.timer);s.phase='controller';}s.busy=false;emit();
    })().catch(e=>{if(current===s)cancel(e.code||'START_FAILED');throw e;});return s.starting;
  }
  function maybeStart(s){if(consented(s)&&!s.starting)startController(s).catch(()=>{});}
  async function receiveRpc(s,value){check(s,true);if(value?.type==='hello'&&value.session===s.rpcId)fail('IDENTITY');await s.rpc.receive(value);check(s,true);if(s.rpc.ready()&&s.helloReceived){clearTimeout(s.timer);s.phase='controller';s.busy=false;emit();}}
  async function receive(s,value){check(s);try{
      if(!s.approved||s.pair.authorized()!==true)fail('APPROVAL');
      if(value?.schema===BOOT_SCHEMA){if(++s.bootReceived>3)fail('BOUNDS');if(new TextEncoder().encode(JSON.stringify(value)).length>2048)fail('BOUNDS');
        exact(value,value.type==='consent'?['schema','type','session','role','allowed']:['schema','type','session','role']);if(value.role!==other||!opaque(value.session))fail('SCHEMA');
        if(value.type==='offer'){if(role!=='phone'||s.offerSeen||s.session)fail('REPLAY');s.offerSeen=true;s.session=value.session;s.sessionReady=true;await sendBoot(s,{schema:BOOT_SCHEMA,type:'offer_ack',session:s.session,role});}
        else if(value.type==='offer_ack'){if(role!=='computer'||s.ackSeen||value.session!==s.session)fail('REPLAY');s.ackSeen=true;s.sessionReady=true;}
        else if(value.type==='consent'){if(!s.sessionReady||value.session!==s.session||s.consentSeen||value.allowed!==true)fail('REPLAY');s.consentSeen=true;s.peerConsent=true;}
        else fail('SCHEMA');emit();maybeStart(s);return;
      }
      check(s,true);if(!s.ownHello){if(!s.starting||s.earlyHello||value?.schema!=='tally.sync-rpc/1'||value.type!=='hello'||new TextEncoder().encode(JSON.stringify(value)).length>2048)fail('UNREADY');exact(value,['schema','type','session','hello']);s.earlyHello=structuredClone(value);return;}
      await receiveRpc(s,value);
    }catch(e){if(current===s)cancel(e.code||'SCHEMA');throw e;}}
  function makePair(s){s.pair=createPair({native:s.lease||null,allowed:()=>active(s),receive:value=>receive(s,value),document:graceDocument,onState:view=>{check(s);if(view.phase==='approved')return;s.details={...s.details,...view};s.phase=view.phase==='approval'?'approve':'connect';emit();},onReady:()=>approved(s),onLost:()=>{if(current===s)cancel('CONNECTION_LOST');}});}
  async function requestPairing(action,payload={},guard){let actionSession=current;const actionAllowed=()=>{if(guard===undefined)return true;try{return typeof guard.allowed==='function'&&guard.allowed()===true;}catch{return false;}};
    const checkAction=()=>{if(!actionAllowed()){if(actionSession&&current===actionSession)cancel('ACTION_CANCELLED');fail('CANCELLED');}};checkAction();
    if(action==='revoke-sharing'){exact(payload,[]);return revokeSharing();}if(action==='grant-sharing'){exact(payload,[]);return grantSharing(guard);}
    if(action==='start'){exact(payload,[]);const s=begin();actionSession=s;try{if(role==='phone'){if(nativeService.available()!==true)fail('PAIRING');s.lease=nativeService.acquire('book-sync',()=>{if(current===s&&!(s.pair?.authorized()===true&&inFlight(s)))cancel('NATIVE_LOST');});if(!active(s)){await s.lease?.close();fail('CANCELLED');}}makePair(s);emit();if(role==='phone'){s.busy=true;emit();await s.pair.host();check(s);checkAction();}return getPairingView();}catch(e){if(current===s)cancel(e.code||'PAIRING');throw e;}finally{if(current===s){s.busy=false;emit();}}}
    const s=current;if(!s)fail('UNREADY');check(s);
    if(action==='connect'){if(role!=='computer'||s.busy||s.approved)fail('ROLE');exact(payload,['address','code','rememberAddress']);if(typeof payload.address!=='string'||typeof payload.code!=='string'||!/^\d{6}$/.test(payload.code)||typeof payload.rememberAddress!=='boolean'||payload.rememberAddress&&typeof onRememberAddress!=='function')fail('SCHEMA');const address=canonicalPhoneAddress(payload.address);s.busy=true;emit();try{await s.pair.join({address,pin:payload.code});check(s);checkAction();if(payload.rememberAddress){await onRememberAddress(address);check(s);checkAction();}return getPairingView();}catch(e){if(current===s)cancel(e.code||'PAIRING');throw e;}finally{if(current===s){s.busy=false;emit();}}}
    if(action==='approve'){exact(payload,[]);try{await s.pair.approve();check(s);checkAction();return getPairingView();}catch(e){if(current===s)cancel(e.code||'APPROVAL');throw e;}}fail('ACTION');
  }
  async function grantSharing(guard){const s=current;if(!s)fail('UNREADY');const checkGrant=()=>{check(s);if(guard!==undefined){let ok=false;try{ok=typeof guard.allowed==='function'&&guard.allowed()===true;}catch{}if(!ok){if(current===s)cancel('ACTION_CANCELLED');fail('CANCELLED');}}};checkGrant();if(!s.approved||!s.sessionReady||s.localConsent||s.pair.authorized()!==true)fail('APPROVAL');s.localConsent=true;emit();try{await sendBoot(s,{schema:BOOT_SCHEMA,type:'consent',session:s.session,role,allowed:true});checkGrant();maybeStart(s);return getPairingView();}catch(e){if(current===s)cancel(e.code||'CONSENT');throw e;}}
  const revokeSharing=()=>cancel('SHARING_REVOKED');
  const hidden=()=>{if(document.hidden===false){if(current)current.hiddenSince=null;return;}if(graceHidden()){const s=current;clearTimeout(s.graceTimer);s.graceTimer=setTimeout(()=>{if(current===s&&document.hidden===true)cancel('HIDDEN');},GRACE_MS+50);s.graceTimer.unref?.();return;}cancel('HIDDEN');},pagehide=()=>cancel('PAGEHIDE'),replaced=()=>cancel('BOOK_REPLACED');
  const unsubscribe=onPrivacyChange(value=>{if(value!==false)cancel('LOCKED');});document.addEventListener('visibilitychange',hidden);window.addEventListener('pagehide',pagehide);document.addEventListener('tally:book-replaced',replaced);
  async function dispose(){if(disposed)return;disposed=true;await cancel('DISPOSED');unsubscribe();document.removeEventListener('visibilitychange',hidden);window.removeEventListener('pagehide',pagehide);document.removeEventListener('tally:book-replaced',replaced);subscribers.clear();}
  return Object.freeze({role,lifecycleReady:true,capabilities:Object.freeze({completeBook:true,bidirectional:true,durableBoth:true,receipts:true,conflictReview:true,localTransport:true,manualPairing:true,bilateralApproval:true}),controller,getPairingView,subscribe,requestPairing,grantSharing,revokeSharing,cancel,dispose,graceHidden});
}
