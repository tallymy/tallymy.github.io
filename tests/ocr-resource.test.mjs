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
 const keys=['Worker','document','createImageBitmap','ImageData','fetch','setTimeout','clearTimeout'],original=Object.fromEntries(keys.map(k=>[k,globalThis[k]]));
 const state={workers:[],closed:0,fetches:0,raws:0,stages:[],terminated:0,blobs:0};let held=false;state.timers=new Set();globalThis.setTimeout=(fn)=>{const timer={fn};state.timers.add(timer);return timer;};globalThis.clearTimeout=timer=>state.timers.delete(timer);
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
   if(mode==='post-error'&&input.raw&&!held){held=true;throw new Error('Owned synthetic post failure');}
   if(mode==='warmup-error'&&!input.raw){queueMicrotask(()=>this.onmessage?.({data:{id:input.id,error:'Owned model initialization failure'}}));return;}
   const emit=()=>this.onmessage?.({data:input.raw?{id:input.id,receipt:{total:1500},text:'TOTAL15.00',raw:input.raw,tries:1}:{id:input.id,texts:[]}});
   if((mode==='warmup'&&!input.raw||mode==='read'&&input.raw)&&!held){held=true;state.release=emit;return;}
   queueMicrotask(emit);
  }
 };
 const scan=await import('data:text/javascript;base64,'+Buffer.from(moduleSource+'\n//'+Math.random()).toString('base64'));
 const file=new File(['owned image'],'owned.png',{type:'image/png'}),begin=()=>{const p=scan.readReceipt(file,s=>state.stages.push(s));p.catch(()=>{});return p;};
 try{await body({scan,state,begin});}finally{scan.cancelOcr();for(const key of keys){if(original[key]===undefined)delete globalThis[key];else globalThis[key]=original[key];}}
}

const baseline=process.env.TALLY_SCAN_PROBE_BASELINE==='1';
test('warmup error owns and terminates failed worker before repeated retry',()=>harness('warmup-error',async({scan,state,begin})=>{for(let i=0;i<2;i++)await assert.rejects(begin(),/Owned model initialization failure/);assert.equal(state.workers.length,2);assert.equal(state.terminated,baseline?0:2);assert.equal(scan.ocrReady(),false);console.log('warmup workers='+state.workers.length+' terminated='+state.terminated);}));
test('postMessage throw cannot leave a timeout capable of resetting a new successful read',()=>harness('post-error',async({scan,state,begin})=>{await assert.rejects(begin(),/Owned synthetic post failure/);assert.equal(state.timers.size,baseline?1:0);const fresh=await begin();assert.equal(fresh.receipt.total,1500);assert.equal(scan.ocrReady(),true);if(baseline){for(const timer of [...state.timers])timer.fn();assert.equal(scan.ocrReady(),false,'stray old timeout killed newer ready worker');}else assert.equal(state.timers.size,0);console.log('post-failure stray timers='+state.timers.size+' ready='+scan.ocrReady());}));

test('late failed old warmup cannot reset its replacement worker',()=>harness('warmup',async({scan,state,begin})=>{const old=begin();await until(()=>state.release);const previous=state.workers[0];scan.cancelOcr();const fresh=begin();previous.onmessage({data:{id:1,error:'Owned late old warmup failure'}});await assert.rejects(old,e=>e.cancelled===true);assert.equal((await fresh).receipt.total,1500);assert.equal(scan.ocrReady(),true);assert.equal(state.workers.length,2);assert.equal(state.terminated,1);assert.equal(state.workers[1].stopped,undefined);}));
