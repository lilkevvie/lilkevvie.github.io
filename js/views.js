// Rendering: routing and the app shell. Pure output from S.data - all
// mutations live in forms.js / app.js. Pages live in ./views/ by area and
// the helpers other modules use are re-exported here:
//   common.js    summaries, deltas, range chips, sample banner, section links
//   home.js      Home and the sections list
//   section.js   a section's page (header, tracker items)
//   table.js     tables: cells, sorting, filtering, chart, selection, grid
//   search.js    search
//   settings.js  settings, including connections
import { html, raw, setHTML, $, icon, dialogOpen, settleHolds, applyTheme } from './ui.js';
import { S, section, saveLabel } from './store.js';
import { secHref } from './views/common.js';
import { viewHome, viewSections } from './views/home.js';
import { viewSection } from './views/section.js';
import { viewSearch } from './views/search.js';
import { viewSettings } from './views/settings.js';

export { secHref, deltaHTML, summary } from './views/common.js';
export { tstate, cellText, visibleRows, rowLabel, selectedRows, INLINE, inlineEditing, refreshTable } from './views/table.js';
export { connStatus } from './views/settings.js';

// ---------- routing ----------
export function route() {
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const parts = path.split('/').filter(Boolean);
  let id = null;
  try { id = parts[1] ? decodeURIComponent(parts[1]) : null; } catch { return { name: 'missing' }; }
  let q = '';
  try { q = new URLSearchParams(qs || '').get('q') || ''; } catch { /* malformed */ }
  return { name: parts[0] || 'home', id, q };
}
export function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}
window.addEventListener('hashchange', () => {
  if (S.screen !== 'app') return;
  render();
  window.scrollTo(0, 0);
  if (!dialogOpen()) $('#main')?.focus({ preventScroll: true });
});

// ---------- shell ----------
const app = $('#app');

export function render() {
  if (S.screen !== 'app') return;
  settleHolds(); // an edit in progress is finished (saved if valid) before the page is redrawn
  const active = document.activeElement;
  const focusId = active && app.contains(active) ? active.id : null;
  const sel = focusId && typeof active.selectionStart === 'number' ? active.selectionStart : null;
  S.mounts = [];
  const r = route();
  let page;
  if (r.name === 'home') page = viewHome();
  else if (r.name === 's' && section(r.id)) page = viewSection(section(r.id));
  else if (r.name === 'sections') page = viewSections();
  else if (r.name === 'search') page = viewSearch(r.q);
  else if (r.name === 'settings') page = viewSettings();
  else page = { title: 'Not found', body: html`<section class="card empty"><h2>That page doesn't exist</h2><p class="muted">It may have been deleted.</p><a class="btn primary" href="#/">Go home</a></section>` };

  const navItem = (href, ic, label, on) => html`<a class="nav-item ${on ? 'on' : ''}" href="${href}" ${on ? raw('aria-current="page"') : ''}>${ic}<span>${label}</span></a>`;
  const priv = S.data.settings.privacy;

  app.className = 'shell';
  setHTML(app, html`
    <a class="skip" href="#main">Skip to content</a>
    <aside class="side" aria-label="Sidebar">
      <a class="brand" href="#/"><span class="brand-mark">${icon('logo')}</span><span>HQ</span></a>
      <form class="side-search" role="search" data-submit="search"><label class="sr-only" for="side-q">Search</label>${icon('search')}<input id="side-q" name="q" type="search" placeholder="Search" autocomplete="off" value="${r.name === 'search' ? r.q : ''}"><kbd aria-hidden="true">/</kbd></form>
      <nav aria-label="Sections">
        ${navItem('#/', icon('home'), 'Home', r.name === 'home')}
        <p class="nav-label">Sections</p>
        ${S.data.sections.map(s => navItem(secHref(s), html`<span class="badge sm c-${s.color}">${icon(s.icon)}</span>`, s.name, r.name === 's' && r.id === s.id))}
        <button type="button" class="nav-item add" data-act="newSection">${icon('plus')}<span>New section</span></button>
      </nav>
      <nav class="side-bottom" aria-label="Settings">${navItem('#/settings', icon('settings'), 'Settings', r.name === 'settings')}</nav>
    </aside>
    <div class="main-col">
      <header class="top">
        ${r.name === 's' ? html`<a class="icon-btn ghost back" href="#/sections" aria-label="All sections">${icon('back')}</a>` : ''}
        <h1 class="page-title">${page.title}</h1>
        <span id="save-state" class="save-state" data-state="${S.saveState}">${saveLabel(S.saveState)}</span>
        <div class="top-actions">
          ${page.actions || ''}
          <button type="button" class="btn primary desk-only" data-act="quickAdd" title="Add data (N)">${icon('plus')}<span>Add</span></button>
          <button type="button" class="icon-btn" data-act="privacy" aria-pressed="${priv}" aria-label="Hide amounts" title="${priv ? 'Show amounts' : 'Hide amounts'}">${icon(priv ? 'eyeoff' : 'eye')}</button>
          <button type="button" class="icon-btn" data-act="lock" aria-label="Lock" title="Lock">${icon('lock')}</button>
        </div>
      </header>
      <main id="main" tabindex="-1">${page.body}</main>
    </div>
    <nav class="bottom" aria-label="Main">
      ${navItem('#/', icon('home'), 'Home', r.name === 'home')}
      ${navItem('#/sections', icon('grid'), 'Sections', r.name === 'sections' || r.name === 's')}
      <button type="button" class="nav-item fab" data-act="quickAdd" aria-label="Add data">${icon('plus')}</button>
      ${navItem('#/search', icon('search'), 'Search', r.name === 'search')}
      ${navItem('#/settings', icon('settings'), 'Settings', r.name === 'settings')}
    </nav>`);

  document.title = page.title === 'Home' ? 'HQ' : `${page.title} · HQ`;
  document.body.classList.toggle('private', priv);
  applyTheme(S.data.settings.theme);
  S.mounts.forEach(fn => fn());
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus({ preventScroll: true });
      if (sel != null) try { el.setSelectionRange(sel, sel); } catch { /* not a text input */ }
    }
  }
}

let resizeTimer;
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastWidth) return; // ignore mobile URL-bar height changes
  lastWidth = window.innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => S.screen === 'app' && S.mounts.forEach(fn => fn()), 150);
});

