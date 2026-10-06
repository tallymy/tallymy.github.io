import {S,load,locked} from '../state.js';
import * as db from '../db.js';
import {privacyLocked,onPrivacyChange} from '../lock.js';
import {isNative} from '../native.js';
import {t} from '../i18n.js';
import {openSheet,closeSheet,esc} from '../ui.js';
import {createMainBookHost} from './bootstrap.mjs';
import {mainHostApproved,localRecoveryApproved,pairingFetch} from './gates.mjs';
import {createHostStartup} from './startup.mjs';
import {createReadyRetry} from './ready-retry.mjs';
const startup=createHostStartup(async owned=>createMainBookHost(hostConfig(renderCurrent,owned)));
let renderCurrent=()=>{},readyRetry=null;const host=()=>startup.current();
export function bindMainBookHostReady(render){renderCurrent=render;return readyRetry ||= createReadyRetry({approved:()=>mainHostApproved()===true&&localRecoveryApproved()===true,unlocked:()=>locked()===false,privacyLocked,getGeneration:()=>S.kv.bookGeneration,start:()=>startMainBookHost(renderCurrent),invalidate:invalidateMainBookHost,onPrivacyChange,document,window});}
export const mainBookCard=()=>host()?.card()||'';
export const openMainBookSync=()=>host()?.open()||false;
export const invalidateMainBookHost=reason=>startup.invalidate(reason);
export const getLocalSafety=()=>host()?.safety()||null;
export const openSavedSafety=()=>host()?.safety()?.open()||false;
export const savedSafetyCard=()=>host()?.safety()?.available()?'<section class="card"><h2>'+esc(t('Saved safety copies'))+'</h2><p class="fine">'+esc(t('These copies stay inside Tally. Export a standard backup to keep a separate file.'))+'</p><button class="btn ghost wide" data-act="saved-safety-open">'+esc(t('Choose a safety copy'))+'</button></section>':'';
export function startMainBookHost(render){renderCurrent=render;return startup.start();}
function hostConfig(render,owned){return {state:S,load,locked,privacyLocked,onPrivacyChange,isNative,approved:()=>owned()===true&&mainHostApproved()===true&&localRecoveryApproved()===true,openSheet,closeSheet,t,render,document,window,loadDependencies:async()=>{
  const loadFetcher=pairingFetch();if(typeof loadFetcher!=='function')throw Error('Reviewed local pairing bootstrap is unavailable');
  const fetcher=await loadFetcher();
  const [core,runtime,store,rpc,controller,pair,recovery,image,ui,leaf,io,safetyAccess,safetyRestore,safetyExport]=await Promise.all([import('./sync-core.mjs'),import('./runtime.mjs'),import('./book-store.mjs'),import('./sync-rpc.mjs'),import('./sync-controller.mjs'),import('./lan-pair.mjs'),import('./recovery.mjs'),import('./image-verifier.mjs'),import('./main-book-sync.mjs'),import('./book-sync-ui.js'),import('../io.js'),import('./safety-accessor.mjs'),import('./safety-restore.mjs'),import('./safety-export.mjs')]);
  const {createMainSafetyUi}=await import('./safety-ui.mjs'),{saveFile}=await import('../native.js');
  const nativeService=isNative?await (await import('../native-pair-singleton.js')).getNativePairService():null;
  const allowed=()=>{try{return mainHostApproved()===true&&(!document.hidden||host()?.graceHidden?.()===true)&&locked()===false&&privacyLocked()===false;}catch{return false;}};
  const codec=recovery.recoveryCodec({core,zipStore:io.zipStore,unzip:io.unzip}),verifyImage=image.createImageVerifier({imageInfo:io.imageInfo,authorized:allowed});
  return {db,core,codec,verifyImage,nativeService,leaf,createUi:ui.createMainBookSync,createRuntime:runtime.createSyncHostRuntime,createStore:store.createBookStore,createRpc:rpc.createSyncRpc,createController:controller.createSyncController,createPair:options=>{const facade=isNative?null:fetcher({window,document,authorized:options.allowed});const linked=pair.createLanPair({...options,...(facade?{fetcher:facade.fetch}:{})});return {...linked,close(reason){facade?.cancel();linked.close(reason);},dispose(){facade?.close();linked.dispose();}};},phoneAddress:(await import('../desk-pair.js')).phoneAddress,
   createSafety:({allowed,load,render,document})=>{if(localRecoveryApproved()!==true)return null;
    const api=createMainSafetyUi({authorized:allowed,getGeneration:()=>S.kv.bookGeneration??null,onPrivacyChange,openSheet,closeSheet,t,document,window,mode:isNative?'native':'browser',saveToDevice:prepared=>saveFile(prepared.name,prepared.blob,prepared.mime),requestDownload:prepared=>{const url=URL.createObjectURL(prepared.blob),a=document.createElement('a');a.href=url;a.download=prepared.name;document.body.appendChild(a);try{a.click();}finally{a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}},createOperations:({authorized,onProgress})=>{
     const verifier=image.createImageVerifier({imageInfo:io.imageInfo,authorized}),access=safetyAccess.createSavedCopyAccess({db,core,...codec,verifyImage:verifier,authorized,onProgress});
     const restore=safetyRestore.createSafetyRestore({db,core,...codec,savedSafetyCopy:async()=>{const copy=await access.read({id:'current'});onProgress({stage:'review'});await new Promise(r=>setTimeout(r,0));return copy;},verifyImage:verifier,storageUsage:store.syncStorageUsage,authorized,document,onReplaced:()=>{},reload:async()=>{await load();render();}}),exporter=safetyExport.createSafetyExport({access,core,io,authorized,onProgress});return {access,restore,exporter};}});
    return Object.freeze({available:api.available,open:api.open,cancel:api.cancel,dispose:api.close});}};
 }};
}
