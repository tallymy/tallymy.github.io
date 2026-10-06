// Full ordinary-book presentation; runtime/controller remain the only mutation owners.
import {validateReview,reviewHtml,escape as esc} from './review-ui.mjs';
export const REQUIRED=['completeBook','bidirectional','durableBoth','receipts','conflictReview','localTransport','manualPairing','bilateralApproval'];
const SHA=/^[a-f0-9]{64}$/;
const phases=new Set(['intro','inspecting','choose','backups','review','approved','conflicts','preparing','prepared','committed-pending','recovery-required','recovery-review','recovery-approved','acknowledging','ready','offline','error']);
const literal=(x,...a)=>x.replace(/\{(\d+)\}/g,(_,i)=>a[Number(i)]??'');
export function controllerView(controller){
 const s=controller.state();if(s?.schema!=='tally.sync-controller/1'||!['computer','phone'].includes(s.role)||!phases.has(s.phase))throw Error('Unsupported sync state');
 const proof=b=>b?.confirmed===true&&typeof b.snapshotHash==='string'&&SHA.test(b.snapshotHash)&&typeof b.archiveSha==='string'&&SHA.test(b.archiveSha)&&Number.isSafeInteger(b.bytes)&&b.bytes>0;
 const own=s.role,other=own==='computer'?'phone':'computer';return {phase:s.phase,role:own,source:['computer','phone'].includes(s.source)?s.source:null,
 computer:own==='computer'?s.local:s.peer,phone:own==='phone'?s.local:s.peer,backups:{[own]:proof(s.backups?.local),[other]:proof(s.backups?.peer)},approved:s.approved===true,
 planToken:typeof s.planHash==='string'&&SHA.test(s.planHash)?s.planHash:null,summary:s.review,peerApproved:s.peerApproved===true,conflicts:Array.isArray(s.conflicts)?s.conflicts.map(c=>({id:String(c.id??''),kind:String(c.kind??'')})):[],bothConfirmed:s.bothConfirmed===true,busy:s.busy===true,errorCode:s.errorCode==='DATES'?'DATES':null};
}
const shell=(body,t,alert=false)=>`<div class="sync-sheet"><h2 class="sh-title" tabindex="-1">${esc(t('Sync this book'))}</h2><div class="main-sync-content" role="${alert?'alert':'status'}" aria-live="polite" aria-atomic="false">${body}</div><div class="sheetfoot"><button class="btn ghost wide" data-act="sheet-close">${esc(t('Close'))}</button></div></div>`;
export function sharingPanel(view,t=literal){
 if(view?.schema!=='tally.sync-host/1'||!['sharing','starting'].includes(view.phase)||!['computer','phone'].includes(view.role))throw Error('Unsupported consent state');
 const p=x=>`<p>${esc(t(x))}</p>`;
 return shell(p('Allow book sharing for this connection?')+p('Matching numbers only pairs the devices. Book sharing needs your permission on each device.')+
 p(view.sharing?.local===true?'You allowed book sharing.':'You have not allowed book sharing yet.')+p(view.sharing?.peer===true?'The other device allowed book sharing.':'Waiting for permission on the other device.')+
 (view.phase==='starting'?p('Opening the shared connection…'):`<button class="btn wide" data-main-sync="grant"${view.sharing?.canGrant!==true||view.busy===true?' disabled':''}>${esc(t('Allow book sharing'))}</button>`)+
 `<button class="btn ghost wide" data-main-sync="revoke">${esc(t('Disconnect without syncing'))}</button>`,t);
}
export function controllerPanel(v,t=literal,{diff=null,page=0,recovery=null,accounts=[]}={}){
 const p=x=>`<p>${esc(t(x))}</p>`;const btn=(label,action,disabled=false,choice='')=>`<button class="btn ghost wide" data-main-sync="${action}"${choice?` data-choice="${choice}"`:''}${disabled||v.busy?' disabled':''}>${esc(t(label))}</button>`;
 const books=()=>['computer','phone'].map(d=>`<div class="rowb"><span class="grow"><b>${esc(t(d==='computer'?'Computer book':'Phone book'))}</b><small>${esc(t('{0} accounts · {1} entries',v[d]?.accounts??0,v[d]?.transactions??0))}</small></span></div>`).join('');
 const valid=!!diff&&diff.planHash===v.planToken&&diff.targetRevision===v.summary?.targetRevision;
 const recovered=['recovery-review','recovery-approved'].includes(v.phase);
 let body='';
 if(v.phase==='intro')body=btn('Compare the books before making changes.','inspect')+btn('Check an unfinished sync','recovery-inspect');
 if(v.phase==='inspecting')body=p('Comparing both books…');
 if(v.phase==='choose')body=p('This copies one whole book to both devices, rather than merging them. The other book is replaced only after a safety copy is saved on each device and both approvals.')+books()+btn('Start from the computer book','choose',false,'computer')+btn('Start from the phone book','choose',false,'phone');
 if(v.phase==='backups')body=p('Save safety copies on both devices')+p(v.source==='computer'?'Computer book selected':v.source==='phone'?'Phone book selected':'Review the changes in both books.')+['computer','phone'].map(d=>p(d==='computer'?'Computer book':'Phone book')+p(v.backups[d]?'Safety copy saved on this device':'Safety copy not saved yet')).join('')+p('On each device, save its own safety copy. These copies stay inside Tally; they are not downloaded backup files.')+btn('Save a safety copy on this device','backup')+btn('Check the other device','refresh');
 if(['review','approved','recovery-review','recovery-approved'].includes(v.phase)){
  body=p(recovered?'Review the unfinished sync':'Review before syncing')+books()+p(v.source==='computer'?'Computer book selected':v.source==='phone'?'Phone book selected':'Review the changes in both books.');
  if(recovered)body+=p('These differences compare this book with the agreed checkpoint. Finishing confirmation keeps edits made after a completed copy.');
  body+=valid?reviewHtml(diff,{page,t,accounts,recovery:recovered}):p('The current review is unavailable.');
  body+=p('Approve these changes on each device before syncing.')+btn(recovered?'Approve finishing this sync':'Approve these changes',recovered?'recovery-approve':'approve',!valid||v.approved)+btn('Check the other device',recovered?'recovery-refresh':'refresh');
  body+=p(v.peerApproved?'The other device approved this plan.':'Waiting for the other device to approve this plan.');
  body+=v.role==='computer'?btn(recovered?'Finish reviewed sync':'Sync reviewed changes',recovered?'recovery-coordinate':'coordinate',!valid||!v.approved||!v.peerApproved||(!recovered&&(!v.backups.computer||!v.backups.phone))):p('Start syncing from the computer after both approvals.');
 }
 if(v.phase==='conflicts')body=p('Both books have changes that need review. Nothing will be merged automatically.')+`<ul class="list">${v.conflicts.map(c=>`<li>${esc(c.kind)} · ${esc(c.id)}</li>`).join('')}</ul>`+p('Keep both books and their backups. Conflict resolution is not available here yet.');
 if(['preparing','prepared','committed-pending','acknowledging'].includes(v.phase))body=p('Syncing the books…')+p('Keep both devices open until syncing finishes.');
 if(v.phase==='recovery-required')body=p('A previous sync still needs confirmation. Keep both books and backups; do not start a replacement sync.')+(!recovery?btn('Check an unfinished sync','recovery-inspect'):recovery.supported===true?p('Both devices must review and approve this unfinished sync again.')+btn('Check the other device','recovery-refresh'):p('This checkpoint cannot be resumed here. Your safety copies remain inside Tally. Exporting or restoring them is not available here yet.'));
 if(v.phase==='ready')body=p(v.bothConfirmed?'Both books are up to date.':'Waiting for both devices to confirm.');
 if(v.phase==='offline')body=p('Offline. Keep using this book; reconnect when you want to sync.');
 if(v.phase==='error')body=p(v.errorCode==='DATES'?"The other device's bill dates look wrong. Check its date and try again":'Sync could not finish. Check both books before trying again.')+btn('Check an unfinished sync','recovery-inspect');
 return shell(body,t,['error','recovery-required','conflicts'].includes(v.phase));
}

export function createMainBookSync({state,locked,privacyLocked,onPrivacyChange,approvedProvider=()=>false,bindOwnedCommit,document:doc,window:win,openSheet,dismissSheet,leaf,t=literal,onAvailability=()=>{}}){
 if(!state||typeof locked!=='function'||typeof privacyLocked!=='function'||typeof onPrivacyChange!=='function'||typeof approvedProvider!=='function'||typeof bindOwnedCommit!=='function'||!doc||!win||typeof openSheet!=='function'||typeof dismissSheet!=='function'||!leaf)throw Error('Missing lifecycle integration');
 let host=null,epoch=0,panel=null,disposePanel=null,subscription=null,session=null,destroyed=false,suppressLeafCancel=false,invalidating=false,diff=null,page=0,recovery=null,pending=false;
 const generation=()=>state.kv?.bookGeneration;
 const permitted=()=>{try{return approvedProvider()===true;}catch{return false;}};
 const allowed=()=>{try{return !destroyed&&(!doc.hidden||host?.graceHidden?.()===true)&&locked()===false&&privacyLocked()===false&&permitted();}catch{return false;}};
 const capable=()=>permitted()&&!!host&&['computer','phone'].includes(host.role)&&host.lifecycleReady===true&&REQUIRED.every(k=>host.capabilities?.[k]===true)&&['subscribe','cancel','controller','getPairingView','requestPairing'].every(k=>typeof host[k]==='function');
 const ticket=()=>({epoch,generation:generation()});const current=token=>allowed()&&token?.epoch===epoch&&token.generation===generation();
 function clear(){disposePanel?.();disposePanel=null;const old=panel;panel=null;diff=null;recovery=null;page=0;pending=false;if(old){old.innerHTML='';dismissSheet(old);}}
 function invalidate(reason){if(invalidating)return;invalidating=true;try{epoch++;session=null;clear();leaf.installSyncUiBridge(null);try{Promise.resolve(host?.cancel(reason)).catch(()=>{});}catch{}onAvailability();}finally{invalidating=false;}}
 function install(next){invalidate('superseded');subscription?.();subscription=null;host=next;if(capable()){subscription=host.subscribe(refresh);if(typeof subscription!=='function'){subscription=null;host=null;throw Error('Async or invalid subscription');}}onAvailability();}
 const stopOwned=bindOwnedCommit(event=>{
  // This callback is registered only with the actual runtime's verified owned-commit seam.
  const controller=host?.controller();if(!controller||typeof controller.state!=='function')throw Error('Missing owned controller');const view=controllerView(controller);if(view.role!==host.role||view.planToken!==event?.planId)throw Error('Wrong owned plan');
  if(!session||!allowed()||event?.kind!=='sync-commit'||typeof event.planId!=='string'||!SHA.test(event.planId)||event.expectedGeneration!==session.generation||event.actualGeneration!==generation()||event.actualGeneration===event.expectedGeneration&&view.summary?.mode!=='reconcile')throw Error('Unverified owned generation');
  session.generation=event.actualGeneration;diff=null;
 });
 function pairedView(){const v=host.getPairingView();if(v?.schema!=='tally.sync-host/1'||v.role!==host.role||v.native!==(host.role==='phone'))throw Error('Unsupported host state');return v;}
 function bridge(){return {capabilities:host.capabilities,getView:()=>{const v=pairedView();if(['sharing','starting','controller'].includes(v.phase))return {phase:'intro',native:v.native};return {...v,phase:v.phase==='error'?'error':v.phase, pairing:{...v.pairing,approvalCode:typeof v.pairing?.approvalCode==='string'&&/^\d{12}$/.test(v.pairing.approvalCode)?v.pairing.approvalCode.replace(/(\d{4})(\d{4})(\d{4})/,'$1 $2 $3'):v.pairing?.approvalCode}};},subscribe:fn=>host.subscribe(()=>{const v=pairedView();if(!['sharing','starting','controller'].includes(v.phase)){fn();hideRemember();}}),cancel:()=>{if(session&&!suppressLeafCancel)invalidate('panel-closed');},request:async(action,payload)=>{
  if(!session||!current(session))throw Error('Cancelled');const own=session;
  if(!['start','connect','approve','retry'].includes(action))throw Error('Unsupported pairing action');const v=pairedView();
  if(action==='approve'&&!(typeof v.pairing?.approvalCode==='string'&&/^(?:\d{12}|\d{4} \d{4} \d{4})$/.test(v.pairing.approvalCode)))throw Error('Invalid approval code');
  const exact=action==='connect'?{address:payload.address,code:payload.code,rememberAddress:v.pairing.canRememberAddress===true&&payload.rememberAddress===true}:{};
  await host.requestPairing(action==='retry'?'start':action,exact,{allowed:()=>current(own)});if(!current(own))throw Error('Cancelled');refresh();
 }};}
 function paint(html,phase){const oldPhase=panel.dataset.mainSyncPhase,focused=doc.activeElement?.dataset?.mainSync,choice=doc.activeElement?.dataset?.choice;panel.innerHTML=html;panel.dataset.mainSyncPhase=phase;
  if(pending){panel.setAttribute('aria-busy','true');for(const b of panel.querySelectorAll('[data-main-sync]'))b.disabled=true;}else panel.removeAttribute('aria-busy');
  if(oldPhase&&oldPhase!==phase)panel.querySelector('.sh-title')?.focus();else if(focused){const replacement=[...panel.querySelectorAll('[data-main-sync]')].find(b=>b.dataset.mainSync===focused&&b.dataset.choice===choice&&!b.disabled);(replacement||panel.querySelector('.sh-title'))?.focus();}
 }
 function refresh(){
  if(!panel)return;if(!session||!current(session)){invalidate('lifecycle');return;}
  const controller=host.controller();let pv;try{pv=pairedView();}catch{invalidate('unsupported');return;}
  if(!controller&&!['sharing','starting'].includes(pv.phase)){if(!disposePanel){diff=null;recovery=null;leaf.installSyncUiBridge(bridge());panel.innerHTML=leaf.syncPanelHtml({...leaf.syncUiView({},host.role==='phone'),native:host.role==='phone'});disposePanel=leaf.bindSyncPanel(panel,{native:host.role==='phone'});hideRemember();}return;}
  suppressLeafCancel=true;disposePanel?.();disposePanel=null;leaf.installSyncUiBridge(null);suppressLeafCancel=false;
  if(!controller){diff=null;paint(sharingPanel(pv,t),pv.phase);return;}
  try{const v=controllerView(controller);if(v.role!==host.role)throw Error('Wrong role');
   if(['review','approved','recovery-review','recovery-approved'].includes(v.phase)&&v.planToken){const review=controller.review(v.planToken);if(review&&typeof review.then==='function')throw Error('Async review is unsupported');const validated=validateReview(review,v.summary,v.planToken);if(diff?.planHash!==validated.planHash||diff?.targetRevision!==validated.targetRevision)page=0;diff=structuredClone(validated);}else diff=null;
   paint(controllerPanel(v,t,{diff,page,recovery,accounts:state.accounts}),v.phase);
  }catch{diff=null;paint(shell(`<p>${esc(t('The current review is unavailable.'))}</p>`,t,true),'error');}
 }
 async function action(event){
  const paging=event.target.closest('[data-review-page]');if(paging&&!paging.disabled&&diff&&session&&current(session)&&!pending){page=Number(paging.dataset.reviewPage);refresh();panel?.querySelector('.sync-review')?.focus();return;}
  const button=event.target.closest('[data-main-sync]');if(!button||button.disabled||pending||!session||!current(session))return;const own=session,a=button.dataset.mainSync,controller=host.controller();
  if(!controller){const v=pairedView();if(!['sharing','starting'].includes(v.phase))return;if(a==='revoke'){invalidate('sharing-revoked');return;}if(a!=='grant'||v.sharing.canGrant!==true||v.busy===true)return;
   pending=true;refresh();try{await host.requestPairing('grant-sharing',{}, {allowed:()=>current(own)});}catch{}finally{if(session===own)pending=false;if(current(own))refresh();}return;}
  const v=controllerView(controller);if(v.busy)return;const actions={intro:['inspect','recovery-inspect'],choose:['choose'],backups:['backup','refresh'],review:['approve','refresh','coordinate'],approved:['refresh','coordinate'],'recovery-required':['recovery-inspect','recovery-refresh'],'recovery-review':['recovery-approve','recovery-refresh','recovery-coordinate'],'recovery-approved':['recovery-refresh','recovery-coordinate'],error:['recovery-inspect']}[v.phase]||[];if(!actions.includes(a))return;
  if(a==='choose'&&!['computer','phone'].includes(button.dataset.choice))return;
  if(['approve','recovery-approve','coordinate','recovery-coordinate'].includes(a)){if(!diff||diff.planHash!==v.planToken||diff.targetRevision!==v.summary?.targetRevision)return;if(a.endsWith('coordinate')&&(v.role!=='computer'||!v.approved||!v.peerApproved||a==='coordinate'&&(!v.backups.computer||!v.backups.phone)))return;if(a.endsWith('approve')&&v.approved)return;}
  if(a==='recovery-refresh'&&v.phase==='recovery-required'&&recovery?.supported!==true)return;
  pending=true;refresh();try{const result=await ({inspect:()=>controller.inspect(),choose:()=>controller.choose(button.dataset.choice),backup:()=>controller.makeBackup(),refresh:()=>controller.refreshPeer(),approve:()=>controller.approve(v.planToken),coordinate:()=>controller.coordinate(),'recovery-inspect':()=>controller.inspectRecovery(),'recovery-refresh':()=>controller.refreshRecovery(),'recovery-approve':()=>controller.approveRecovery(v.planToken),'recovery-coordinate':()=>controller.coordinateRecovery()})[a]();if(current(own)&&a==='recovery-inspect')recovery=result;}
  catch{}finally{if(session===own)pending=false;if(current(own)&&panel)refresh();}
 }
 function open(){if(!capable()||!allowed())return false;if(panel)return true;epoch++;session=ticket();leaf.installSyncUiBridge(bridge());panel=openSheet('',{label:t('Sync this book'),onClose:()=>invalidate('panel-closed')});panel.addEventListener('click',action);
  const v=pairedView();if(host.controller()||['sharing','starting'].includes(v.phase))refresh();else{panel.innerHTML=leaf.syncPanelHtml({...leaf.syncUiView({accounts:state.accounts.length,entries:state.tx.length},host.role==='phone'),native:host.role==='phone'});disposePanel=leaf.bindSyncPanel(panel,{local:{accounts:state.accounts.length,entries:state.tx.length},native:host.role==='phone'});hideRemember();}return true;}
 function hideRemember(){if(pairedView().pairing.canRememberAddress!==true)panel?.querySelector('.sync-remember')?.remove();}
 // Leaf subscriptions own their pairing repaint; hide unsupported persistence after each notification.
 function changed(){refresh();if(panel&&!host.controller())hideRemember();}
 function card(){return capable()?leaf.syncSettingsCard({accounts:state.accounts.length,entries:state.tx.length}):'';}
 const hidden=()=>{if(doc.hidden&&host?.graceHidden?.()!==true)invalidate('hidden');},leave=()=>invalidate('pagehide'),replaced=()=>invalidate('book-replaced');doc.addEventListener('visibilitychange',hidden);win.addEventListener('pagehide',leave);doc.addEventListener('tally:book-replaced',replaced);const stopPrivacy=onPrivacyChange(value=>{if(value!==false)invalidate('locked');});
 return Object.freeze({install(next){install(next);if(subscription){subscription();subscription=host.subscribe(changed);if(typeof subscription!=='function'){subscription=null;host=null;throw Error('Async or invalid subscription');}}},open,card,available:capable,captureGuard:()=>{const own=ticket();return()=>current(own);},invalidate,destroy(){if(destroyed)return;invalidate('destroy');destroyed=true;subscription?.();stopPrivacy?.();stopOwned?.();doc.removeEventListener('visibilitychange',hidden);win.removeEventListener('pagehide',leave);doc.removeEventListener('tally:book-replaced',replaced);host=null;}});
}
