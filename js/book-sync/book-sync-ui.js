// Presentation only. Normal Tally local-book bootstrap remains the owner of storage.
// A host bridge must verify complete portable records/photos and guard atomic commits.
import { literalT as t } from './i18n.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const PHASES=new Set(['intro','connect','approve','choose','backup','review','syncing','ready','offline','error']);
export const SYNC_UI_CAPABILITIES=['completeBook','bidirectional','durableBoth','receipts','conflictReview','localTransport','manualPairing','bilateralApproval'];
const CLOSE='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
let bridge=null,bridgeGeneration=0;
const panels=new Set();
export const syncUiAvailable=()=>!!bridge&&typeof bridge.subscribe==='function'&&SYNC_UI_CAPABILITIES.every(key=>bridge.capabilities?.[key]===true);
export function installSyncUiBridge(next){
  if(next!==null&&(!next||typeof next.getView!=='function'||typeof next.request!=='function'))throw Error('Invalid sync UI bridge');
  bridge=next;bridgeGeneration++; // No transport, ledger, persistence or defaults are implemented here.
  for(const dispose of [...panels])dispose(); // Immediately clear secrets and cancel the superseded session.
}
function count(value){return Number.isSafeInteger(value)&&value>=0?value:0;}
function summary(book){return book?`<p class="fine">${esc(t('{0} accounts · {1} entries',count(book.accounts),count(book.entries)))}</p>`:`<p class="fine">${esc(t('Connect to compare this book.'))}</p>`;}
function enabled(action,view){
  if(!syncUiAvailable())return false;
  if(action==='apply')return view.phase==='review'&&typeof view.planToken==='string'&&view.planToken.length>0&&view.backups?.computer?.status==='confirmed'&&view.backups?.phone?.status==='confirmed'&&view.reviewComplete===true&&view.receiptsVerified===true&&Array.isArray(view.conflicts)&&view.conflicts.length===0;
  if(action==='review')return view.backups?.computer?.status==='confirmed'&&view.backups?.phone?.status==='confirmed';
  if(action==='connect')return view.pairing?.manualRole!=='host'&&!view.native;
  if(action==='approve')return /^[0-9]{4} [0-9]{4} [0-9]{4}$/.test(view.pairing?.approvalCode||'');
  if(action==='choose')return !!view.computer&&!!view.phone;
  if(action==='resolve')return bridge.capabilities?.perDifferenceResolution===true;
  return true;
}
function button(label,action,view,{ghost=false,device='',id='',choice=''}={}){return `<button class="btn${ghost?' ghost':''} wide" data-sync-action="${esc(action)}"${device?` data-device="${esc(device)}"`:''}${id?` data-conflict="${esc(id)}"`:''}${choice?` data-choice="${esc(choice)}"`:''}${enabled(action,view)?'':' disabled'}>${esc(t(label))}</button>`;}
function backupStatus(value){return value?.status==='confirmed'?t('Backup file confirmed'):value?.status==='started'?t('Backup started; find the file before relying on it.'):t('Backup not confirmed');}
export function syncSettingsCard(local={}){
  return `<section class="card" id="s-book-sync"><h2>${esc(t('Sync this book'))}</h2><p class="fine">${esc(t('Keep a local book on this computer and phone. Sync when they are together; keep working offline.'))}</p>${summary(local)}<button class="btn ghost wide" data-act="book-sync-open">${esc(t('Set up book sync'))}</button><p class="fine">${esc(t('Book sync is separate from live phone editing.'))}</p></section>`;
}
export function syncUiView(local={},native=false){
  let supplied={};
  try{supplied=bridge?.getView(local)||{};}catch{return{phase:'error',computer:native?null:local,phone:native?local:null};}
  return {...supplied,phase:PHASES.has(supplied.phase)?supplied.phase:'intro',computer:supplied.computer||(native?null:local),phone:supplied.phone||(native?local:null)};
}
export function syncPanelHtml(view={}){
  const phase=PHASES.has(view.phase)?view.phase:'intro',unavailable=!syncUiAvailable();
  let body='';
  if(phase==='intro')body=`<p class="sh-body">${esc(t('Keep a local book on this computer and phone. Sync when they are together; keep working offline.'))}</p><p>${esc(t('Compare the books before making changes.'))}</p>${button('Set up book sync','start',view)}${unavailable?`<p class="fine" role="status">${esc(t('Book sync is not available on this device yet.'))}</p>`:''}`;
  if(phase==='connect'){
    const host=view.native===true||view.pairing?.manualRole==='host';
    const pin=/^[0-9]{6}$/.test(view.pairing?.joiningCode||'')?view.pairing.joiningCode:'';
    body=`<h3>${esc(t('Pair the devices'))}</h3><p>${esc(t('Keep both devices on the same Wi-Fi.'))}</p>${host?'':`<p class="fine">${esc(t("Your browser may ask to connect to devices on your local network. Allow this to reach your phone on Wi-Fi; it does not approve book sharing."))}</p>`}<p>${esc(t(host?'Type this address and fresh PIN on your computer.':'Enter the phone address and fresh PIN shown in Tally on your phone.'))}</p><label class="field"><span>${esc(t('Phone address'))}</span><input data-sync-field="address" maxlength="80" autocomplete="off" spellcheck="false" placeholder="192.168.1.5:49213" value="${esc(view.pairing?.address||'')}"${host?' readonly':''}></label><label class="field"><span>${esc(t('Fresh 6-digit PIN'))}</span><input data-sync-field="code" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" autocomplete="off" value="${host?esc(pin):''}"${host?' readonly':''}></label>${host?'':`<label class="sync-remember"><input type="checkbox" data-sync-field="remember-address"${view.pairing?.rememberAddress===true?' checked':''}><span>${esc(t('Remember this phone address'))}</span></label>${button('Connect','connect',view)}`}<p class="fine">${esc(t('Connecting does not approve access. Confirm matching numbers on both devices.'))}</p>`;
  }
  if(phase==='approve')body=`<h3>${esc(t('Do these numbers match on both devices?'))}</h3><p class="code" aria-label="${esc((view.pairing?.approvalCode||'').replace(/\D/g,'').replace(/(\d)/g,'$1 '))}">${esc(view.pairing?.approvalCode||'')}</p><p>${esc(t('Only approve if both devices show the same 12 digits. You have 1 minute.'))}</p>${button('Yes, they match','approve',view)}`;
  if(phase==='choose')body=`<h3>${esc(t('Choose the book to use on both devices.'))}</h3><p class="fine">${esc(t('This copies one whole book to both devices, rather than merging them. The other book is replaced only after both safety backups and your final confirmation.'))}</p><div class="rowb"><span class="grow"><b>${esc(t('Computer book'))}</b>${summary(view.computer)}</span></div>${button('Start from the computer book','choose',view,{choice:'computer'})}<div class="rowb"><span class="grow"><b>${esc(t('Phone book'))}</b>${summary(view.phone)}</span></div>${button('Start from the phone book','choose',view,{choice:'phone'})}`;
  if(phase==='backup')body=`<h3>${esc(t('Back up both books'))}</h3><p>${esc(t('Save a separate backup of each book before continuing.'))}</p>${['computer','phone'].map(device=>`<div class="rowb"><span class="grow"><b>${esc(t(device==='computer'?'Computer book':'Phone book'))}</b><small>${esc(backupStatus(view.backups?.[device]))}</small></span></div>${button('Back up now','backup',view,{device,ghost:true})}${view.backups?.[device]?.status==='started'?button('Check backup file','verify-backup',view,{device,ghost:true}):''}`).join('')}${button('Continue','review',view)}`;
  if(phase==='review'){
    const conflicts=Array.isArray(view.conflicts)?view.conflicts:[];
    body=`<h3>${esc(t('Review before syncing'))}</h3><p>${esc(t('The selected book will be copied to both devices. Review the differences first.'))}</p>${conflicts.length?`<p>${esc(t('These books have different versions. Choose the whole book to use; entries will not be guessed together.'))}</p>`:''}`;
    for(const conflict of conflicts){body+=`<div class="sync-difference"><h4>${esc(conflict.title||t('Review differences'))}</h4>${(Array.isArray(conflict.fields)?conflict.fields:[]).map(field=>`<p class="fine">${esc(t(field.label||''))}</p><div class="grid2"><p><b>${esc(t('Computer book'))}</b><br>${esc(field.computer)}</p><p><b>${esc(t('Phone book'))}</b><br>${esc(field.phone)}</p></div>`).join('')}${bridge?.capabilities?.perDifferenceResolution===true?`<div class="row2">${button('Keep the computer version','resolve',view,{ghost:true,id:conflict.id,choice:'computer'})}${button('Keep the phone version','resolve',view,{ghost:true,id:conflict.id,choice:'phone'})}</div>`:''}${conflict.choice?`<p class="fine" role="status">${esc(t(conflict.choice==='computer'?'Computer version selected':'Phone version selected'))}</p>`:''}</div>`;}
    if(conflicts.length&&!bridge?.capabilities?.perDifferenceResolution)body+=button('Start from the computer book','choose',view,{choice:'computer',ghost:true})+button('Start from the phone book','choose',view,{choice:'phone',ghost:true});
    body+=`<p class="warnbox">${esc(t('No changes will be made until you confirm.'))}</p>${button('Sync reviewed changes','apply',view)}`;
  }
  if(phase==='syncing'){
    const progress=view.progress,valid=Number.isSafeInteger(progress?.receivedChunks)&&Number.isSafeInteger(progress?.totalChunks)&&progress.receivedChunks>=0&&progress.totalChunks>0&&progress.receivedChunks<=progress.totalChunks;
    body=`<p role="status" aria-live="polite">${esc(t('Syncing the books…'))}${valid?`<br>${esc(t('{0} of {1} chunks received',progress.receivedChunks,progress.totalChunks))}`:''}</p><p>${esc(t('Keep both devices open until syncing finishes.'))}</p>`;
  }
  if(phase==='ready')body=`<p class="${view.bothConfirmed===true?'okbox':'fine'}" role="status">${esc(t(view.bothConfirmed===true&&syncUiAvailable()?'Both books are up to date.':'Waiting for both devices to confirm.'))}</p>`;
  if(phase==='offline')body=`<p>${esc(t('Offline. Keep using this book; reconnect when you want to sync.'))}</p>${button('Connect','start',view)}`;
  if(phase==='error')body=`<p class="err" role="alert">${esc(t('Sync could not finish. Check both books before trying again.'))}</p>${view.unchanged===true?`<p>${esc(t('No changes have been made.'))}</p>`:''}${view.native?'':`<p class="fine">${esc(t("If you denied local-network access, allow it in this site’s browser permissions and try again. Keep both devices on the same Wi-Fi."))}</p>`}${button('Try again','retry',view)}`;
  return `<div class="sync-sheet"><div class="sheethead"><h2 class="sh-title">${esc(t('Sync this book'))}</h2><button class="icon-btn" data-act="sheet-close" aria-label="${esc(t('Close'))}">${CLOSE}</button></div>${body}<p class="fine">${esc(t('Book sync is separate from live phone editing.'))}</p><div class="sheetfoot"><button class="btn ghost wide" data-act="sheet-close">${esc(t('Close'))}</button></div></div>`;
}
const ACTIONS={intro:['start'],connect:['connect'],approve:['approve'],choose:['choose'],backup:['backup','verify-backup','review'],review:['choose','resolve','apply'],offline:['start'],error:['retry']};
export function bindSyncPanel(el,{local={},native=false,onLive=()=>{}}={}){
  const sessionBridge=bridge,sessionGeneration=bridgeGeneration;
  let pending=false,closed=false,unsubscribe=null,current={...syncUiView(local,native),native};
  const repaint=()=>{if(!closed){el.innerHTML=syncPanelHtml(current);if(pending){for(const button of el.querySelectorAll('[data-sync-action]'))button.disabled=true;el.setAttribute('aria-busy','true');}}};
  const refresh=()=>{if(!closed&&sessionGeneration===bridgeGeneration&&sessionBridge===bridge){current={...syncUiView(local,native),native};repaint();}};
  el.addEventListener('click',async event=>{
    const target=event.target.closest('[data-sync-action]');if(!target||target.disabled||pending||closed||sessionGeneration!==bridgeGeneration||sessionBridge!==bridge)return;
    const action=target.dataset.syncAction;
    if(action==='live'){onLive();return;}
    if(!ACTIONS[current.phase]?.includes(action)||!enabled(action,current))return;
    const payload={planToken:current.planToken};
    if(action==='choose'&&!['computer','phone'].includes(target.dataset.choice))return;
    if(['choose','resolve'].includes(action))payload.choice=target.dataset.choice;
    if(action==='resolve'){if(!['computer','phone'].includes(payload.choice)||!current.conflicts?.some(c=>String(c.id)===target.dataset.conflict))return;payload.conflictId=target.dataset.conflict;}
    if(['backup','verify-backup'].includes(action)){if(!['computer','phone'].includes(target.dataset.device))return;payload.device=target.dataset.device;}
    if(action==='connect'){
      payload.address=(el.querySelector('[data-sync-field="address"]')?.value||'').trim();
      payload.code=(el.querySelector('[data-sync-field="code"]')?.value||'').trim();
      payload.rememberAddress=el.querySelector('[data-sync-field="remember-address"]')?.checked===true;
      if(!payload.address||payload.address.length>80||!/^[0-9]{6}$/.test(payload.code))return; // Endpoint validation is owned by the actual transport, not copied here.
    }
    pending=true;for(const button of el.querySelectorAll('[data-sync-action]'))button.disabled=true;el.setAttribute('aria-busy','true');
    try{await sessionBridge.request(action,payload);if(!closed&&sessionGeneration===bridgeGeneration){pending=false;refresh();}}
    catch{if(!closed&&sessionGeneration===bridgeGeneration){pending=false;current={phase:'error',native};repaint();}}
    finally{pending=false;el.removeAttribute('aria-busy');}
  });
  const dispose=()=>{if(closed)return;closed=true;panels.delete(dispose);current={};el.innerHTML='';el.removeAttribute('aria-busy');try{unsubscribe?.();}catch{}try{Promise.resolve(sessionBridge?.cancel?.()).catch(()=>{});}catch{}};
  panels.add(dispose);
  try{const subscription=sessionBridge?.subscribe?.(refresh);if(typeof subscription==='function'){if(closed)subscription();else unsubscribe=subscription;}}catch{current={phase:'error',native};repaint();}
  return dispose;
}
