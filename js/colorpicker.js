// Colours: the look (theme, accent, compact) and one colour picker sheet, a honeycomb of hexagons like Office's
// "More colours": white in the middle, hues around it, stronger outward, a row of greys, and a hex code field.
import { t } from './i18n.js';
import { esc, ICON, openSheet, closeSheet } from './ui.js';

// ---- colour maths (pure) -------------------------------------------------------------------------------------------
/** "#1e40af", "1E40AF", "#fff", "abc" → "#1E40AF" / "#FFFFFF" / "#AABBCC"; anything else → null. */
export function parseHex(s) {
  const m = String(s ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(m)) return `#${[...m].map(c => c + c).join('')}`.toUpperCase();
  return /^[0-9a-f]{6}$/i.test(m) ? `#${m}`.toUpperCase() : null;
}
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const toHex = a => `#${a.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
/** WCAG relative luminance and contrast ratio. */
export const luminance = hex => { const [r, g, b] = rgb(hex).map(v => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export const INK = '#020617';   // near-black: with white, every colour gets one of the two at 4.5:1 or more
/** Text on a colour: white or near-black, whichever reads better. */
export const onColor = hex => (contrast(hex, '#FFFFFF') >= contrast(hex, INK) ? '#FFFFFF' : INK);
export const mix = (a, b, k) => { const B = rgb(b); return toHex(rgb(a).map((v, i) => v + (B[i] - v) * k)); };
/** The theme surfaces (bg, panel, panel2 in css/app.css) that accent text sits on. */
export const SURFACES = { dark: ['#0F172A', '#192134', '#1F2A42'], light: ['#F3F5F9', '#FFFFFF', '#EAEEF5'] };
/** The nearest shade of `hex` readable (min:1) on every surface: lighter on dark themes, darker on light ones. */
export function readable(hex, surfaces, min = 4.5) {
  const toward = luminance(surfaces[0]) < 0.2 ? '#FFFFFF' : '#000000';
  for (let k = 0; k <= 20; k++) { const c = mix(hex, toward, k / 20); if (surfaces.every(s => contrast(c, s) >= min)) return c; }
  return toward;
}
/** A plain name for a colour, for screen readers: "Blue", "Grey"… */
export function colourName(hex) {
  const [r, g, b] = rgb(hex).map(v => v / 255), mx = Math.max(r, g, b), c = mx - Math.min(r, g, b), l = mx - c / 2;
  if (c < 0.1) return l > 0.95 ? t('White') : l < 0.08 ? t('Black') : t('Grey');
  const h = ((mx === r ? ((g - b) / c + 6) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4) * 60);
  return h < 15 || h >= 345 ? t('Red') : h < 45 ? t('Orange') : h < 70 ? t('Yellow') : h < 170 ? t('Green') : h < 195 ? t('Teal') : h < 255 ? t('Blue') : h < 290 ? t('Purple') : t('Pink');
}
const hsv = (h, s, v) => { const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); }; return toHex([f(5), f(3), f(1)].map(x => x * 255)); };

export const RINGS = 5;
const R3 = Math.sqrt(3);
/** Cells of a hexagon of hexagons (pointy-top, axial q/r), row by row: white in the middle, hue by angle (red at the
 *  top, clockwise), saturation growing and brightness falling a little per ring. x/y in cell widths. */
export function honeycomb(n = RINGS) {
  const out = [];
  for (let r = -n; r <= n; r++) for (let q = Math.max(-n, -r - n); q <= Math.min(n, n - r); q++) {
    const ring = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)), x = q + r / 2, y = r * R3 / 2;
    const hue = (Math.atan2(x, -y) * 180 / Math.PI + 360) % 360;
    out.push({ q, r, ring, x, y, hex: ring ? hsv(hue, ring / n, 1 - 0.35 * ring / n) : '#FFFFFF' });
  }
  return out;
}
/** A row of greys, white to black. */
export const GREYS = Array.from({ length: 2 * RINGS + 1 }, (_, i) => toHex([0, 0, 0].map(() => 255 - i * 255 / (2 * RINGS))));

// ---- the look: theme, accent, compact ---------------------------------------------------------------------------------
/** Accent presets; the first is the design system's blue (the default, drawn by css/app.css's own tokens). */
export const ACCENTS = ['#1E40AF', '#0284C7', '#0D9488', '#059669', '#B45309', '#C2410C', '#E11D48', '#DB2777', '#7C3AED'];
const accentVars = (a, m) => `--accent:${readable(a, SURFACES[m])};--btn:${a};--btn-ink:${onColor(a)};`;
/** Whole-app colours: the surfaces (bg, panel, panel2) for dark and light, and the accent that comes with them (an accent
 *  picked by hand still wins). Text and lines are worked out to stay readable (4.5:1) on every surface. */
export const APP_PALETTES = {
  tally: { name: 'Tally', dark: ['#0F172A', '#192134', '#1F2A42'], light: ['#F3F5F9', '#FFFFFF', '#EAEEF5'], accent: '#1E40AF' },
  kopi: { name: 'Kopi', dark: ['#1A1410', '#251D17', '#30261E'], light: ['#F7F2EC', '#FFFFFF', '#EFE5D9'], accent: '#B45309' },
  pandan: { name: 'Pandan', dark: ['#0D1A14', '#14261D', '#1B3226'], light: ['#F0F7F2', '#FFFFFF', '#DFEEE4'], accent: '#047857' },
  laut: { name: 'Ocean', dark: ['#0A1A20', '#11262E', '#17323B'], light: ['#EEF6F8', '#FFFFFF', '#DAEBF0'], accent: '#0E7490' },
  bunga: { name: 'Hibiscus', dark: ['#1C1016', '#281820', '#34202B'], light: ['#FBF1F4', '#FFFFFF', '#F2DFE6'], accent: '#BE185D' },
  arang: { name: 'Charcoal', dark: ['#111111', '#1B1B1B', '#262626'], light: ['#F4F4F5', '#FFFFFF', '#E6E6E9'], accent: '#52525B' },
};
/** Your own app colours ("Mine"): {dark: [bg, cards, raised], light: [...], accent}, every one "#RRGGBB". */
export const okMine = p => !!p && typeof p === 'object' && Object.keys(p).length === 3 && /^#[0-9a-f]{6}$/i.test(p.accent)
  && ['dark', 'light'].every(m => Array.isArray(p[m]) && p[m].length === 3 && p[m].every(h => /^#[0-9a-f]{6}$/i.test(h)));
/** A background and a card colour → the three surfaces: the raised one a step from the cards (lighter on dark, darker on light). */
export const surfacesFrom = (bg, card) => [bg, card, mix(card, luminance(bg) < 0.2 ? '#FFFFFF' : '#000000', 0.07)];
/** A finished sticker book's colours (settings.bookPalettes[YYYY-MM], picked as "book-YYYY-MM"), or null. */
export const bookPalette = s => { const ym = /^book-(\d{4}-\d{2})$/.exec(s?.appPalette || '')?.[1], p = ym && s.bookPalettes?.[ym]; return okMine(p) ? p : null; };
/** The app colours the settings pick: one of APP_PALETTES, a finished book's, or your own. */
export const paletteFor = s => (s?.appPalette === 'mine' && okMine(s.myPalette) ? { name: 'Mine', ...s.myPalette } : bookPalette(s) ? { name: 'Book', ...bookPalette(s) } : APP_PALETTES[Object.hasOwn(APP_PALETTES, s?.appPalette) ? s.appPalette : 'tally']);
const surfaceVars = (m, s) => { const ink = m === 'dark' ? '#EEF2FA' : '#0F172A';
  return `--bg:${s[0]};--panel:${s[1]};--panel2:${s[2]};--ink:${readable(ink, s, 7)};--mute:${readable(mix(ink, s[0], 0.42), s)};--line:${m === 'dark' ? 'rgba(255,255,255,.1)' : mix(s[2], '#000000', 0.1)};`; };
const paletteCss = p => `:root{${surfaceVars('dark', p.dark)}}:root[data-theme="light"]{${surfaceVars('light', p.light)}}@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){${surfaceVars('light', p.light)}}}`;
/** Runtime colours follow the base stylesheet, which loads at the end of body. */
const styleTag = (id, css) => { let st = document.getElementById(id); if (!css) return st?.remove(); if (!st) { st = document.createElement('style'); st.id = id; } if (st.textContent !== css) st.textContent = css; (document.body || document.head).append(st); };
/** The CSS for a chosen accent, in the same shape as the theme tokens (forced theme, or the system's). */
export const accentCss = a => `:root{${accentVars(a, 'dark')}}:root[data-theme="light"]{${accentVars(a, 'light')}}@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){${accentVars(a, 'light')}}}`;
export const themeNow = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
const LOOK = 'tally-look';   // a copy in localStorage, so the look is right before the database opens
/** Apply settings {theme, accent, compact} to the page. Called before the first paint and on every render. */
export function applyLook(s = {}) {
  const html = document.documentElement, theme = ['light', 'dark'].includes(s.theme) ? s.theme : '';
  const pal = paletteFor(s), pid = pal.name === 'Mine' ? 'mine' : pal.name === 'Book' ? s.appPalette : Object.hasOwn(APP_PALETTES, s.appPalette) ? s.appPalette : 'tally';
  SURFACES.dark = pal.dark; SURFACES.light = pal.light;   // accents are made readable on the palette's own surfaces
  const a = (s.accent && parseHex(s.accent)) || (pid !== 'tally' ? pal.accent : null);
  if (theme) html.dataset.theme = theme; else delete html.dataset.theme;
  html.toggleAttribute('data-compact', s.compact === true);
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = SURFACES[theme || (/light/.test(m.media) ? 'light' : 'dark')][0];
  styleTag('palette-css', pid === 'tally' ? null : paletteCss(pal));
  styleTag('accent-css', a ? accentCss(a) : null);   // after the palette, so it wins
  try { localStorage.setItem(LOOK, JSON.stringify({ theme, accent: s.accent || '', appPalette: pid, ...(pid === 'mine' ? { myPalette: s.myPalette } : {}), ...(pal.name === 'Book' ? { bookPalettes: { [pid.slice(5)]: bookPalette(s) } } : {}), compact: s.compact === true })); } catch { /* private window: the database copy still applies */ }
}
export function applySavedLook() { try { applyLook(JSON.parse(localStorage.getItem(LOOK)) || {}); } catch { /* none saved */ } }

// ---- the picker sheet ------------------------------------------------------------------------------------------------
const S = 10, W = S * R3;   // hexagon circumradius and width in SVG units
const hexPts = [0, 1, 2, 3, 4, 5].map(k => { const a = Math.PI / 180 * (60 * k - 90); return `${(S * 0.94 * Math.cos(a)).toFixed(2)},${(S * 0.94 * Math.sin(a)).toFixed(2)}`; }).join(' ');
/** Every cell with its place in SVG units: the honeycomb, then the greys in a row below it. */
const CELLS = [
  ...honeycomb().map(c => ({ hex: c.hex, cx: c.x * W, cy: c.y * W })),
  ...GREYS.map((hex, i) => ({ hex, cx: (i - RINGS) * W, cy: (RINGS + 1) * 1.5 * S + S * 0.6 })),
];
const top = Math.min(...CELLS.map(c => c.cy)) - S - 2, bottom = Math.max(...CELLS.map(c => c.cy)) + S + 2;
const VB = `${(-(RINGS + 0.5) * W - 2).toFixed(1)} ${top.toFixed(1)} ${((2 * RINGS + 1) * W + 4).toFixed(1)} ${(bottom - top).toFixed(1)}`;
/** Arrow keys: the next cell that way (same row for left/right; the nearest in the next row for up/down). */
export function neighbour(cells, i, key) {
  const c = cells[i], dir = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 }[key];
  if (!dir) return i;
  const row = key === 'ArrowRight' || key === 'ArrowLeft';
  const pool = cells.map((d, j) => ({ d, j })).filter(({ d }) => (row ? Math.abs(d.cy - c.cy) < 1 && (d.cx - c.cx) * dir > 1 : (d.cy - c.cy) * dir > 1));
  if (!pool.length) return i;
  const ny = row ? c.cy : pool.reduce((m, { d }) => (Math.abs(d.cy - c.cy) < Math.abs(m - c.cy) ? d.cy : m), pool[0].d.cy);
  return pool.filter(({ d }) => Math.abs(d.cy - ny) < 1).sort((p, q) => Math.abs(p.d.cx - c.cx) - Math.abs(q.d.cx - c.cx))[0].j;
}

/** Pick a colour. Resolves the chosen "#RRGGBB", or null if closed. reset: a default colour offered as a button. */
export function pickColor({ value = '#1E40AF', title = t('Colour'), reset = null, warn = true } = {}) {
  return new Promise(resolve => {
    let cur = parseHex(value) || '#1E40AF', done = false;
    const at = h => CELLS.findIndex(c => c.hex === h);
    const start = at(cur) >= 0 ? at(cur) : at('#FFFFFF');   // the chosen colour, or the white centre
    const cells = CELLS.map((c, i) => `<polygon class="hx" points="${hexPts}" transform="translate(${c.cx.toFixed(2)} ${c.cy.toFixed(2)})" fill="${c.hex}" role="radio" aria-label="${esc(`${c.hex} ${colourName(c.hex).toLocaleLowerCase()}`)}" aria-checked="false" tabindex="${i === start ? 0 : -1}" data-i="${i}"${i === start ? ' autofocus' : ''}/>`).join('');
    const sheet = openSheet(`<h2 class="sh-title">${esc(title)}</h2>
      <div class="cp-top"><span class="cp-prev" aria-hidden="true"><i style="background:${cur}"></i><i id="cp-new">Aa</i></span>
        <label class="field cp-hex"><span>${esc(t('Hex code'))}</span><input id="cp-hex" value="${cur}" maxlength="7" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-describedby="cp-msg"></label></div>
      <p class="fine cp-msg" id="cp-msg" aria-live="polite"></p>
      <div class="cp-wrap"><svg class="hc" viewBox="${VB}" tabindex="-1" role="radiogroup" aria-label="${esc(t('Colours'))}">${cells}<polygon class="hx-sel" points="${hexPts}" aria-hidden="true"/><polygon class="hx-foc" points="${hexPts}" aria-hidden="true"/></svg></div>
      ${reset ? `<button class="link cp-reset" data-x="reset">${esc(t('Default'))} <span class="dot" style="background:${esc(reset)}"></span></button>` : ''}
      <div class="row2"><button class="btn ghost" data-x="no">${esc(t('Cancel'))}</button><button class="btn" data-x="yes" id="cp-ok">${esc(t('Apply'))}</button></div>`,
    { label: title, onClose: () => { if (!done) resolve(null); } });
    const field = sheet.querySelector('#cp-hex'), msg = sheet.querySelector('#cp-msg'), ok = sheet.querySelector('#cp-ok'), svg = sheet.querySelector('.hc');
    const polys = [...svg.querySelectorAll('.hx')], mark = svg.querySelector('.hx-sel'), foc = svg.querySelector('.hx-foc');
    svg.addEventListener('focusin', e => { const p = e.target.closest('.hx'); if (p) foc.setAttribute('transform', p.getAttribute('transform')); });   // keyboard focus, even on a cell not chosen
    const show = (h, { from } = {}) => {
      cur = h;
      const nw = sheet.querySelector('#cp-new'); nw.style.background = h; nw.style.color = onColor(h);
      if (from !== 'field') { field.value = h; field.removeAttribute('aria-invalid'); field.classList.remove('bad'); }
      const i = at(h);
      polys.forEach((p, j) => { p.setAttribute('aria-checked', String(j === i)); if (i >= 0) p.tabIndex = j === i ? 0 : -1; });
      mark.style.display = i >= 0 ? '' : 'none';
      if (i >= 0) mark.setAttribute('transform', polys[i].getAttribute('transform'));
      const low = warn && contrast(h, SURFACES[themeNow()][0]) < 3;   // a colour for things on the background, not the background itself
      msg.innerHTML = low ? `${ICON.alert}<span>${esc(t('Hard to see on this background. Text on it stays readable.'))}</span>` : '';
      msg.className = `fine cp-msg${low ? ' warn' : ''}`;
      ok.disabled = false;
    };
    const choose = i => { show(CELLS[i].hex); polys[i].focus(); };
    show(cur);
    svg.addEventListener('click', e => { const p = e.target.closest('.hx'); if (p) choose(+p.dataset.i); });
    svg.addEventListener('keydown', e => {
      const p = e.target.closest('.hx'); if (!p) return;
      if (e.key === 'Enter') { e.preventDefault(); show(CELLS[+p.dataset.i].hex); done = true; resolve(cur); closeSheet(); return; }
      if (e.key === ' ') { e.preventDefault(); return choose(+p.dataset.i); }
      const j = neighbour(CELLS, +p.dataset.i, e.key);
      if (e.key.startsWith('Arrow')) { e.preventDefault(); choose(j); }
    });
    field.addEventListener('input', () => {
      const h = parseHex(field.value), v = field.value.trim().replace(/^#/, '');
      const bad = !h && (/[^0-9a-f]/i.test(v) || v.length > 6);
      field.classList.toggle('bad', bad); if (bad) field.setAttribute('aria-invalid', 'true'); else field.removeAttribute('aria-invalid');
      if (h) return show(h, { from: 'field' });
      ok.disabled = true;
      msg.className = `fine cp-msg${bad ? ' bad' : ''}`;
      msg.textContent = bad ? t('Use 6 digits, 0-9 and A-F, like #1E40AF') : '';
    });
    field.addEventListener('keydown', e => { if (e.key === 'Enter' && !ok.disabled) { e.preventDefault(); ok.click(); } });
    sheet.addEventListener('click', e => {
      const b = e.target.closest('[data-x]'); if (!b) return;
      if (b.dataset.x === 'reset') return show(parseHex(reset));
      done = true; resolve(b.dataset.x === 'yes' ? cur : null); closeSheet();
    });
  });
}
