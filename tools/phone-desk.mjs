import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';
export async function runPhoneDesk({client:c,adbRun,capture}){
 const root='D:/tally-native',out='D:/tally-android/verification/desk-device',accountId='desk_device_check',merchant='Desk device verification';
 const results=[];const errors=[];let originalPlace;
 const wait=async fn=>{const start=Date.now();while(Date.now()-start<45000){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,250));}throw Error('Phone pairing timed out');};
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml'};
 const server=createServer(async(req,res)=>{try{const p=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!p.startsWith(resolve(root)+sep))throw Error();res.setHeader('Content-Type',mime[extname(p)]||'application/octet-stream');res.setHeader('Cache-Control','no-store');res.end(await readFile(p));}catch{res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));await mkdir(out,{recursive:true});
 const context=await chromium.launchPersistentContext('D:/tally-android/temp/desk-device-browser',{headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',viewport:{width:1280,height:960}});
 try{
  const info=await c.evaluate(`(async()=>{const s=await import('./js/state.js');return {locked:s.locked(),visible:!document.hidden,place:s.S.kv.deskPlace||null};})()`);assert.equal(info.locked,false,'Unlock Tally Test before pairing');assert.equal(info.visible,true);originalPlace=info.place;
  await c.evaluate(`(async()=>{const s=await import('./js/state.js');if(!s.S.accounts.some(a=>a.id==='${accountId}'))await s.saveAccount({id:'${accountId}',name:'Desk device check',kind:'bank',opening:10000});const ui=await import('./js/ui.js');while(ui.sheetOpen())ui.closeSheet();(await import('./js/app.js')).go('home');})()`);
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',msg=>{if(msg.type()==='error')console.log('PC browser:',msg.text());});page.on('requestfailed',r=>console.log('PC request:',r.url(),r.failure()?.errorText));await page.goto(`http://127.0.0.1:${server.address().port}/connect.html`);
  const pair=async()=>{
   await c.evaluate(`(async()=>{const ui=await import('./js/ui.js');document.querySelector('.desk-status')?.click();document.querySelector('[data-desk="stop"]')?.click();while(ui.sheetOpen())ui.closeSheet();(await import('./js/desk-host.js')).openDesk();})()`);
   await wait(()=>c.evaluate(`!!document.querySelector('#desk-start')`));await c.evaluate(`document.querySelector('#desk-start').click()`);
   const status=await wait(()=>c.evaluate(`Capacitor.Plugins.TallyNative.lanPairStatus().then(s=>s.active?s:null)`));
   const signal=await fetch('http://'+status.address+'/offer',{headers:{Origin:`http://127.0.0.1:${server.address().port}`,'X-Tally-Code':status.pin},signal:AbortSignal.timeout(8000)});console.log('LAN signaling reachability:',signal.status);assert.equal(signal.status,200);
   const payload=await signal.json();assert.deepEqual(Object.keys(payload),['sdp']);assert.equal(typeof payload.sdp,'string');
   capture?.('desk-device/phone-address');
   await page.locator('#address').fill(status.address);await page.locator('#pin').fill(status.pin);await page.locator('#connect').click();
   await page.locator('#approve').waitFor({timeout:45000}).catch(async e=>{console.log('PC pairing screen:',await page.locator('body').textContent());console.log('Phone connection state:',await c.evaluate(`Capacitor.Plugins.TallyNative.lanPairStatus().then(s=>({active:s.active,hasAnswer:!!s.answer}))`));throw e;});const code=await page.locator('.code').textContent();const phoneCode=await wait(()=>c.evaluate(`document.querySelector('.scrim:not(.out) [data-desk="approve"]')?document.querySelector('.scrim:not(.out) .desk-code')?.textContent:null`));assert.equal(code,phoneCode);
   await page.screenshot({path:out+'/pc-approval.png',fullPage:true});capture?.('desk-device/phone-approval');
   assert.equal(await page.locator('#balances').count(),0);await c.evaluate(`document.querySelector('.scrim:not(.out) [data-desk="approve"]').click()`);assert.equal(await page.locator('#balances').count(),0);
   await page.locator('#approve').click();await page.locator('#entry').waitFor({timeout:15000});results.push('Real Android LAN signaling and WebRTC: matching codes, no book before both approvals');
  };
  await pair();await page.locator('#accountId').selectOption(accountId);await page.locator('#amount').fill('3.21');await page.locator('#merchant').fill(merchant);await page.locator('#save').click();await page.getByText('Saved on your phone.',{exact:true}).waitFor();
  const id=await c.evaluate(`import('./js/state.js').then(s=>s.S.tx.find(x=>x.accountId==='${accountId}'&&x.merchant==='${merchant}')?.id)`);assert.ok(id);results.push('PC save committed to real phone');
  await c.evaluate(`(async()=>{const s=await import('./js/state.js');await s.saveTx({...s.S.tx.find(x=>x.id==='${id}'),merchant:'Phone device verification',amount:456});})()`);await page.locator('#entries').getByText('Phone device verification',{exact:true}).waitFor();results.push('Phone edits reach PC');
  await page.locator(`[data-edit="${id}"]`).click();await page.locator('#amount').fill('5.00');await c.evaluate(`(async()=>{const s=await import('./js/state.js');await s.saveTx({...s.S.tx.find(x=>x.id==='${id}'),amount:678});})()`);await page.locator('#stale').waitFor({state:'visible'});await page.locator('#save').click();await page.getByText('The entry changed on your phone. Refresh and try again.',{exact:true}).waitFor();assert.equal(await c.evaluate(`import('./js/state.js').then(s=>s.S.tx.find(x=>x.id==='${id}').amount)`),678);results.push('Real phone concurrent edit rejects stale PC save');
  await page.locator('#refresh').click();await page.waitForTimeout(1500);await page.locator(`[data-edit="${id}"]`).click();await page.waitForTimeout(1500);await page.screenshot({path:out+'/connected.png',fullPage:true});
  capture?.('desk-device/phone-connected');await page.setViewportSize({width:390,height:844});await page.screenshot({path:out+'/mobile-browser.png',fullPage:true});await page.setViewportSize({width:1280,height:960});
  // Device screenshots use adb; Android WebView does not reliably answer Page.captureScreenshot.
  await page.goto(`http://127.0.0.1:${server.address().port}/privacy.html`);await page.goBack();await page.locator('#join').waitFor();assert.equal((await page.locator('body').textContent()).includes('Phone device verification'),false);results.push('Navigation/back cannot restore private book from browser history');
  await pair();assert.equal(await page.locator('#amount').inputValue(),'6.78');results.push('Fresh pairing resumes latest saved entry from phone');
  adbRun(['shell','input','keyevent','3']);await page.locator('#join').waitFor({timeout:15000});assert.equal((await page.locator('body').textContent()).includes('Desk device check'),false);results.push('Android Home/background clears PC private display');
  assert.deepEqual(await page.evaluate(async()=>({local:Object.keys(localStorage),session:Object.keys(sessionStorage),db:(await indexedDB.databases()).map(x=>x.name)})),{local:[],session:[],db:[]});results.push('No PC expense database, localStorage or sessionStorage');
  await page.screenshot({path:out+'/disconnected.png',fullPage:true});assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:results.length,results,errors},null,2));await writeFile(out+'/results.json',JSON.stringify({passed:results.length,results,errors},null,2));
 }finally{
  adbRun(['shell','am','start','-n','io.github.tallymy.dev/io.github.tallymy.MainActivity']);
  try{await c.evaluate(`(async()=>{const s=await import('./js/state.js');await Capacitor.Plugins.TallyNative.stopLanPair();const ids=s.S.tx.filter(x=>x.accountId==='${accountId}'||x.toAccountId==='${accountId}').map(x=>x.id);await s.putAll({del:{tx:ids,accounts:['${accountId}']},edit:true,kv:{deskPlace:${JSON.stringify(originalPlace??null)}}});(await import('./js/app.js')).render();})()`);}catch(e){console.log('Test account cleanup needs checking:',e.message);}
  await context.close();await new Promise(r=>server.close(r));
 }
}

