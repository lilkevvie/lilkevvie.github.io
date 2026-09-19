// Search across every section, item and row.
import { html, icon } from '../ui.js';
import * as M from '../model.js';
import { S, section, money, unitFmt, amtIf } from '../store.js';
import { cellText, rowLabel } from './table.js';

// ---------- search ----------
export function viewSearch(q) {
  const needle = q.trim().toLowerCase();
  const results = [];
  if (needle) {
    for (const s of S.data.sections) {
      if (s.name.toLowerCase().includes(needle)) results.push({ s, title: s.name, sub: 'Section' });
      if (s.type === 'tracker') {
        for (const it of s.items) if (`${it.name} ${it.note}`.toLowerCase().includes(needle)) results.push({ s, title: it.name, sub: `${s.name} · ${unitFmt(it.value, s.tracker.unit)}`, money: s.tracker.unit === 'currency', act: 'editItem', id: it.id });
      } else {
        const hits = M.filterRows(s, s.rows, needle, (c, v) => cellText(c, v, s));
        for (const r of hits.slice(0, 20)) {
          const text = s.table.columns.map(c => textOf(s, c, r)).filter(Boolean);
          results.push({ s, title: rowLabel(s, r), sub: `${s.name} · ${text.slice(0, 4).join(' · ')}`, money: s.table.columns.some(c => c.type === 'currency'), act: 'editRow', id: r.id });
        }
        if (hits.length > 20) results.push({ s, title: `${hits.length - 20} more in ${s.name}`, sub: 'Open the section to see them all', q });
      }
    }
  }
  return {
    title: 'Search',
    body: html`
      <form class="card search-card" role="search" data-submit="search">
        <label class="search-box big">${icon('search')}<span class="sr-only">Search everything</span><input id="main-q" name="q" type="search" value="${q}" placeholder="Search sections, items and rows" autocomplete="off" data-input="liveSearch"></label>
      </form>
      <div aria-live="polite">${needle ? html`<ul class="card rows" role="list">${results.length ? results.map(x => html`<li>
        <button type="button" class="row" data-act="${x.act || 'openSection'}" data-sec="${x.s.id}" data-id="${x.id || ''}" data-q="${x.q || ''}">
          <span class="badge sm c-${x.s.color}">${icon(x.s.icon)}</span>
          <span class="row-main"><span class="row-title">${x.title}</span><span class="row-sub">${amtIf(x.sub, x.money)}</span></span>${icon('chevron', 'chev')}
        </button></li>`) : html`<li class="pad muted">Nothing matches “${q}”.</li>`}</ul>` : html`<p class="muted pad">Search across every section, item and row.</p>`}</div>`,
  };
}
