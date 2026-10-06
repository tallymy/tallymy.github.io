// Internal safety archive, kept on this device and sealed by its existing app key.
// Distinct from the user-facing Tally backup format; never claim universal import.
export function recoveryCodec({core,zipStore,unzip}) {
  const max=40*1024*1024,format='tally-sync-recovery/1',encoder=new TextEncoder();
  const fail=message=>{throw Object.assign(new Error(message),{code:'BACKUP'});};
  async function packRecovery({book,photos}) {
    book=core.validateBook(book);if(book.receipts.length+1>65000)fail('Too many receipt files for this safety copy.');const data=encoder.encode(core.canonical({format,book}));
    let total=data.length;const files=[{name:'sync-recovery.json',data}];
    for(const manifest of book.receipts){
      const blob=photos.get(manifest.id);if(!(blob instanceof Blob)||blob.type!==manifest.mime)fail('Safety copy photo missing.');
      total+=blob.size;if(total>max)fail('Safety copy exceeds 40 MB.');
      const bytes=new Uint8Array(await blob.arrayBuffer());await core.verifyReceipt(manifest,bytes);files.push({name:`photos/${manifest.id}.bin`,data:bytes});
    }
    const result=zipStore(files);if(result.size>max)fail('Safety copy exceeds 40 MB.');return result;
  }
  async function unpackRecovery(blob) {
    if(!(blob instanceof Blob)||blob.size>max)fail('Invalid safety copy.');
    const files=await unzip(new Uint8Array(await blob.arrayBuffer()),()=>true,{budget:max,entries:65000});
    const bytes=files['sync-recovery.json'];if(!bytes)fail('Safety copy metadata missing.');
    const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(data.format!==format||Object.keys(data).sort().join(',')!=='book,format')fail('Unsupported safety copy.');
    const book=core.validateBook(data.book),names=new Set(['sync-recovery.json']),photos=new Map();
    for(const manifest of book.receipts){
      const name=`photos/${manifest.id}.bin`,bytes=files[name];names.add(name);
      if(!bytes)fail('Safety copy photo missing.');await core.verifyReceipt(manifest,bytes);photos.set(manifest.id,new Blob([bytes],{type:manifest.mime}));
    }
    if(Object.keys(files).some(name=>!names.has(name)))fail('Unexpected safety copy file.');
    return {book,photos};
  }
  return {packRecovery,unpackRecovery};
}
