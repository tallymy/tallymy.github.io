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
 const bitmap=()=>({width:400,height:800,close(){state.closed++;}});
 globalThis.createImageBitmap=async()=>{if(mode==='decode'&&!held){held=true;return new Promise(r=>state.release=()=>r(bitmap()));}return bitmap();};
 const response=()=>({ok:true,body:new ReadableStream({start(c){c.close();}})});
 globalThis.fetch=async(_,options)=>{state.fetches++;if(mode==='fetch'&&!held){held=true;state.signal=options.signal;return new Promise(r=>state.release=()=>r(response()));}return response();};
 globalThis.ImageData=class{constructor(data,width,height){Object.assign(this,{data,width,height});}};
 globalThis.document={createElement(){const canvas={width:1,height:1,toDataURL(){return 'data:image/jpeg;base64,'+btoa('owned');},toBlob(cb){state.blobs++;if(mode==='jpeg'&&!held){held=true;state.release=()=>cb(new Blob(['owned'],{type:'image/jpeg'}));}else cb(new Blob(['owned'],{type:'image/jpeg'}));},getContext(){return {drawImage(){},putImageData(){},getImageData(){return {width:canvas.width,height:canvas.height,data:new Uint8ClampedArray(canvas.width*canvas.height*4)};}};}};return canvas;}};
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
 const scan=await import('data:text/javascript;base64,'+Buffer.from(moduleSource.replace('const isNative=true;', 'const isNative='+(mode!=='jpeg')+';')+'\n//'+Math.random()).toString('base64'));
 const file=new File(['owned image'],'owned.png',{type:'image/png'}),begin=()=>{const p=scan.readReceipt(file,s=>state.stages.push(s));p.catch(()=>{});return p;};
 try{await body({scan,state,begin});}finally{scan.cancelOcr();for(const key of keys){if(original[key]===undefined)delete globalThis[key];else globalThis[key]=original[key];}}
}
for(const mode of ['decode','fetch','warmup','read','jpeg'])test(`cancel during ${mode} rejects late work, frees resources and permits a fresh read`,()=>harness(mode,async({scan,state,begin})=>{
 const old=begin();await until(()=>typeof state.release==='function');scan.cancelOcr();
 if(mode==='fetch')assert.equal(state.signal.aborted,true);
 // Even a platform callback arriving after termination must not revive its read.
 const release=state.release;release();await assert.rejects(old,e=>e.name==='AbortError'&&e.cancelled===true);
 const fresh=await begin();assert.equal(fresh.receipt.total,1500);assert.equal(fresh.photo.type,'image/jpeg');assert.equal(scan.ocrReady(),true);
 assert.equal(state.closed,2,'both decoded original bitmaps freed');assert.ok(state.workers.length<=2);assert.ok(state.terminated<=1);
}));
test('a delayed cancelled loader cannot clear a newer ready worker or re-emit progress',()=>harness('fetch',async({scan,state,begin})=>{
 const old=begin();await until(()=>state.release);const late=state.release;scan.cancelOcr();
 const fresh=await begin();assert.equal(fresh.receipt.total,1500);const worker=state.workers.at(-1),before=state.fetches;
 late();await assert.rejects(old,e=>e.cancelled===true);assert.equal(scan.ocrReady(),true);await scan.loadOcr();assert.equal(state.workers.at(-1),worker);assert.equal(state.fetches,before);
}));
test('cancel terminates a worker holding the active photo and read-ahead, and ignores stale stages',()=>harness('read',async({scan,state,begin})=>{
 const active=begin();await until(()=>state.raws===1);const ahead=begin();await until(()=>state.raws===2);const worker=state.workers.at(-1),oldStages=state.stages.length;
 scan.cancelOcr();await assert.rejects(active,e=>e.cancelled===true);
 // This fake worker returned read-ahead before cancellation. It must either have
 // finished completely before cancellation or reject at its JPEG epoch guard.
 try{await ahead;}catch(e){assert.equal(e.cancelled,true);}
 worker.onmessage({data:{id:999,stage:'turn'}});assert.equal(state.stages.length,oldStages);assert.equal(state.terminated,1);assert.equal(scan.ocrReady(),false);
 assert.equal((await begin()).receipt.total,1500);
}));
