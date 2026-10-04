import test from'node:test';import assert from'node:assert/strict';import{readFile}from'node:fs/promises';import vm from'node:vm';
const root=new URL('../',import.meta.url),read=p=>readFile(new URL(p,root),'utf8');
const setup=await read('js/views/setup.js'),home=await read('js/views/home.js'),lock=await read('js/lock.js');
const esc=s=>String(s??'').replaceAll('<','&lt;'),t=(s,...v)=>s.replace(/\{(\d+)\}/g,(_,i)=>v[i]),ICON=new Proxy({},{get:()=>''});
const section=setup.slice(setup.indexOf('<section class="card" id="backup">'),setup.indexOf('<section class="card" id="s-data">'));
test('actual Settings backup template never presents browser persistence promises in native, keeps web statuses',()=>{
for(const isNative of[true,false])for(const persisted of[null,true,false]){const html=vm.runInNewContext('`'+section+'`',{isNative,storage:{persisted},esc,t,ICON,backupEvidence:()=>''});if(isNative){assert.match(html,/Stored in this app on this phone/);assert.doesNotMatch(html,/browser|protected|free up space/);}else{assert.match(html,/browser/);if(persisted===true)assert.match(html,/Storage: protected/);if(persisted===false)assert.match(html,/browser may clear/);assert.doesNotMatch(html,/Uninstalling Tally/);}}
});
test('actual Home banner renders platform-specific storage and keeps backup actions',()=>{
const source=home.slice(home.indexOf('function backupBanner()'),home.indexOf('/** The one other banner'));
for(const isNative of[true,false]){const html=vm.runInNewContext(source+'\nbackupBanner();',{isNative,settings:()=>({}),S:{tx:Array(5).fill({}),kv:{}},today:()=> '2026-10-04',began:()=>Infinity,daysBetween:()=>0,dayOf:x=>x,dismissed:()=>[],NEW:5,esc,t,ICON});assert.match(html,/data-act="backup"/);assert.match(html,/data-act="storage-info"/);assert.match(html,isNative?/stored in this app/:/stored in this browser/);if(isNative)assert.doesNotMatch(html,/browser/);else assert.doesNotMatch(html,/uninstall/i);}
});
test('actual erase confirmation branches match in Settings and locked recovery',()=>{
const line=setup.split('\n').find(s=>s.includes('body: (isNative ? t(\'This deletes your accounts'));
const start=line.indexOf('body: ')+6,end=line.indexOf(', ok:');const expr=line.slice(start,end);
for(const isNative of[true,false]){const result=vm.runInNewContext(expr,{isNative,t});assert.match(result,isNative?/stored in this app on this phone/:/storage of the browser/);assert.match(result,/cannot be undone/);assert.match(result,/Other apps/);assert.ok(lock.includes(expr));}
});
test('all eight new keys exist exactly once in every locale and existing web/native disclosure remains',async()=>{
const keys={
 "Your book is stored in this app on this phone. Back up before uninstalling Tally or clearing its app data.": {
  "ms":"Buku anda disimpan dalam aplikasi ini pada telefon ini. Buat sandaran sebelum menyahpasang Tally atau memadam data aplikasinya.",
  "zh":"账本保存在这部手机的应用内。卸载 Tally 或清除应用数据前，请先备份。",
  "zh-Hant":"帳本儲存在這部手機的應用程式內。解除安裝 Tally 或清除應用程式資料前，請先備份。",
  "ja":"帳簿はこのスマホのアプリ内に保存されています。Tally のアンインストールやアプリデータの削除前に、バックアップしてください。",
  "ta":"உங்கள் கணக்குப் புத்தகம் இந்தக் கைப்பேசியின் செயலியில் சேமிக்கப்பட்டுள்ளது. Tally-ஐ நிறுவல் நீக்கும் முன்போ அதன் செயலித் தரவை அழிக்கும் முன்போ காப்புப்பிரதி எடுங்கள்."
 },
 "Stored in this app on this phone. Keep a backup file outside Tally.": {
  "ms":"Disimpan dalam aplikasi ini pada telefon ini. Simpan fail sandaran di luar Tally.",
  "zh":"保存在这部手机的应用内。请在 Tally 以外另存备份文件。",
  "zh-Hant":"儲存在這部手機的應用程式內。請在 Tally 以外另存備份檔案。",
  "ja":"このスマホのアプリ内に保存されています。バックアップファイルは Tally の外に保管してください。",
  "ta":"இந்தக் கைப்பேசியின் செயலியில் சேமிக்கப்படுகிறது. காப்புப்பிரதிக் கோப்பை Tally-க்கு வெளியே வைத்திருங்கள்."
 },
 "This deletes your accounts, entries, receipt photos, budgets, bills, categories and settings stored in this app on this phone. Other apps, your gallery and files are not touched. It cannot be undone. Back up first.": {
  "ms":"Ini memadam akaun, catatan, gambar resit, bajet, bil, kategori dan tetapan yang disimpan dalam aplikasi ini pada telefon ini. Aplikasi lain, galeri dan fail anda tidak terjejas. Ia tidak boleh dibatalkan. Buat sandaran dahulu.",
  "zh":"这会删除这部手机应用内保存的账户、记录、收据照片、预算、账单、分类和设置。其他应用、相册和文件不会受影响。此操作无法撤销，请先备份。",
  "zh-Hant":"這會刪除這部手機應用程式內儲存的帳戶、記錄、收據照片、預算、帳單、分類和設定。其他應用程式、相簿和檔案不受影響。此操作無法復原，請先備份。",
  "ja":"このスマホのアプリ内に保存された口座、記録、レシート写真、予算、請求、カテゴリ、設定を削除します。他のアプリ、ギャラリー、ファイルには影響しません。元に戻せないため、先にバックアップしてください。",
  "ta":"இந்தக் கைப்பேசியின் செயலியில் சேமிக்கப்பட்ட கணக்குகள், பதிவுகள், ரசீதுப் படங்கள், பட்ஜெட்டுகள், பில்கள், வகைகள், அமைப்புகள் நீக்கப்படும். பிற செயலிகள், கேலரி, கோப்புகள் பாதிக்கப்படாது. இதை மீட்டமைக்க முடியாது. முதலில் காப்புப்பிரதி எடுங்கள்."
 },
 "Local storage is limited. Keep a backup file and avoid adding receipt photos for now.": {
  "ms":"Storan setempat terhad. Simpan fail sandaran dan elakkan menambah gambar resit buat masa ini.",
  "zh":"本地存储受限。请保留备份文件，并暂时不要添加收据照片。",
  "zh-Hant":"本機儲存空間受限。請保留備份檔案，並暫時不要新增收據照片。",
  "ja":"ローカル保存に制限があります。バックアップファイルを保管し、当面はレシート写真の追加を控えてください。",
  "ta":"உள்ளகச் சேமிப்பில் வரம்புகள் உள்ளன. காப்புப்பிரதிக் கோப்பை வைத்திருங்கள்; இப்போது ரசீதுப் படங்களைச் சேர்ப்பதைத் தவிர்க்கவும்."
 },
 "Save to this phone": {
  "ms":"Simpan di telefon ini",
  "zh":"保存到这部手机",
  "zh-Hant":"儲存到這部手機",
  "ja":"このスマホに保存",
  "ta":"இந்தக் கைப்பேசியில் சேமி"
 },
 "Network requests recorded by this app since it opened (external links, such as Google Calendar, are not included):": {
  "ms":"Permintaan rangkaian yang direkodkan oleh aplikasi ini sejak dibuka (pautan luar, seperti Google Calendar, tidak disertakan):",
  "zh":"本应用打开以来记录的网络请求（不包括 Google 日历等外部链接）：",
  "zh-Hant":"本應用程式開啟以來記錄的網路請求（不包括 Google 日曆等外部連結）：",
  "ja":"このアプリを開いてから記録されたネットワーク要求（Google カレンダーなどの外部リンクは含みません）：",
  "ta":"இந்தச் செயலியைத் திறந்ததிலிருந்து பதிவான பிணையக் கோரிக்கைகள் (Google Calendar போன்ற வெளி இணைப்புகள் இதில் இல்லை):"
 },
 "Clearing the browser's data for Tally or resetting this phone deletes Tally's local book. Back up first.": {
  "ms":"Memadam data pelayar untuk Tally atau menetapkan semula telefon ini akan memadam buku setempat Tally. Buat sandaran dahulu.",
  "zh":"清除浏览器中的 Tally 数据或重置这部手机，会删除 Tally 的本地账本。请先备份。",
  "zh-Hant":"清除瀏覽器中的 Tally 資料或重設這部手機，會刪除 Tally 的本機帳本。請先備份。",
  "ja":"ブラウザの Tally データを削除したり、このスマホを初期化したりすると、Tally のローカル帳簿が削除されます。先にバックアップしてください。",
  "ta":"உலாவியில் Tally-இன் தரவை அழித்தாலோ இந்தக் கைப்பேசியை மீட்டமைத்தாலோ Tally-இன் உள்ளகக் கணக்குப் புத்தகம் நீக்கப்படும். முதலில் காப்புப்பிரதி எடுங்கள்."
 },
 "Your book is stored in this browser on this device. Clearing Tally's site data deletes it. Keep a backup file.": {
  "ms":"Buku anda disimpan dalam pelayar ini pada peranti ini. Memadam data laman Tally akan memadamnya. Simpan fail sandaran.",
  "zh":"账本保存在这台设备的浏览器中。清除 Tally 的网站数据会删除账本，请保留备份文件。",
  "zh-Hant":"帳本儲存在這台裝置的瀏覽器中。清除 Tally 的網站資料會刪除帳本，請保留備份檔案。",
  "ja":"帳簿はこの端末のブラウザ内に保存されています。Tally のサイトデータを削除すると帳簿も削除されます。バックアップファイルを保管してください。",
  "ta":"உங்கள் கணக்குப் புத்தகம் இந்தச் சாதனத்தின் உலாவியில் சேமிக்கப்பட்டுள்ளது. Tally-இன் தளத் தரவை அழித்தால் அதுவும் நீக்கப்படும். காப்புப்பிரதிக் கோப்பை வைத்திருங்கள்."
 }
}
;
for(const lang of['ms','zh','zh-Hant','ja','ta']){const source=await read(`js/i18n/${lang}.js`),dict=(await import(new URL(`../js/i18n/${lang}.js`,import.meta.url))).default;for(const[key,values]of Object.entries(keys)){assert.equal(dict[key],values[lang]);assert.equal(source.split(JSON.stringify(key)+':').length,2);assert.ok(values[lang].trim());}assert.ok(dict['Your book is saved in this app on this phone. Clearing browser data does not delete it. A computer you approve can view and edit it while connected. Tally keeps no cloud copy.']);}
});
test('save picker cancellation contract is unchanged and native saved toast does not claim Downloads',()=>{
assert.match(setup,/if \(isNative && result\?\.cancelled !== false\) \{ if \(b\?\.isConnected\) b\.disabled = false; return; \}/);
const joint=setup.slice(setup.indexOf("'jt-save':"),setup.indexOf("'export-csv':"));assert.match(joint,/toast\(isNative \? `\$\{t\('Saved'\)\}: \$\{name\}` : t\('Download started/);
assert.equal((setup.match(/isNative \? t\('Save to this phone'\) : t\('Save to this phone \(Downloads\)'\)/g)||[]).length,2);
});
