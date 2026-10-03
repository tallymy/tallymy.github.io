import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { verifyReminderDraft } from './reminder-device-helper.mjs';
const stage = fileURLToPath(new URL('../../', import.meta.url)), nativeRoot = 'D:/tally-native';
const out = resolve(stage, 'verification/share-ui'); await mkdir(out, { recursive: true });
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.png':'image/png', '.webp':'image/webp' };
const server = createServer(async (req,res) => {
  try {
    const path = new URL(req.url,'http://localhost').pathname, relative = '.' + (path === '/' ? '/index.html' : path);
    const root = ['/js/views/home.js','/js/views/analytics.js','/js/views/setup.js'].includes(path) ? stage : nativeRoot;
    const target = resolve(root,relative); if (!target.startsWith(resolve(root)+sep)) throw Error();
    res.setHeader('Content-Type',mime[extname(target)]||'application/octet-stream'); res.setHeader('Cache-Control','no-store');
    res.end(await readFile(target));
  } catch {res.writeHead(404);res.end();}
});
await new Promise(r => server.listen(0,'127.0.0.1',r)); const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const errors=[], results=[];
async function closeSheets(page) { await page.evaluate(async()=>{const ui=await import('/js/ui.js');while(ui.sheetOpen())ui.closeSheet();}); await page.waitForFunction(()=>document.querySelectorAll('.sheet').length===0); }
async function openSticker(page) {
  await closeSheets(page);
  await page.evaluate(async()=>{const st=await import('/js/state.js'), home=await import('/js/views/home.js');await st.setSetting('noSpend',[st.today(),st.today().slice(0,7)+'-01']);await home.act['sticker-sheet']({dataset:{ym:st.today().slice(0,7),day:'1'},closest:()=>null});});
  await page.locator('[data-x="save"]:enabled').waitFor({timeout:10000}).catch(async e=>{console.log('Sticker diagnostic',await page.evaluate(async()=>{const st=await import('/js/state.js');return{today:st.today(),settings:st.settings(),body:document.body.textContent};}));throw e;});
}
async function fit(page, selectors) {
  const bad=await page.evaluate(selectors=>selectors.flatMap(s=>[...document.querySelectorAll(s)].filter(el=>el.getClientRects().length).filter(el=>{const r=el.getBoundingClientRect();return r.left<-.5||r.right>innerWidth+.5||el.scrollWidth>el.clientWidth+1;}).map(el=>({selector:s,text:el.textContent,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right}))),selectors);
  assert.deepEqual(bad,[]); return bad;
}
async function capture(page,name){
  await page.evaluate(()=>{for(const a of document.getAnimations()){if(a.effect?.getComputedTiming().iterations!==Infinity)try{a.finish();}catch{}}document.querySelectorAll('.toast,#toast').forEach(el=>el.remove());});
  await page.screenshot({path:resolve(out,name),animations:'disabled'});
}
try {
  const context=await browser.newContext({viewport:{width:320,height:844},reducedMotion:'reduce',serviceWorkers:'block'});
  await context.addInitScript(()=>{
    window.__calls=[];window.__shareMode='ok';window.__saveCancelled=false;
    window.Capacitor={isNativePlatform:()=>true,Plugins:{App:{addListener:async()=>({remove(){}}),getInfo:async()=>({id:'test',version:'1.13.0',build:'3'})},
      TallyNative:{addListener:async()=>({remove(){}}),takeShared:async()=>({files:[]}),releaseShared:async()=>{},reserveOutput:async o=>({path:'out/test-'+o.name,uri:'file:///cache/out/test-'+o.name}),releaseOutput:async()=>{},saveToDevice:async o=>{window.__calls.push(['save',o]);return{cancelled:window.__saveCancelled};},openExternal:async()=>{throw Error('External launch prohibited');}},
      Filesystem:{writeFile:async o=>{window.__calls.push(['cache',o.path]);},appendFile:async()=>{},deleteFile:async()=>{},getUri:async o=>({uri:'content://test/'+o.path})},
      Share:{share:async o=>{window.__calls.push(['share',o]);if(window.__shareMode==='cancel')throw Error('cancelled');if(window.__shareMode==='fail')throw Error('unavailable');}}
    }};
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/index.html');await page.locator('.welcome').waitFor({timeout:10000}).catch(async e=>{console.log('Startup diagnostics',errors,await page.locator('body').textContent());throw e;});
  await page.evaluate(async()=>{const st=await import('/js/state.js');await st.replaceAll({accounts:[{id:'bank',name:'Test bank',kind:'bank',opening:10000}],tx:[],recurring:[],kv:{settings:{tourDone:true,seenVersion:'1.13.0',lang:'en',noSpend:[st.today()]}}});(await import('/js/app.js')).go('home');});
  results.push({check:'reminder actual DOM',checks:await verifyReminderDraft(page)});
  for(const theme of ['dark','light'])for(const lang of ['en','ta']){
    await page.evaluate(async({theme,lang})=>{await(await import('/js/i18n.js')).setLang(lang);document.documentElement.dataset.theme=theme;document.documentElement.style.fontSize='130%';},{theme,lang});
    await openSticker(page);await fit(page,['.sheethead','[data-x="share"]','[data-x="save"]','.stk-row']);
    await capture(page,`sticker-${theme}-${lang}-320-130.png`);
    await closeSheets(page);await page.evaluate(async()=>{(await import('/js/views/analytics.js')).openReminder({name:'Ali',sen:1234});});
    await fit(page,['#reminder-draft','#reminder-share','#reminder-copy','#reminder-cancel','.sheetfoot']);
    await capture(page,`reminder-${theme}-${lang}-320-130.png`);
    results.push({theme,lang,width:320,size:130,fit:true});
  }
  await page.evaluate(async()=>{await(await import('/js/i18n.js')).setLang('en');window.__calls=[];});await openSticker(page);
  await page.locator('[data-x="share"]').click();await page.waitForFunction(()=>window.__calls.some(x=>x[0]==='share'));
  const shared=await page.evaluate(()=>window.__calls.find(x=>x[0]==='share')[1]);assert.equal(shared.files.length,1);assert.equal(shared.text,undefined);assert.equal(shared.url,undefined);
  assert.equal(await page.evaluate(()=>window.__calls.some(x=>x[0]==='save')),false);
  await page.evaluate(()=>{window.__shareMode='cancel';});await page.locator('[data-x="share"]').click();await page.locator('[data-x="share"]:enabled').waitFor();
  assert.equal(await page.locator('[data-x="save"]').isEnabled(),true);
  await page.evaluate(()=>{window.__shareMode='fail';});await page.locator('[data-x="share"]').click();await page.locator('[data-x="share"]:enabled').waitFor();assert.match(await page.locator('body').textContent(),/could not be shared/);
  await page.evaluate(()=>{window.__saveCancelled=true;});await page.locator('[data-x="save"]').click();await page.locator('[data-x="save"]:enabled').waitFor();assert.equal(await page.locator('.howto').count(),0);
  await page.evaluate(()=>{window.__saveCancelled=false;});await page.locator('[data-x="save"]').click();await page.locator('.howto').waitFor();
  results.push({check:'native file chooser stub',fileOnly:true,noSaveBeforeShare:true,cancelRetry:true,failureRetry:true,saveCancelNoHelp:true,saveSuccessHelp:true});
  for(const mode of ['simple','standard']){
    await closeSheets(page);
    await page.evaluate(async()=>{const st=await import('/js/state.js');await st.replaceAll({accounts:[],tx:[],recurring:[],kv:{settings:{tourDone:true,seenVersion:'1.13.0',lang:'en'}}});(await import('/js/views/setup.js')).act['start-fresh']();});
    const before=await page.evaluate(async()=>JSON.stringify((await import('/js/state.js')).settings().features||{}));
    await page.locator('#sf-cash').fill('23.45');await page.locator('#sf-bank').fill('100.00');
    await page.locator('[data-act="sf-mode"][data-v="simple"]').click();assert.match(await page.locator('#sf-mode-summary').textContent(),/Simple selected/);
    assert.equal(await page.locator('#sf-mode-summary').getAttribute('aria-live'),'polite');
    await page.locator('[data-act="sf-mode"][data-v="standard"]').click();assert.match(await page.locator('#sf-mode-summary').textContent(),/Standard selected/);
    assert.equal(await page.locator('#sf-cash').inputValue(),'23.45');assert.equal(await page.locator('#sf-bank').inputValue(),'100.00');
    assert.equal(await page.evaluate(async()=>JSON.stringify((await import('/js/state.js')).settings().features||{})),before);
    await page.locator('[data-act="sf-mode"][data-v="'+mode+'"]').click();await page.locator('#sf-cash').fill('oops');await page.locator('[data-act="sf-go"]').click();assert.ok(await page.locator('#sf-err').textContent());
    assert.equal(await page.evaluate(async()=>JSON.stringify((await import('/js/state.js')).settings().features||{})),before);
    await page.locator('#sf-cash').fill('23.45');await fit(page,['#sf-mode-summary','#sf-cash','#sf-bank','[data-act="sf-mode"]']);
    await page.evaluate(()=>document.querySelector('.sheet').scrollTop=0);await capture(page,`setup-${mode}-light-320-130.png`);
    await page.locator('[data-act="sf-go"]').click();await page.locator('#sf-cash').waitFor({state:'detached'});
    assert.equal(await page.evaluate(async()=>(await import('/js/features.js')).on('receipts')),mode==='standard');
    assert.equal(await page.getByRole('button',{name:'Scan a receipt',exact:true}).count()>0,mode==='standard');
    results.push({check:'setup mode '+mode,preservesAmounts:true,noEarlyPersistence:true,invalidAmountNoPersistence:true,scanAfterStart:mode==='standard'});
  }
  const fallback=await browser.newContext({viewport:{width:320,height:844},serviceWorkers:'block'}), fp=await fallback.newPage();fp.on('pageerror',e=>errors.push(e.message));await fp.goto(base+'/index.html?app');await fp.locator('.welcome').waitFor();
  await fp.evaluate(async()=>{const st=await import('/js/state.js');await st.replaceAll({accounts:[{id:'bank',name:'Test',kind:'bank',opening:10000}],tx:[],recurring:[],kv:{settings:{tourDone:true,seenVersion:'1.13.0',noSpend:[st.today()]}}});});await openSticker(fp);assert.equal(await fp.locator('[data-x="share"]').count(),0);assert.equal(await fp.locator('[data-x="save"]').isEnabled(),true);
  results.push({check:'browser Save fallback',pass:true});assert.deepEqual(errors,[]);
  await writeFile(resolve(out,'checks.json'),JSON.stringify({results,errors},null,2));console.log(JSON.stringify({results,errors},null,2));
} finally {await browser.close();await new Promise(r=>server.close(r));}
