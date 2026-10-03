// Welcome (first run), Settings, and every way to bring data in or take it out.
import { S, settings, setSetting, setKv, saveAccount, deleteAccount, saveTxs, addCategory, removeCategory, bringBackCategory, savePhoto, deletePhotos, dropPhotos, getPhoto, replaceAll, addAll, eraseAll, uid, today, nowTime, expenseCats, hasJoint, jointIds, putAll, startDay, thisMonth, storage, persistStorage, setCatColor, setCatIcon, allCats, cat, storageMode } from '../state.js';
import { t, setLang, getLang, LANGS, langTag, fmtDate, fmtMonth, fuzzyScore, english } from '../i18n.js';
import { esc, ICON, MASK, balHidden, openSheet, closeSheet, confirmSheet, toast, $, $$, haptic, announce } from '../ui.js';
import { lockOn, lockSheet, lockOff, askCode, encOn, encryptOn, encryptOff } from '../lock.js';
import { keepReceiptUntil, fmtRM, parseAmount, balances, ACCOUNT_KINDS, CATEGORIES, INCOME_CATEGORIES, calcAmount, nextColor, fmtAcct, tooLarge, isFx, rateOf, FX_START, ownCategories, incomeCategory, owing } from '../engine.js';
import { ownKey, fileToRows, reshape, guessMapping, headerRow, rowsToTx, openingFromBalance, mapCategory, sameCategory, OTHER_NAME, catName as theirCatName, photosToWrite, fitCats, overCap, overCapAfter, SEALED_MAX, backupFits, parseCSV, sheetCsvUrl, sealBackup, openBackup, isSealed, toCSV, toTSV, toXlsx, txRows, toQIF, makeBackup, readBackup, mergeBackup, backupSettings, download, shareFile, cleanText, importIds, LIMITS, zipStore, unzip, BACKUP_JSON, makeJointShare, relinkReloads, mergeJoint, readCapped, imageInfo, splitDups, pairTransfers, asTransfer, hash, cleanDesc, accountNames, isMoneyRow, rowCategory, reloadTransfers, typedShift, isAtm } from '../io.js';
import { detectPreset } from '../presets.js';
import { parseStatement, statementToTx, linesFromItems, detectProvider, guessKind, PAGE_BREAK, isWallet } from '../statement.js';
import { render, go, APP_VERSION, MAKER, CONTACT } from '../app.js';
import { openFeedback } from '../feedback.js';
import { isNative } from '../native.js';
import { dailyEvent, ics, googleUrl } from '../calendar.js';
import { showTour, showWhatsNew, siteUrl, afterSetup, markSeen, canInstall, promptInstall, checkForUpdates, holdUpdates, iosBrowser } from '../tour.js';
import { settingsCard as learnCard, tickQuietly, gameOn, firstWord } from './learn.js';
import { demoCard } from './home.js';
import { badge } from './money.js';
import { goalsSettings } from './goals.js';
import { MODULES, PRESETS, on, setModules, presetNow } from '../features.js';
import { CAT_ICONS, DEFAULT_ICON, catIcon } from '../caticons.js';
import { startSample, sampleRows, endSample } from '../sample.js';
import { pickColor, ACCENTS, onColor, applyLook, parseHex, colourName, APP_PALETTES, themeNow, okMine, surfacesFrom, paletteFor } from '../colorpicker.js';

const KIND = { cash: 'Cash', bank: 'Bank account', ewallet: 'E-wallet', card: 'Credit card', savings: 'Savings' };
// Short native names so five languages fit one row on a 360px phone (Tamil wraps to a second); the full name is what
// a screen reader says.
const SHORT = { ms: 'BM', zh: '简体', 'zh-Hant': '繁體' };
// New translations not yet checked by a native reader: tagged, and the note under the picker asks readers for better words
// through the usual feedback form (the app info it sends already names the language).
const BETA = new Set(['ta']);
const langButtons = () => `<div class="segs lang" role="group" aria-label="Language · Bahasa · 语言">${LANGS.map(([k, n]) => `<button class="seg${getLang() === k ? ' on' : ''}" data-act="set-lang" data-l="${k}" lang="${langTag(k)}" aria-pressed="${getLang() === k}"${SHORT[k] ? ` aria-label="${esc(n)}" title="${esc(n)}"` : ''}>${esc(SHORT[k] || n)}${BETA.has(k) ? ' <small class="beta" lang="en">beta</small>' : ''}</button>`).join('')}</div>
  ${getLang() === 'ta' ? `<button class="link betanote" data-act="feedback">${esc(t('Tamil is new. Suggest a better word'))}<span lang="en">Tamil is new. Suggest a better word</span></button>` : ''}`;

const SIZES = [100, 115, 130];
/** A / A+ / A++, the same sizes as Settings → Text size, drawn at the size they give. */
const sizeButtons = () => `<div class="segs sizes" role="group" aria-label="${esc(t('Text size'))}">${SIZES.map((n, i) => `<button class="seg${(settings().textSize || 100) === n ? ' on' : ''}" data-act="set-size" data-n="${n}" aria-pressed="${(settings().textSize || 100) === n}" aria-label="A${'+'.repeat(i)}, ${n}%" style="font-size:${n}%">A${'+'.repeat(i)}</button>`).join('')}</div>`;
const setSize = async n => { await setSetting('textSize', n); document.documentElement.style.fontSize = `${n}%`; };

// ---- Appearance & personal: few words, the controls show what they do ------------------------------------------------
const seg = (act, v, on, label, icon = '') => `<button class="seg${on ? ' on' : ''}" data-act="${act}" data-v="${v}" aria-pressed="${on}"${icon ? ` aria-label="${esc(label)}" title="${esc(label)}"` : ''}>${icon || esc(label)}</button>`;
const HOME_CARDS = () => [['gap', t('Missed days'), ICON.clock], ['nudge', t('Habit nudges'), ICON.clock], ['bills', t('Bills due'), ICON.bell], ['insight', t('Insights'), ICON.chart], ['learn', t('Learn Tally'), ICON.sparkles], ['stickers', t('Sticker book'), ICON.award]];
/** Tally in modules: a preset (Simple · Standard · Everything) or each feature on its own. Off hides; nothing is deleted.
 *  Folded to one line (the mode now) until opened; it stays open while Settings redraws after each change. */
let featOpen = false;
function featuresCard() {
  const now = presetNow(), preset = (id, label, sub) => `<button class="pal preset${now === id ? ' on' : ''}" data-act="set-preset" data-v="${id}" aria-pressed="${now === id}"><b>${esc(label)}</b><small>${esc(sub)}</small></button>`;
  const mode = { simple: t('Simple'), standard: t('Standard'), everything: t('Everything') }[now] || t('Custom');
  return `<details class="card acard" id="s-features"${featOpen ? ' open' : ''}><summary data-act="features-open"><span class="grow"><span class="lbl">${esc(t('Features'))}</span><b>${esc(mode)}</b></span><span class="chev" aria-hidden="true"></span></summary><p class="fine">${esc(t("Turn off what you don't use. Nothing is deleted: turn it back on and it is all there."))}</p>
    <div class="palettes" role="group" aria-label="${esc(t('Features'))}">${preset('simple', t('Simple'), t('Type it, see the list and totals'))}${preset('standard', t('Standard'), t('Receipts, budgets, insights'))}${preset('everything', t('Everything'), t('All of it, streaks too'))}</div>
    ${now === 'custom' ? `<p class="fine">${esc(t('Custom: your own mix.'))}</p>` : ''}
    <details class="more-cats"><summary>${esc(t('Choose features one by one'))}</summary>${MODULES.map(([k, name, sub]) => `<label class="toggle"><span class="grow"><b>${esc(t(name))}</b><small>${esc(t(sub))}</small></span><input type="checkbox" class="switch" role="switch" data-input="module" data-k="${k}"${on(k) ? ' checked' : ''}></label>`).join('')}</details></details>`;
}
function lookCard() {
  const s = settings(), theme = ['light', 'dark'].includes(s.theme) ? s.theme : 'system', acc = parseHex(s.accent) || baseAccent(), hide = s.homeHide || [];
  const themes = [['system', t('Same as phone'), ICON.phone], ['light', t('Light theme'), ICON.sun], ['dark', t('Dark theme'), ICON.moon]];
  const mine = okMine(s.myPalette) ? s.myPalette : null, onMine = !!mine && s.appPalette === 'mine', mode = themeNow();
  const mineColours = [['bg', t('Background'), mine?.[mode][0]], ['card', t('Cards'), mine?.[mode][1]], ['accent', t('Accent colour'), mine?.accent]];
  const sw = (hex, label) => `<li><button class="sw" style="--c:${hex};--on:${onColor(hex)}" data-act="set-accent" data-v="${hex}" aria-pressed="${acc === hex}" aria-label="${esc(label)}" title="${esc(label)}">${acc === hex ? ICON.check : ''}</button></li>`;
  return `<section class="card" id="look"><h2>${esc(t('Appearance & personal'))}</h2>${langButtons()}
    <div class="lookrow"><span>${ICON.sun}${esc(t('Theme'))} · ${esc(themes.find(x => x[0] === theme)[1])}</span><div class="segs icons" role="group" aria-label="${esc(t('Theme'))}">${themes.map(([v, l, i]) => seg('set-theme', v, theme === v, l, i)).join('')}</div></div>
    <div class="lookrow"><span>${ICON.palette}${esc(t('App colours'))}</span><div class="palettes" role="group" aria-label="${esc(t('App colours'))}">${Object.entries(APP_PALETTES).map(([id, p]) => { const on = (s.appPalette || 'tally') === id, sf = p[themeNow()]; return `<button class="pal apal${on ? ' on' : ''}" data-act="set-app-palette" data-v="${id}" aria-pressed="${on}"><span class="apv" aria-hidden="true" style="background:${sf[0]}"><i style="background:${sf[2]}"></i><b style="background:${p.accent}"></b></span>${esc(t(p.name))}</button>`; }).join('')}${Object.entries(s.bookPalettes || {}).filter(([, p]) => okMine(p)).map(([ym, p]) => { const id = `book-${ym}`, on = s.appPalette === id, sf = p[themeNow()]; return `<button class="pal apal${on ? ' on' : ''}" data-act="set-app-palette" data-v="${esc(id)}" aria-pressed="${on}"><span class="apv" aria-hidden="true" style="background:${sf[0]}"><i style="background:${sf[2]}"></i><b style="background:${p.accent}"></b></span>${esc(fmtMonth(ym))}</button>`; }).join('')}<button class="pal apal${onMine ? ' on' : ''}" data-act="set-app-palette" data-v="mine" aria-pressed="${onMine}">${mine ? `<span class="apv" aria-hidden="true" style="background:${mine[mode][0]}"><i style="background:${mine[mode][2]}"></i><b style="background:${mine.accent}"></b></span>` : `<span class="apv apv-new" aria-hidden="true">${ICON.plus}</span>`}${esc(t('Mine'))}</button></div></div>
    ${onMine ? `<div class="lookrow"><span>${ICON.palette}${esc(t('Your colours, {0}', mode === 'dark' ? t('Dark theme') : t('Light theme')))}</span><ul class="swatches mine">${mineColours.map(([k, l, h]) => `<li><button class="sw" style="--c:${h};--on:${onColor(h)}" data-act="mine-colour" data-k="${k}" aria-label="${esc(`${l}: ${colourName(h)} ${h}`)}"></button><small aria-hidden="true">${esc(l)}</small></li>`).join('')}</ul><p class="fine">${esc(t('Switch the theme above to set the other one. Text colours adjust to stay readable.'))}</p></div>` : ''}
    ${onMine ? '' : `<div class="lookrow"><span>${ICON.palette}${esc(t('Accent colour'))}</span><ul class="swatches">${sw(baseAccent(), `${colourName(baseAccent())} (${t('Default')})`)}${ACCENTS.filter(h => h !== baseAccent()).map(h => sw(h, colourName(h))).join('')}${[baseAccent(), ...ACCENTS].includes(acc) ? '' : sw(acc, `${colourName(acc)} ${acc}`)}
      <li><button class="sw more" data-act="accent-custom" aria-label="${esc(t('Custom colour'))}" title="${esc(t('Custom colour'))}">${ICON.plus}</button></li></ul></div>`}
    <div class="lookrow"><span>${ICON.palette}${esc(t('Category colours'))}</span><div class="palettes" role="group" aria-label="${esc(t('Category colours'))}">${PALETTES.map(([id, name, cols]) => { const on = (s.palette || 'tally') === id; return `<button class="pal${on ? ' on' : ''}" data-act="set-palette" data-v="${id}" aria-pressed="${on}"${id === 'tally' ? ` title="${esc(t('Colour-blind safe'))}"` : ''}><span class="pdots" aria-hidden="true">${(cols || CATEGORIES.map(c => c.color)).slice(0, 5).map(c => `<i style="background:${c}"></i>`).join('')}</span>${esc(t(name))}</button>`; }).join('')}</div></div>
    <label class="field"><span>${esc(t('Text size'))}</span><select data-input="text-size">${[100, 115, 130].map(n => `<option value="${n}"${(s.textSize || 100) === n ? ' selected' : ''}>${n}%</option>`).join('')}</select></label>
    <label class="field"><span>${esc(t('Your name'))}</span><input data-input="my-name" maxlength="30" value="${esc(s.myName || '')}" placeholder="${esc(t('e.g. Aisyah'))}" autocomplete="given-name"></label>
    <div class="lookrow"><span>${esc(t('Start screen'))}</span><div class="segs">${seg('set-start', 'home', s.start !== 'activity', t('Home'))}${seg('set-start', 'activity', s.start === 'activity', t('Activity'))}</div></div>
    ${gameOn() ? `<div class="lookrow"><span>${esc(t('Week starts on'))}</span><div class="segs">${seg('set-week', 1, s.weekStart !== 0, t('Monday'))}${seg('set-week', 0, s.weekStart === 0, t('Sunday'))}</div></div>` : ''}
    <label class="toggle"><span class="grow"><b>${esc(t('Compact'))}</b></span><input type="checkbox" class="switch" role="switch" data-input="compact"${s.compact ? ' checked' : ''}></label>
    ${'vibrate' in navigator ? `<label class="toggle"><span class="grow"><b>${esc(t('Haptics'))}</b><small>${esc(t('A short tap when something is saved'))}</small></span><input type="checkbox" class="switch" role="switch" data-input="haptics"${s.haptics !== false ? ' checked' : ''}></label>` : ''}
    <details class="more-cats"><summary>${esc(t('Home cards'))}</summary>${HOME_CARDS().map(([k, l, i]) => `<label class="toggle"><span class="lic">${i}</span><span class="grow"><b>${esc(l)}</b></span><input type="checkbox" class="switch" role="switch" data-input="home-card" data-k="${k}"${(k === 'learn' ? !s.learnHidden : !hide.includes(k)) ? ' checked' : ''}></label>`).join('')}</details></section>`;
}
// Whole sets of category colours. Tally's own (Okabe-Ito) stays apart for red-green colour blindness; the others keep
// about 3:1 against the light background so bars and dots still read.
const PALETTES = [['tally', 'Tally'],
  ['soft', 'Soft', ['#5B84B1', '#D07A5A', '#6E9B69', '#9A78B8', '#B8923F', '#4F9696', '#BD6E8F', '#7F7F4F', '#6E71B8', '#A8754C']],
  ['vivid', 'Vivid', ['#D62828', '#E07000', '#1F8A7D', '#2F6FE0', '#8338EC', '#E0005F', '#06875F', '#B35C00', '#1D3557', '#9D0208']],
  ['earth', 'Earth', ['#6B705C', '#BC6C25', '#588157', '#7F5539', '#8A7152', '#3A5A40', '#9C6644', '#936F4E', '#606C38', '#283618']]];
/** The accent that comes with the app colours (the design blue for Tally's own). */
const baseAccent = () => paletteFor(settings()).accent || ACCENTS[0];
const pickAccent = async () => {
  const h = await pickColor({ value: parseHex(settings().accent) || baseAccent(), title: t('Accent colour'), reset: baseAccent() });
  if (!h) return;
  await setSetting('accent', h === baseAccent() ? null : h);
  render(); $('[data-act="accent-custom"]')?.focus();
};
/** Add a category: its name, and a colour from the picker (the sheet comes back with the name kept). */
const catAddSheet = (name = '', color = nextColor(S.kv.customCats.map(c => c.color))) => openSheet(`<h2 class="sh-title">${esc(t('Add a category'))}</h2><label class="field"><span>${esc(t('Name'))}</span><input id="cat-name" maxlength="40" value="${esc(name)}"${name ? '' : ' autofocus'}></label>
    <div class="lookrow"><span>${esc(t('Colour'))}</span><ul class="chips"><li><button class="chip dotbtn" id="cat-color" data-act="cat-add-color" data-v="${esc(color)}"${name ? ' autofocus' : ''}><span class="dot" style="background:${esc(color)}"></span><span class="num">${esc(color)}</span></button></li></ul></div>
    <button class="btn wide" data-act="cat-save">${esc(t('Save'))}</button>`, { label: t('Category') });


// ---- Welcome ----------------------------------------------------------------------------------------------------------
/** Exchange rates, asked for only when the person taps "Get today's rate" (ECB rates; see privacy.html). */
// The commit this copy was built from (build.txt, written at deploy and kept in the offline cache with the code).
let build = '';
const buildLink = () => (build ? ` · <a class="link" href="https://github.com/tallymy/tallymy.github.io/tree/${build}" target="_blank" rel="noopener" aria-label="${esc(t('The code of this version: {0}', build.slice(0, 7)))}">${build.slice(0, 7)}</a>` : '');
fetch('./build.txt').then(r => (r.ok ? r.text() : '')).then(s => {
  if (!/^[0-9a-f]{40}\s*$/.test(s)) return;
  build = s.trim(); const el = document.getElementById('build'); if (el) el.innerHTML = buildLink();
}).catch(() => {});
const mailLink = () => `<a class="link" href="mailto:${CONTACT}">${CONTACT}</a>`;
const RATE_API = 'https://api.frankfurter.dev/v1/latest';
/** Privacy, terms and the source code: on Welcome (people check before the first tap) and in Settings. */
const legalLinks = () => `<a class="link" href="privacy${({ ms: '.ms', zh: '.zh', 'zh-Hant': '.zh-Hant', ja: '.ja' })[getLang()] || ''}.html" target="_blank" rel="noopener">${esc(t('Privacy policy'))}</a><a class="link" href="terms${({ ms: '.ms', zh: '.zh', 'zh-Hant': '.zh-Hant', ja: '.ja' })[getLang()] || ''}.html" target="_blank" rel="noopener">${esc(t('Terms of use'))}</a><a class="link" href="https://github.com/tallymy/tallymy.github.io" target="_blank" rel="noopener">${esc(t('Source code'))}</a><a class="link" href="licences.html" target="_blank" rel="noopener">${esc(t('Licences'))}</a>`;
/** Why Tally costs nothing: on Welcome (before the first tap) and in Settings. */
const whyFree = () => `<section class="card whyfree"><h2>${esc(t('Why is Tally free?'))}</h2><ul class="points">
  <li>${ICON.sparkles}<span>${esc(t('A passion project by {0}, one developer in Malaysia.', MAKER))} ${mailLink()}</span></li>
  <li>${ICON.globe}<span><a class="link" href="https://github.com/tallymy/tallymy.github.io" target="_blank" rel="noopener">${esc(t('Open source: anyone can read the code.'))}</a></span></li>
  <li>${ICON.lock}<span>${esc(t('No servers to pay for, and none of your money data to sell.'))}</span></li></ul></section>`;
// Optional migration guide: no completion flag and no data changes on skip.
function migrationGuide(step = 1) {
  const title = isNative ? (step === 1 ? 'Step 1: Back up the website' : 'Step 2: Restore here') : ['Step 1: Make a backup', 'Step 2: Find the file', 'Step 3: Restore in the app'][step - 1];
  let body;
  if (isNative && step === 1) body = `<p class="sh-body">${esc(t('Open the browser you used for Tally. In Settings, tap Back up now and save or send the file to yourself.'))}</p>
    <a class="btn ghost wide" href="https://tallymy.github.io/?app" target="_blank" rel="noopener noreferrer">${ICON.external || ICON.globe}${esc(t('Open old Tally'))}</a>
    <button class="btn wide" data-act="migration-restore-step">${esc(t('I have the backup file'))}</button>`;
  else if (isNative) body = `<p class="sh-body">${esc(t('Choose your Tally backup file to restore your accounts and entries here.'))}</p>
    <button class="btn wide" data-act="migration-restore">${esc(t('Restore a Tally backup'))}</button>`;
  else if (step === 1) body = `<p class="sh-body">${esc(t('Tap Back up now, then save the file or send it to yourself. Keep this website data until you have checked it in the app.'))}</p>
    <button class="btn wide" data-act="migration-backup">${ICON.download}${esc(t('Back up now'))}</button>
    <button class="btn ghost wide" data-act="migration-check">${esc(t('I have the backup file'))}</button>`;
  else if (step === 2) body = `<p class="sh-body">${esc(t('Look in Downloads, or where you sent the backup. Continue only when you can find the file yourself.'))}</p>
    <button class="btn wide" data-act="migration-found">${esc(t("I've found the file"))}</button>`;
  else body = `<p class="sh-body">${esc(t('When you have the Tally app, open it, tap Restore a Tally backup, and choose the file. Check your accounts and entries before removing the website data.'))}</p>`;
  openSheet(`<div class="sheethead"><h2 class="sh-title">${esc(t(title))}</h2><button class="icon-btn" data-act="sheet-close" aria-label="${esc(t('Close'))}">${ICON.x}</button></div>
    ${body}<p class="fine">${esc(t('You can open this guide later in Settings.'))}</p>
    <button class="btn ghost wide" data-act="sheet-close">${esc(t('Later'))}</button>`, { label: t(title) });
}

function setupModeSummary(mode) {
  const simple = mode === 'simple';
  return `<p><b>${esc(t('{0} selected', t(simple ? 'Simple' : 'Standard')))}</b></p>
    <p>${esc(t(simple ? 'Type expenses yourself. See your balance, entries and totals. Receipt scanning, budgets and other extras stay off.' : 'Scan receipts, set budgets and see spending charts. You can still type expenses yourself.'))}</p>
    <p class="fine">${esc(t('Your choice takes effect when you press Start. Change it later in Settings → Features.'))}</p>`;
}

export const welcomeView = {
  title: 'Welcome',
  render() {
    return `<section class="welcome">
      <div class="langrow top">${langButtons()}</div>
      <h1>Tally</h1>
      <p class="lede">${esc(t('Snap any receipt. See what you actually spent on, item by item.'))}</p>
      <p class="sublede">${ICON.lock} ${esc(t('Never asks for your bank login, TAC, OTP or IC.'))} <button class="link" data-act="net-check">${esc(t('Check it yourself'))}</button></p>
      ${demoCard()}
      <ul class="promise" aria-label="${esc(t('Tally is'))}">${[t('No subscription'), t('No ads'), t('No sign-up'), t('Kept on your phone')].map(w => `<li>${ICON.check}${esc(w)}</li>`).join('')}</ul>
      <button class="btn wide" data-act="start-fresh">${esc(t('Start fresh'))}</button>
      <button class="btn ghost wide" data-act="sample-go">${esc(t('Not sure yet? Look around with sample data'))}</button>
      <button class="btn ghost wide" data-act="import-open">${esc(t('Bring my data: bank or e-wallet statements (MAE, TNG, Grab…), other money apps, Excel'))}</button>
      <button class="btn ghost wide" data-act="restore-pick">${esc(t('Restore a Tally backup'))}</button>
      ${isNative ? `<section class="card" id="migration-welcome"><h2>${esc(t('Moving from the website?'))}</h2>
      <p class="fine">${esc(t('Moving from the website? Back up there, then restore that file here.'))}</p>
      <button class="btn ghost wide" data-act="migration-guide">${esc(t('Guide me'))}</button>
      <button class="btn ghost wide" data-act="migration-dismiss">${esc(t("I'll do it myself"))}</button>
      <button class="btn ghost wide" data-act="migration-dismiss">${esc(t('Later'))}</button>
      </section>` : ''}
      <a class="meet-card" href="https://tallymy.github.io/${siteUrl()}" target="_blank" rel="noopener noreferrer">
        <div class="website-preview"><img src="img/website-preview.png" alt="" width="1100" height="640" loading="lazy"><span class="website-address">${ICON.globe} tallymy.github.io</span></div>
        <div class="meet-copy"><h2>${esc(t('Meet Tally'))}</h2><p>${esc(t('See what Tally can do, with examples and a quick tour.'))}</p><span class="explore">${esc(t("Explore Tally's website"))} ${ICON.external || ICON.globe}</span><small>${esc(t('Opens in your browser'))}</small></div>
      </a>
      ${whyFree()}
      <div class="langrow"><div class="sizerow"><span class="fine">${esc(t('Text size'))}</span>${sizeButtons()}</div></div>
      <p class="fine">${esc(t('By using Tally you agree to the Terms of use and have read the Privacy policy.'))}</p>
      <p class="legal">${legalLinks()}</p>
      <ul class="points">
        <li>${ICON.receipt}<span>${esc(t('Receipts are read on this phone and split into categories automatically.'))}</span></li>
        <li>${ICON.lock}<span>${esc(t('Tally never reads your SMS and never asks for your bank login. The camera is the only permission it asks for.'))}</span></li>
        <li>${ICON.wallet}<span>${esc(t('No account, no ads. Your entries stay on this phone. They leave it only when you export, back up, share, connect your own computer, or add a reminder to Google Calendar.'))} <button class="link" data-act="storage-info">${esc(t('How your data is kept'))}</button> · <button class="link" data-act="net-check">${esc(t('Check it yourself'))}</button></span></li>
        <li>${ICON.upload}<span>${esc(t('Already tracking in another app or a spreadsheet? Bring your history with you.'))}</span></li>
        <li>${ICON.download}<span>${esc(t('Your data is never locked in: take it to Excel, Google Sheets or another money app any time.'))}</span></li>
      </ul>
      ${canInstall() ? `<button class="btn ghost wide" data-act="install">${ICON.download}${esc(t('Install Tally on this phone'))}</button>` : ''}
      <h2 class="welcome-h">${esc(t('How it works'))}</h2>
      <ol class="steps">
        <li><b>${esc(t('Snap'))}</b><span>${esc(t('Photograph a receipt, or pick several from your gallery. No receipt? Just type the amount.'))}</span></li>
        <li><b>${esc(t('Check'))}</b><span>${esc(t('Tally lists every item with a category. Fix anything it got wrong; it learns for next time.'))}</span></li>
        <li><b>${esc(t('See'))}</b><span>${esc(t('Your balance, where the money went, and a nudge when it is time to log.'))}</span></li>
      </ol>
    </section>`;
  },
};

function accountSheet(a = {}) {
  const isNew = !a.id, now = isNew ? null : balances([a], S.tx, today()).by[a.id], cur = a.currency || 'MYR';
  openSheet(`<h2 class="sh-title">${esc(isNew ? t('Add an account') : t('Edit account'))}</h2>
    <label class="field"><span>${esc(t('Name'))}</span><input id="ac-name" maxlength="60" value="${esc(a.name || '')}" placeholder="${esc(t('e.g. Maybank, Cash, Touch \'n Go'))}"${isNew ? ' autofocus' : ''}></label>
    ${isNew ? '' : `<label class="field"><span>${esc(isFx(a) ? t('Balance today ({0})', cur) : t('Balance today (RM)'))}</span><input id="ac-now" inputmode="decimal" data-now="${now}" value="${(now / 100).toFixed(2)}" autofocus><small>${esc(t('Type what your bank or wallet app shows. Tally moves the starting balance to match, so nothing counts as spending.'))}</small></label>`}
    <div class="grid2"><label class="field"${on('currencies') || isFx(a) ? '' : ' hidden'}><span>${esc(t('Currency'))}</span><select id="ac-cur" data-input="ac-cur">${['MYR', ...Object.keys(FX_START)].map(c => `<option${cur === c ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="field" id="ac-rate-f"${isFx(a) ? '' : ' hidden'}><span>${esc(t('RM for 1 {0}', isFx(a) ? a.currency : 'SGD'))}</span><input id="ac-rate" inputmode="decimal" value="${isFx(a) ? rateOf(a) : ''}"><button type="button" class="link" data-act="rate-get">${esc(t("Get today's rate"))}</button><small class="fine" id="rate-src" role="status"></small></label></div>
    <p class="fine" id="ac-cur-note"${isFx(a) ? '' : ' hidden'}>${esc(t('Amounts in this account stay in its own currency. Totals, budgets and insights count them in RM at this rate. A transfer to or from an RM account updates it.'))}</p>
    <label class="field"><span>${esc(t('Type'))}</span><select id="ac-kind">${ACCOUNT_KINDS.map(k => `<option value="${k}"${(a.kind || 'bank') === k ? ' selected' : ''}>${esc(t(KIND[k]))}</option>`).join('')}</select></label>
    ${isNew ? '' : `<details class="more"><summary>${esc(t('More'))}</summary>`}<label class="field"><span>${esc(isFx(a) ? t('Balance when you started ({0})', cur) : t('Balance when you started (RM)'))}</span><input id="ac-open" inputmode="decimal" value="${a.opening != null ? (a.opening / 100).toFixed(2) : ''}" placeholder="0.00"><small>${esc(t('For a credit card, enter what you owe as a negative number, e.g. -350.'))}</small></label>${isNew ? '' : '</details>'}
    <label class="field"><span>${esc(t('Whose money'))}</span><select id="ac-scope"><option value="personal">${esc(t('Mine (personal)'))}</option>${on('joint') || a.scope === 'joint' ? `<option value="joint"${a.scope === 'joint' ? ' selected' : ''}>${esc(t('Joint (shared with my partner)'))}</option>` : ''}${on('business') || a.scope === 'business' ? `<option value="business"${a.scope === 'business' ? ' selected' : ''}>${esc(t('Business (my stall, rides, shop)'))}</option>` : ''}</select></label>
    <p class="err" id="ac-err" role="alert"></p>
    <div class="row2">${isNew ? `<button class="btn ghost" data-act="sheet-close">${esc(t('Cancel'))}</button>` : `<button class="btn ghost danger" data-act="acc-del" data-id="${esc(a.id)}">${esc(t('Delete'))}</button>`}<button class="btn" data-act="acc-save" data-id="${esc(a.id || '')}">${esc(t('Save'))}</button></div>`, { label: t('Account') });
}

/** "Bank account · RM 1,200.00", without repeating a type the name already says ("Cash · Cash"). */
function accSub(a, by) {
  const kind = t(KIND[a.kind] || 'Bank account');
  const n = a.name.trim().toLowerCase(), k = kind.toLowerCase();
  return [a.scope === 'joint' && t('Joint'), a.scope === 'business' && t('Business'), !(k.startsWith(n) || n.startsWith(k)) && kind, (a.typed === false ? t('Not set') : balHidden() ? MASK : fmtAcct(a, by[a.id] || 0))].filter(Boolean).join(' · ');
}
// ---- Settings -----------------------------------------------------------------------------------------------------------
const catName = id => t(([...expenseCats(), ...INCOME_CATEGORIES].find(c => c.id === id) || CATEGORIES.at(-1)).name);
async function dailyReminder() {
  const at = $('#remind-at')?.value || '21:00';
  await setSetting('remindAt', at);
  return dailyEvent({ at, title: t("Tally: add today's spending"), details: `${t('A minute is enough: snap the receipts or type what you spent.')} ${isNative ? 'https://tallymy.github.io/' : `${location.origin}${location.pathname}`}` });
}
// ---- Settings search: the titles and labels on the page, in the language shown and in English ----------------------
let findQ = '', hits = [];
/** Each card's title and the labels in it (once each per card; an icon button by its name), with the element to show. */
const findables = () => $$('#view .card').flatMap(card => {
  const title = card.querySelector('h2, summary .lbl')?.textContent.trim() || '', seen = new Set();
  return [[title, card], ...$$('label.toggle b, label.field > span, .rowb b, .lookrow > span, summary, .btn, .segs [aria-label]', card).map(el => [(el.matches('.segs *') && el.getAttribute('aria-label')) || el.textContent.trim(), el])]
    .filter(([s]) => s && !seen.has(s) && seen.add(s)).map(([s, el]) => ({ s, el, card: title }));
});
function findSettings() {
  const list = $('#set-hits'), none = $('#set-none'); if (!list) return;
  hits = findQ.trim() ? findables().map(x => ({ ...x, n: Math.max(fuzzyScore(findQ, x.s), fuzzyScore(findQ, english(x.s))) })).filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 6) : [];
  list.innerHTML = hits.map((x, i) => `<li><button class="txrow" data-act="set-find" data-i="${i}"><span class="grow"><b>${esc(x.s)}</b>${x.card && x.card !== x.s ? `<small>${esc(x.card)}</small>` : ''}</span></button></li>`).join('');
  none.textContent = findQ.trim() && !hits.length ? t('No setting matches. Try another word.') : '';
}
/** Show a found setting: open what folds it away, scroll to it, flash it and put the focus there. */
function showFound(x) {
  if (!x?.el.isConnected) return;
  findQ = ''; $('#set-q').value = ''; findSettings();
  for (let d = x.el.closest('details'); d; d = d.parentElement.closest('details')) { d.open = true; if (d.id === 's-features') featOpen = true; }
  const box = x.el.classList.contains('card') ? x.el : x.el.closest('.toggle, .field, .rowb, .lookrow, .btn, summary') || x.el;
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash');
  const to = box.matches('.card') ? box.querySelector('h2, summary') : x.el.matches('button, a, summary') ? x.el : box.querySelector('input, select, button, a') || box;
  if (to.matches('h2, .rowb, .lookrow')) to.tabIndex = -1;
  to.focus({ preventScroll: true });
}
export const settingsView = {
  title: 'Settings',
  async after() {   // the reader card says so when the reader is already on this phone
    if (isNative) {
      const control = $('#scan-shortcut');
      try { const result = await Capacitor.Plugins.TallyNative.scanShortcut({}); if (control?.isConnected) control.value = result.button; } catch { if (control) control.disabled = true; }
    }
    // Search: Down from the box to the matches, Up/Down between them, Enter takes the best, Escape clears.
    $('#set-q')?.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' && hits.length) { e.preventDefault(); $('#set-hits button')?.focus(); }
      else if (e.key === 'Enter') { e.preventDefault(); showFound(hits[0]); }
      else if (e.key === 'Escape' && findQ) { e.preventDefault(); findQ = e.target.value = ''; findSettings(); }
    });
    $('#set-hits')?.addEventListener('keydown', e => {
      const all = $$('#set-hits button'), i = all.indexOf(document.activeElement), k = { ArrowDown: 1, ArrowUp: -1 }[e.key];
      if (!k || i < 0) return;
      e.preventDefault(); (all[i + k] || (k < 0 ? $('#set-q') : all[i]))?.focus();
    });
    if (findQ) findSettings();
    const { ocrReady, ocrSaved } = await import('../scan.js');
    if (!(ocrReady() || await ocrSaved()) || !$('#reader-state')) return;
    $('#reader-state').textContent = t('The receipt reader is ready on this phone and works offline.');
    $('#reader [data-act="reader-get"]')?.remove(); $('#reader-dl')?.remove();
  },
  render() {
    const rules = Object.entries(S.kv.rules), names = Object.entries(S.kv.itemNames || {}), bal = balances(S.accounts, S.tx, today()).by;
    const last = S.kv.lastBackup;
    return `<header class="top"><button class="icon-btn" data-act="back" data-to="home" aria-label="${esc(t('Back'))}">${ICON.back}</button><h1>${esc(t('Settings'))}</h1><span></span></header>
      <div class="sfind" role="search"><label class="search">${ICON.search}<input id="set-q" type="search" data-input="set-q" value="${esc(findQ)}" placeholder="${esc(t('Search settings'))}" aria-label="${esc(t('Search settings'))}" aria-controls="set-hits" autocomplete="off"></label>
        <ul class="list" id="set-hits" aria-label="${esc(t('Search settings'))}"></ul><p class="fine" id="set-none" role="status"></p></div>
      <nav class="jumps chips" aria-label="${esc(t('Go to'))}">${[['s-backup', t('Backup & restore')], ['s-accounts', t('Accounts')], ['s-cats', t('Categories')], ['look', t('Language & text size')], ['remind', t('Daily reminder')], ['s-help', t('Help and feedback')]].map(([id, l]) => `<button class="chip" data-act="jump" data-to="${id}">${esc(l)}</button>`).join('')}</nav>
      ${featuresCard()}
      ${lookCard()}
      <section class="card"><h2>${esc(t('Budget month'))}</h2>
        <label class="field"><span>${esc(t('My month starts on day'))}</span><select data-input="month-start">${[...Array.from({ length: 28 }, (_, i) => [i + 1, String(i + 1)]), [-2, t('Second-last day')], [-1, t('Last day')]].map(([v, l]) => `<option value="${v}"${startDay() === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <p class="fine">${esc(t('Paid on the 25th? Start your month on payday. Home, Budgets and Insights follow it.'))} ${esc(t('This month: {0}', fmtMonth(thisMonth(), startDay())))}</p></section>
      <section class="card" id="s-accounts"><h2>${esc(t('Accounts'))}</h2><ul class="list">${S.accounts.filter(a => !owing(a)).map(a => `<li><button class="txrow" data-act="acc-edit" data-id="${esc(a.id)}"><span class="grow"><b>${esc(a.name)}</b><small>${esc(accSub(a, bal))}</small></span><span class="fine">${esc(t('Edit'))}</span></button></li>`).join('')}</ul>
        <button class="btn ghost wide" data-act="acc-edit">${ICON.plus}${esc(t('Add an account'))}</button>${goalsSettings()}</section>
      <section class="card" id="joint"><h2>${esc(t('Joint account'))}</h2>
        <p class="fine">${esc(hasJoint() ? t('Send your joint accounts to your partner as a file. They import it in Tally, and their changes come back the same way.') : t('In a relationship? Mark an account as Joint (tap it above) to keep shared money apart from your own and share it with your partner.'))}</p>
        ${hasJoint() ? `<button class="btn ghost wide" data-act="joint-share">${ICON.download}${esc(t('Share joint accounts'))}</button>` : ''}
        <button class="btn ghost wide" data-act="restore-pick">${ICON.upload}${esc(t('Import from my partner'))}</button></section>
      <section class="card" id="remind"><h2>${esc(t('Daily reminder'))}</h2><p class="fine">${esc(t("Your calendar reminds you to add the day's spending, even with Tally closed."))}</p>
        <label class="field"><span>${esc(t('Remind me at'))}</span><input id="remind-at" type="time" value="${esc(settings().remindAt || '21:00')}"></label>
        <div class="row2"><button class="btn" data-act="remind-google">${ICON.calendar}${esc(t('Google Calendar'))}</button><button class="btn ghost" data-act="remind-ics">${ICON.download}${esc(t('Other calendar'))}</button></div></section>
      <section class="card" id="reader"><h2>${esc(t('Receipt reader'))}</h2><p class="fine" id="reader-state">${esc(t('The reader (about 30 MB) downloads the first time you scan. Get it now on Wi-Fi so scanning works offline straight away.'))}</p>
        <div class="dl" id="reader-dl" hidden><progress id="ocr-prog" max="100" value="0" aria-label="${esc(t('Downloading the receipt reader'))}"></progress><span id="ocr-pct" class="fine num"></span></div>
        <button class="btn ghost wide" data-act="reader-get">${ICON.download}${esc(t('Download the receipt reader now'))}</button></section>
      <section class="card" id="backup"><h2 id="s-backup">${esc(t('Backup'))}</h2>
        <p class="fine">${esc(last ? t('Last backup: {0}', last.slice(0, 10)) : t('Not backed up yet'))} · ${esc(t('Tally keeps everything on this phone. Save a backup file to Google Drive or email it to yourself.'))}</p>
        <div class="row2"><button class="btn" data-act="backup">${ICON.download}${esc(t('Back up now'))}</button><button class="btn ghost" data-act="restore-pick">${esc(t('Restore'))}</button></div>
        <button class="btn ghost wide" data-act="migration-guide">${esc(t('Migration help'))}</button>
        <p class="warnbox">${ICON.alert}<span>${esc(isNative ? t('Uninstalling Tally, clearing its app data, or resetting this phone deletes your entries, accounts and receipt photos. Back up first.') : t('Uninstalling Tally or clearing its site data deletes your Tally entries, accounts and receipt photos from this phone. Back up first.'))} <button class="link" data-act="storage-info">${esc(t('How your data is kept'))}</button></span></p>
        ${storage.persisted == null ? '' : `<p class="fine">${esc(storage.persisted ? t('Storage: protected. The browser will not clear Tally to free up space.') : t('If the phone runs out of space, the browser may clear Tally. A backup file keeps you safe.'))}</p>`}</section>
      <section class="card" id="s-data"><h2>${esc(t('Import & export'))}</h2><p class="fine">${esc(t('From Money Manager, Money Lover, Spendee, Wallet, Monefy, YNAB, Cashew, Bluecoins, 1Money, Toshl or AndroMoney, Excel, CSV, a bank statement, or Google Sheets.'))}</p>
        <button class="btn ghost wide" data-act="import-open">${ICON.upload}${esc(t('Import'))}</button>
        <p class="fine">${esc(t('Your data is never locked in: take it to Excel, Google Sheets or another money app any time.'))}</p>
        <button class="btn ghost wide" data-act="export-open">${ICON.download}${esc(t('Export'))}</button></section>
      <section class="card" id="s-cats"><h2>${esc(t('Categories'))}</h2><ul class="chips">${expenseCats().map(c => `<li><button class="chip dotbtn" data-act="cat-edit" data-c="${esc(c.id)}" aria-label="${esc(t('Icon and colour: {0}', t(c.name)))}">${badge(c)}${esc(t(c.name))}</button></li>`).join('')}</ul>
        <button class="btn ghost wide" data-act="cat-add">${ICON.plus}${esc(t('Add a category'))}</button>
        ${(gone => (gone.length ? `<p class="fine">${esc(t('Removed:'))}</p><ul class="chips">${gone.map(c => `<li><button class="chip" data-act="cat-back" data-c="${esc(c.id)}" aria-label="${esc(t('Bring back {0}', t(c.name)))}">${ICON.plus}${esc(t(c.name))}</button></li>`).join('')}</ul>` : ''))(settings().ownCats ? [] : CATEGORIES.filter(c => Object.hasOwn(settings().movedCats || {}, c.id)))}
        <label class="toggle"><span class="grow"><b>${esc(t('Only my categories'))}</b><small>${esc(t("Hide Tally's categories and stop its guesses. Things go to Other until you pick a category; Tally then remembers."))}</small></span><input type="checkbox" class="switch" data-input="own-cats"${settings().ownCats ? ' checked' : ''}></label>
        ${rules.length || names.length ? `<button class="btn ghost wide" data-act="rules-clear">${esc(t('Forget everything Tally learned'))}</button>` : ''}
        <details><summary>${esc(t('What Tally remembers ({0})', rules.length + names.length))}</summary><p class="fine">${esc(t('When you change an item\'s category, Tally files that item the same way next time.'))} ${esc(t('When you fix an item\'s name, Tally reads it that way next time.'))}</p>
          <ul class="list">${rules.slice(0, 200).map(([k, v]) => `<li class="rowb"><span class="grow">${esc(k.replace(/^SHOP /, `${t('Shop')}: `))} → ${esc(catName(v))}</span><button class="icon-btn" data-act="rule-del" data-k="${esc(k)}" aria-label="${esc(t('Forget'))}">${ICON.x}</button></li>`).join('')}${names.slice(-200).reverse().map(([k, v]) => `<li class="rowb"><span class="grow">${esc(k)} → ${esc(v)}</span><button class="icon-btn" data-act="name-del" data-k="${esc(k)}" aria-label="${esc(t('Forget'))}">${ICON.x}</button></li>`).join('')}</ul></details></section>
      <section class="card"><h2>${esc(t('Privacy'))}</h2><p class="fine">${esc(t('No account, no ads, no tracking. Receipts are read on this phone. Tally goes online only for its own files, a Google Sheets link you paste, an exchange rate you ask for, feedback you send, and a Google Calendar reminder you add.'))}</p>
        <div class="rowb">${ICON.image}<span class="grow"><b>${esc(t('Receipt photos'))}</b><small>${esc(t('{0} on this phone', new Set(S.tx.map(x => x.receiptId).filter(Boolean)).size))} · ${esc(settings().photoKeep > 0 ? t('kept {0} days', settings().photoKeep) : t('kept always'))}</small></span>
          <button class="btn small ghost" data-act="photos-manage">${esc(t('Manage'))}</button></div>
        <div class="rowb">${ICON.lock}<span class="grow"><b>${esc(t('Lock Tally'))}</b><small>${esc(!lockOn() ? t('Off') : settings().lock.kind === 'pass' ? t('On: password') : settings().lock.cred && !encOn() ? t('On: PIN, fingerprint or face') : t('On: PIN'))}</small></span>
          <button class="btn small ghost" data-act="lock-set">${esc(lockOn() ? t('Change the lock') : t('Turn on'))}</button>${lockOn() ? `<button class="btn small ghost" data-act="lock-off">${esc(t('Turn off'))}</button>` : ''}</div>
        ${lockOn() && storageMode() === 'indexeddb' ? `<div class="rowb">${ICON.lock}<span class="grow"><b>${esc(t('Encrypt data on this phone'))}</b><small>${esc(encOn() ? t('On') : t('Off'))}</small></span><button class="btn small ghost" data-act="${encOn() ? 'enc-off' : 'enc-on'}">${esc(encOn() ? t('Turn off') : t('Turn on'))}</button></div>` : ''}
        <p class="fine">${esc(!lockOn() ? t('A privacy lock for people who pick up your phone. Turn it on to encrypt your data too.') : !encOn() ? t('A privacy lock for people who pick up your phone. Your data is not encrypted.')
          : settings().lock.kind === 'pass' ? t('Your entries and photos are encrypted with your password. Without it no one can read them, not even from a copy of the phone.')
          : t('Your entries and photos are encrypted with your PIN. Someone with a copy of the phone could try every 4–6 digit PIN on a computer; a password of 8 or more characters stops that.'))}</p>
        <button class="btn ghost wide" data-act="net-check">${ICON.check}${esc(t('Check what Tally contacted'))}</button>
        <button class="btn ghost danger wide" data-act="erase">${ICON.trash}${esc(t("Erase Tally's data"))}</button>
        <p class="legal">${legalLinks()}</p></section>
      ${learnCard()}
      ${isNative ? `<section class="card"><h2>${esc(t('Use Tally on your computer'))}</h2><p class="fine">${esc(t('A bigger screen for your expenses. Nothing to install on the computer.'))}</p><button class="btn ghost wide" data-act="desk-connect">${esc(t('Start connection'))}</button></section>` : ''}
      ${isNative ? `<section class="card"><h2>${esc(t('Receipt shortcut'))}</h2><p class="fine">${esc(t('Double-tap a volume button while Tally is open to open the receipt camera. It does nothing in other apps. Single presses still change the volume.'))}</p><label class="field"><span>${esc(t('Button'))}</span><select data-input="scan-shortcut" id="scan-shortcut"><option value="off">${esc(t('Off'))}</option><option value="up">${esc(t('Volume up'))}</option><option value="down">${esc(t('Volume down'))}</option></select></label><p class="fine">${esc(t('For receipts in another app, take a screenshot and share that image with Tally. No background screen access.'))}</p></section>` : ''}
      <section class="card" id="s-help"><h2>${esc(t('Help and feedback'))}</h2>
        <div class="row2"><button class="btn ghost" data-act="tour">${esc(t('Take the tour'))}</button><button class="btn ghost" data-act="whats-new">${esc(t("What's new"))}</button></div>
        ${canInstall() ? `<button class="btn ghost wide" data-act="install">${ICON.download}${esc(t('Install Tally on this phone'))}</button>` : ''}
        ${isNative ? '' : `<button class="btn ghost wide" data-act="update-check">${esc(t('Check for updates'))}</button>
        <label class="toggle"><span class="grow"><b>${esc(t('Ask before updating'))}</b><small>${esc(t('A new version waits until you tap Update now, so you can read its changes first.'))}</small></span><input type="checkbox" class="switch" data-input="ask-update"${settings().askUpdate ? ' checked' : ''}></label>`}
        <p class="fine">${esc(t('Tell the developer about a bug or an idea. Sent: your message, the contact you add, and app and device details. Nothing about your money.'))}</p>
        <button class="btn ghost wide" data-act="feedback">${ICON.chat}${esc(t('Send feedback'))}</button>
        <p class="fine center">${esc(t('Or email the developer ({0}):', MAKER))} ${mailLink()}</p></section>
      <section class="card" id="s-about"><h2>${esc(t('About Tally'))}</h2><a class="btn ghost wide" href="${siteUrl()}" target="_blank" rel="noopener">${ICON.globe}${esc(t("Tally's website"))}</a></section>
      ${whyFree()}
      <p class="fine center">Tally ${APP_VERSION}<span id="build">${buildLink()}</span> · <a class="link" href="https://github.com/tallymy/tallymy.github.io/commits/main" target="_blank" rel="noopener">${esc(t("Every change, with its code"))}</a></p>`;
  },
};
export const input = {
  'scan-shortcut': async el => { try { await Capacitor.Plugins.TallyNative.scanShortcut({ button: el.value }); } catch { el.value = 'off'; toast(t('Could not save. Your phone may be out of space.'), { k: 'bad' }); } },
  'set-q': el => { findQ = el.value; findSettings(); if (hits.length) announce(t('{0} found', hits.length)); },
module: async el => { await setModules({ [el.dataset.k]: el.checked }); render(); $(`[data-input="module"][data-k="${el.dataset.k}"]`)?.focus(); },
  'text-size': el => setSize(+el.value),
  'ask-update': async el => { await setSetting('askUpdate', el.checked); await holdUpdates(el.checked); },
  'own-cats': async el => { await setSetting('ownCats', el.checked); ownCategories(el.checked); render(); toast(el.checked ? t('Only your categories now. Add yours above.') : t("Tally's categories are back.")); },
  'ac-cur': el => {   // another currency: its rate, starting from a rough one to change
    const fx = el.value !== 'MYR', f = $('#ac-rate-f');
    f.hidden = $('#ac-cur-note').hidden = !fx;
    if (fx) { f.querySelector('span').textContent = t('RM for 1 {0}', el.value); $('#ac-rate').value = FX_START[el.value]; }
    const say = (id, rm, cur) => { const s = $(id)?.closest('label').querySelector('span'); if (s) s.textContent = fx ? t(cur, el.value) : t(rm); };
    say('#ac-open', 'Balance when you started (RM)', 'Balance when you started ({0})'); say('#ac-now', 'Balance today (RM)', 'Balance today ({0})');
  },
  'month-start': async el => { const v = +el.value; await setSetting('monthStart', v === -1 || v === -2 ? v : Math.min(28, Math.max(1, v || 1))); render(); },
  'imp-map': el => { if (el.value === '') delete IMP.map[el.dataset.k]; else IMP.map[el.dataset.k] = +el.value; showMapping(); },
  'imp-acc': el => { IMP.accountId = el.value; showMapping(); },
  'imp-accname': el => { IMP.accName = el.value; },
  'imp-joint': el => { IMP.joint = el.checked; },
  'my-name': el => setSetting('myName', cleanText(el.value, 30)),
  compact: async el => { await setSetting('compact', el.checked); applyLook(settings()); },
  haptics: async el => { await setSetting('haptics', el.checked); haptic(); },
  'home-card': async el => {
    const k = el.dataset.k;
    if (k === 'learn') return setSetting('learnHidden', !el.checked);
    const hide = new Set(settings().homeHide || []);
    if (el.checked) hide.delete(k); else hide.add(k);
    await setSetting('homeHide', [...hide]);
  },
  'imp-future': el => { IMP.skipFuture = el.checked; showMapping(); },
  'imp-cat': el => { IMP.catMap[el.dataset.src] = el.value; },
};

// ---- import: files, paste, Google Sheets link, Money Manager ------------------------------------------------------------
let IMP = null; // {rows, header, map, accountId, catMap, name} or {mm, buf}
function importSheet() {
  openSheet(`<h2 class="sh-title">${esc(t('Bring data in'))}</h2>
    <label class="btn wide filebtn">${ICON.upload}${esc(t('Choose a file'))}<input type="file" id="imp-file" hidden></label>
    <p class="err" id="imp-err" role="alert"></p>
    <p class="fine">${esc(t("Can't see your file here? Open your phone's file manager, long-press the file and Share it to Tally. Or move it to another folder once, then it shows up here."))}</p>
    <p class="fine">${esc(t('Exports and backups from Money Manager (Innim or Realbyte), Money Lover, Spendee, Wallet, Monefy, YNAB, Cashew, Bluecoins, 1Money, Toshl or AndroMoney; Excel (.xlsx) or CSV from your bank; or a Tally backup.'))}</p>
    <details class="howto"><summary>${esc(t('How to export from your money app'))}</summary><ul class="newlist">${howTo().map(([a, s]) => `<li><b>${esc(a)}:</b> ${esc(s)}</li>`).join('')}</ul></details>
    <h3>${esc(t('From Google Sheets'))}</h3>
    <label class="field"><span>${esc(t('Paste the cells (select all in the sheet, copy, paste here)'))}</span><textarea id="imp-paste" rows="4" placeholder="Date	Amount	Category	Note"></textarea></label>
    <button class="btn ghost wide" data-act="imp-paste">${esc(t('Use pasted cells'))}</button>
    <label class="field"><span>${esc(t('Or paste the sheet link (sharing must be "Anyone with the link")'))}</span><input id="imp-link" inputmode="url" placeholder="https://docs.google.com/spreadsheets/d/…"></label>
    <button class="btn ghost wide" data-act="imp-link">${esc(t('Fetch from Google Sheets'))}</button>`, { label: t('Import') });
  $('#imp-file').addEventListener('change', e => { const f = e.target.files[0]; if (f) importFile(f); });
}
/** Where each app keeps its export (presets.js reads them with no column matching). Menu names as the apps' help pages
 *  give them; ponytail: check a path when an app redesigns its settings. */
const howTo = () => [
  ['Money Manager (Realbyte)', t('More → Backup → Export data to Excel, or Backup data for a .mmbak file.')],
  ['Money Manager (Innim)', t('Settings → Backup → create a backup (.mmbackup).')],
  ['Money Lover', t('Settings → Export to CSV or Excel, with all wallets.')],
  ['Spendee', t('Settings → Export (CSV). One file per wallet; transfers between them are matched.')],
  ['Wallet by BudgetBakers', t('Settings → Export → all data, CSV.')],
  ['Monefy', t('Settings → Export to file (CSV).')],
  ['YNAB', t('Budget menu → Export budget; unzip it and pick the Register file.')],
  ['Cashew', t('Settings → Import and export → Export CSV.')],
  ['Bluecoins', t('Settings → Export to CSV.')],
  ['1Money', t('Settings → Export to CSV.')],
  ['Toshl', t('On toshl.com: Export → CSV.')],
  ['AndroMoney', t('Settings → Export → CSV (Excel), all accounts.')],
];
const newAccName = () => cleanText(IMP?.accName || '', 40) || (IMP?.sheet ? t('Google Sheet') : '') || cleanText(String(IMP?.name || '').replace(/\.[a-z0-9]{2,5}$/i, ''), 40) || t('Imported');
const impAccount = () => (IMP.accountId === 'new' ? IMP.newId : IMP.accountId);
const newKind = () => IMP.kind || (IMP.map.debit != null || IMP.map.credit != null || IMP.map.balance != null ? 'bank' : 'cash');
/** What's wrong with a typed amount: over RM 100 million, or not an amount. */
const amtErr = v => (tooLarge(v) ? t('That amount is too large (RM 100 million at most).') : t('Enter amounts like 150 or 150.50.'));
/** Import progress and errors, under "Choose a file" and scrolled into view (a small phone showed them below the fold). */
const impErr = m => { const el = $('#imp-err'); if (!el) return toast(m, { k: 'bad' }); el.textContent = m; if (m) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
async function ensureAccount() {
  if (!S.accounts.length) await saveAccount({ id: uid('a'), name: t('Cash'), kind: 'cash', opening: 0, createdAt: Date.now() });
}
/** An account the user already has for this bank or wallet ("Maybank MAE" for Maybank), same kind when known. */
const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const findAccount = (name, kind) => {
  const n = norm(name), ok = a => !kind || a.kind === kind;
  return n ? S.accounts.find(a => ok(a) && norm(a.name) === n) || S.accounts.find(a => ok(a) && (norm(a.name).startsWith(n) || n.startsWith(norm(a.name)))) : null;
};
export async function importFile(f) {
  if (!$('#imp-err')) importSheet();   // shared from another app: show the import sheet for messages
  let kind = 'file';
  try {
    // A password-protected backup is its file in base64 (a third bigger): it may be as big as the biggest backup sealed.
    const sealed = f.size > LIMITS.backupBytes && isSealed(new TextDecoder().decode(await f.slice(0, 64).arrayBuffer()));
    if (f.size > (sealed ? SEALED_MAX : LIMITS.backupBytes)) return impErr(t('That file is too big (over 200 MB).'));
    impErr(t('Reading {0} ({1} MB)…', f.name || t('file'), Math.max(0.1, Math.round(f.size / 104857.6) / 10)));
    const buf = await f.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 64));
    const zipAt = head.findIndex((x, i) => x === 0x50 && head[i + 1] === 0x4b && head[i + 2] === 3 && head[i + 3] === 4);
    // Money Manager backups: .mmbackup, or any zip (maybe renamed by a download) holding MyFinance.db
    if (!/\.mmbak$/i.test(f.name) && (/\.mmbackup$/i.test(f.name) || (zipAt > 0 && zipAt < 64))) { kind = 'Money Manager'; return await importMoneyManager(buf); }
    if (/\.json$/i.test(f.name) || new Uint8Array(buf.slice(0, 1))[0] === 0x7b) {
      const text = isSealed(new TextDecoder().decode(head)) ? new TextDecoder().decode(buf) : jsonText(buf);   // sealed: held to SEALED_MAX above
      if (isSealed(text)) {   // a password-protected backup: opened here, then read like any backup (zip or JSON)
        const pw = await askPassword(); if (!pw) return impErr('');
        const bytes = await openBackup(text, pw);
        return importFile(new File([bytes], bytes[0] === 0x50 ? 'tally-backup.zip' : 'tally-backup.json'));
      }
      return await restoreText(text);
    }
    // Money Manager by Realbyte (.mmbak): SQLite, bare or zipped
    if (/\.mmbak$/i.test(f.name) || new TextDecoder().decode(head.slice(0, 15)) === 'SQLite format 3') { kind = 'Money Manager'; return await importMoneyManager(buf, 'realbyte'); }
    if (zipAt === 0) {
      const names = [];
      const z = await unzip(buf, n => (names.push(n), n === BACKUP_JSON || /^photos\/[\w-]{1,60}\.jpg$/.test(n))).catch(() => ({}));
      if (z[BACKUP_JSON]) return await restoreText(jsonText(z[BACKUP_JSON]), z);
      if (names.includes('MyFinance.db')) { kind = 'Money Manager'; return await importMoneyManager(buf); }   // a .mmbackup renamed .zip (Telegram, Drive)
      if (names.length && !names.some(n => n.startsWith('xl/'))) { kind = 'Money Manager'; return await importMoneyManager(buf, 'realbyte'); }   // a renamed .mmbak
    }
    if (new TextDecoder().decode(buf.slice(0, 5)) === '%PDF-') return await importStatement(buf);
    await startMapping(await fileToRows(f.name, buf), f.name);
  } catch (e) { console.error(e); impErr(kind === 'Money Manager' ? t('This looks like a Money Manager backup, but it could not be read: {0}', t(e.message)) : t(e.message)); }
}
/** `sheet`: pasted cells or a Google Sheets link. Its new account is named "Google Sheet" (or by its Account column),
 *  and the next paste goes into the account the last one used. */
async function startMapping(rows, name, { sheet = false } = {}) {
  rows = Object.assign(reshape(rows), { tabs: rows.tabs });   // side-by-side tables and one column per category, as a list
  const h = headerRow(rows);
  if (rows.length < h + 2) return impErr(t('That file has no rows to import. Check you picked the right sheet.'));
  const header = rows[h].map(x => cleanText(x, 40)), sig = hash(header.join('|').toLowerCase());
  // The bank or wallet from the file name and the title rows above the header, never from the transactions:
  // a Touch 'n Go export says "Reload via Maybank" on every reload.
  const prov = detectProvider([String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_.-]+/g, ' '), ...rows.slice(0, h).map(r => r.join(' '))]);
  const kind = prov?.[2] || (header.some(x => /wallet|dompet/i.test(x)) ? 'ewallet' : null);
  // The columns and categories chosen the last time a file with this header came in.
  // Another money app's export: its columns, transfers and categories are known (presets.js).
  const preset = detectPreset(header, name);
  const saved = settings().importMaps?.[sig], okMap = saved?.map && (saved.preset || null) === (preset?.id || null) && Object.values(saved.map).every(i => Number.isInteger(i) && i >= 0 && i < header.length);
  const have = new Set([...expenseCats(), ...INCOME_CATEGORIES].map(c => c.id));
  const catMap = Object.assign(Object.create(null), Object.fromEntries(Object.entries(saved?.catMap || {}).filter(([, v]) => have.has(v))));   // keyed by the file's names
  const sourceKey = hash(JSON.stringify(rows)), remembered = settings().importSources?.[sourceKey] ?? settings().importSources?.[hash(JSON.stringify([name, rows]))];   // by content: "file (1).csv" is the same file (the old key held the name too)
  const existing = S.accounts.find(a => a.id === remembered) || (sheet && S.accounts.find(a => a.id === settings().sheetAccount)) || (prov && findAccount(prov[1], kind))
    || (!preset && /bank|statement|penyata|结单|對賬/i.test(name) && S.accounts.filter(a => a.kind === 'bank').length === 1 && S.accounts.find(a => a.kind === 'bank'));   // "bank_statement_sep.csv" and one bank account: that one
  // Another app's history or a bank's statement is its own account by default (Round 2: imports landed in Cash).
  IMP = { rows: rows.slice(h + 1), header, sig, sourceKey, map: okMap ? { ...saved.map } : preset ? { ...preset.map } : guessMapping(header), preset, accountId: existing?.id || 'new', newId: uid('a'), accName: prov?.[1] || (sheet ? t('Google Sheet') : ''), kind, catMap, accIds: Object.create(null), name, sheet, skipFuture: true, tabs: rows.tabs };
  showMapping();
}
/** Their categories, each with its Tally category: chosen, remembered, matched by name, or a new one named after it. */
function catChoices() {
  const { rows, map } = IMP, out = Object.create(null);
  if (map.category == null) return out;
  const ctx = { preset: IMP.preset, header: IMP.header };
  for (const s of new Set(rows.filter(r => isMoneyRow(r, map, ctx)).map(r => cleanText(rowCategory(r, map, ctx), 60)).filter(Boolean))) {
    if (Object.keys(out).length >= 60) break;
    // Their names stay: the Tally category of exactly that name, else a new one called the same. "Other" stays Other.
    out[s] = IMP.catMap[s] || sameCategory(s, S.kv.customCats) || sameCategory(s, S.kv.customCats, true) || (OTHER_NAME.test(theirCatName(s)) ? 'other' : `new:${theirCatName(s)}`);
  }
  return out;
}
/** An Account column ("Paid by": Cash / TNG / Card): one account per value, an existing one when the name matches. */
function accPlan() {
  const { rows, map } = IMP, values = [], lookup = Object.create(null), { names, blanks } = accountNames(rows, map, { preset: IMP.preset, header: IMP.header });
  for (const v of names) {
    if (values.length >= 20) break;
    const kind = guessKind(v), a = findAccount(v, kind);
    const id = a?.id || (IMP.accIds[v.toLowerCase()] ||= uid('a'));
    values.push({ v, id, kind, isNew: !a });
    lookup[v.toLowerCase()] = id;
  }
  return { values, lookup, blanks };
}
/** An existing account the file goes into whose balance was never given and that has no entries yet: the file sets it. */
const unsetTarget = () => IMP.accountId !== 'new' && S.accounts.find(a => a.id === IMP.accountId && a.typed === false && !S.tx.some(x => x.accountId === a.id || x.toAccountId === a.id));
/** The rows as they will be imported, with the sheet's choices applied, what is already here, and a new account's opening balance. */
function impPlan() {
  const acc = accPlan();
  const { txs: all, skipped, loose, adjustments, opening: adjusted, openKnown } = rowsToTx(IMP.rows, IMP.map, { accountId: impAccount(), accounts: acc.lookup, catMap: catChoices(), customCats: S.kv.customCats, preset: IMP.preset, header: IMP.header });
  const tdy = today(), later = all.filter(x => x.date > tdy), future = later.length, txs = IMP.skipFuture ? all.filter(x => x.date <= tdy) : all;
  // Day and month may be swapped only if every such date could be read the other way round, and there are several.
  const swapped = future >= 3 && later.every(x => +x.date.slice(8, 10) <= 12);
  const names = Object.fromEntries([...S.accounts.map(a => [a.id, a.name]), [IMP.newId, newAccName()], ...acc.values.map(a => [a.id, a.v])]);
  return { txs, ...splitDups(S.tx, txs, names), skipped, future, swapped, acc, loose, adjustments, adjusted, openKnown, opening: (IMP.accountId === 'new' || unsetTarget()) && IMP.map.account == null ? openingFromBalance(IMP.rows, IMP.map, all, tdy) : null };
}
function showMapping() {
  const { header, map, rows } = IMP;
  const col = (k, label) => `<label class="field"><span>${esc(label)}</span><select data-input="imp-map" data-k="${k}"><option value="">${esc(t('(none)'))}</option>${header.map((h, i) => `<option value="${i}"${map[k] === i ? ' selected' : ''}>${esc(h || t('Column {0}', i + 1))}</option>`).join('')}</select></label>`;
  const { fresh, dups, skipped, future, swapped, opening, acc, loose, adjustments } = impPlan(), moved = fresh.filter(x => x.type === 'transfer').length;
  const reloads = planMoves(fresh, [...S.accounts, { id: IMP.newId, kind: newKind() }, ...acc.values], '').reloads.length, kept = Object.keys(typedShift(S.accounts, S.tx, fresh, today())).length;
  // What the import will add, before it's added: dates, money in and out, and dates that can't be right yet.
  const dates = fresh.map(x => x.date).sort(), sum = k => fresh.filter(x => x.type === k).reduce((s, x) => s + x.amount, 0);
  const choices = catChoices(), cats = [...expenseCats(), ...INCOME_CATEGORIES], tabs = IMP.tabs;
  const intoAcc = `<label class="field"><span>${esc(map.account != null ? t('Rows without an account go into') : t('Into account'))}</span><select data-input="imp-acc">${S.accounts.filter(a => !owing(a)).map(a => `<option value="${esc(a.id)}"${IMP.accountId === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}<option value="new"${IMP.accountId === 'new' ? ' selected' : ''}>${esc(t('A new account'))}</option></select></label>
    ${IMP.accountId === 'new' ? `<label class="field"><span>${esc(t('Name of the new account'))}</span><input data-input="imp-accname" maxlength="40" value="${esc(newAccName())}"></label>
      <label class="check"><input type="checkbox" data-input="imp-joint"${IMP.joint ? ' checked' : ''}> ${esc(t('Joint (shared with my partner)'))}</label>
      ${opening != null ? `<p class="fine">${esc(t('Opening balance {0}, worked out from the Balance column so the account matches your statement.', fmtRM(opening)))}</p>` : ''}` : ''}`;
  openSheet(`<h2 class="sh-title">${esc(t('Match the columns'))}</h2><p class="fine">${esc(IMP.name || '')} · ${esc(rows.length === 1 ? t('1 row') : t('{0} rows', rows.length))}</p>
    ${IMP.preset ? `<p class="okbox">${esc(t('Recognised: {0} export. Columns, accounts, transfers and categories are matched for you; change anything that looks wrong.', IMP.preset.name))}</p>` : ''}
    ${tabs?.read.length > 1 ? `<p class="fine">${esc(t('Tabs read: {0}', tabs.read.join(', ')))}</p>` : ''}
    ${tabs?.skipped.length ? `<p class="warnbox">${ICON.alert}<span class="grow">${esc(t('Tabs not imported: {0}', tabs.skipped.map(s => `${s.name} (${s.why === 'rows' ? t('too many rows') : t('no date or amount column')})`).join(', ')))}</span></p>` : ''}
    <div class="grid2">${col('date', t('Date'))}${col('amount', t('Amount'))}${col('debit', t('Money out (debit)'))}${col('credit', t('Money in (credit)'))}${col('type', t('Income or expense'))}${col('category', t('Category'))}${col('merchant', t('Shop / payee'))}${col('note', t('Note'))}${col('balance', t('Balance'))}${col('account', t('Account'))}</div>
    ${acc.values.length ? `<p class="fine">${esc(t('Accounts from this column: {0}', acc.values.map(a => (a.isNew ? t('{0} (new)', a.v) : a.v)).join(', ')))}</p>` : ''}
    ${map.account == null || acc.blanks ? intoAcc : ''}
    ${Object.keys(choices).length ? `<details open><summary>${esc(t('Their categories → Tally categories'))}</summary><div class="grid2">${Object.entries(choices).map(([s, v]) => `<label class="field"><span>${esc(s)}</span><select data-input="imp-cat" data-src="${esc(s)}">${cats.map(c => `<option value="${esc(c.id)}"${v === c.id ? ' selected' : ''}>${esc(t(c.name))}</option>`).join('')}<option value="${esc(`new:${s}`)}"${v === `new:${s}` ? ' selected' : ''}>${esc(t('New category: {0}', s))}</option></select></label>`).join('')}</div></details>` : ''}
    ${fresh.length || !dups.length ? `<p class="${fresh.length ? 'okbox' : 'warnbox'}">${esc(t('{0} ready to import', fresh.length))}${dups.length ? ` · ${esc(t('{0} already in Tally, will be skipped', dups.length))}` : ''}${(k => (k.length ? ` · ${esc(k.length === 1 ? t('1 row skipped (no date or amount)') : t('{0} rows skipped (no date or amount)', k.length))}` : ''))(skipped.filter(x => !['currency', 'unpaid'].includes(x.why)))}</p>
    ${(k => (k ? `<p class="warnbox">${ICON.alert}<span>${esc(t('{0} rows are in another currency (SGD…) and were left out. Add an account in that currency (Settings → Accounts), then import them into it.', k))}</span></p>` : ''))(skipped.filter(x => x.why === 'currency').length)}
    ${(k => (k ? `<p class="fine">${esc(t('{0} unpaid rows (Paid? not ticked) left out.', k))}</p>` : ''))(skipped.filter(x => x.why === 'unpaid').length)}
    ${(k => (k ? `<p class="warnbox">${ICON.alert}<span>${esc(t('{0} rows are for accounts after the first 20 and were left out. Import them from a file with fewer accounts.', k))}</span></p>` : ''))(skipped.filter(x => x.why === 'account').length)}
    ${!fresh.length && !dups.length && !skipped.some(x => ['currency', 'unpaid', 'failed', 'account'].includes(x.why)) ? `<p class="fine">${esc(IMP.map.date == null ? t('No date column found. Pick it above, or open the tab with your transactions.') : (IMP.map.amount ?? IMP.map.debit ?? IMP.map.credit) == null ? t('No amount column found. Pick it above.') : t('This looks like a summary or budget, not a list of transactions. Open the tab with your transactions, or pick the columns above.'))}</p>` : ''}`
      : `<p class="warnbox">${esc(t('All {0} rows are already in Tally. Nothing new to import.', dups.length))}</p>`}
    ${fresh.length ? `<p class="fine">${esc(t('{0} to {1}', fmtDate(dates[0]), fmtDate(dates.at(-1))))} · ${esc(t('{0} spent', fmtRM(sum('expense'))))} · ${esc(t('{0} received', fmtRM(sum('income'))))}</p>` : ''}
    ${moved || loose || adjustments ? `<p class="fine">${[moved && (moved === 1 ? t('1 transfer between your accounts') : t('{0} transfers between your accounts', moved)), loose && (loose === 1 ? t("1 transfer to another wallet: import that wallet's file next and it will be matched.") : t("{0} transfers to another wallet: import that wallet's file next and they'll be matched.", loose)), adjustments && t('{0} balance corrections folded into opening balances (not counted as spending)', adjustments)].filter(Boolean).map(esc).join(' · ')}</p>` : ''}
    ${reloads ? `<p class="fine">${esc(t('{0} wallet reloads with no bank line: counted as money moved from your bank, not as income.', reloads))}</p>` : ''}
    ${kept ? `<p class="okbox">${esc(t('Balances stay as you set them today: rows from before an account was added are already in its starting balance.'))}</p>` : ''}
    ${future ? `<div class="warnbox">${ICON.alert}<span class="grow">${esc(swapped ? t('{0} rows are dated after today. If that looks wrong, check the date column: day and month may be swapped.', future) : future === 1 ? t('1 row is dated after today (a scheduled or future entry).') : t('{0} rows are dated after today (scheduled or future entries).', future))}
      <label class="check"><input type="checkbox" data-input="imp-future"${IMP.skipFuture ? ' checked' : ''}> ${esc(t('Leave them out'))}</label></span></div>` : ''}
    <ul class="list preview">${fresh.slice(0, 5).map(x => `<li class="rowb"><span>${esc(fmtDate(x.date))}</span><span class="grow">${esc(x.merchant || '')}</span><span class="amt ${x.type}">${x.type === 'income' ? '+' : x.type === 'transfer' ? '' : '−'}${esc(fmtRM(x.amount))}</span></li>`).join('')}</ul>
    <div class="row2"><button class="btn ghost" data-act="sheet-close">${esc(t('Cancel'))}</button><button class="btn" data-act="imp-go" ${fresh.length ? '' : 'disabled'}>${esc(t('Import {0}', fresh.length))}</button></div>`, { label: t('Import') });
}
/**
 * What an import moves between the user's own accounts: a reload that shows up as money out of the bank and money into
 * the wallet becomes one transfer (pairTransfers), also when the other side came in earlier; a wallet reload with no
 * bank line becomes a transfer from the bank its text names, else from `otherId` (a bank not in Tally): never income.
 */
function planMoves(fresh, accounts, otherId) {
  const pairs = pairTransfers([...S.tx, ...fresh], fresh), paired = new Set(pairs.flat().map(x => x.id));
  return { pairs, paired, reloads: reloadTransfers(fresh.filter(x => !paired.has(x.id)), accounts, otherId) };
}
/**
 * Save imported rows, minus those already here (splitDups), with their transfers (planMoves). An account whose
 * starting balance the user typed keeps today's balance when older rows come in (typedShift).
 * Undo takes everything back: the rows, the transfers (restoring what they replaced), photos, new accounts, openings.
 * `before(fresh)` runs first (photos) and returns photo ids to remove again on Undo. → the ids of the accounts it touched.
 */
async function commitImport(txs, label, { before = async () => [], accounts = [], kv = {}, newAccounts = [], undoMore = async () => {}, tourLater = false } = {}) {
  const split = splitDups(S.tx, txs, Object.fromEntries([...S.accounts, ...accounts].map(a => [a.id, a.name]))), { dups } = split;
  const outside = S.accounts.find(a => a.outside), { relink, taken } = outside ? relinkReloads(S.tx, split.fresh, outside.id) : { relink: [], taken: new Set() };
  const fresh = split.fresh.filter(x => !taken.has(x.id));   // reloads the wallet's file already had: now from this bank
  const photoIds = await before(fresh);
  const other = S.accounts.find(a => a.outside) || { id: uid('a'), name: t('Other bank'), kind: 'bank', opening: 0, outside: true, createdAt: Date.now() };
  if (![...S.accounts, ...accounts].some(a => a.kind === 'cash' && !a.outside) && fresh.some(isAtm)) {   // withdrawals need a wallet to go into; its balance is the user's to give
    const cash = { id: uid('a'), name: t('Cash'), kind: 'cash', opening: 0, typed: false, createdAt: Date.now() };
    accounts = [...accounts, cash]; newAccounts = [...newAccounts, cash.id];
  }
  const { pairs, paired, reloads } = planMoves(fresh, [...S.accounts, ...accounts], other.id), moved = new Set(reloads.map(x => x.id));
  if (reloads.some(x => x.accountId === other.id) && !S.accounts.includes(other)) { accounts = [...accounts, other]; newAccounts = [...newAccounts, other.id]; }
  const relinked = new Set(relink.map(x => x.id));
  const replaced = S.tx.filter(x => paired.has(x.id) || relinked.has(x.id)), save = [...fresh.filter(x => !paired.has(x.id) && !moved.has(x.id)), ...pairs.map(asTransfer), ...reloads, ...relink];
  const kept = new Set(save.map(x => x.id)), gone = replaced.filter(x => !kept.has(x.id)).map(x => x.id);
  const used = new Set(save.flatMap(x => [x.accountId, x.toAccountId]).filter(Boolean));
  const stagedAccounts = accounts.filter(a => !newAccounts.includes(a.id) || used.has(a.id));
  const was = new Set(replaced.map(x => x.id)), shift = typedShift(S.accounts, S.tx, save.filter(x => !was.has(x.id)), today()), shifted = S.accounts.filter(a => shift[a.id]);
  for (const a of shifted) { const i = stagedAccounts.findIndex(x => x.id === a.id), base = i >= 0 ? stagedAccounts[i] : a, next = { ...base, opening: (base.opening || 0) + shift[a.id], updatedAt: Date.now() }; if (i >= 0) stagedAccounts[i] = next; else stagedAccounts.push(next); }
  const first = !settings().onboarded;
  const stagedKv = { ...kv, ...(first ? { settings: { ...(kv.settings || settings()), onboarded: true } } : {}) };
  const brings = stagedAccounts.some(a => newAccounts.includes(a.id) && a.kind === 'bank' && !a.outside);
  const empty = brings ? S.accounts.filter(a => a.typed === false && a.kind === 'bank' && !a.outside && !a.scope?.match(/joint|business/) && !S.tx.some(x => x.accountId === a.id || x.toAccountId === a.id) && !save.some(x => x.accountId === a.id || x.toAccountId === a.id)) : [];
  if (overCapAfter({ accounts: S.accounts, tx: S.tx, recurring: S.recurring, customCats: S.kv.customCats }, { accounts: stagedAccounts, tx: save, customCats: stagedKv.customCats }, { tx: gone, accounts: empty.map(a => a.id) })) {
    await deletePhotos(photoIds); throw new Error(t("Adding this would make Tally's data more than a backup can restore, so nothing was added."));
  }
  try { await putAll({ accounts: stagedAccounts, tx: save, del: { tx: gone, accounts: empty.map(a => a.id) }, kv: stagedKv, edit: true }); }   // joint rows sync like any edit
  catch (e) { await deletePhotos(photoIds); throw e; }
  if (first && !tourLater) afterSetup();
  closeSheet(); go('home'); render();
  toast(t('Imported {0} from {1}', fresh.length, label) + (dups.length ? ` · ${t('{0} already here, skipped', dups.length)}` : '') + (pairs.length + relink.length ? ` · ${t('{0} top-ups counted as transfers between your accounts', pairs.length + relink.length)}` : '')
    + (reloads.length ? ` · ${t('{0} wallet reloads with no bank line: counted as money moved from your bank, not as income.', reloads.length)}` : ''), { undo: !save.length ? null : async () => {
    await putAll({ accounts: [...shifted, ...empty], tx: replaced, del: { tx: save.map(x => x.id), accounts: newAccounts.filter(id => !S.tx.some(x => !kept.has(x.id) && (x.accountId === id || x.toAccountId === id))) }, edit: true, mark: false });   // the import's own rows, seconds old and never shared: no delete markers (1000 of them pushed out real ones)
    await deletePhotos(photoIds);
    await undoMore(); render();
  } });
  return [...used].filter(id => id !== other.id);
}
/** After an import that said nothing about balances: what each account it touched (new or already here) holds today,
 *  prefilled with Tally's figure. Saving moves each starting balance to match, so nothing counts as spending. */
function balanceTodaySheet(ids, onClose) {
  const accs = ids.map(id => S.accounts.find(a => a.id === id)).filter(a => a && !a.outside);
  if (!accs.length) return onClose?.();
  const now = balances(accs, S.tx, today()).by;
  const done = async () => {   // skipped (or left empty) and below zero: the balance is unknown, and Home says "not set" instead of a false minus
    for (const a of accs) { const cur = S.accounts.find(x => x.id === a.id); if (cur && !cur.typed && balances([cur], S.tx, today()).by[cur.id] < 0) await saveAccount({ ...cur, typed: false }); }
    onClose?.();
  };
  openSheet(`<h2 class="sh-title">${esc(t('What is in these accounts today?'))}</h2><p class="sh-body">${esc(t('The file has no balances. Type what your bank or wallet app shows today; Tally moves the starting balance to match, so nothing counts as spending.'))}</p>
    ${accs.map(a => `<label class="field"><span>${esc(a.name)} · ${esc(t('Balance today (RM)'))}</span><input inputmode="decimal" data-bt="${esc(a.id)}" data-now="${now[a.id] ?? 0}" value="${(now[a.id] ?? 0) < 0 ? '' : ((now[a.id] ?? 0) / 100).toFixed(2)}"></label>`).join('')}
    <p class="err" id="bt-err" role="alert"></p>
    <div class="row2"><button class="btn ghost" data-act="sheet-close">${esc(t('Skip'))}</button><button class="btn" data-act="bt-save">${esc(t('Save'))}</button></div>`, { label: t('Balance today (RM)'), onClose: done });
}
/** Money Manager backups: Innim (.mmbackup) or, with app 'realbyte', Realbyte (.mmbak). An Innim-looking zip without
 *  MyFinance.db gets a second try as Realbyte. */
async function importMoneyManager(buf, app) {
  impErr(t('Reading the Money Manager backup…'));
  const { loadSqlJs, readMoneyManager, readRealbyte } = await import('../mmimport.js');
  const SQL = await loadSqlJs();
  const mm = app === 'realbyte' ? await readRealbyte(buf, SQL) : await readMoneyManager(buf, SQL).catch(e => (/MyFinance.db is missing/.test(e.message) ? readRealbyte(buf, SQL) : Promise.reject(e)));
  IMP = { mm, buf };
  const appName = mm.app === 'cashew' ? 'Cashew' : 'Money Manager';
  openSheet(`<h2 class="sh-title">${esc(mm.app === 'cashew' ? t('Cashew backup') : mm.app === 'realbyte' ? t('Money Manager (Realbyte) backup') : t('Money Manager backup'))}</h2>
    <ul class="list"><li>${esc(t('{0} transactions', mm.tx.length))}</li><li>${esc(t('{0} accounts: {1}', mm.accounts.length, mm.accounts.map(a => a.name).join(', ')))}</li>
    <li>${esc(t('{0} of your categories kept as they are', mm.customCats.length))}</li>${mm.skipped ? `<li class="warn">${esc(t('{0} could not be read and will be skipped', mm.skipped))}</li>` : ''}
    ${mm.adjustments ? `<li>${esc(t('{0} balance corrections folded into opening balances (not counted as spending)', mm.adjustments))}</li>` : ''}
    ${mm.transfers ? `<li>${esc(t('{0} transfers between your accounts', mm.transfers))}</li>` : ''}
    ${mm.planned ? `<li>${esc(t('{0} upcoming entries not paid yet are left out', mm.planned))}</li>` : ''}
    ${mm.transfersSkipped ? `<li class="warn">${esc(t('{0} transfers between accounts were not imported', mm.transfersSkipped))}</li>` : ''}
    ${mm.otherCurrency.length ? `<li class="warn">${esc(t('Not in RM: {0}. Kept in their own currency and counted in RM at a rate you can change in Settings.', mm.otherCurrency.join(', ')))}</li>` : ''}</ul>
    ${mm.photos.length ? `<label class="check"><input type="checkbox" id="mm-photos" checked> ${esc(mm.photos.length === 1 ? t('Also import 1 receipt photo (up to {0} MB on this phone)', Math.round(buf.byteLength / 1048576)) : t('Also import {0} receipt photos (up to {1} MB on this phone)', mm.photos.length, Math.round(buf.byteLength / 1048576)))}</label>` : ''}
    <p class="fine">${esc(appName === 'Cashew' ? t('Balances will match what Cashew shows today.') : t('Balances will match what Money Manager shows today.'))}</p>
    <div class="row2"><button class="btn ghost" data-act="sheet-close">${esc(t('Cancel'))}</button><button class="btn" data-act="mm-go">${esc(t('Import'))}</button></div>`, { label: t('Import') });
}

// ---- bank and e-wallet PDF statements ---------------------------------------------------------------------
async function importStatement(buf, password) {
  if (buf.byteLength > LIMITS.fileBytes) return impErr(t('This file is over 25 MB. Split it or export a shorter date range.'));
  impErr(t('Reading the statement…'));
  const pdfjs = await import('../../vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdf.worker.min.mjs', import.meta.url).href;
  let doc;
  try {
    // isEvalSupported false: the CVE-2024-4367 class of malicious-PDF script is never evaluated; no font loading;
    // images over 16 megapixels are never decoded (only the text is read).
    doc = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)), password, isEvalSupported: false, disableFontFace: true, maxImageSize: 4096 * 4096 }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') return pdfPassword(buf, !!password);
    throw new Error(t('This PDF could not be opened. Download it again from your bank app.'));
  }
  const lines = [];
  for (let i = 1; i <= Math.min(doc.numPages, 80); i++) lines.push(...(i > 1 ? [PAGE_BREAK] : []), ...linesFromItems((await (await doc.getPage(i)).getTextContent()).items));
  const st = parseStatement(lines);
  if (!st.rows.length) return impErr(t('No transactions found in this PDF. If it is a scanned picture, download the statement again from your bank app, or its CSV.'));
  const sourceKey = hash(JSON.stringify(st.rows));
  IMP = { st, sourceKey };
  const name = st.provider?.[1] || t('Bank statement');
  const existing = S.accounts.find(a => a.id === settings().importSources?.[sourceKey]) || (st.provider && findAccount(name, st.provider[2]));
  const reloads = st.provider?.[2] === 'ewallet' ? planMoves(statementToTx(st.rows, { accountId: '_w' }), [{ id: '_w', kind: 'ewallet' }, ...S.accounts], '').reloads.length : 0;
  openSheet(`<h2 class="sh-title">${esc(name)}</h2>
    <p class="fine">${esc(t('{0} transactions', st.rows.length))} · ${esc(`${st.rows[0].date} → ${st.rows.at(-1).date}`)}</p>
    <p class="${st.reconciled ? 'okbox' : 'warnbox'}">${esc(st.reconciled ? t('The rows add up from the opening to the closing balance. Check a few before importing.') : t('The balances on this statement could not be checked. Look over the rows before importing.'))}</p>
    ${reloads ? `<p class="fine">${esc(t('{0} wallet reloads with no bank line: counted as money moved from your bank, not as income.', reloads))}</p>` : ''}
    <label class="field"><span>${esc(t('Into account'))}</span><select id="st-acc">${existing ? '' : `<option value="new">${esc(t('New account: {0}', name))}</option>`}${S.accounts.filter(a => !owing(a)).map(a => `<option value="${esc(a.id)}"${existing?.id === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
    <ul class="list preview">${st.rows.slice(0, 6).map(r => `<li class="rowb"><span>${esc(r.date)}</span><span class="grow">${esc(cleanDesc(r.desc))}</span><span class="amt ${r.amount > 0 ? 'income' : 'expense'}">${r.amount > 0 ? '+' : '−'}${esc(fmtRM(Math.abs(r.amount)))}</span></li>`).join('')}</ul>
    <div class="row2"><button class="btn ghost" data-act="sheet-close">${esc(t('Cancel'))}</button><button class="btn" data-act="st-go">${esc(t('Import {0}', st.rows.length))}</button></div>`, { label: t('Import') });
}
function pdfPassword(buf, wrong) {
  IMP = { pdf: buf };
  openSheet(`<h2 class="sh-title">${esc(t('This statement is locked'))}</h2>
    <p class="sh-body">${esc(t('Banks usually lock statements with your IC number or date of birth. The password is only used on this phone.'))}</p>
    <label class="field"><span>${esc(t('PDF password'))}</span><input id="pdf-pw" type="password" autocomplete="off" autofocus></label>
    ${wrong ? `<p class="err">${esc(t('That password did not work. Try again.'))}</p>` : ''}
    <button class="btn wide" data-act="pdf-unlock">${esc(t('Unlock'))}</button>`, { label: t('PDF password') });
}
/** Re-encode a photo as JPEG (max 1200 px): smaller, and location data in the original is dropped. Only a JPEG or PNG
 *  within 40 MB and 50 megapixels is decoded, so a crafted image can't exhaust memory; anything else → null. */
/** A backup's JSON bytes as text, refused before decoding when too big. */
function jsonText(bytes) {
  if (bytes.byteLength > LIMITS.backupJson) throw new Error(t('This backup is too big to restore (over 50 MB).'));
  return new TextDecoder().decode(bytes);
}
async function reencode(blob) {
  try {
    const info = blob.size <= LIMITS.photoBytes && imageInfo(new Uint8Array(await blob.slice(0, 1 << 20).arrayBuffer()));
    if (!info || info.w * info.h > LIMITS.pixels) return null;
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const k = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
  } catch { return null; }
}

// ---- restore -------------------------------------------------------------------------------------------------------------
async function restoreText(text, zip = {}) {
  let data;
  try { data = readBackup(text); } catch (e) { return impErr(t(e.message)); }
  if (data.joint) return importJoint(data, zip);
  // Plan sample removal without writing: cancel or a failed restore must leave the old book intact.
  const sample = settings().sample ? sampleRows() : null;
  if (sample?.tx.some(x => !x.sample) && !(await confirmSheet({ title: t('Remove the sample data?'), body: t('Entries you added to the sample accounts go too.'), ok: t('Remove') }))) return;
  const removed = { accounts: [...(sample?.ids || [])], tx: (sample?.tx || []).map(x => x.id), recurring: (sample?.recurring || []).map(x => x.id) };
  const keep = (list, store) => list.filter(x => !removed[store].includes(x.id));
  const local = { accounts: keep(S.accounts, 'accounts'), tx: keep(S.tx, 'tx'), recurring: keep(S.recurring, 'recurring'), kv: {
    budgets: sample ? { total: 0, byCat: {} } : S.kv.budgets, rules: S.kv.rules, customCats: S.kv.customCats,
    shopNames: S.kv.shopNames || {}, itemNames: S.kv.itemNames || {}, goals: sample ? S.kv.goals.filter(g => !g.sample && !sample.ids.has(g.accountId)) : S.kv.goals,
    subcats: S.kv.subcats || {}, subRules: S.kv.subRules || {}, catColors: S.kv.catColors || {}, catIcons: S.kv.catIcons || {}, dismissed: S.kv.dismissed,
  } };
  const choice = local.tx.length || local.accounts.length ? await new Promise(res => {
    openSheet(`<h2 class="sh-title">${esc(t('Restore backup'))}</h2><p class="sh-body">${esc(t('The backup has {0} transactions. This phone has {1}.', data.tx.length, local.tx.length))}</p>
      <button class="btn wide" data-x="merge">${esc(t('Merge (keep both, recommended)'))}</button><button class="btn ghost danger wide" data-x="replace">${esc(t("Replace Tally's data on this phone"))}</button><button class="btn ghost wide" data-x="no">${esc(t('Cancel'))}</button>`, { label: t('Restore backup'), onClose: () => res('no') })
      .addEventListener('click', e => { const b = e.target.closest('[data-x]'); if (b) { res(b.dataset.x); closeSheet(); } });
  }) : 'replace';
  if (choice === 'no') return;
  const before = choice === 'merge' ? local.tx : [], had = new Set(before.map(x => x.id));
  const restored = choice === 'merge' ? mergeBackup(local, data) : data;
  if (choice === 'merge' && overCap({ ...restored, customCats: restored.kv.customCats })) return impErr(t("Adding this would make Tally's data more than a backup can restore, so nothing was added."));
  // Decode every requested image before the transaction. Ledger, images and restore metadata then land together.
  const wanted = photosToWrite(data.tx.filter(x => !had.has(x.id)), before), receipts = [];
  let missing = 0;
  for (const id of wanted) {
    const bytes = zip[`photos/${id}.jpg`];
    const jpeg = bytes && await reencode(new Blob([bytes]));
    if (jpeg) receipts.push({ id, blob: jpeg }); else missing++;
  }
  const cur = { ...settings() };
  if (sample) { delete cur.noSpend; delete cur.friends; cur.sample = false; }
  const want = Object.entries(data.settings || {}).filter(([k]) => choice !== 'merge' || cur[k] == null);
  restored.kv = { ...restored.kv, settings: { ...cur, ...Object.fromEntries(want), onboarded: true }, lastBackup: `${today()}T${nowTime()}` };
  if (choice === 'merge') {
    const keptPhotos = new Set(local.tx.map(x => x.receiptId).filter(Boolean));
    const gonePhotos = [...new Set((sample?.tx || []).map(x => x.receiptId).filter(id => id && !keptPhotos.has(id)))];
    await addAll({ ...restored, receipts, del: { ...removed, receipts: gonePhotos } });
  } else await replaceAll({ ...restored, receipts });
  if (settings().lang && settings().lang !== getLang()) setLang(settings().lang);
  document.documentElement.style.fontSize = `${settings().textSize || 100}%`; applyLook(settings());
  if (!settings().tourDone) await markSeen();   // a restored backup means someone who knows the app
  await tickQuietly();   // Learn Tally: what the restored data shows is done
  persistStorage();
  closeSheet(); go('home'); render();
  toast(t('Restored {0} transactions', data.tx.length) + (data.dropped ? ` · ${t('{0} damaged entries skipped', data.dropped)}` : '') + (missing ? ` · ${t('{0} could not be read and will be skipped', `${missing} ${t('Receipt photos')}`)}` : ''), { k: missing ? 'warn' : 'good' });
}

/** The backup, as JSON, or with photos as a zip holding the same JSON plus photos/<id>.jpg. */
async function backupBlob(withPhotos, { name, text } = backupFile(), txs = S.tx) {
  const json = new TextEncoder().encode(text);
  if (!withPhotos) return { name, blob: new Blob([json], { type: 'application/json' }), missing: 0, jsonBytes: json.length, entries: 1 };
  const files = [{ name: BACKUP_JSON, data: json }];
  let missing = 0;
  for (const id of new Set(txs.map(x => x.receiptId).filter(Boolean))) { const p = await getPhoto(id); if (p) files.push({ name: `photos/${id}.jpg`, data: new Uint8Array(await p.arrayBuffer()) }); else missing++; }
  return { name: name.replace(/\.json$/, '.zip'), blob: zipStore(files), missing, jsonBytes: json.length, entries: files.length };
}
/** The backup as the sheet asks: with or without photos, and sealed with its password when one is typed. Null: too short. */
async function sealedBackup(r = null, pass = '#bk-pass', err = '#bk-err') {
  const pw = $(pass)?.value || '';
  if (!r) {   // this phone's backup: never one its own restore would refuse, reported as saved
    r = await backupBlob($('#bk-photos')?.checked);
    const big = !backupFits({ zip: r.name.endsWith('.zip'), fileBytes: r.blob.size, jsonBytes: r.jsonBytes, entries: r.entries });
    if (big || overCap({ accounts: S.accounts, tx: S.tx, recurring: S.recurring, customCats: S.kv.customCats })) { $(err).textContent = t('This is more than a backup can restore. Leave out the photos, or remove some entries or bills first.'); return null; }
  }
  if (!pw) return r;
  if (pw.length < 10) { $(err).textContent = t('Use at least 10 characters.'); $(pass).focus(); return null; }
  const text = await sealBackup(new Uint8Array(await r.blob.arrayBuffer()), pw);
  return { ...r, name: r.name.replace(/\.(json|zip)$/, '.locked.json'), blob: new Blob([text], { type: 'application/json' }) };
}
/** Ask for a protected backup's password. → the password, or null (cancelled). */
function askPassword() {
  return new Promise(done => {
    const el = openSheet(`<h2 class="sh-title">${ICON.lock} ${esc(t('Protected backup'))}</h2><label class="field"><span>${esc(t('Password'))}</span><input id="rp-pass" type="password" autocomplete="current-password" autofocus></label>
      <div class="row2 sheetfoot"><button class="btn ghost" data-x="no">${esc(t('Cancel'))}</button><button class="btn" data-x="ok">${esc(t('Open'))}</button></div>`, { label: t('Protected backup'), onClose: () => done(null) });
    const go = ok => { const v = el.querySelector('#rp-pass').value; done(ok && v ? v : null); closeSheet(); };
    el.addEventListener('click', e => { const x = e.target.closest('[data-x]')?.dataset.x; if (x) go(x === 'ok'); });
    el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(true); } });
  });
}
const warnMissingPhotos = n => { if (n) toast(t('{0} receipt photos could not be included in this backup.', n), { k: 'warn' }); };
const photoCount = () => new Set(S.tx.map(x => x.receiptId).filter(Boolean)).size;
const backupFile = () => ({ name: `tally-backup-${today()}.json`, text: makeBackup({ accounts: S.accounts, tx: S.tx, recurring: S.recurring, kv: { budgets: S.kv.budgets, rules: S.kv.rules, customCats: S.kv.customCats, shopNames: S.kv.shopNames || {}, itemNames: S.kv.itemNames || {}, catColors: S.kv.catColors, catIcons: S.kv.catIcons, goals: S.kv.goals, subcats: S.kv.subcats || {}, subRules: S.kv.subRules || {}, settings: backupSettings({ monthStart: 1, weekStart: 1, textSize: 100, ...settings() }) } }) });
// ---- joint accounts: a file for the spouse, and theirs merged in -----------------------------------------------------
const jointTx = () => { const j = jointIds(); return S.tx.filter(x => j.has(x.accountId) || j.has(x.toAccountId)); };
const jointFile = () => ({ name: `tally-joint-${today()}.json`, text: makeJointShare({ accounts: S.accounts, tx: S.tx, kv: S.kv, recurring: S.recurring }, settings().myName || '') });
async function importJoint(data, zip = {}) {
  const m = mergeJoint({ accounts: S.accounts, tx: S.tx, kv: S.kv, recurring: S.recurring }, data), from = data.by || t('your partner');
  if (overCapAfter({ accounts: S.accounts, tx: S.tx, recurring: S.recurring, customCats: S.kv.customCats }, m, { tx: m.drop, accounts: [...m.empty.map(a => a.id), ...m.dropAccounts], recurring: m.dropBills })) return impErr(t("Adding this would make Tally's data more than a backup can restore, so nothing was added."));
  const theirs = m.tx.length - m.empty.reduce((s, a) => s + (a.moved || 0), 0);
  const body = [t('New or changed entries: {0}. Deleted: {1}. Newer edits win; your personal accounts are not touched.', theirs, m.drop.length),
    m.budgetsJoint ? t('Joint budgets are updated.') : '', m.recurring.length ? t('Joint bills: {0}.', m.recurring.length) : '',
    ...m.empty.map(a => (a.moved ? t('Your joint account "{0}" is the same account as theirs: your {1} entries move into it.', a.name, a.moved) : t('Your empty joint account "{0}" is replaced by theirs.', a.name)))].filter(Boolean).join(' ');
  if (!(await confirmSheet({ title: t('Joint accounts from {0}', from), body, ok: t('Add') }))) return;
  const before = S.tx;   // whose photo is whose, before the joint rows land
  await putAll({ accounts: m.accounts, tx: m.tx, recurring: m.recurring, del: { tx: m.drop, accounts: [...m.empty.map(a => a.id), ...m.dropAccounts], recurring: m.dropBills }, kv: {
    jointGone: m.gone,
    ...(m.customCats.length ? { customCats: [...S.kv.customCats, ...m.customCats] } : {}),
    ...(m.budgetsJoint ? { budgets: { ...S.kv.budgets, joint: m.budgetsJoint } } : {}),
  } });
  await setSetting('onboarded', true);
  if (!settings().tourDone) await markSeen();
  closeSheet(); go('home'); render();
  const wanted = photosToWrite(m.tx, before);
  for (const [n, bytes] of Object.entries(zip)) { const id = n.slice(7, -4); if (n.startsWith('photos/') && wanted.has(id)) { const jpeg = await reencode(new Blob([bytes])); if (jpeg) await savePhoto(id, jpeg); } }   // same size and pixel limits as a backup
  toast(t('{0} joint entries added or updated from {1}', theirs, from), { k: 'good', icon: 'check' });
}
async function backedUp(msg) {
  const migrationCheck = !isNative && !!$('[data-act="migration-check"]');
  const first = !S.kv.lastBackup;
  await setKv('lastBackup', `${today()}T${nowTime()}`);
  const w = first && firstWord('backup');
  closeSheet(); render(); toast(w || msg, { k: 'good', icon: 'check', cheer: !!w });
  if (migrationCheck) migrationGuide(2);
}

// ---- actions ---------------------------------------------------------------------------------------------------------------
export const act = {
  'desk-connect': () => import('../desk-host.js').then(m => m.openDesk()),
  // Receipt photos off the phone, entries kept: now, or automatically after a while. LHDN can ask for receipts behind a
  // tax-relief claim for 7 years, so their download comes first.
  'photos-manage': () => {
    const keep = settings().photoKeep || 0, n = new Set(S.tx.map(x => x.receiptId).filter(Boolean)).size;
    const years = [...new Set(S.tx.filter(x => x.receiptId && keepReceiptUntil(x)).map(x => x.date.slice(0, 4)))].sort().reverse();
    const el = openSheet(`<div class="sheethead"><h2 class="sh-title">${esc(t('Receipt photos'))}</h2><button class="icon-btn" data-act="sheet-close" aria-label="${esc(t('Close'))}">${ICON.x}</button></div>
      <p class="sh-body">${esc(t('Deleting a photo keeps its entry: the shop, date, amount and items stay. Only the picture goes.'))}</p>
      <label class="field"><span>${esc(t('Keep receipt photos'))}</span><select id="ph-keep">${[[0, t('Always')], [365, t('1 year')], [90, t('90 days')], [30, t('30 days')]].map(([v, l]) => `<option value="${v}"${v === keep ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <p class="fine">${esc(t('Older photos are deleted when Tally starts.'))}</p>
      <p class="warnbox">${esc(t('LHDN can ask for the receipts behind a relief claim for 7 years after the end of the year you file that return. Photos Tally matched to a relief are kept until then, even if you choose to delete older photos. Keep the original receipt or e-Invoice too: a phone photo is a backup, not a replacement.'))}</p>
      ${years.map(y => `<button class="btn ghost wide" data-act="relief-dl" data-y="${y}">${ICON.download}${esc(t('Download the receipts for {0}', y))}</button>`).join('')}
      ${n ? `<button class="btn ghost danger wide" data-act="photos-drop">${ICON.trash}${esc(t('Delete all {0} receipt photos now', n))}</button>` : ''}`, { label: t('Receipt photos') });
    el.querySelector('#ph-keep').addEventListener('change', async e => {
      const v = +e.target.value;
      if (v && !(await confirmSheet({ title: t('Delete photos older than {0} days?', v), body: t('Their entries stay. This happens now and from then on whenever Tally starts.'), ok: t('Delete older photos'), danger: true }))) { e.target.value = String(keep); return; }
      await setSetting('photoKeep', v);
      if (v) { const d = new Date(`${today()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - v); const gone = await dropPhotos(d.toISOString().slice(0, 10)); toast(t('{0} photos deleted. The entries are kept.', gone)); }
      closeSheet(); render();
    });
  },
  'photos-drop': async () => {
    const n = new Set(S.tx.map(x => x.receiptId).filter(Boolean)).size;
    if (!(await confirmSheet({ title: t('Delete all {0} receipt photos?', n), body: t('Their entries stay. This cannot be undone: keep a backup with photos first if you might need them.'), ok: t('Delete photos'), danger: true }))) return;
    const gone = await dropPhotos(); closeSheet(); render(); toast(t('{0} photos deleted. The entries are kept.', gone));
  },
  'reader-get': async b => {
    b.disabled = true; $('#reader-dl').hidden = false;
    const { loadOcr } = await import('../scan.js');
    await import('./review.js');   // its progress listener fills the bar
    try { await loadOcr(); } catch (e) {
      $('#reader-dl').hidden = true; b.disabled = false;
      return toast(e?.message ? t(e.message) : t('The receipt reader could not be downloaded. Check the connection and try again.'), { k: 'bad' });
    }
    $('#reader-dl').hidden = true; b.remove(); $('#reader-state').textContent = t('The receipt reader is ready on this phone and works offline.');
    toast(t('The receipt reader is ready on this phone and works offline.'), { k: 'good', icon: 'check' });
  },
  // A daily reminder from the phone's own calendar: no server, works with the app closed.
  'remind-google': async () => { const ev = await dailyReminder(); window.open(googleUrl(ev), '_blank', 'noopener'); },
  'remind-ics': async () => { const result = await download('tally-daily-reminder.ics', ics([await dailyReminder()]), 'text/calendar'); if (isNative && result?.cancelled !== false) return; toast(t('Open the file to add the reminder to your calendar.'), { k: 'good', icon: 'check' }); },
  feedback: () => openFeedback(APP_VERSION),
  'lock-set': async () => { if (lockOn() && !(await askCode(t('Change the lock')))) return; lockSheet(render); },
  'lock-off': async () => {
    if (!(await confirmSheet({ title: t('Turn off the lock?'), body: encOn() ? t('Anyone with your phone will be able to open Tally, and your data will no longer be encrypted.') : t('Anyone with your phone will be able to open Tally.'), ok: t('Turn off') }))) return;
    const code = await askCode(t('Turn off the lock?')); if (!code) return;
    try { await lockOff(code); } catch { return toast(t('Could not turn it off. Try again.'), { k: 'bad' }); }
    render();
  },
  // Encryption: everything but the settings, with the lock's PIN or password. Forgetting it means the data is gone.
  'enc-on': async () => {
    if (!(await confirmSheet({ title: t('Encrypt data on this phone?'), body: t('Your entries and receipt photos will be stored encrypted with your PIN or password, so no one can read them without it, even from a copy of the phone. Fingerprint or face can no longer open Tally. If you forget the PIN or password, the data cannot be recovered: keep a backup.'), ok: t('Continue') }))) return;
    const code = await askCode(t('Encrypt data on this phone')); if (!code) return;
    toast(t('Encrypting…'));
    let all;
    try { all = await encryptOn(code); } catch { return toast(t('Could not encrypt. Nothing was changed.'), { k: 'bad' }); }
    render(); toast(all ? t('Your data on this phone is encrypted.') : t('Your entries are encrypted. Some photos are not yet: Tally finishes them the next time it opens.'), { k: all ? 'good' : 'warn', icon: all ? 'check' : null });
  },
  'enc-off': async () => {
    const code = await askCode(t('Stop encrypting data?')); if (!code) return;
    try { await encryptOff(code); } catch { return toast(t('Could not turn it off. Try again.'), { k: 'bad' }); }
    render(); toast(t('Your data is stored without encryption again.'));
  },
  tour: () => showTour(1),
  'whats-new': () => showWhatsNew(),
  install: async () => { if (await promptInstall()) render(); },
  'update-check': async b => {
    b.disabled = true;
    const r = await checkForUpdates().catch(() => 'unsupported');
    b.disabled = false;
    toast(r === 'latest' ? t('You have the latest version') : r === 'updating' ? t('Updating… Tally will reload in a moment') : t('Updates install by themselves when you open Tally online'));
  },
  'set-size': async b => { await setSize(+b.dataset.n); render(); },
  'set-lang': async b => { await setSetting('lang', b.dataset.l); await setLang(b.dataset.l); render(); },
  'start-fresh': () => {
    openSheet(`<div class="sheethead"><h2 class="sh-title">${esc(t('Your accounts'))}</h2><button class="icon-btn" data-act="sheet-close" aria-label="${esc(t('Close'))}">${ICON.x}</button></div><p class="sh-body">${esc(t('Where do you keep money? Type what is in each today, or leave it empty if you are not sure.'))}</p>
      <div class="segs" role="group" aria-label="${esc(t('Features'))}"><button type="button" class="seg on" data-act="sf-mode" data-v="standard" aria-pressed="true">${esc(t('Standard'))}</button><button type="button" class="seg" data-act="sf-mode" data-v="simple" aria-pressed="false">${esc(t('Simple'))}</button></div>
      <div id="sf-mode-summary" role="status" aria-live="polite" aria-atomic="true">${setupModeSummary('standard')}</div>
      <label class="field"><span>${esc(t('Cash in wallet (RM)'))}</span><input id="sf-cash" inputmode="decimal" placeholder="0.00" autofocus></label>
      <label class="field"><span>${esc(t('Bank account (RM)'))}</span><input id="sf-bank" inputmode="decimal" placeholder="0.00"></label>
      <div class="grid2 keep2"><label class="field"><span>${esc(t('E-wallet (RM), optional'))}</span><input id="sf-ewallet" inputmode="decimal" placeholder="${esc(t('leave empty to skip'))}"></label>
      <label class="field"><span>${esc(t('Its name'))}</span><input id="sf-ewname" maxlength="40" placeholder="Touch 'n Go"></label></div>
      ${on('business') ? `<label class="field"><span>${esc(t('Business money: a stall, rides or a shop (RM), optional'))}</span><input id="sf-biz" inputmode="decimal" placeholder="${esc(t('leave empty to skip'))}"></label>` : ''}
      <label class="field" hidden><span>${esc(t('Joint account with your partner (RM), optional'))}</span><input id="sf-joint" inputmode="decimal" placeholder="${esc(t('leave empty to skip'))}"></label>
      <p class="err" id="sf-err" role="alert"></p><button class="btn wide" data-act="sf-go">${esc(t('Start'))}</button>`, { label: t('Your accounts') });
  },
  'sf-go': async b => {
    const vals = ['cash', 'bank', 'ewallet', 'joint', 'biz'].map(k => [k, $(`#sf-${k}`)?.value.trim() || '']);
    const bad = vals.find(([, v]) => v && calcAmount(v) == null);
    if (bad) return ($('#sf-err').textContent = amtErr(bad[1]));
    b.disabled = true;
    const selectedMode = b.closest('.sheet').querySelector('[data-act="sf-mode"].on')?.dataset.v || 'standard';
    await setModules(PRESETS[selectedMode]);
    const names = { cash: t('Cash'), bank: t('Bank'), ewallet: t('E-wallet'), joint: t('Joint account'), biz: t('Business') };
    let n = 0;
    names.ewallet = $('#sf-ewname').value.trim().slice(0, 40) || names.ewallet;
    // a Bank only when one is given: "no bank on my phone" means none
    for (const [k, v] of vals) if (k === 'cash' || v || (k === 'ewallet' && $('#sf-ewname').value.trim())) await saveAccount({ id: uid('a'), name: names[k], kind: k === 'joint' || k === 'biz' ? 'bank' : k, scope: k === 'joint' ? 'joint' : k === 'biz' ? 'business' : 'personal', opening: calcAmount(v || '0'), typed: !!v, createdAt: Date.now() + n++ });
    await setSetting('onboarded', true);
    closeSheet(); go('home');
    afterSetup();
  },
  'bt-save': async () => {
    const rows = [...document.querySelectorAll('.sheet [data-bt]')].filter(el => el.value.trim()).map(el => [el, calcAmount(el.value)]);
    const bad = rows.find(([, v]) => v == null);
    if (bad) return ($('#bt-err').textContent = amtErr(bad[0].value));
    for (const [el, v] of rows) { const a = S.accounts.find(x => x.id === el.dataset.bt); if (a) await saveAccount({ ...a, opening: (a.opening || 0) + v - +el.dataset.now, typed: true }); }
    closeSheet(); render(); if (rows.length) toast(t('Saved'));
  },
  'acc-edit': b => accountSheet(S.accounts.find(a => a.id === b.dataset.id) || {}),
  'acc-save': async b => {
    const name = $('#ac-name').value.trim(), nowEl = $('#ac-now');
    let opening = $('#ac-open').value.trim() ? calcAmount($('#ac-open').value) : 0;
    // A new balance for today moves the starting balance by the difference (like Money Manager's corrections on import).
    const target = nowEl?.value.trim() ? calcAmount(nowEl.value) : null, was = nowEl ? +nowEl.dataset.now : null;
    if (nowEl && nowEl.value.trim() && target == null) return ($('#ac-err').textContent = amtErr(nowEl.value));
    if (target != null && target !== was) opening = (S.accounts.find(a => a.id === b.dataset.id)?.opening || 0) + target - was;
    if (!name) return ($('#ac-err').textContent = t('Give the account a name.'));
    if (opening == null) return ($('#ac-err').textContent = amtErr($('#ac-open').value));
    const old = S.accounts.find(a => a.id === b.dataset.id), kind = $('#ac-kind').value, scope = ['joint', 'business'].includes($('#ac-scope').value) ? $('#ac-scope').value : 'personal';
    const currency = $('#ac-cur').value, rate = currency === 'MYR' ? null : +String($('#ac-rate').value).replace(',', '.');
    if (rate != null && !(rate > 0 && rate < 100000)) return ($('#ac-err').textContent = t('Enter how many ringgit 1 {0} is, for example 3.30.', currency));
    const fx = currency === 'MYR' ? { currency: undefined, rate: undefined } : { currency, rate };
    // A big gap is usually a salary or spending not added yet: moving the starting balance would hide it from Insights.
    const diff = target != null ? target - was : 0;
    if (Math.abs(diff) >= 50000 && await confirmSheet({
      title: diff > 0 ? t('{0} more than Tally has', fmtRM(diff)) : t('{0} less than Tally has', fmtRM(-diff)),
      body: diff > 0 ? t('Money in not added yet, like a salary? Add it as money in today, or only change the starting balance.') : t('Spending not added yet? Add it as money out today, or only change the starting balance.'),
      ok: diff > 0 ? t('Add as money in') : t('Add as money out'), no: t('Only change the balance') })) {
      opening = old.opening || 0;
      await saveTxs([{ id: uid('t'), date: today(), time: nowTime(), type: diff > 0 ? 'income' : 'expense', amount: Math.abs(diff), accountId: old.id, category: diff > 0 ? 'income' : 'other', merchant: t('Balance update'), note: '', source: 'quick', createdAt: Date.now() }]);
    }
    const acc = { ...(old || { id: uid('a'), createdAt: Date.now(), typed: true }), ...(target != null ? { typed: true } : {}), name, kind, opening, scope, ...fx };
    await saveAccount(acc);
    closeSheet(); render(); toast(t('Saved'));
    if (!old) document.dispatchEvent(new CustomEvent('tally:account-added', { detail: acc.id }));   // a receipt being checked picks it
  },
  'acc-del': async b => {
    if (!(await confirmSheet({ title: t('Delete this account?'), ok: t('Delete'), danger: true }))) return;
    try { await deleteAccount(b.dataset.id); render(); toast(t('Deleted')); } catch { toast(t('This account has transactions. Move or delete them first.'), { k: 'warn' }); }
  },
  'set-find': b => showFound(hits[+b.dataset.i]),
  'features-open': b => { const d = b.parentElement; d.open = featOpen = !d.open; },   // taps are handled here, not by the browser
  'cat-add': () => catAddSheet(),
  'cat-add-color': async b => { const name = $('#cat-name').value; catAddSheet(name, (await pickColor({ value: b.dataset.v })) || b.dataset.v); },
  'cat-save': async () => {
    const n = $('#cat-name').value.trim(); if (!n) return;
    try { await addCategory(n, $('#cat-color').dataset.v); } catch (e) { return toast(t(e.message), { k: 'warn' }); }   // 50 of the user's own at most
    closeSheet(); render(); toast(t('Saved'));
  },
  // Settings is long (8+ screens at big text): the chips at the top jump to a section, Restore included.
  jump: b => { const el = document.getElementById(b.dataset.to); el?.scrollIntoView({ behavior: 'smooth', block: 'start' }); el?.querySelector('h2')?.setAttribute('tabindex', '-1'); el?.querySelector('h2')?.focus({ preventScroll: true }); },
  'rules-clear': async () => {
    if (!(await confirmSheet({ title: t('Forget everything Tally learned?'), body: t('Items and shops you filed yourself will be guessed afresh. Your entries keep their categories.'), ok: t('Forget'), danger: true }))) return;
    await setKv('rules', {}); await setKv('itemNames', {}); render(); toast(t('Forgotten.'));
  },
  // A category's look: its icon (tap one; the built-in one again resets it) and, from here, its colour.
  'cat-edit': b => {
    const c = expenseCats().find(x => x.id === b.dataset.c); if (!c) return;
    const icon = () => S.kv.catIcons[c.id] || DEFAULT_ICON[c.id] || c.icon || 'tag';
    const el = openSheet(`<h2 class="sh-title">${badge(cat(c.id))} ${esc(t(c.name))}</h2><p class="fine">${esc(t('Icon'))}</p>
      <div class="icgrid" role="group" aria-label="${esc(t('Icon'))}">${Object.keys(CAT_ICONS).map((k, i) => `<button class="icbtn" data-x="${k}" aria-pressed="${icon() === k}" aria-label="${esc(t('Icon {0}', i + 1))}">${catIcon({ icon: k })}</button>`).join('')}</div>
      <div class="row2 sheetfoot"><button class="btn ghost" data-x="colour">${esc(t('Change colour'))}</button><button class="btn" data-x="done">${esc(t('Done'))}</button></div>
      ${c.id === 'other' ? '' : `<button class="btn ghost danger wide" data-x="remove">${esc(t('Remove category'))}</button>`}`, { label: t(c.name) });
    el.addEventListener('click', async e => {
      const x = e.target.closest('[data-x]')?.dataset.x; if (!x) return;
      if (x === 'done') { closeSheet(); render(); return; }
      if (x === 'colour') { closeSheet(); render(); return act['cat-color'](b); }
      if (x === 'remove') { closeSheet(); return act['cat-remove'](b); }
      const custom = S.kv.customCats.find(y => y.id === c.id);
      await setCatIcon(c.id, x === (DEFAULT_ICON[c.id] || custom?.icon || 'tag') ? null : x);
      for (const btn of el.querySelectorAll('.icbtn')) btn.setAttribute('aria-pressed', btn.dataset.x === x);
      el.querySelector('.sh-title .cbadge')?.replaceWith(Object.assign(document.createElement('span'), { innerHTML: badge(cat(c.id)) }).firstChild);
    });
  },
  // Remove a category: what is in it (entries, bills, budget, what Tally learned) moves to the one picked, Other at first.
  'cat-remove': async b => {
    const c = expenseCats().find(x => x.id === b.dataset.c); if (!c || c.id === 'other') return;
    const opts = expenseCats().filter(x => x.id !== c.id).map(x => `<option value="${esc(x.id)}"${x.id === 'other' ? ' selected' : ''}>${esc(t(x.name))}</option>`).join('');
    const to = await new Promise(res => {
      const el = openSheet(`<h2 class="sh-title">${esc(t('Remove {0}?', t(c.name)))}</h2><label class="field"><span>${esc(t('What is in it moves to'))}</span><select id="cat-to">${opts}</select></label>
        <div class="row2 sheetfoot"><button class="btn ghost" data-x="no">${esc(t('Cancel'))}</button><button class="btn danger" data-x="ok">${esc(t('Remove'))}</button></div>`, { label: t('Remove category'), onClose: () => res(null) });
      el.addEventListener('click', e => { const x = e.target.closest('[data-x]')?.dataset.x; if (!x) return; const v = el.querySelector('#cat-to').value; res(x === 'ok' ? v : null); closeSheet(); });
    });
    if (!to) return;
    try { await removeCategory(c.id, to); } catch (e) { return toast(t(e.message), { k: 'warn' }); }
    render(); toast(t('Removed. What was in it is in {0} now.', t(expenseCats().find(x => x.id === to)?.name || to)), { icon: 'check' });
  },
  'cat-back': async b => { await bringBackCategory(b.dataset.c); render(); toast(t('Brought back.'), { icon: 'check' }); },
  'cat-color': async b => {
    const c = expenseCats().find(x => x.id === b.dataset.c); if (!c) return;
    const base = [...CATEGORIES, ...S.kv.customCats].find(x => x.id === c.id)?.color;
    const h = await pickColor({ value: c.color, title: t(c.name), reset: base });
    if (!h) return;
    await setCatColor(c.id, h === base ? null : h);
    render(); $(`[data-act="cat-edit"][data-c="${CSS.escape(c.id)}"]`)?.focus();
  },
  'set-theme': async b => { await setSetting('theme', b.dataset.v === 'system' ? null : b.dataset.v); render(); $(`[data-act="set-theme"][data-v="${b.dataset.v}"]`)?.focus(); },
  'set-accent': async b => { await setSetting('accent', b.dataset.v === baseAccent() ? null : parseHex(b.dataset.v)); render(); $(`[data-act="set-accent"][data-v="${b.dataset.v}"]`)?.focus(); },
  'accent-custom': () => pickAccent(),
  // Your own palette: the background, the cards and the accent of the theme on screen (the other theme keeps its own).
  'mine-colour': async b => {
    const k = b.dataset.k, m = themeNow(), p = structuredClone(settings().myPalette), dflt = APP_PALETTES.tally;
    if (!okMine(p)) return;
    const i = k === 'bg' ? 0 : 1, now = k === 'accent' ? p.accent : p[m][i];
    const h = await pickColor({ value: now, title: { bg: t('Background'), card: t('Cards'), accent: t('Accent colour') }[k], reset: k === 'accent' ? dflt.accent : dflt[m][i], warn: k === 'accent' });
    if (!h) return;
    if (k === 'accent') p.accent = h; else p[m] = k === 'bg' ? surfacesFrom(h, p[m][1]) : surfacesFrom(p[m][0], h);
    await setSetting('myPalette', p); await setSetting('accent', null); render(); $(`[data-act="mine-colour"][data-k="${k}"]`)?.focus();
  },
  'set-preset': async b => { const p = PRESETS[b.dataset.v]; if (!p) return; await setModules(p); render(); $(`[data-act="set-preset"][data-v="${b.dataset.v}"]`)?.focus(); toast(t('Features set: {0}', t({ simple: 'Simple', standard: 'Standard', everything: 'Everything' }[b.dataset.v]))); },
  'sf-mode': b => { const sheet = b.closest('.sheet'); if (!sheet || !['simple', 'standard'].includes(b.dataset.v)) return; for (const x of sheet.querySelectorAll('[data-act="sf-mode"]')) { const o = x === b; x.classList.toggle('on', o); x.setAttribute('aria-pressed', o); } sheet.querySelector('#sf-mode-summary').innerHTML = setupModeSummary(b.dataset.v); },
  // Only on this tap does Tally go online for a rate: the European Central Bank's, via frankfurter.dev (nothing about the
  // person or their money is sent). It fills the field; the person can still type their bank's own rate.
  'rate-get': async () => {
    const cur = $('#ac-cur')?.value, out = $('#rate-src'); if (!cur || cur === 'MYR') return;
    out.textContent = t('Getting the rate…');
    try {
      const rateUrl = `${RATE_API}?from=${encodeURIComponent(cur === 'BND' ? 'SGD' : cur)}&to=MYR`;   // the Brunei dollar is pegged 1:1 to the Singapore dollar
      const res = await fetch(rateUrl, { credentials: 'omit' });
      const j = await res.json(), r = +j?.rates?.MYR; if (!res.ok || !(r > 0)) throw new Error();
      $('#ac-rate').value = String(+r.toFixed(r < 0.01 ? 7 : 4)); out.textContent = t("European Central Bank reference rate for {0}, for information only. Your bank's rate will differ; change it if you like.", fmtDate(j.date, { year: true }));
    } catch { out.textContent = t('Could not get the rate (offline?). Type the rate from your bank app.'); }
  },
  // The whole app's colours; a palette brings its own accent, so a hand-picked one is cleared (it can be picked again after).
  'set-app-palette': async b => {
    const s = settings();   // "Mine" starts as a copy of the colours on screen now
    if (b.dataset.v === 'mine' && !okMine(s.myPalette)) { const p = paletteFor(s); await setSetting('myPalette', { dark: [...p.dark], light: [...p.light], accent: parseHex(s.accent) || p.accent }); }
    await setSetting('appPalette', b.dataset.v === 'tally' ? null : b.dataset.v); await setSetting('accent', null); render(); $(`[data-act="set-app-palette"][data-v="${b.dataset.v}"]`)?.focus(); },
  // A palette colours every category at once (one picked by hand later still wins for that category); Undo puts back the old ones.
  'set-palette': async b => {
    const p = PALETTES.find(x => x[0] === b.dataset.v); if (!p) return;
    const before = { ...S.kv.catColors }, was = settings().palette || null;
    const apply = async (colors, id) => { await setKv('catColors', colors); await setSetting('palette', id); render(); $(`[data-act="set-palette"][data-v="${id || 'tally'}"]`)?.focus(); };
    await apply(p[2] ? Object.fromEntries(allCats().map((c, i) => [c.id, p[2][i % p[2].length]])) : {}, p[2] ? p[0] : null);
    toast(t('Category colours changed.'), { undo: () => apply(before, was) });
  },
  'set-start': async b => { await setSetting('start', b.dataset.v === 'activity' ? 'activity' : null); render(); },
  'set-week': async b => { await setSetting('weekStart', +b.dataset.v === 0 ? 0 : 1); render(); },
  'name-del': async b => { const r = { ...S.kv.itemNames }; delete r[b.dataset.k]; await setKv('itemNames', r); render(); },
  'rule-del': async b => { const r = { ...S.kv.rules }; delete r[b.dataset.k]; await setKv('rules', r); render(); },
  'import-open': () => importSheet(),
  'imp-paste': () => { const v = $('#imp-paste').value; if (!v.trim()) return impErr(t('Paste some cells first.')); startMapping(parseCSV(v, v.includes('\t') ? '\t' : undefined), t('Pasted cells'), { sheet: true }).catch(e => { console.error(e); impErr(t(e.message)); }); },
  'imp-link': async () => {
    const url = sheetCsvUrl($('#imp-link').value);
    if (!url) return impErr(t('That is not a Google Sheets link. It should start with https://docs.google.com/spreadsheets/d/'));
    impErr(t('Fetching…'));
    try {
      const res = await fetch(url, { credentials: 'omit', redirect: 'follow', signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error('private');
      const text = new TextDecoder().decode(await readCapped(res, LIMITS.fileBytes));   // 25 MB: Content-Length, then while streaming
      if (/^\s*<!DOCTYPE html|<html/i.test(text)) throw new Error('private');
      await startMapping(parseCSV(text), t('Google Sheets'), { sheet: true });
    } catch { impErr(t('Could not open that sheet. In Google Sheets, tap Share and set "Anyone with the link" to Viewer, or copy the cells and paste them instead.')); }
  },
  'imp-go': async b => {
    b.disabled = true;
    const { txs, fresh, dups, opening, acc, adjusted, openKnown } = impPlan(), m = IMP.map, made = [], staged = [], now = Date.now();
    if (!fresh.length) { b.disabled = false; return impErr(t('All rows are already in Tally. Nothing new to import.')); }
    if (IMP.accountId === 'new' && fresh.some(x => x.accountId === IMP.newId)) {
      staged.push({ id: IMP.newId, name: newAccName(), kind: newKind(), opening: opening ?? adjusted[''] ?? 0, scope: IMP.joint ? 'joint' : 'personal', createdAt: now });
      made.push(IMP.newId);
    }
    const unset = unsetTarget(), bumped = [];
    if (unset && opening != null) { staged.push({ ...unset, opening, typed: true, updatedAt: now }); bumped.push(unset); }   // Undo puts it back as it was
    for (const [n, a] of acc.values.entries()) if (a.isNew && fresh.some(x => x.accountId === a.id || x.toAccountId === a.id)) {
      staged.push({ id: a.id, name: a.v, kind: a.kind, opening: adjusted[a.v.toLowerCase()] || 0, createdAt: now + n + 1 }); made.push(a.id);
    }
    // An adjustment has no transaction row. Remember its source so a repeated file cannot move the balance twice.
    const adjustmentKey = IMP.sourceKey;
    const seenAdjustments = settings().importAdjustments || [];
    const bump = (id, d) => { const a = S.accounts.find(x => x.id === id); if (!a || !d) return; if (!bumped.some(x => x.id === id)) bumped.push(a); const i = staged.findIndex(x => x.id === id), prior = i >= 0 ? staged[i] : a; const next = { ...prior, opening: (prior.opening || 0) + d, updatedAt: now }; if (i >= 0) staged[i] = next; else staged.push(next); };
    // Mostly already here (the same ledger from another format): its corrections are already in those openings too.
    if (!seenAdjustments.includes(adjustmentKey) && dups.length <= fresh.length) {
      if (IMP.accountId !== 'new') bump(IMP.accountId, adjusted['']);
      for (const a of acc.values) if (!a.isNew) bump(a.id, adjusted[a.v.toLowerCase()]);
    }
    // "New category: Parents" becomes a real category when a row uses it; the choices are remembered for this header.
    const choices = catChoices(), newCats = [];
    for (const [src, v] of Object.entries(choices)) {
      if (!v.startsWith('new:') || !fresh.some(x => x.category === v)) continue;
      const name = v.slice(4), own = [...S.kv.customCats, ...newCats], inc = !fresh.some(x => x.category === v && x.type !== 'income');   // only money in: an income category
      // 50 of the user's own at most (a backup with more won't restore): past that, the nearest Tally category.
      const c = own.find(x => norm(x.name) === norm(name) && (x.kind === 'income') === inc) || (own.length < 50 ? { id: uid('c_'), name, color: nextColor(own.map(x => x.color)), ...(inc ? { kind: 'income' } : {}) } : null);
      if (c && !S.kv.customCats.some(x => x.id === c.id)) newCats.push(c);
      for (const x of txs) if (x.category === v) x.category = x.type === 'income' && !inc ? incomeCategory(`${name} ${x.merchant}`) : c ? c.id : inc ? incomeCategory(name) : mapCategory(name);
      if (c) choices[src] = c.id;
    }
    const maps = Object.entries({ ...settings().importMaps, [IMP.sig]: { map: m, ...(IMP.preset ? { preset: IMP.preset.id } : {}), catMap: Object.fromEntries(Object.entries(choices).filter(([, v]) => !v.startsWith('new:'))) } }).slice(-30);
    const sourceKey = IMP.sourceKey, importedAccount = IMP.accountId === 'new' ? IMP.newId : IMP.accountId;
    const nextSettings = { ...settings(), importMaps: Object.fromEntries(maps), importSources: Object.fromEntries(Object.entries({ ...settings().importSources, [IMP.sourceKey]: importedAccount }).slice(-100)), ...(bumped.length ? { importAdjustments: [...seenAdjustments, adjustmentKey].slice(-100) } : {}), ...(IMP.sheet ? { sheetAccount: importedAccount } : {}) };
    // No Balance column: every account the file touched, new or already here, is asked what it holds today (unless
    // the file's own starting balance or corrections said so).
    const known = id => (id === IMP.newId && opening != null) || openKnown.includes(id === IMP.newId || id === IMP.accountId ? '' : acc.values.find(a => a.id === id)?.v.toLowerCase());
    const blind = m.balance == null, first = !settings().onboarded;   // the tour waits until the balances are in
    const touched = await commitImport(txs, IMP.preset?.name || IMP.name || t('file'), { accounts: staged, kv: { settings: nextSettings, ...(newCats.length ? { customCats: [...S.kv.customCats, ...newCats] } : {}) }, newAccounts: made, tourLater: blind, undoMore: async () => {
      for (const a of bumped) await saveAccount(a);
      if (newCats.length) await setKv('customCats', S.kv.customCats.filter(c => !newCats.some(n => n.id === c.id) || S.tx.some(x => x.category === c.id)));
      const sources = { ...settings().importSources }; if (sources[sourceKey] === importedAccount) delete sources[sourceKey];
      await setKv('settings', { ...settings(), importSources: sources, importAdjustments: (settings().importAdjustments || []).filter(k => k !== adjustmentKey) });
    } });
    if (blind) setTimeout(() => balanceTodaySheet(touched.filter(id => !known(id)), first ? afterSetup : undefined), 300);   // after the move to Home settles (like the tour)
  },
  'mm-go': async b => {
    b.disabled = true;
    const { buf } = IMP, withPhotos = $('#mm-photos')?.checked;
    // The same ledger from another format (its Excel export first): same-named accounts are the ones already here.
    const here = new Map(S.accounts.map(a => [norm(a.name), a.id])), same = id => (!S.accounts.some(a => a.id === id) && here.get(norm(IMP.mm.accounts.find(a => a.id === id)?.name))) || id;
    const mm = { ...IMP.mm, tx: IMP.mm.tx.map(x => ({ ...x, accountId: same(x.accountId), ...(x.toAccountId ? { toAccountId: same(x.toAccountId) } : {}) })) };
    const fresh = splitDups(S.tx, mm.tx, Object.fromEntries([...S.accounts, ...mm.accounts].map(a => [a.id, a.name]))).fresh, used = new Set(fresh.flatMap(x => [x.accountId, x.toAccountId]).filter(Boolean));
    const accounts = mm.accounts.filter(a => used.has(a.id) && !S.accounts.some(x => x.id === a.id));
    const cats = fitCats(S.kv.customCats, mm.customCats, fresh, mm.tx);   // 50 of the user's own at most, counting those already here
    await commitImport(mm.tx, mm.app === 'cashew' ? 'Cashew' : mm.app === 'realbyte' ? 'Money Manager (Realbyte)' : 'Money Manager', { accounts, newAccounts: accounts.map(a => a.id), kv: cats.length ? { customCats: [...S.kv.customCats, ...cats] } : {}, before: async fresh => {
      if (!withPhotos) return [];
      const { readPhotos } = await import('../mmimport.js');
      const want = new Map(fresh.map(x => [x.id, x]));
      const todo = mm.photos.map(p => ({ ...p, txIds: p.txIds.filter(id => want.has(id)) })).filter(p => p.txIds.length), ids = [];
      const files = todo.length ? await readPhotos(buf, todo.map(p => p.path)) : {};   // one unzip: its entry and byte caps cover every photo
      for (const [n, p] of todo.entries()) {   // each file decoded and stored once, however many entries link it
        if (n % 25 === 0) toast(t('Copying photos… {0} of {1}', n, todo.length));
        const bytes = files[p.path];
        const jpeg = bytes && await reencode(new Blob([bytes], { type: 'image/jpeg' }));
        if (!jpeg) continue;
        const id = uid('p');
        if (!(await savePhoto(id, jpeg))) continue;
        ids.push(id);
        for (const txId of p.txIds) want.get(txId).receiptId = id;   // a shared receiptId is safe: a photo is deleted only when no row uses it
      }
      return ids;
    }, undoMore: async () => {
      if (cats.length) await setKv('customCats', S.kv.customCats.filter(c => !cats.some(n => n.id === c.id) || S.tx.some(x => x.category === c.id)));
    } });
  },
  'pdf-unlock': () => { const pw = $('#pdf-pw').value; if (pw) importStatement(IMP.pdf, pw).catch(e => impErr(e.message)); },
  'st-go': async b => {
    b.disabled = true;
    const { st } = IMP, sel = $('#st-acc').value;
    let accountId = sel;
    let account = null;
    if (sel === 'new') {
      accountId = uid('a');
      const first = st.rows[0];
      account = { id: accountId, name: st.provider?.[1] || t('Bank statement'), kind: st.provider?.[2] || 'bank', opening: st.opening ?? (first.balance != null ? first.balance - first.amount : 0), createdAt: Date.now() };
    }
    const source = Object.fromEntries(Object.entries({ ...settings().importSources, [IMP.sourceKey]: accountId }).slice(-100));
    const blind = st.opening == null && !st.rows.some(r => r.balance != null), first = !settings().onboarded;   // a statement without balances: ask, as for a file
    const touched = await commitImport(importIds(statementToTx(st.rows, { accountId }), 's'), st.provider?.[1] || t('Bank statement'), { accounts: account ? [account] : [], newAccounts: account ? [accountId] : [], kv: { settings: { ...settings(), importSources: source } }, tourLater: blind });
    if (blind) setTimeout(() => balanceTodaySheet(touched, first ? afterSetup : undefined), 300);
  },
  'migration-guide': () => migrationGuide(),
  'migration-dismiss': () => { $('#migration-welcome')?.remove(); },
  'migration-restore-step': () => migrationGuide(2),
  'migration-restore': () => { closeSheet(); act['restore-pick'](); },
  'migration-check': () => migrationGuide(2),
  'migration-found': () => migrationGuide(3),
  'migration-backup': () => {
    act['backup']();
    const el = document.createElement('button'); el.className = 'btn ghost wide'; el.dataset.act = 'migration-check'; el.textContent = t('Check backup file');
    $('.scrim:not(.out) .sheet')?.append(el);
  },
  'restore-pick': () => {
    // No accept filter (Android hides .mmbackup and some .json files); importFile routes by content and size.
    const inp = Object.assign(document.createElement('input'), { type: 'file' });
    inp.addEventListener('change', () => { const f = inp.files[0]; if (f) importFile(f); });
    inp.click();
  },
  // Say what the file is and where it goes before anything opens (Round 1: people lost track of the file).
  // Where the data is and what deletes it, in plain words: people clear "cache" or uninstall to fix a phone and lose everything.
  'storage-info': () => {
    const li = (icon, s) => `<li>${icon}<span>${esc(s)}</span></li>`;
    openSheet(`<h2 class="sh-title">${esc(t('How your data is kept'))}</h2>
      <ul class="points">
        ${li(ICON.wallet, isNative ? t('Your book is saved in this app on this phone. Clearing browser data does not delete it. A computer you approve can view and edit it while connected. Tally keeps no cloud copy.') : t('Only on this phone, in the storage of the browser Tally runs in. It is not copied to a server or to your other devices: no one can bring it back, not even us.'))}
        ${li(ICON.check, t('What is kept: your accounts, entries, receipt photos, budgets, bills, categories and settings.'))}
        ${li(ICON.alert, isNative ? t('Uninstalling Tally, clearing its app data, or resetting this phone deletes your entries, accounts and receipt photos. Back up first.') : t("Deleted by: uninstalling Tally, clearing the browser's data for Tally, cleaner apps, a phone reset."))}
        ${iosBrowser() ? li(ICON.plusSquare, t("On iPhone, keep Tally on the Home Screen: Safari clears web apps it hasn't seen for 7 days.")) : ''}
        ${li(ICON.check, t('Safe: closing, restarting, updates, offline.'))}
        ${li(ICON.upload, t('New phone? Back up, then restore there.'))}
      </ul>
      <div class="row2 sheetfoot"><button class="btn" data-act="backup">${ICON.download}${esc(t('Back up now'))}</button><button class="btn ghost" data-act="sheet-close">${esc(t('Got it'))}</button></div>`, { label: t('How your data is kept') });   // the buttons stay on screen at big text
  },
  'backup': () => {
    const { name, text } = backupFile(), canShare = !!navigator.canShare?.({ files: [new File([''], name, { type: 'application/json' })] });
    openSheet(`<div class="sheethead"><h2 class="sh-title">${esc(t('Back up'))}</h2><button class="icon-btn" data-act="sheet-close" aria-label="${esc(t('Close'))}">${ICON.x}</button></div>
      <p class="sh-body">${esc(t('One file with all {0} transactions, your accounts, budgets and categories.', S.tx.length))}</p>
      <p class="filechip">${ICON.download}<span class="grow"><b>${esc(name)}</b><small>${esc(t('{0} KB', Math.max(1, Math.round(text.length / 1024))))}</small></span></p>
      ${photoCount() ? `<label class="check"><input type="checkbox" id="bk-photos" checked> ${esc(photoCount() === 1 ? t('Include 1 receipt photo (a bigger .zip file)') : t('Include {0} receipt photos (a bigger .zip file)', photoCount()))}</label>` : ''}
      <details class="more-cats"><summary>${ICON.lock}${esc(t('Protect with a password'))}</summary><label class="field"><span>${esc(t('Password (optional)'))}</span><input id="bk-pass" type="password" autocomplete="new-password" minlength="8"></label>
        <p class="fine">${esc(t("Without this password the file can't be opened, and no one can reset it. Use a long password: short ones can be guessed."))}</p><p class="err" id="bk-err" role="alert"></p></details>
      ${canShare ? `<button class="btn wide" data-act="bk-share">${esc(t('Send to myself (Google Drive, email, WhatsApp)'))}</button>` : ''}
      <button class="btn ${canShare ? 'ghost ' : ''}wide" data-act="bk-save">${esc(t('Save to this phone (Downloads)'))}</button>
      <p class="fine">${esc(t('To restore on a new phone: open Tally there, tap Restore a Tally backup, and pick this file.'))}</p>`, { label: t('Back up') });
  },
  'bk-share': async () => {
    const r = await sealedBackup(); if (!r) return;
    const { name, blob, missing } = r;
    try { if (!(await shareFile(name, blob, blob.type))) return act['bk-save'](); } catch (e) { if (e?.name === 'AbortError') return; throw e; } // closed the share sheet: nothing sent
    await backedUp(t('Sent {0}. Check it arrived before you rely on it.', name));
    warnMissingPhotos(missing);
  },
  'bk-save': async b => {
    const r = await sealedBackup(); if (!r) return;
    b ||= $('[data-act="bk-save"]');   // also called from bk-share when the phone can't share files
    if (b) b.disabled = true;
    const { name, blob, missing } = r;
    try {
      const result = await download(name, blob, blob.type);
      if (isNative && result?.cancelled !== false) return;
      await backedUp(isNative ? `${t('Saved')}: ${name}` : t('Download started. Check your Downloads folder for {0}.', name));
      warnMissingPhotos(missing);
    } catch {
      toast(t('Could not save. Your phone may be out of space.'), { k: 'bad' });
    } finally { if (b?.isConnected) b.disabled = false; }
  },
  'joint-share': () => {
    const { name, text } = jointFile(), rows = jointTx(), photos = new Set(rows.map(x => x.receiptId).filter(Boolean)).size;
    const canShare = !!navigator.canShare?.({ files: [new File([''], name, { type: 'application/json' })] });
    openSheet(`<h2 class="sh-title">${esc(t('Share joint accounts'))}</h2>
      <p class="sh-body">${esc(jointIds().size === 1 ? t('One file with your joint account, its {0} entries, joint budgets and the categories they use. Nothing from your personal accounts.', rows.length) : t('One file with your {0} joint accounts, their {1} entries, joint budgets and the categories they use. Nothing from your personal accounts.', jointIds().size, rows.length))}</p>
      <p class="filechip">${ICON.download}<span class="grow"><b>${esc(name)}</b><small>${esc(t('{0} KB', Math.max(1, Math.round(text.length / 1024))))}</small></span></p>
      ${photos ? `<label class="check"><input type="checkbox" id="jt-photos"> ${esc(t('Include {0} receipt photos (a bigger .zip file)', photos))}</label>` : ''}
      <p class="warnbox">${ICON.alert}<span class="grow">${esc(t('Anyone with this file can read it, including any receipt photos (they may show card numbers or names). Send it only to your partner, or add a password.'))}</span></p>
      <details class="more-cats"><summary>${ICON.lock}${esc(t('Protect with a password'))}</summary><label class="field"><span>${esc(t('Password (optional)'))}</span><input id="jt-pass" type="password" autocomplete="new-password" minlength="8"></label><p class="fine">${esc(t('Tell your partner the password another way (not in the same chat).'))}</p><p class="err" id="jt-err" role="alert"></p></details>
      ${canShare ? `<button class="btn wide" data-act="jt-send">${esc(t('Send to my partner (WhatsApp, email)'))}</button>` : ''}
      <button class="btn ${canShare ? 'ghost ' : ''}wide" data-act="jt-save">${esc(t('Save to this phone (Downloads)'))}</button>
      <p class="fine">${esc(t('Your partner opens Tally, taps Settings → Import from my partner and picks this file. Newer edits win on both phones.'))} ${esc(t('Deleting an entry deletes it on the other phone too, once they import your next file.'))}</p>`, { label: t('Share joint accounts') });
  },
  'jt-send': async () => {
    const r = await sealedBackup(await backupBlob($('#jt-photos')?.checked, jointFile(), jointTx()), '#jt-pass', '#jt-err'); if (!r) return;
    const { name, blob, missing } = r;
    try { if (!(await shareFile(name, blob, blob.type))) return act['jt-save'](); } catch (e) { if (e?.name === 'AbortError') return; throw e; }
    closeSheet(); toast(t('Sent {0}', name), { k: 'good', icon: 'check' }); warnMissingPhotos(missing);
  },
  'jt-save': async b => {
    const r = await sealedBackup(await backupBlob($('#jt-photos')?.checked, jointFile(), jointTx()), '#jt-pass', '#jt-err'); if (!r) return;
    if (b) b.disabled = true;
    const { name, blob, missing } = r;
    const result = await download(name, blob, blob.type);
    if (isNative && result?.cancelled !== false) { if (b?.isConnected) b.disabled = false; return; }
    closeSheet(); toast(t('Download started. Check your Downloads folder for {0}.', name), { k: 'good', icon: 'check' }); warnMissingPhotos(missing);
  },
  'export-csv': () => download(`tally-${today()}.csv`, toCSV(S.tx, S.accounts, catName), 'text/csv'),
  // Every entry in formats other apps open, so nobody is tied to Tally. Tally reads each of them back too.
  'export-open': () => {
    const row = (act, label, sub) => `<li><button class="rbtn" data-act="${act}"><span class="rowb"><b>${ICON.download}${esc(label)}</b></span><small>${esc(sub)}</small></button></li>`;
    openSheet(`<h2 class="sh-title">${esc(t('Export'))}</h2><ul class="relief exports">
      ${row('export-xlsx', t('Excel (.xlsx)'), t('Excel, Numbers, LibreOffice. Google Drive opens it in Sheets.'))}
      ${row('export-sheets', t('Google Sheets'), t('Copies your entries and opens a new sheet: paste in cell A1.'))}
      ${row('export-csv', 'CSV', t('Most money apps and spreadsheets with an import.'))}
      ${row('export-qif', 'QIF', t('GnuCash, HomeBank, Moneydance, Money Manager Ex.'))}</ul>
      <p class="fine">${esc(t('Moving to a new phone? Back up instead: it keeps photos, budgets and settings too.'))}</p>
      <div class="sheetfoot"><button class="btn ghost wide" data-act="sheet-close">${esc(t('Close'))}</button></div>`, { label: t('Export') });
  },
  'export-xlsx': () => download(`tally-${today()}.xlsx`, toXlsx(txRows(S.tx, S.accounts, catName)), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  'export-qif': () => download(`tally-${today()}.qif`, toQIF(S.tx, S.accounts, catName), 'application/qif'),
  // No Google sign-in (nothing leaves the phone by itself): the rows go on the clipboard and a blank sheet opens for pasting.
  'export-sheets': async () => {
    try { await navigator.clipboard.writeText(toTSV(S.tx, S.accounts, catName)); } catch { return toast(t('Could not copy. Use Excel (.xlsx) and open it in Google Drive.'), { k: 'warn' }); }
    window.open('https://sheets.new', '_blank', 'noopener');
    toast(t('Copied. In the new sheet, tap cell A1 and paste. Tally clears the clipboard in 2 minutes where the phone allows it.'), { k: 'good', icon: 'check' });
    setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), 120_000);   // other apps and keyboards read the clipboard: best effort
  },
  // Sample data: two made-up months to look around in (only on an empty app); "Start for real" removes it (and anything added to its accounts).
  'sample-go': async () => {
    await startSample(today(), t('Cash'), t('Emergency fund'));
    go('home');
  },
  'sample-end': async () => {
    if (sampleRows().tx.some(x => !x.sample) && !(await confirmSheet({ title: t('Remove the sample data?'), body: t('Entries you added to the sample accounts go too.'), ok: t('Remove') }))) return;
    await endSample();
    go(S.accounts.length ? 'home' : 'welcome'); toast(t('Sample data removed. Your turn.'));
  },
  // What this page has contacted since it opened, from the browser's own record, so nobody has to take our word for it.
  'net-check': () => {
    const what = h => (h === location.host ? t("Tally's own files (the app itself)") : /(^|\.)google(usercontent)?\.com$/.test(h) ? t('Google: feedback you sent or a Sheets link you pasted') : h === 'api.frankfurter.dev' ? t('Exchange rate you asked for (no money data sent)') : t('Not expected: please tell us'));
    const hosts = [...new Set(performance.getEntriesByType('resource').concat(performance.getEntriesByType('navigation')).map(e => { try { return new URL(e.name).host; } catch { return ''; } }).filter(Boolean))];
    openSheet(`<div class="sheethead"><h2 class="sh-title">${esc(t('Check it yourself'))}</h2><button class="icon-btn" data-act="sheet-close" aria-label="${esc(t('Close'))}">${ICON.x}</button></div>
      <p class="sh-body">${esc(t('Every address this page has fetched since it opened, as recorded by your browser (links you open in a new tab, like Google Calendar, are not in it):'))}</p>
      ${hosts.every(h => h === location.host) ? `<p class="okbox">${esc(t("Only Tally's own website. Nothing else."))}</p>` : ''}
      ${isNative ? '<p class="fine">'+esc(t('This list shows downloaded pages and files. A computer connection uses a separate encrypted channel and is not shown here.'))+'</p>' : ''}
      <ul class="list">${hosts.map(h => `<li><span class="grow"><b>${esc(h)}</b><small>${esc(what(h))}</small></span></li>`).join('')}</ul>
      <p class="fine">${esc(t('Try this: turn on airplane mode, then add an entry. It still works. Scanning works offline too, once the receipt reader has downloaded (once, about 30 MB, from Tally\'s own site).'))}</p>
      <p class="fine"><a class="link" href="https://github.com/tallymy/tallymy.github.io" target="_blank" rel="noopener">${esc(t('Tally is open source: anyone can read the code on GitHub.'))}</a></p>`, { label: t('Check it yourself') });
  },
  'erase': async () => {
    if (!(await confirmSheet({ title: t("Erase all of Tally's data?"), body: t('This deletes only Tally\'s own data: your accounts, entries, receipt photos, budgets, bills, categories and settings, kept in the storage of the browser Tally runs in on this phone. Other apps, your gallery, your files and the rest of the phone are not touched. It cannot be undone. Back up first if you might want them.'), ok: t("Erase Tally's data"), danger: true }))) return;
    await eraseAll(); location.hash = '#/welcome'; location.reload();   // a fresh page: drafts, queues and Undo from before can't write back
  },
};
