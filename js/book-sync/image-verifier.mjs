// Validate receipt bytes without changing them. The store performs hash/length checks.
export function createImageVerifier({ imageInfo, decode = globalThis.createImageBitmap,
  authorized, maxBytes = 40 * 1024 * 1024, maxPixels = 50_000_000 } = {}) {
  if (typeof imageInfo !== 'function' || typeof decode !== 'function' || typeof authorized !== 'function') throw new TypeError('Image verifier dependencies required');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 40 * 1024 * 1024 || !Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > 50_000_000) throw new TypeError('Invalid image bounds');
  const fail = code => { throw Object.assign(new Error(code === 'LOCKED' ? 'Receipt verification stopped.' : 'A receipt image is unreadable or too large.'), { code }); };
  const check = () => { let ok; try { ok = authorized(); } catch {} if (ok !== true) fail('LOCKED'); };
  function sniff(b) {
    if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
    if (b.length >= 8 && [137,80,78,71,13,10,26,10].every((n,i)=>b[i]===n)) return 'image/png';
    if (b.length >= 12 && b[0]===82 && b[1]===73 && b[2]===70 && b[3]===70 && b[8]===87 && b[9]===69 && b[10]===66 && b[11]===80) return 'image/webp';
    fail('RECEIPTS');
  }
  function webpInfo(b,size) {
    const dv=new DataView(b.buffer,b.byteOffset,b.byteLength),u24=i=>b[i]+b[i+1]*256+b[i+2]*65536;
    if(dv.getUint32(4,true)+8!==size)fail('RECEIPTS');
    let canvas=null;
    for(let p=12,n=0;p+8<=b.length&&n++<128;){
      const tag=String.fromCharCode(...b.subarray(p,p+4)),length=dv.getUint32(p+4,true),start=p+8,end=start+length;
      if(end>size||end<start)fail('RECEIPTS');
      let dims;
      if(tag==='ANIM'||tag==='ANMF')fail('RECEIPTS');
      if(tag==='VP8X'){
        if(length!==10||start+10>b.length||(b[start]&2))fail('RECEIPTS');
        canvas={w:u24(start+4)+1,h:u24(start+7)+1};
        if(canvas.w*canvas.h>maxPixels)fail('RECEIPTS');
      }else if(tag==='VP8 '){
        if(length<10||start+10>b.length||(b[start]&1)||b[start+3]!==157||b[start+4]!==1||b[start+5]!==42)fail('RECEIPTS');
        dims={w:dv.getUint16(start+6,true)&16383,h:dv.getUint16(start+8,true)&16383};
      }else if(tag==='VP8L'){
        if(length<5||start+5>b.length||b[start]!==47)fail('RECEIPTS');
        const bits=dv.getUint32(start+1,true);if(bits>>>29)fail('RECEIPTS');
        dims={w:(bits&16383)+1,h:((bits>>>14)&16383)+1};
      }
      if(dims){if(!dims.w||!dims.h||dims.w*dims.h>maxPixels||canvas&&(canvas.w!==dims.w||canvas.h!==dims.h))fail('RECEIPTS');return dims;}
      p=end+(length&1);
    }
    fail('RECEIPTS');
  }
  return async blob => {
    check();
    if (!(blob instanceof Blob) || blob.size < 1 || blob.size > maxBytes || !['image/jpeg','image/png','image/webp'].includes(blob.type)) fail('RECEIPTS');
    const bytes = new Uint8Array(await blob.slice(0, 1 << 20).arrayBuffer()); check();
    if (sniff(bytes) !== blob.type) fail('RECEIPTS');
    const header = blob.type==='image/webp'?webpInfo(bytes,blob.size):imageInfo(bytes);
    // Unbounded/late dimension headers are refused before browser allocation.
    if (!header || !Number.isSafeInteger(header.w) || !Number.isSafeInteger(header.h) || header.w < 1 || header.h < 1 || header.w * header.h > maxPixels) fail('RECEIPTS');
    let bitmap;
    try {
      bitmap = await decode(blob, { imageOrientation: 'from-image' }); check();
      if (!bitmap || !Number.isSafeInteger(bitmap.width) || !Number.isSafeInteger(bitmap.height) || bitmap.width < 1 || bitmap.height < 1 || bitmap.width * bitmap.height > maxPixels) fail('RECEIPTS');
      return { mime: blob.type, width: bitmap.width, height: bitmap.height };
    } catch (error) {
      if (error?.code === 'LOCKED' || error?.code === 'RECEIPTS') throw error;
      fail('RECEIPTS');
    } finally { bitmap?.close?.(); }
  };
}
