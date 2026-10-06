import {sanitizeLocalSdp,validateRemoteSdp} from './local-sdp.mjs';
import {phoneAddress,sasHandshake,validSdp,gather} from './desk-pair.js';
import {approvedDesk} from './desk-wire.js';
let nativeQueue=Promise.resolve();
const nativeOperation=operation=>{const result=nativeQueue.then(operation);nativeQueue=result.catch(()=>{});return result;};

// Signalling contains SDP only. Book data uses a separately approved DTLS channel.
// One owner must arbitrate this helper and the legacy live editor's native service.
export function createLanPair({native=null,allowed,receive,onState=()=>{},onReady=()=>{},onLost=()=>{},Peer=globalThis.RTCPeerConnection,fetcher=globalThis.fetch,document=globalThis.document}) {
  if(typeof allowed!=='function'||typeof receive!=='function')throw Error('Pairing requires an authorization boundary.');
  let active=null;
  const permitted=()=>{try{return allowed()===true;}catch{return false;}};
  const fail=(message='Connection ended.')=>Object.assign(new Error(message),{code:'PAIRING'});
  const current=s=>active===s&&!s.closed&&permitted()&&!document?.hidden;
  const check=s=>{if(!current(s))throw fail();};
  function state(s,value){check(s);onState(value);}
  function close(reason='Disconnected') {
    const s=active;if(!s)return;active=null;s.closed=true;s.abort.abort();
    clearInterval(s.poll);clearInterval(s.guard);clearTimeout(s.deadline);
    s.link?.close();s.channel?.close();s.peer?.close();
    if(s.ownsNative){s.ownsNative=false;nativeOperation(()=>native.stopLanPair()).catch(()=>{});}
    s.pending=0;s.pendingBytes=0;onLost(reason);
  }
  function begin(role) {
    if(active)throw fail('Disconnect the existing session first.');
    if(!permitted()||document?.hidden||!globalThis.isSecureContext||!Peer)throw fail('Unlock Tally and use a secure browser.');
    const s={role,closed:false,abort:new AbortController(),pending:0,pendingBytes:0,queue:Promise.resolve(),expiresAt:Date.now()+600000};active=s;
    s.guard=setInterval(()=>{if(!current(s))close('Connection paused. Your local book stays available.');},1000);
    s.deadline=setTimeout(()=>{if(active===s)close('Pairing expired. Start again.');},role==='computer'?45000:600000);
    s.peer=new Peer({iceServers:[]});
    s.peer.addEventListener('connectionstatechange',()=>{if(active===s&&['failed','closed','disconnected'].includes(s.peer.connectionState))close('Connection lost. Your local book stays available.');});
    return s;
  }
  async function incoming(s,value) {
    check(s);
    const bytes=new TextEncoder().encode(JSON.stringify(value)).length;
    if(bytes>256*1024||s.pending>=4||s.pendingBytes+bytes>1024*1024)throw fail('Sync message exceeds safety limits.');
    s.pending++;s.pendingBytes+=bytes;
    const operation=s.queue.then(async()=>{check(s);await receive(value);check(s);});
    s.queue=operation.catch(()=>{});
    try{await operation;}finally{s.pending--;s.pendingBytes-=bytes;}
  }
  async function attach(s,channel) {
    check(s);
    if(s.channel&&s.channel!==channel||channel.label!=='tally-sync-v1'||channel.ordered!==true||channel.maxRetransmits!=null||channel.maxPacketLifeTime!=null){channel.close();throw fail('Unexpected connection.');}
    s.channel=channel;
    if(channel.readyState!=='open'||s.link||!s.offer||!s.answer)return;
    if(s.attaching)return s.attaching;
    s.attaching=(async()=>{
    const code=await sasHandshake(channel,{role:s.role==='computer'?'answer':'offer',offer:s.offer,answer:s.answer});check(s);if(s.link)return;
    s.link=approvedDesk(channel,code,value=>incoming(s,value),()=>{
      if(!current(s))return close();
      clearTimeout(s.deadline);
      state(s,{phase:'approved'});
      Promise.resolve(onReady()).catch(()=>{if(active===s)close('Could not start sync.');});
    },()=>{if(active===s)close('Connection lost. Your local book stays available.');});
    clearTimeout(s.deadline);s.deadline=setTimeout(()=>{if(active===s)close('Pairing approval expired.');},Math.max(0,s.expiresAt-Date.now()));
    state(s,{phase:'approval',approvalCode:code,expiresAt:s.expiresAt});
    })();
    try{await s.attaching;}finally{s.attaching=null;}
  }
  function watch(s,channel) {
    channel.addEventListener('open',()=>attach(s,channel).catch(()=>{if(active===s)close();}),{once:true});
    return attach(s,channel);
  }
  async function signal(s,address,path,pin,sdp) {
    check(s);const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(),12000);
    const abort=()=>timeout.abort();s.abort.signal.addEventListener('abort',abort,{once:true});
    try{
      const response=await fetcher(address+path,{method:sdp?'POST':'GET',headers:{'X-Tally-Code':pin,...(sdp?{'Content-Type':'application/json'}:{})},...(sdp?{body:JSON.stringify({sdp})}:{}),credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',targetAddressSpace:address.includes('127.0.0.1')?'loopback':'local',signal:timeout.signal});
      check(s);if(!response.ok)throw fail('Could not pair.');
      const reader=response.body?.getReader();if(!reader)throw fail('Invalid signalling response.');
      const chunks=[];let size=0;
      try{while(true){const part=await reader.read();check(s);if(part.done)break;size+=part.value.length;if(size>65000)throw fail('Signalling response too large.');chunks.push(part.value);}}
      finally{await reader.cancel().catch(()=>{});}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    }finally{clearTimeout(timer);s.abort.signal.removeEventListener('abort',abort);}
  }
  async function host() {
    if(!native?.startLanPair||!native?.lanPairStatus||!native?.stopLanPair)throw fail('Start pairing on the Android phone.');
    const s=begin('phone');
    try{
      const channel=s.peer.createDataChannel('tally-sync-v1',{ordered:true});s.channel=channel;
      await s.peer.setLocalDescription(await s.peer.createOffer());await gather(s.peer);check(s);
      s.offer=sanitizeLocalSdp(s.peer.localDescription.sdp);
      const details=await nativeOperation(async()=>{
        check(s);const result=await native.startLanPair({offer:s.offer});
        if(!current(s)){await native.stopLanPair();throw fail();}s.ownsNative=true;return result;
      });
      const address=phoneAddress(details.address),pin=String(details.pin);
      if(!/^\d{6}$/.test(pin))throw fail('Invalid joining code.');
      state(s,{phase:'joining',address,pin,expiresAt:s.expiresAt});await watch(s,channel);
      let polling=false;
      s.poll=setInterval(async()=>{
        if(!current(s)){if(active===s)close();return;}if(polling||s.answer)return;polling=true;
        try{
          const details=await native.lanPairStatus();check(s);if(!details.active)throw fail('Pairing expired.');
          if(details.answer){s.answer=validateRemoteSdp(details.answer);await s.peer.setRemoteDescription({type:'answer',sdp:s.answer});check(s);await nativeOperation(async()=>{check(s);await native.stopLanPair({keepAwake:true});});check(s);await attach(s,channel);}
        }catch{if(active===s)close('Could not pair. Try again.');}finally{polling=false;}
      },500);
    }catch(error){if(active===s)close(error.message);throw error;}
  }
  async function join({address:input,pin,expiresAt}) {
    const address=phoneAddress(input);if(typeof pin!=='string'||!/^\d{6}$/.test(pin)||expiresAt!=null&&(!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now()||expiresAt>Date.now()+600000))throw fail('Use the current joining details.');
    const s=begin('computer');if(expiresAt)s.expiresAt=expiresAt;
    try{
      state(s,{phase:'connecting'});s.offer=validateRemoteSdp((await signal(s,address,'/offer',pin)).sdp);check(s);
      s.peer.addEventListener('datachannel',event=>{if(!current(s)){event.channel.close();return;}watch(s,event.channel).catch(()=>{if(active===s)close();});});
      await s.peer.setRemoteDescription({type:'offer',sdp:s.offer});await s.peer.setLocalDescription(await s.peer.createAnswer());await gather(s.peer);check(s);
      s.answer=sanitizeLocalSdp(s.peer.localDescription.sdp);await signal(s,address,'/answer',pin,s.answer);check(s);
      if(s.channel)await attach(s,s.channel);
    }catch(error){if(active===s)close(error.message);throw error;}
  }
  const visibility=()=>{if(document?.hidden)close('Connection paused. Your local book stays available.');};document?.addEventListener('visibilitychange',visibility);
  return {host,join,approve:async()=>{const s=active;check(s);if(!s.link)throw fail('Compare the numbers first.');await s.link.approve();},send:async value=>{const s=active;check(s);if(new TextEncoder().encode(JSON.stringify(value)).length>256*1024)throw fail('Sync message too large.');await s.link?.send(value);if(!s.link)throw fail('Approve pairing first.');},authorized:()=>!!active&&current(active)&&!!active.link?.authorized(),close,dispose(){close();document?.removeEventListener('visibilitychange',visibility);}};
}
