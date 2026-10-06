// Internal messages only, over the separately approved DTLS channel. No HTTP,
// discovery, server, storage writes, UI approval or finance semantics live here.
const SCHEMA='tally.sync-rpc/1',MAX_PACKET=256*1024,MAX_REQUESTS=4096;
const ID=/^[A-Za-z0-9_-]{1,128}$/;
const plain=x=>x&&Object.getPrototypeOf(x)===Object.prototype;
const fault=code=>Object.assign(new Error('Sync connection ended. Reconnect to continue.'),{code});
function bounded(value){
  const walk=(x,depth=0)=>{
    if(depth>28)throw fault('SCHEMA');
    if(x===null||typeof x==='boolean')return;
    if(typeof x==='string'){if(x.length>MAX_PACKET)throw fault('BOUNDS');return;}
    if(typeof x==='number'){if(!Number.isFinite(x))throw fault('SCHEMA');return;}
    if(Array.isArray(x)){if(x.length>10000)throw fault('BOUNDS');for(const v of x)walk(v,depth+1);return;}
    if(!plain(x))throw fault('SCHEMA');
    const keys=Object.keys(x);if(keys.length>10000)throw fault('BOUNDS');
    for(const key of keys){if(['__proto__','prototype','constructor'].includes(key))throw fault('SCHEMA');walk(x[key],depth+1);}
  };
  walk(value);const bytes=new TextEncoder().encode(JSON.stringify(value)).length;if(bytes>MAX_PACKET)throw fault('BOUNDS');return bytes;
}
function exact(value,keys){if(!plain(value)||Object.keys(value).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(value,k)))throw fault('SCHEMA');}
export function createSyncRpc({send,authorized,handle,validateHello,onHello=()=>{},onClose=()=>{},newIdentity=()=>crypto.randomUUID(),timeoutMs=15000}){
  if(![send,authorized,handle,validateHello,newIdentity].every(fn=>typeof fn==='function')||!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>60000)throw fault('CONFIG');
  const session=newIdentity();if(typeof session!=='string'||!ID.test(session))throw fault('CONFIG');
  let closed=false,started=false,peer=null,nextOut=0,nextIn=0,pending=null,incoming=false,queued=0,responses=0,responseBytes=0,tail=Promise.resolve();
  const permitted=()=>{try{return authorized()===true;}catch{return false;}};
  const check=()=>{if(closed||!permitted())throw fault('CANCELLED');};
  function close(code='CANCELLED'){
    if(closed)return;closed=true;const e=fault(code);if(pending){clearTimeout(pending.timer);pending.reject(e);pending=null;}peer=null;onClose(code);
  }
  async function transmit(message){check();bounded(message);await send(message);check();}
  async function start(hello){
    check();if(started)throw fault('SCHEMA');bounded(hello);validateHello(hello);started=true;
    try{await transmit({schema:SCHEMA,type:'hello',session,hello});}catch(e){close(e.code||'NETWORK');throw e;}
  }
  function request(method,args={}){
    // Callers may enqueue a small number of tasks, but wire requests are strictly
    // stop-and-wait so a fast sender cannot exhaust the receiver's chunk buffers.
    if(queued>=4)return Promise.reject(fault('BUSY'));
    try{check();if(typeof method!=='string'||!ID.test(method))throw fault('SCHEMA');bounded(args);}catch(e){return Promise.reject(e);}
    queued++;
    const operation=tail.then(async()=>{
      check();if(!started||!peer||nextOut>=MAX_REQUESTS)throw fault('SESSION');const seq=++nextOut;
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>close('TIMEOUT'),timeoutMs);pending={seq,resolve,reject,timer};
        transmit({schema:SCHEMA,type:'request',session,to:peer.session,seq,method,args}).catch(e=>close(e.code||'NETWORK'));
      });
    }).finally(()=>{queued--;});
    tail=operation.catch(()=>{});return operation;
  }
  async function receive(message){
    try{
      check();bounded(message);if(message.schema!==SCHEMA)throw fault('SCHEMA');
      if(message.type==='hello'){
        exact(message,['schema','type','session','hello']);if(peer||typeof message.session!=='string'||!ID.test(message.session)||message.session===session)throw fault('SESSION');
        validateHello(message.hello);peer={session:message.session,hello:structuredClone(message.hello)};onHello(structuredClone(peer.hello));return;
      }
      if(!started||!peer||message.session!==peer.session||message.to!==session||!Number.isInteger(message.seq)||message.seq<1||message.seq>MAX_REQUESTS)throw fault('SESSION');
      if(message.type==='response'){
        exact(message,['schema','type','session','to','seq','ok','value']);
        if(!pending||message.seq!==pending.seq||typeof message.ok!=='boolean')throw fault('REPLAY');
        if(!message.ok){exact(message.value,['code']);if(typeof message.value.code!=='string'||!ID.test(message.value.code))throw fault('SCHEMA');}
        const result=pending;pending=null;clearTimeout(result.timer);
        if(message.ok)result.resolve(message.value);
        else result.reject(fault(message.value.code));
        return;
      }
      exact(message,['schema','type','session','to','seq','method','args']);
      if(message.type!=='request'||message.seq!==nextIn+1||incoming||typeof message.method!=='string'||!ID.test(message.method))throw fault('REPLAY');
      nextIn=message.seq;incoming=message.seq;
      const reply=(ok,value)=>{
        check();
        const response={schema:SCHEMA,type:'response',session,to:peer.session,seq:message.seq,ok,value};
        const bytes=bounded(response);
        if(responses>=4||responseBytes+bytes>1024*1024)throw fault('BOUNDS');
        responses++;responseBytes+=bytes;
        // The peer may receive this packet before send's backpressure promise
        // resolves. Its next request is already legitimate at that point.
        if(incoming===message.seq)incoming=false;
        return transmit(response).finally(()=>{responses--;responseBytes-=bytes;});
      };
      // Do not await the handler in the transport receive queue. A simultaneous
      // outbound response must remain processable while IndexedDB is working.
      Promise.resolve().then(()=>{check();return handle(message.method,structuredClone(message.args),structuredClone(peer.hello));}).then(
        value=>reply(true,value),
        e=>{check();const code=typeof e?.code==='string'&&ID.test(e.code)?e.code:'FAILED';return reply(false,{code});}
      ).catch(e=>close(e.code||'NETWORK')).finally(()=>{if(incoming===message.seq)incoming=false;});
    }catch(e){close(e.code||'SCHEMA');throw e;}
  }
  // Outgoing includes reservations for queued operations conservatively. The
  // receiver uses incoming when budgeting a peer's forthcoming chunk requests.
  const budget=()=>!closed&&permitted()?{outgoing:Math.max(0,MAX_REQUESTS-nextOut-queued),incoming:Math.max(0,MAX_REQUESTS-nextIn)}:{outgoing:0,incoming:0};
  return {start,request,receive,close,budget,ready:()=>!closed&&started&&!!peer&&permitted(),peer:()=>peer?structuredClone(peer.hello):null};
}
