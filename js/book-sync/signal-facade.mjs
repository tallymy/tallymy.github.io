import {phoneAddress,validSdp} from './desk-pair.js';
const SCHEMA='tally.lan-signal/1',NONCE=/^[a-f0-9]{64}$/;
const error=code=>Object.assign(Error('Local pairing '+code),{code});
const exact=(v,keys)=>{if(!v||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))throw error('SCHEMA');};
export function requestShape(v){exact(v,['schema','type','nonce','seq','address','pin','sdp']);if(v.schema!==SCHEMA||v.type!=='request'||typeof v.nonce!=='string'||!NONCE.test(v.nonce)||![1,2].includes(v.seq)||typeof v.address!=='string'||phoneAddress(v.address)!==v.address||typeof v.pin!=='string'||!/^\d{6}$/.test(v.pin)||v.seq===1&&v.sdp!==null)throw error('SCHEMA');if(v.seq===2)validSdp(v.sdp);return v;}
export function responseShape(v,nonce,seq){exact(v,['schema','type','nonce','seq','status','sdp']);if(v.schema!==SCHEMA||v.type!=='response'||v.nonce!==nonce||v.seq!==seq||![200,400,401,403,404,409,410,413,429,502].includes(v.status)||v.status!==200&&v.sdp!==null||seq===2&&v.sdp!==null)throw error('SCHEMA');if(seq===1&&v.status===200)validSdp(v.sdp);return v;}
function permitted(fn){try{return fn()===true;}catch{return false;}}
export function createSignalFacadeClient({window:win,document:doc,authorized,open=()=>{const url=new URL('../../sync-signal.html',import.meta.url);const lang=doc.documentElement.lang,theme=doc.documentElement.dataset.theme;if(['en','ms','zh','zh-Hant','ja','ta'].includes(lang))url.searchParams.set('lang',lang);if(['light','dark'].includes(theme))url.searchParams.set('theme',theme);if(win.crossOriginIsolated)url.searchParams.set('iso','1');return win.open(url.href,'','popup,width=520,height=480');},random=()=>crypto.getRandomValues(new Uint8Array(32))}){
 if(!win||!doc||typeof authorized!=='function'||typeof open!=='function')throw error('CONFIG');
 let active=null,closed=false;
 const origin=win.location.origin;
 const allowed=()=>!closed&&doc.hidden===false&&permitted(authorized);
 function finish(s,code){if(active!==s)return;active=null;clearTimeout(s.deadline);clearInterval(s.poll);win.removeEventListener('message',s.message);s.abort?.();try{s.popup?.close();}catch{}s.reject?.(error(code));s.reject=null;}
 function post(s,value){try{s.popup.postMessage(value,origin);return true;}catch{finish(s,'CHANNEL');return false;}}
 function begin(){if(!allowed())throw error('CANCELLED');if(win.navigator?.userActivation&&win.navigator.userActivation.isActive!==true)throw error('ACTIVATION');
  const nonce=Array.from(random(),b=>b.toString(16).padStart(2,'0')).join('');if(!NONCE.test(nonce))throw error('NONCE');
  const s={nonce,seq:0,address:null,pin:null,popup:null,ready:false,pending:null,send:null};active=s;
  s.message=e=>{if(active!==s||e.origin!==origin||e.source!==s.popup||!allowed())return;const v=e.data;if(v?.nonce!==nonce)return;
   try{if(v.type==='hello'){exact(v,['schema','type','nonce']);if(v.schema!==SCHEMA)throw error('SCHEMA');if(s.ready)return;s.ready=true;s.send?.();return;}
    const value=responseShape(v,nonce,s.seq);if(!s.pending)throw error('REPLAY');const pending=s.pending;s.pending=null;s.reject=null;s.abort?.();s.abort=null;
    pending.resolve(new Response(JSON.stringify(value.seq===1&&value.status===200?{sdp:value.sdp}:{}),{status:value.status,headers:{'Content-Type':'application/json'}}));if(value.seq===2||value.status!==200)finish(s,'DONE');
   }catch{finish(s,'SCHEMA');}};
  win.addEventListener('message',s.message);try{s.popup=open();}catch{finish(s,'POPUP');throw error('POPUP');}if(!s.popup){finish(s,'POPUP');throw error('POPUP');}
  // No nonce, PIN, address or SDP is placed in a URL, browser storage or a log.
  s.deadline=setTimeout(()=>finish(s,'TIMEOUT'),45000);s.poll=setInterval(()=>{if(!allowed()||s.popup.closed)finish(s,'CANCELLED');else if(!s.ready)post(s,{schema:SCHEMA,type:'init',nonce});},150);
  if(!post(s,{schema:SCHEMA,type:'init',nonce}))throw error('CHANNEL');
  return s;
 }
 async function fetcher(url,options){if(!allowed())throw error('CANCELLED');const parsed=new URL(url),address=phoneAddress(parsed.origin);if(url!==address+'/offer'&&url!==address+'/answer')throw error('ENDPOINT');
  if(!options||options.credentials!=='omit'||options.redirect!=='error'||options.cache!=='no-store'||options.referrerPolicy!=='no-referrer'||!options.signal)throw error('OPTIONS');
  const offer=url===address+'/offer';if(options.method!==(offer?'GET':'POST'))throw error('METHOD');exact(options.headers,offer?['X-Tally-Code']:['X-Tally-Code','Content-Type']);const pin=options.headers['X-Tally-Code'];if(typeof pin!=='string'||!/^\d{6}$/.test(pin)||!offer&&options.headers['Content-Type']!=='application/json')throw error('SCHEMA');
  let sdp=null;if(!offer){if(typeof options.body!=='string'||options.body.length>130000)throw error('SIZE');const body=JSON.parse(options.body);exact(body,['sdp']);sdp=validSdp(body.sdp);}else if(options.body!==undefined)throw error('SCHEMA');
  if(options.signal.aborted)throw error('CANCELLED');let s=active;if(offer){if(s)throw error('BUSY');s=begin();}else if(!s||s.seq!==1||s.pending||s.address!==address||s.pin!==pin)throw error('ORDER');
  if(s.pending)throw error('BUSY');s.seq=offer?1:2;s.address=address;s.pin=pin;
  const request=requestShape({schema:SCHEMA,type:'request',nonce:s.nonce,seq:s.seq,address,pin,sdp});
  return new Promise((resolve,reject)=>{s.pending={resolve,reject};s.reject=reject;const aborted=()=>finish(s,'CANCELLED');options.signal.addEventListener('abort',aborted,{once:true});s.abort=()=>options.signal.removeEventListener('abort',aborted);s.send=()=>{if(active===s&&allowed())post(s,request);else finish(s,'CANCELLED');};if(s.ready)s.send();});
 }
 const hidden=()=>{if(doc.hidden&&active)finish(active,'CANCELLED');},leave=()=>{if(active)finish(active,'CANCELLED');};doc.addEventListener('visibilitychange',hidden);win.addEventListener('pagehide',leave);
 return Object.freeze({fetch:fetcher,cancel:leave,close(){if(closed)return;closed=true;leave();doc.removeEventListener('visibilitychange',hidden);win.removeEventListener('pagehide',leave);}});
}
export function installSignalFacade({window:win,document:doc,fetcher=globalThis.fetch}){
 if(!win||!doc||typeof fetcher!=='function'||win.top!==win||!win.opener)throw error('TOP_LEVEL');
 const parent=win.opener,origin=win.location.origin;let nonce=null,seq=0,address=null,pin=null,busy=false,closed=false,controller=null,requestTimer=null;
 const timer=setTimeout(close,45000);function close(){if(closed)return;closed=true;clearTimeout(timer);clearTimeout(requestTimer);controller?.abort();win.removeEventListener('message',message);win.removeEventListener('pagehide',close);}
 const send=value=>{if(!closed)try{parent.postMessage(value,origin);}catch{close();}};
 async function message(e){if(closed||e.origin!==origin||e.source!==parent)return;const v=e.data;
  if(v?.type==='init'){try{exact(v,['schema','type','nonce']);if(v.schema!==SCHEMA||typeof v.nonce!=='string'||!NONCE.test(v.nonce)||nonce&&nonce!==v.nonce)throw error('SCHEMA');nonce=v.nonce;send({schema:SCHEMA,type:'hello',nonce});}catch{close();}return;}
  if(!nonce||v?.nonce!==nonce)return;
  let request;try{request=requestShape(v);if(busy||request.seq!==seq+1||seq&&address!==request.address||seq&&pin!==request.pin)throw error('ORDER');}catch{close();return;}
  busy=true;seq=request.seq;address=request.address;pin=request.pin;controller=new AbortController();requestTimer=setTimeout(()=>controller.abort(),12000);let status=502,sdp=null;
  try{const r=await fetcher(address+(seq===1?'/offer':'/answer'),{method:seq===1?'GET':'POST',headers:{'X-Tally-Code':pin,...(seq===2?{'Content-Type':'application/json'}:{})},...(seq===2?{body:JSON.stringify({sdp:request.sdp})}:{}),credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',targetAddressSpace:address.includes('127.0.0.1')?'loopback':'local',signal:controller.signal});
   if(closed)return;status=[200,400,401,403,404,409,410,413,429].includes(r.status)?r.status:502;
   if(status===200){const reader=r.body?.getReader();if(!reader)throw error('BODY');const chunks=[];let size=0;try{while(true){const part=await reader.read();if(closed||controller.signal.aborted)throw error('CANCELLED');if(part.done)break;size+=part.value.byteLength;if(size>65000)throw error('SIZE');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});}const bytes=new Uint8Array(size);let at=0;for(const b of chunks){bytes.set(b,at);at+=b.length;}const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));exact(value,seq===1?['sdp']:[]);if(seq===1)sdp=validSdp(value.sdp);}
  }catch{status=502;sdp=null;}finally{clearTimeout(requestTimer);busy=false;}
  if(closed)return;send(responseShape({schema:SCHEMA,type:'response',nonce,seq,status,sdp},nonce,seq));if(seq===2||status!==200)close();
 }
 win.addEventListener('message',message);win.addEventListener('pagehide',close);return Object.freeze({close});
}
