import {createNativePairService} from './native-pair-service.js';
import {privacyLocked,onPrivacyChange} from './lock.js';
let service=null,plugin=null;
export async function getNativePairService(){
  const current=globalThis.Capacitor?.Plugins?.TallyNative;
  if(!current||plugin&&plugin!==current)throw Error('Native pairing unavailable.');
  if(!service){plugin=current;service=createNativePairService({native:plugin,privacyLocked,onPrivacyChange,document,window});}
  if(!(await service.whenReady)||!service.available())throw Error('Native pairing unavailable.');
  return service;
}
