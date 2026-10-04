import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const src=await readFile(new URL('../js/views/setup.js',import.meta.url),'utf8'),start=src.indexOf('async function reencode(blob) {'),body=src.slice(start,src.indexOf('// ---- restore ',start));
function harness({native=true,header={w:100,h:100},bitmap={width:100,height:100},drawError=false,decodeError=false,url='data:image/jpeg;base64,/9j/2Q==',asyncError=false}={}){
 const calls={decode:0,close:0,sync:0,async:0};const bmp={...bitmap,close(){calls.close++;}},canvas={getContext:()=>({drawImage(){if(drawError)throw Error('draw');}}),toDataURL(type,q){calls.sync++;assert.equal(type,'image/jpeg');assert.equal(q,.8);return url;},toBlob(done,type,q){calls.async++;assert.equal(type,'image/jpeg');assert.equal(q,.8);if(asyncError)throw Error('encode');done(new Blob(['web'],{type}));}};
 const ctx=vm.createContext({LIMITS:{photoBytes:40*1024*1024,pixels:50e6},imageInfo:()=>header,isNative:native,createImageBitmap:async()=>{calls.decode++;if(decodeError)throw Error('decode');return bmp;},document:{createElement:()=>canvas},Blob,Uint8Array,atob,Math});vm.runInContext(body+';globalThis.run=reencode;',ctx);return{run:ctx.run,calls,canvas};
}
test('native JPEG path uses bounded synchronous encoder; web keeps async encoder; bitmap closes',async()=>{
 for(const native of[true,false]){const h=harness({native,bitmap:{width:2400,height:1600}}),out=await h.run(new Blob(['input']));assert.equal(out.type,'image/jpeg');assert.equal(h.canvas.width,1200);assert.equal(h.canvas.height,800);assert.equal(h.calls.sync,native?1:0);assert.equal(h.calls.async,native?0:1);assert.equal(h.calls.close,1);}
});
test('header/size limits refuse before decoding and actual decoded pixel excess closes without encoding',async()=>{
 const h=harness();assert.equal(await h.run({size:40*1024*1024+1,slice(){throw Error('should not read');}}),null);assert.equal(h.calls.decode,0);
 const large=harness({header:{w:10000,h:10000}});assert.equal(await large.run(new Blob(['x'])),null);assert.equal(large.calls.decode,0);
 const decoded=harness({bitmap:{width:10000,height:10000}});assert.equal(await decoded.run(new Blob(['x'])),null);assert.equal(decoded.calls.close,1);assert.equal(decoded.calls.sync,0);
});
test('corrupt decoder, draw failure, async failure and unexpected dataURL fail closed with bitmap cleanup',async()=>{
 for(const options of[{decodeError:true},{drawError:true},{native:false,asyncError:true},{url:'data:image/png;base64,AAAA'}]){const h=harness(options);assert.equal(await h.run(new Blob(['x'])),null);assert.equal(h.calls.close,options.decodeError?0:1);}
});
test('native photo preparation visibly yields every photo and retains book/owner checks',()=>{
 assert.equal((src.match(/if\(isNative \|\| decoded%10===0 \|\| decoded===/g)||[]).length,2);assert.ok(src.includes('checkBackupWork(work)'));assert.ok(src.includes('beforeWrite:()=>commitBackupWork(work)')||src.includes('beforeWrite: () => commitBackupWork(work)'));
});
