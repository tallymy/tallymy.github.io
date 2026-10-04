import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../js/scan.js',import.meta.url),'utf8');
const imageSource=await readFile(new URL('../js/receipt-image.js',import.meta.url),'utf8');
const moduleSource=source.replace("import { isNative } from './native.js';",'const isNative=true;')
 .replace("import { imageInfo, LIMITS } from './io.js';",'const imageInfo=()=>null,LIMITS={photoBytes:10000000,pixels:50000000};')
 .replace("import { readSize } from './receipt-image.js';",`const {readSize}=await import(${JSON.stringify('data:text/javascript;base64,'+Buffer.from(imageSource).toString('base64'))});`)
 .replace("new URL('./ocr-worker.js', import.meta.url)","new URL('https://localhost/js/ocr-worker.js')")
 .replace('new URL(p, import.meta.url)','new URL(p, "https://localhost/js/scan.js")');
const tick=()=>new Promise(r=>setImmediate(r));
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await tick();}throw Error('Test did not reach its controlled stage');}
async function harness(mode,body){
 const keys=['Worker','document','createImageBitmap','ImageData','fetch'],original=Object.fromEntries(keys.map(k=>[k,globalThis[k]]));
 const state={workers:[],closed:0,fetches:0,raws:0,stages:[],terminated:0,blobs:0};let held=false;
 const bitmap=()=>({width:mode==='oversized-decoded'?50000001:400,height:mode==='oversized-decoded'?1:800,close(){state.closed++;}});
 globalThis.createImageBitmap=async()=>{if(mode==='decode'&&!held){held=true;return new Promise(r=>state.release=()=>r(bitmap()));}return bitmap();};
 const response=()=>({ok:true,body:new ReadableStream({start(c){c.close();}})});
 globalThis.fetch=async(_,options)=>{state.fetches++;if(mode==='fetch'&&!held){held=true;state.signal=options.signal;return new Promise(r=>state.release=()=>r(response()));}return response();};
 globalThis.ImageData=class{constructor(data,width,height){Object.assign(this,{data,width,height});}};
 globalThis.document={createElement(){const canvas={width:1,height:1,toDataURL(type,quality){state.nativeCalls=(state.nativeCalls||0)+1;state.nativeCanvas={width:canvas.width,height:canvas.height,type,quality};if(mode==='native-encode-cancel')state.scan.cancelOcr();return 'data:image/jpeg;base64,'+btoa('owned');},toBlob(cb){state.blobs++;if(mode==='jpeg'&&!held){held=true;state.release=()=>cb(new Blob(['owned'],{type:'image/jpeg'}));}else cb(new Blob(['owned'],{type:'image/jpeg'}));},getContext(){return {drawImage(){},putImageData(){},getImageData(){return {width:canvas.width,height:canvas.height,data:new Uint8ClampedArray(canvas.width*canvas.height*4)};}};}};return canvas;}};
 globalThis.Worker=class{
  constructor(){state.workers.push(this);}
  terminate(){this.stopped=true;state.terminated++;}
  postMessage(message,transfer){
   const input=structuredClone(message,{transfer});if(input.raw)state.raws++;
   const emit=()=>this.onmessage?.({data:input.raw?{id:input.id,receipt:{total:1500},text:'TOTAL15.00',raw:input.raw,tries:1}:{id:input.id,texts:[]}});
   if((mode==='warmup'&&!input.raw||mode==='read'&&input.raw)&&!held){held=true;state.release=emit;return;}
   queueMicrotask(emit);
  }
 };
 const scan=await import('data:text/javascript;base64,'+Buffer.from(moduleSource.replace('const isNative=true;', 'const isNative='+(!['web','jpeg'].includes(mode))+';')+'\nexport const __test={jpegBlob,bitmap};\n//'+Math.random()).toString('base64'));
 state.scan=scan;
 const file=new File(['owned image'],'owned.png',{type:'image/png'}),begin=()=>{const p=scan.readReceipt(file,s=>state.stages.push(s));p.catch(()=>{});return p;};
 try{await body({scan,state,begin});}finally{scan.cancelOcr();for(const key of keys){if(original[key]===undefined)delete globalThis[key];else globalThis[key]=original[key];}}
}

test('native encoder keeps actual preview dimensions,quality and JPEG bytes while avoiding async callback',()=>harness('native',async({scan,state,begin})=>{const r=await begin();assert.equal(r.photo.type,'image/jpeg');assert.equal(await r.photo.text(),'owned');assert.equal(state.blobs,0);assert.equal(state.nativeCalls,1);assert.deepEqual(state.nativeCanvas,{width:400,height:800,type:'image/jpeg',quality:.8});assert.equal(state.closed,1);}));
test('web encoder preserves incumbent asynchronous path and output',()=>harness('web',async({state,begin})=>{const r=await begin();assert.equal(await r.photo.text(),'owned');assert.equal(r.photo.type,'image/jpeg');assert.equal(state.blobs,1);assert.equal(state.nativeCalls,undefined);assert.equal(state.closed,1);}));
test('native encode invalidation rejects output rather than returning cancelled receipt',()=>harness('native-encode-cancel',async({state,begin})=>{await assert.rejects(begin(),e=>e.cancelled===true);assert.equal(state.closed,1);assert.equal(state.terminated,1);}));
test('unknown-header decoded image above50MP is closed before canvas/model work',()=>harness('oversized-decoded',async({state,begin})=>{await assert.rejects(begin(),/too many pixels/);assert.equal(state.closed,1);assert.equal(state.workers.length,0);assert.equal(state.blobs,0);assert.equal(state.nativeCalls,undefined);}));
test('native helper refuses unsupported encoder MIME/empty output/oversized encoded bytes',()=>harness('native',async({scan})=>{const encode=url=>()=>url;assert.throws(()=>scan.__test.jpegBlob({toDataURL:encode('data:image/png;base64,b3duZWQ=')},0),/could not be prepared/);assert.throws(()=>scan.__test.jpegBlob({toDataURL:encode('data:image/jpeg;base64,')},0),/too big/);assert.throws(()=>scan.__test.jpegBlob({toDataURL:encode('data:image/jpeg;base64,'+'A'.repeat(13333340))},0),/too big/);}));
