// UI primitives: auto-escaping templates, Trusted Types sink, locale-aware
// parsing/formatting, dialogs and toasts.

// ---------- safe HTML ----------
// Every interpolation in html`` is escaped unless it is itself html`` / raw().
// XSS through user-defined names, columns or cell values is impossible by
// construction, and CSP `require-trusted-types-for 'script'` makes the browser
// reject any innerHTML write that doesn't go through setHTML below.
export class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = s => new Raw(String(s));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export const esc = s => String(s ?? '').replace(/[&<>"'`]/g, c => ESC[c]);
function part(v) {
  if (v == null || v === false || v === true) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  return esc(v);
}
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += part(vals[i]) + strings[i + 1];
  return new Raw(out);
}
// Module-private Trusted Types policy: the only way to produce TrustedHTML,
// and the only script URL it will ever vouch for is the app's own service worker.
const SW_URL = 'sw.js';
const rules = {
  createHTML: s => s,
  createScriptURL: s => { if (s !== SW_URL) throw new TypeError('Only the HQ service worker may be loaded'); return s; },
};
const policy = self.trustedTypes?.createPolicy('hq', rules) ?? rules;
// The service worker's address, in the form Trusted Types requires.
export const serviceWorkerURL = () => policy.createScriptURL(SW_URL);
// The only innerHTML sink in the app, and it accepts nothing but html``/raw()
// output - a plain string is a programming error and throws.
export function setHTML(el, content) {
  if (!(content instanceof Raw)) throw new TypeError('setHTML only accepts html`` output');
  el.innerHTML = policy.createHTML(content.s);
}

// Light / dark / match-the-device. The choice is also kept (it isn't
// sensitive) outside the vault so the lock screen matches.
export function applyTheme(theme) {
  const t = theme === 'light' || theme === 'dark' ? theme : null;
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  document.querySelectorAll('meta[name=theme-color]').forEach(m => {
    const dark = t ? t === 'dark' : (m.getAttribute('media') || '').includes('dark');
    m.setAttribute('content', dark ? '#0d0d0d' : '#f6f5f2');
  });
  try { if (t) localStorage.setItem('hq.theme', t); else localStorage.removeItem('hq.theme'); } catch { /* storage blocked */ }
}
export function storedTheme() {
  try { return localStorage.getItem('hq.theme'); } catch { return null; }
}

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : sid(32));
// Short random id (base36, ~52 bits at 10 chars). Keeps stored rows compact.
export function sid(n = 10) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (const x of b) s += (x % 36).toString(36);
  return s;
}

// Only http(s) links are ever rendered as links - blocks javascript:, data: etc.
export function safeUrl(u) {
  try {
    const url = new URL(String(u).trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

// ---------- locale ----------
export const LOCALE = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
export const DECIMAL = (1.5).toLocaleString(LOCALE).includes(',') ? ',' : '.';
// true when the user's locale writes day before month (19/09/2026)
export const DAY_FIRST = (() => {
  try {
    const parts = new Intl.DateTimeFormat(LOCALE).formatToParts(new Date(2026, 10, 22)).map(p => p.type);
    return parts.indexOf('day') < parts.indexOf('month');
  } catch {
    return false;
  }
})();

// ---------- dates (always local calendar days, never UTC) ----------
export const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const today = () => isoDate(new Date());
export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoDate(new Date(y, m - 1, d + n));
}
// Same day-of-month n months later, clamped to the month's end (Jan 31 + 1 → Feb 28).
export function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const last = new Date(y, m - 1 + n + 1, 0).getDate();
  return isoDate(new Date(y, m - 1 + n, Math.min(d, last)));
}
export function daysBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}
export function fmtDate(iso, opts = { month: 'short', day: 'numeric' }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(LOCALE, opts);
}
// Accepts 2026-09-19, 19.09.2026 and slashed dates. Slashed dates follow the
// user's locale order unless one part is > 12 and settles it. Returns ISO or null.
export function parseDate(input, dayFirst = DAY_FIRST) {
  const s = String(input ?? '').trim();
  let m, y, mo, d;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/))) [, y, mo, d] = m;
  else if ((m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/))) [, d, mo, y] = m;
  else if ((m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/))) {
    let [a, b] = [Number(m[1]), Number(m[2])];
    const df = a > 12 ? true : b > 12 ? false : dayFirst;
    [d, mo] = df ? [a, b] : [b, a];
    y = m[3];
  } else return null;
  y = Number(String(y).length === 2 ? `20${y}` : y);
  mo = Number(mo);
  d = Number(d);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return isoDate(dt);
}
export function ago(ts) {
  if (!ts) return 'never';
  const days = daysBetween(isoDate(new Date(ts)), today());
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return fmtDate(isoDate(new Date(ts)), { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---------- numbers ----------
// Tolerant of "$1,234.56", "1.234,56", "(50)", "1'234". A lone separator
// followed by exactly three digits is ambiguous and follows the user's locale.
export function parseNum(input, decimal = DECIMAL) {
  if (typeof input === 'number') return Number.isFinite(input) ? input : NaN;
  let s = String(input ?? '').trim();
  if (!s) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[\s\p{Sc}'’%]/gu, '');
  if (/[^\d.,-]/.test(s)) return NaN;
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (s.includes('-')) return NaN;
  const commas = (s.match(/,/g) || []).length;
  const dots = (s.match(/\./g) || []).length;
  const lc = s.lastIndexOf(',');
  const ld = s.lastIndexOf('.');
  if (commas && dots) s = lc > ld ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (commas) {
    const decimalComma = commas === 1 && (s.length - lc - 1 !== 3 || decimal === ',');
    s = decimalComma ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (dots) {
    const decimalDot = dots === 1 && (s.length - ld - 1 !== 3 || decimal === '.');
    if (!decimalDot) s = s.replace(/\./g, '');
  }
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return NaN;
  const n = Number(s);
  if (!Number.isFinite(n) || Math.abs(n) > 1e15) return NaN;
  return neg ? -n : n;
}
export const round2 = n => Math.round((n + Math.sign(n) * Number.EPSILON) * 100) / 100;

const fmtCache = new Map();
function nf(key, opts) {
  let f = fmtCache.get(key);
  if (!f) { f = new Intl.NumberFormat(LOCALE, opts); fmtCache.set(key, f); }
  return f;
}
export function fmtMoney(v, currency, { compact = false, sign = false } = {}) {
  const small = Math.abs(v) < 1000;
  return nf(`m|${currency}|${compact}|${sign}|${small}`, {
    style: 'currency', currency, notation: compact ? 'compact' : 'standard',
    minimumFractionDigits: compact ? 0 : 2, maximumFractionDigits: compact && !small ? 1 : compact ? 0 : 2,
    signDisplay: sign ? 'exceptZero' : 'auto',
  }).format(v);
}
export function fmtNum(v, { compact = false, sign = false } = {}) {
  const c = compact && Math.abs(v) >= 10000;
  return nf(`n|${c}|${sign}`, { notation: c ? 'compact' : 'standard', maximumFractionDigits: c ? 1 : 2, signDisplay: sign ? 'exceptZero' : 'auto' }).format(v);
}
export function fmtUnit(v, unit, currency, opts = {}) {
  if (unit === 'currency') return fmtMoney(v, currency, opts);
  if (unit === 'percent') return `${fmtNum(v, { ...opts, compact: false })}%`;
  return fmtNum(v, opts);
}
// Value to put in an <input> for editing: plain digits with the locale decimal.
export function numInput(v) {
  if (v == null || !Number.isFinite(v)) return '';
  return nf('in', { useGrouping: false, maximumFractionDigits: 6 }).format(v);
}

// ---------- icons ----------
const ICONS = {
  logo: '<rect x="4" y="12" width="4" height="8" rx="1" class="fill"/><rect x="10" y="7" width="4" height="13" rx="1" class="fill"/><rect x="16" y="3" width="4" height="17" rx="1" class="fill"/>',
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  bank: '<path d="M3 10h18M5 10v7M9.5 10v7M14.5 10v7M19 10v7M3 20h18M12 3l9 4.5H3z"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M16 15h2"/><path d="M6 6l9-3 1 3"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  bag: '<path d="M5 8h14l-1.2 12H6.2z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  repeat: '<path d="M4 12a8 8 0 0 1 13.7-5.7L20 8.5"/><path d="M20 4v4.5h-4.5"/><path d="M20 12a8 8 0 0 1-13.7 5.7L4 15.5"/><path d="M4 20v-4.5h4.5"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  heart: '<path d="M12 20s-8-4.6-8-10.2A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 2.8C20 15.4 12 20 12 20z"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  book: '<path d="M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4z"/><path d="M20 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/>',
  car: '<path d="M5 16l1.5-6h11L19 16"/><rect x="3" y="12" width="18" height="6" rx="2"/><circle cx="7.5" cy="18" r="1.5"/><circle cx="16.5" cy="18" r="1.5"/>',
  dumbbell: '<path d="M6 7v10M3 9v6M18 7v10M21 9v6M6 12h12"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  link: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v4h16v-4"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v4h16v-4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
};
export const SECTION_ICONS = ['bank', 'wallet', 'chart', 'trend', 'users', 'video', 'bag', 'receipt', 'repeat', 'shield', 'target', 'heart', 'star', 'calendar', 'book', 'briefcase', 'car', 'dumbbell', 'list', 'home'];
export const icon = (name, cls = '') => raw(`<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ICONS.grid}</svg>`);

// ---------- dialogs ----------
let openDialogs = 0;
let dialogSeq = 0;
const closedListeners = [];
// Called whenever the last open dialog closes (used to apply deferred reloads).
export const onDialogsClosed = fn => closedListeners.push(fn);

// Other editing that must not be re-rendered underneath the user (a table
// cell being edited in place) holds the UI like a dialog does. One lifecycle
// for all of them:
//   - `settle()` finishes the edit (saves a valid value, or says why not). It
//     runs before every redraw and before locking (settleHolds), so leaving
//     the page behaves exactly like leaving the field.
//   - Releasing a hold, or finding one whose editor vanished (`stillOpen()`
//     false), runs the same "closed" listeners a dialog does, so deferred
//     merges and sync results always resume.
const holds = new Map(); // stillOpen -> settle
const notifyClosedSoon = () => setTimeout(() => { if (!uiBusy()) closedListeners.forEach(fn => fn()); }, 0);
export function holdUI(stillOpen, settle = null) {
  holds.set(stillOpen, settle);
  return () => { if (holds.delete(stillOpen)) notifyClosedSoon(); };
}
export function settleHolds() {
  for (const [stillOpen, settle] of [...holds]) if (stillOpen()) settle?.();
  uiBusy(); // sweeps anything that vanished meanwhile
}
// A dialog is open or something is being edited in place.
export function uiBusy() {
  let dropped = false;
  for (const stillOpen of [...holds.keys()]) if (!stillOpen()) { holds.delete(stillOpen); dropped = true; }
  if (dropped) notifyClosedSoon();
  return openDialogs > 0 || holds.size > 0;
}

// Describe the element that opened a dialog so focus can return to its
// re-rendered twin afterwards (the DOM is rebuilt on save).
function focusKey(el) {
  if (!el || el === document.body) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const attrs = ['data-act', 'data-sec', 'data-id', 'data-v'].filter(a => el.hasAttribute(a));
  return attrs.length ? attrs.map(a => `[${a}="${CSS.escape(el.getAttribute(a))}"]`).join('') : null;
}

const active = new Set(); // dismiss functions of open dialogs
let submitGuard = () => true;
// Lets the app hold back dialog submits (e.g. while merging another window's changes).
export const setSubmitGuard = fn => { submitGuard = fn; };

// Opens a modal dialog. Always close it through the returned `dismiss()`
// (buttons, Escape and closeAllDialogs do): cleanup runs synchronously and
// doesn't depend on the native 'close' event, which browsers can delay or
// skip for documents that aren't being rendered.
export function modal({ title, body, submit = 'Save', danger = false, extra = '', onSubmit, onOpen, onClose, wide = false }) {
  const d = document.createElement('dialog');
  const tid = `dlg-${++dialogSeq}`;
  const opener = focusKey(document.activeElement);
  d.className = `modal${wide ? ' wide' : ''}`;
  d.setAttribute('aria-labelledby', tid);
  setHTML(d, html`<form class="modal-form" novalidate>
    <header><h2 id="${tid}" tabindex="-1">${title}</h2><button type="button" class="icon-btn ghost" data-close aria-label="Close">${icon('x')}</button></header>
    <div class="modal-body">${body}</div>
    <footer>${extra}<span class="spacer"></span><button type="button" class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger-fill' : 'primary'}" data-submit>${submit}</button></footer>
  </form>`);
  document.body.appendChild(d);
  openDialogs++;
  let closed = false;
  const dismiss = () => {
    if (closed) return;
    closed = true;
    active.delete(dismiss);
    if (d.open) d.close();
    d.remove();
    openDialogs--;
    onClose?.();
    if (openDialogs) return;
    // setTimeout, not rAF: rAF is paused in background tabs.
    setTimeout(() => {
      if (openDialogs) return;
      if (opener) document.querySelector(opener)?.focus({ preventScroll: true });
      if (!uiBusy()) closedListeners.forEach(fn => fn());
    }, 0);
  };
  d.dismiss = dismiss;
  active.add(dismiss);
  $$('[data-close]', d).forEach(b => b.addEventListener('click', dismiss));
  d.addEventListener('cancel', e => { e.preventDefault(); dismiss(); }); // Escape
  d.addEventListener('close', dismiss); // any other native close
  const close = dismiss;
  const form = $('form', d);
  let busy = false;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (busy || !form.reportValidity() || !submitGuard()) return;
    busy = true;
    const btn = $('[data-submit]', d);
    btn.disabled = true;
    try {
      const ok = await onSubmit(new FormData(form), d);
      if (ok !== false) close();
    } catch (err) {
      console.error(err);
      toast(err?.message || 'Something went wrong.');
    } finally {
      busy = false;
      btn.disabled = false;
    }
  });
  onOpen?.(d);
  d.showModal();
  // In privacy mode focus the heading: auto-focusing any field could reveal
  // an amount, or scroll a long form to its middle.
  const first = document.body.classList.contains('private')
    ? ($('[autofocus]:not(.amt)', d) || $(`#${tid}`, d))
    : ($('[autofocus]', d) || $('.modal-body input:not([type=checkbox]):not([type=radio]), .modal-body select, .modal-body textarea', d) || $(`#${tid}`, d));
  first.focus();
  return d;
}
export const dialogOpen = () => openDialogs > 0;
export function closeAllDialogs() {
  [...active].forEach(dismiss => dismiss());
}

export function confirmDialog({ title, body, confirm = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    let result = false;
    modal({ title, body, submit: confirm, danger, onSubmit: () => { result = true; }, onClose: () => resolve(result) });
  });
}

// ---------- toast ----------
let toastTimer;
export function toast(msg, action) {
  let t = $('#toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    document.body.appendChild(t);
  }
  setHTML(t, html`<span>${msg}</span>${action ? html`<button type="button" class="toast-btn">${action.label}</button>` : ''}`);
  if (action) $('.toast-btn', t).addEventListener('click', () => { clearToast(); action.fn(); });
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(clearToast, action ? 7000 : 3000);
}
export function clearToast() {
  clearTimeout(toastTimer);
  const t = $('#toast');
  if (t) { t.classList.remove('show'); t.replaceChildren(); }
}

export function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pickFile(accept) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files[0] || null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}
