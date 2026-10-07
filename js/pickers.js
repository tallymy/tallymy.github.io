// Dropdowns and date fields as bottom sheets. The native <select> / <input type=date> stays the source of truth: a pick sets its
// value and fires input + change, so every existing handler (data-input) runs as before. A field with data-native keeps the
// phone's own picker. The sheets are ordinary stacked sheets (js/ui.js), so phone Back closes just the picker.
import { t, langTag } from './i18n.js';
import { esc, ICON, openSheet, closeSheet } from './ui.js';
import { today } from './state.js';

const CARET = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6"/></svg>';
const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const parse = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null; };
const shift = (s, n) => { const p = parse(s), d = new Date(Date.UTC(p.y, p.m, p.d + n)); return iso(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
const fmt = (opts, y, m, d = 1) => new Intl.DateTimeFormat(langTag(), { ...opts, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m, d)));
const fire = el => { for (const type of ['input', 'change']) el.dispatchEvent(new Event(type, { bubbles: true })); };

const eligible = el => el?.matches?.('select:not([multiple]):not([disabled]):not([data-native]), input[type=date]:not([disabled]):not([readonly]):not([data-native])') && !!el.closest('#app, .sheet');
const titleOf = el => el.getAttribute('aria-label') || el.closest('label')?.querySelector(':scope > span')?.firstChild?.textContent?.trim() || '';

// ---- dropdown ------------------------------------------------------------------------------------------------------
function pickSelect(sel) {
  const items = [...sel.children].flatMap(n => n.tagName === 'OPTGROUP' ? [{ group: n.label }, ...[...n.children].map(o => ({ o }))] : [{ o: n }]);
  const title = titleOf(sel);
  const body = items.map(it => {
    if (it.group != null) return `<li class="pick-group" role="presentation">${esc(it.group)}</li>`;
    const o = it.o, on = o === sel.selectedOptions[0];
    return `<li role="presentation"><button type="button" class="pick-opt${o.value === '' ? ' blank' : ''}" role="option" aria-selected="${on}" data-i="${o.index}"${on ? ' autofocus' : ''}${o.disabled ? ' disabled' : ''}><span class="grow">${esc(o.textContent)}</span>${on ? ICON.check : ''}</button></li>`;
  }).join('');
  const el = openSheet(`${title ? `<h2 class="sh-title">${esc(title)}</h2>` : ''}<ul class="pick" role="listbox"${title ? ` aria-label="${esc(title)}"` : ''}>${body}</ul>`, { stack: true, label: title || t('Choose') });
  el.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
  el.addEventListener('click', e => {
    const b = e.target.closest('.pick-opt');
    if (!b || b.disabled) return;
    const changed = sel.selectedIndex !== +b.dataset.i;
    sel.selectedIndex = +b.dataset.i;
    closeSheet();
    if (changed) fire(sel);
  });
}

// ---- date ----------------------------------------------------------------------------------------------------------
function pickDate(inp) {
  const min = inp.min || '1900-01-01', max = inp.max || '', now = today();
  const start = parse(inp.value) || parse(now), st = { y: start.y, m: start.m, view: 'days' };
  const inRange = s => s >= min && (!max || s <= max);
  const minY = +min.slice(0, 4), maxY = max ? +max.slice(0, 4) : parse(now).y + 20;
  const title = titleOf(inp) || t('Pick a date');
  const el = openSheet(`<h2 class="sh-title">${esc(title)}</h2><div class="dp"></div>`, { stack: true, label: title });
  const cal = el.querySelector('.dp');
  const set = s => { const changed = inp.value !== s; inp.value = s; closeSheet(); if (changed) fire(inp); };
  const nav = (label, dir, ok) => `<button type="button" class="icon-btn" data-nav="${dir}" aria-label="${esc(label)}"${ok ? '' : ' disabled'}><span class="${dir < 0 ? '' : 'flip'}">${ICON.back}</span></button>`;
  const draw = focus => {
    let head, grid;
    if (st.view === 'days') {
      head = `${nav(t('Previous month'), -1, iso(st.y, st.m, 1) > min)}<button type="button" class="dp-title" data-view="months" aria-live="polite">${esc(fmt({ month: 'long', year: 'numeric' }, st.y, st.m))}<span class="dp-caret">${CARET}</span></button>${nav(t('Next month'), 1, !max || iso(st.y, st.m + 1, 1) <= max)}`;
      const lead = (new Date(Date.UTC(st.y, st.m, 1)).getUTCDay() + 6) % 7, days = new Date(Date.UTC(st.y, st.m + 1, 0)).getUTCDate();
      grid = `<div class="dp-week" aria-hidden="true">${Array.from({ length: 7 }, (_, i) => `<span>${esc(fmt({ weekday: 'narrow' }, 2024, 0, 1 + i))}</span>`).join('')}</div><div class="dp-days" role="grid">${'<span></span>'.repeat(lead)}${Array.from({ length: days }, (_, i) => {
        const s = iso(st.y, st.m, i + 1), sel = s === inp.value;
        return `<button type="button" class="dp-day${sel ? ' on' : ''}${s === now ? ' now' : ''}" data-d="${s}" aria-label="${esc(fmt({ dateStyle: 'full' }, st.y, st.m, i + 1))}"${sel ? ' aria-pressed="true"' : ''}${inRange(s) ? '' : ' disabled'}>${i + 1}</button>`;
      }).join('')}</div>`;
    } else if (st.view === 'months') {
      head = `${nav(t('Previous year'), -12, st.y > minY)}<button type="button" class="dp-title" data-view="years">${st.y}<span class="dp-caret">${CARET}</span></button>${nav(t('Next year'), 12, st.y < maxY)}`;
      grid = `<div class="dp-grid">${Array.from({ length: 12 }, (_, m) => `<button type="button" class="dp-cell${m === st.m ? ' on' : ''}" data-m="${m}"${iso(st.y, m, 28) < min || (max && iso(st.y, m, 1) > max) ? ' disabled' : ''}>${esc(fmt({ month: 'short' }, st.y, m))}</button>`).join('')}</div>`;
    } else {
      head = `<span class="grow"></span><button type="button" class="dp-title" data-view="months" aria-expanded="true">${esc(t('Pick a date'))}</button><span class="grow"></span>`;
      grid = `<div class="dp-grid years">${Array.from({ length: maxY - minY + 1 }, (_, i) => maxY - i).map(y => `<button type="button" class="dp-cell${y === st.y ? ' on' : ''}" data-y="${y}">${y}</button>`).join('')}</div>`;
    }
    const foot = `<div class="dp-foot">${inp.value && inp.hasAttribute('data-optional') ? `<button type="button" class="btn ghost small" data-clear>${esc(t('Clear'))}</button>` : '<span></span>'}${inRange(now) ? `<button type="button" class="btn ghost small" data-today>${esc(t('Today'))}</button>` : ''}</div>`;
    cal.innerHTML = `<div class="dp-head">${head}</div>${grid}${foot}`;
    const f = focus && cal.querySelector(`[data-d="${focus}"]:not([disabled])`) || cal.querySelector('.dp-day.on, .dp-cell.on, .dp-day.now, .dp-day:not([disabled]), .dp-cell:not([disabled])');
    f?.focus({ preventScroll: true });
    if (st.view === 'years') cal.querySelector('.dp-cell.on')?.scrollIntoView({ block: 'center' });
  };
  cal.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.d) return set(b.dataset.d);
    if (b.hasAttribute('data-today')) return set(now);
    if (b.hasAttribute('data-clear')) { const changed = inp.value !== ''; inp.value = ''; closeSheet(); if (changed) fire(inp); return; }
    if (b.dataset.nav) { const n = +b.dataset.nav, d = new Date(Date.UTC(st.y, st.m + n, 1)); st.y = d.getUTCFullYear(); st.m = d.getUTCMonth(); return draw(); }
    if (b.dataset.view) { st.view = b.dataset.view; return draw(); }
    if (b.dataset.y) { st.y = +b.dataset.y; st.view = 'months'; return draw(); }
    if (b.dataset.m) { st.m = +b.dataset.m; st.view = 'days'; return draw(); }
  });
  cal.addEventListener('keydown', e => {   // arrow keys walk the days; past the month's edge they turn the page
    const d = e.target.closest?.('.dp-day')?.dataset.d, step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (!d || !step) return;
    e.preventDefault();
    const to = shift(d, step);
    if (!inRange(to)) return;
    const p = parse(to); st.y = p.y; st.m = p.m; draw(to);
  });
  draw();
}

// ---- wiring --------------------------------------------------------------------------------------------------------
function open(el) { el.focus({ preventScroll: true }); (el.tagName === 'SELECT' ? pickSelect : pickDate)(el); }
if (typeof document !== 'undefined') {
  // The phone's own popup opens on press / tap; stop it there and open ours on the click.
  document.addEventListener('mousedown', e => { if (eligible(e.target)) e.preventDefault(); }, true);
  document.addEventListener('click', e => { const el = e.target; if (eligible(el)) { e.preventDefault(); open(el); } }, true);
  document.addEventListener('keydown', e => {
    const el = e.target;
    if (!eligible(el) || e.ctrlKey || e.metaKey) return;
    if (['Enter', ' ', 'F4'].includes(e.key) || (e.altKey && e.key === 'ArrowDown')) { e.preventDefault(); open(el); }
  }, true);
}
