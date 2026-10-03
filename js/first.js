// A brand-new visitor in a browser tab sees the landing page first: what Tally is and how to start, in their own
// language when the browser's first choice is Malay, Chinese, Japanese or Tamil (start.ms/zh/zh-Hant/ja/ta.html, Traditional
// for zh-Hant, zh-TW, zh-HK and zh-MO), else start.html; its
// "Open Tally" comes back as ./?app. Never the installed app, anyone who has opened Tally here before (the look is
// saved on every open), a link with anything in it (?app, a shared file, a sample), or a window where storage is blocked.
// A classic script in <head>, so it runs before anything is drawn (the CSP allows no inline script). It also puts the
// saved light or dark choice on <html> first, so the loading outline is drawn in the right colours.
(() => {
  try { const th = (JSON.parse(localStorage.getItem('tally-look')) || {}).theme; if (th === 'light' || th === 'dark') document.documentElement.dataset.theme = th; } catch { /* none saved */ }
  try {
    if (location.search || location.hash) return;
    if (globalThis.Capacitor?.isNativePlatform?.()) return;   // the Android app: no landing page inside it
    if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) return;
    if (localStorage.getItem('tally-look') !== null) return;
    if (document.referrer && new URL(document.referrer).origin === location.origin) return;
    const want = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    const lang = /^zh-(hant|tw|hk|mo)(-|$)/i.test(want) ? 'zh-Hant' : (/^(ms|zh|ja|ta)(-|$)/i.exec(want) || [])[1];
    location.replace(lang ? `start.${lang === 'zh-Hant' ? lang : lang.toLowerCase()}.html` : 'start.html');
  } catch { /* storage blocked: stay in the app */ }
})();
