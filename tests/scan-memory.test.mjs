import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../js/scan.js',import.meta.url),'utf8');
const imageSource=await readFile(new URL('../js/receipt-image.js',import.meta.url),'utf8');
const moduleSource=source.replace("import { isNative } from './native.js';",'const isNative=true;')
 .replace("import { imageInfo, LIMITS } from './io.js';",'const imageInfo=()=>null,LIMITS={photoBytes:10000000,pixels:50000000};')
 .replace("import { readSize } from './receipt-image.js';",`const {readSize}=await import(${JSON.stringify('data:text/javascript;base64,'+Buffer.from(imageSource).toString('base64'))});`)
 .replace("new URL('./ocr-worker.js', import.meta.url)","new URL('https://localhost/js/ocr-worker.js')")
 .replace('new URL(p, import.meta.url)','new URL(p, "https://localhost/js/scan.js")');

async function run(failWarmup=false){
 let closed=0,transferVerified=false,closeBeforeRead=false;
 const original={Worker:globalThis.Worker,document:globalThis.document,createImageBitmap:globalThis.createImageBitmap,ImageData:globalThis.ImageData,fetch:globalThis.fetch};
 globalThis.fetch=async()=>({ok:true,body:new ReadableStream({start(c){c.close();}})});
 globalThis.createImageBitmap=async()=>({width:4000,height:3000,close(){closed++;}});
 globalThis.document={createElement(){const canvas={width:1,height:1,toBlob(cb){cb(new Blob(['photo'],{type:'image/jpeg'}));},getContext(){return {drawImage(){},putImageData(){},getImageData(){return {width:canvas.width,height:canvas.height,data:new Uint8ClampedArray(canvas.width*canvas.height*4)};}};}};return canvas;}};
 globalThis.ImageData=class{constructor(data,width,height){Object.assign(this,{data,width,height});}};
 globalThis.Worker=class{
  postMessage(message,transfer){
   const workerMessage=structuredClone(message,{transfer});
   if(message.raw){transferVerified=message.raw.data.byteLength===0;closeBeforeRead=closed===1;}
   queueMicrotask(()=>this.onmessage({data:failWarmup?{id:message.id,error:'model failed'}:workerMessage.raw?{id:message.id,receipt:{total:1500},text:'TOTAL 15.00',raw:workerMessage.raw,tries:1}:{id:message.id,texts:[]}}));
  }
  terminate(){}
 };
 try{
  const scan=await import('data:text/javascript;base64,'+Buffer.from(moduleSource+'\n//'+Math.random()).toString('base64'));
  const file=new File(['image'],'receipt.png',{type:'image/png'});
  if(failWarmup)await assert.rejects(scan.readReceipt(file),/model failed/);
  else{const result=await scan.readReceipt(file);assert.equal(result.receipt.total,1500);assert.equal(result.photo.type,'image/jpeg');assert.equal(transferVerified,true);assert.equal(closeBeforeRead,true);}
  assert.equal(closed,1,'decoded original closed exactly once');
 }finally{for(const [key,value]of Object.entries(original)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
}
test('receipt pixels transfer ownership and original decoded photo is freed before OCR',()=>run());
test('OCR startup failure still frees the decoded original photo',()=>run(true));
