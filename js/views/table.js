// Tables: cells, sorting, filtering, the chart, breakdown, selection and the in-place grid.
import { html, raw, setHTML, $, icon, settleHolds, today, addDays, fmtDate, fmtNum, safeUrl, LOCALE } from '../ui.js';
import * as M from '../model.js';
import * as Charts from '../charts.js';
import { S, section, money, unitFmt, amtIf, plural } from '../store.js';
import { summary, sampleBanner, rangeChips } from './common.js';

// ---------- tables ----------
export function tstate(id) {
  if (!S.tables.has(id)) S.tables.set(id, { q: '', sort: null, limit: 100, sel: new Set() });
  return S.tables.get(id);
}

// Text for a cell value. Formula columns need their section to know whether
// the result is money.
export function cellText(col, v, sec = null) {
  if (v == null || v === '') return '';
  switch (col.type) {
    case 'currency': return typeof v === 'number' ? money(v) : '';
    case 'number': return typeof v === 'number' ? fmtNum(v) : '';
    case 'formula': return typeof v !== 'number' ? '' : sec && M.formulaUnit(sec, col) === 'currency' ? money(v) : fmtNum(v);
    case 'date': return fmtDate(v, { month: 'short', day: 'numeric', year: 'numeric' });
    case 'checkbox': return v ? 'Yes' : 'No';
    case 'tags': return Array.isArray(v) ? v.join(', ') : '';
    case 'url': { const u = safeUrl(v); return u ? new URL(u).hostname : ''; }
    default: return String(v);
  }
}
const textOf = (sec, col, row) => cellText(col, M.cellValue(sec, col, row), sec);

export function dueChip(sec, col, row) {
  const due = M.dueState(sec, col, row);
  if (!due) return '';
  const label = due.kind === 'overdue' ? `${-due.days}d overdue` : due.days === 0 ? 'Today' : `In ${due.days}d`;
  return html` <span class="due ${due.kind}">${due.kind === 'overdue' ? icon('warn', 'warn-ico') : ''}${label}</span>`;
}

// In the keyboard grid (inGrid) controls inside cells leave the Tab order;
// the grid's own keys reach them (see tableedit.js cellKey).
function cellHTML(sec, col, row, inGrid = false) {
  const skip = inGrid ? raw('tabindex="-1"') : '';
  const v = M.cellValue(sec, col, row);
  switch (col.type) {
    case 'checkbox':
      return html`<input type="checkbox" id="cb-${row.id}-${col.id}" ${skip} data-change="toggleCell" data-sec="${sec.id}" data-row="${row.id}" data-col="${col.id}" ${v ? raw('checked') : ''} aria-label="${col.name}">`;
    case 'url': {
      const u = v && safeUrl(v);
      return u ? html`<a href="${u}" ${skip} target="_blank" rel="noopener noreferrer">${new URL(u).hostname}</a>` : '';
    }
    case 'currency':
      return v == null ? '' : html`<span class="amt">${cellText(col, v)}</span>`;
    case 'formula':
      return v == null ? '' : amtIf(cellText(col, v, sec), M.formulaUnit(sec, col) === 'currency');
    case 'date':
      return html`${cellText(col, v)}${dueChip(sec, col, row)}`;
    case 'tags':
      return Array.isArray(v) ? html`<span class="tags">${v.map(t => html`<span class="tag">${t}</span>`)}</span>` : '';
    case 'longtext':
      return html`<span class="clamp">${v || ''}</span>`;
    default:
      return cellText(col, v);
  }
}

export function visibleRows(sec) {
  const st = tstate(sec.id);
  const sort = st.sort || M.defaultSort(sec);
  return { rows: M.sortRows(sec, M.filterRows(sec, sec.rows, st.q, (c, v) => cellText(c, v, sec)), sort), sort };
}

export function rowLabel(sec, r) {
  for (const c of sec.table.columns) {
    const t = c.type === 'checkbox' ? '' : textOf(sec, c, r);
    if (t) return t;
  }
  return 'row';
}

// Rows ticked for bulk actions; ids of rows that no longer exist drop out.
export function selectedRows(sec) {
  const st = tstate(sec.id);
  const ids = new Set(sec.rows.map(r => r.id));
  for (const id of st.sel) if (!ids.has(id)) st.sel.delete(id);
  return sec.rows.filter(r => st.sel.has(r.id));
}

function bulkBar(sec, n) {
  return html`<div class="bulk-bar" role="region" aria-label="Selected rows">
    <strong>${plural(n, 'row')} selected</strong>
    <button type="button" class="btn small" data-act="bulkSet" data-sec="${sec.id}">Set a column…</button>
    <button type="button" class="btn small" data-act="bulkExport" data-sec="${sec.id}">${icon('download')} Export</button>
    <button type="button" class="btn small danger" data-act="bulkDelete" data-sec="${sec.id}">${icon('trash')} Delete</button>
    <button type="button" class="btn small ghost" data-act="bulkClear" data-sec="${sec.id}">Clear</button>
  </div>`;
}

function tableHTML(sec) {
  const st = tstate(sec.id);
  const cols = sec.table.columns;
  if (!cols.length) return html`<p class="muted pad">This table has no columns yet. Add some in section settings.</p>`;
  const { rows, sort } = visibleRows(sec);
  const shown = rows.slice(0, st.limit);
  const nSel = selectedRows(sec).length;
  const allShown = shown.length > 0 && shown.every(r => st.sel.has(r.id));
  const leadable = new Set(['text', 'longtext', 'select', 'date']);
  // On a computer the cells form a grid: one Tab stop, arrow keys to move,
  // Enter or F2 to edit (see tableedit.js).
  const grid = inlineEditing() && shown.length > 0;
  const cellId = (r, c) => `cell-${r.id}-${c.id}`;
  // Every body cell is part of the grid (select, data, edit), so arrows reach
  // them all and the whole grid is a single Tab stop.
  const gridIds = r => [`gsel-${r.id}`, ...cols.map(c => cellId(r, c)), `gedit-${r.id}`];
  const home = grid && (shown.some(r => gridIds(r).includes(st.focusCell)) ? st.focusCell : cellId(shown[0], cols[0]));
  const gcell = id => (grid ? html`id="${id}" role="gridcell" data-grid tabindex="${id === home ? 0 : -1}"` : '');
  // Marked up as an ARIA grid so screen readers hand the arrow keys to it;
  // only the rows on screen are in the DOM, so the full counts are given.
  const R = attrs => (grid ? raw(attrs) : '');
  // How each kind of cell is used from the keyboard (announced via aria-describedby).
  const hint = c => (c.type === 'checkbox' ? 'toggle' : c.type === 'url' ? 'link' : INLINE.has(c.type) ? 'edit' : null);
  return html`
    ${nSel ? bulkBar(sec, nSel) : ''}
    <div class="scroll">
      <table class="data" ${grid ? html`role="grid" aria-rowcount="${rows.length + 1}" aria-colcount="${cols.length + 2}"` : ''}>
        <caption class="sr-only">${sec.name}${st.q ? `, filtered by “${st.q}”` : ''}. Use the edit button at the end of a row to change it${grid ? '. Or move between cells with the arrow keys and press Enter to edit one in place' : ''}.</caption>
        <thead><tr ${R('role="row" aria-rowindex="1"')}><th scope="col" ${R('role="columnheader"')} class="t-sel"><input type="checkbox" id="selall-${sec.id}" data-change="selAll" data-sec="${sec.id}" ${allShown ? raw('checked') : ''} aria-label="Select all ${plural(shown.length, 'shown row')}"></th>${cols.map(c => {
          const on = sort?.col === c.id;
          return html`<th scope="col" ${R('role="columnheader"')} class="${M.NUMERIC.has(c.type) ? 'r' : ''}" aria-sort="${on ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="th-btn" data-act="sort" data-sec="${sec.id}" data-col="${c.id}">${c.name}${on ? icon(sort.dir > 0 ? 'up' : 'down', 'sort-ico') : ''}</button></th>`;
        })}<th scope="col" ${R('role="columnheader"')} class="t-edit"><span class="sr-only">Edit</span></th></tr></thead>
        <tbody>${shown.map((r, ri) => html`<tr ${grid ? html`role="row" aria-rowindex="${ri + 2}"` : ''} data-act="editRow" data-sec="${sec.id}" data-id="${r.id}" class="${st.sel.has(r.id) ? 'selected' : ''}"><td ${gcell(`gsel-${r.id}`)} class="t-sel"><input type="checkbox" id="sel-${r.id}" ${R('tabindex="-1"')} data-change="selRow" data-sec="${sec.id}" data-row="${r.id}" ${st.sel.has(r.id) ? raw('checked') : ''} aria-label="Select ${rowLabel(sec, r)}"></td>${cols.map((c, i) => html`<td id="${cellId(r, c)}" ${grid ? html`role="gridcell" data-grid tabindex="${cellId(r, c) === home ? 0 : -1}" ${hint(c) ? html`aria-describedby="${hint(c)}-hint-${sec.id}"` : raw('aria-readonly="true"')}` : ''} data-label="${c.name}" data-act="cellEdit" data-sec="${sec.id}" data-row="${r.id}" data-col="${c.id}" class="${M.NUMERIC.has(c.type) ? 'r num ' : ''}t-${c.type}${i === 0 && leadable.has(c.type) ? ' lead' : ''}${INLINE.has(c.type) ? ' editable' : ''}">${cellHTML(sec, c, r, grid)}</td>`)}<td ${gcell(`gedit-${r.id}`)} class="t-edit"><button type="button" ${R('tabindex="-1"')} class="icon-btn ghost sm" data-act="editRow" data-sec="${sec.id}" data-id="${r.id}" aria-label="Edit ${rowLabel(sec, r)}">${icon('edit')}</button></td></tr>`)}</tbody>
      </table>
      ${grid ? html`<span id="edit-hint-${sec.id}" class="sr-only">Press Enter to edit</span><span id="toggle-hint-${sec.id}" class="sr-only">Press Space to check or uncheck</span><span id="link-hint-${sec.id}" class="sr-only">Press Enter to open the link, F2 to edit</span>` : ''}
    </div>
    ${!rows.length ? html`<p class="muted pad">${st.q ? 'No rows match your filter.' : 'No rows yet.'}</p>` : ''}
    ${rows.length > shown.length ? html`<div class="pad"><button type="button" class="btn" data-act="more" data-sec="${sec.id}">Show ${Math.min(500, rows.length - shown.length)} more (${(rows.length - shown.length).toLocaleString(LOCALE)} hidden)</button></div>` : ''}`;
}

// Cells that can be edited in place (desktop, with a mouse). Everything else,
// and every cell on touch screens, uses the row editor.
export const INLINE = new Set(['text', 'number', 'currency', 'date', 'select', 'url']);
export const inlineEditing = () => matchMedia('(min-width: 701px) and (pointer: fine)').matches;

function sortOptions(sec) {
  const s = tstate(sec.id).sort || M.defaultSort(sec);
  const words = t => (M.NUMERIC.has(t) ? ['low → high', 'high → low'] : t === 'date' ? ['oldest first', 'newest first'] : t === 'checkbox' ? ['unchecked first', 'checked first'] : ['A → Z', 'Z → A']);
  return html`${!s ? html`<option value="" selected>Order added</option>` : ''}${sec.table.columns.map(c => {
    const [a, b] = words(c.type);
    return html`<option value="${c.id}:1" ${s?.col === c.id && s.dir === 1 ? raw('selected') : ''}>${c.name}: ${a}</option><option value="${c.id}:-1" ${s?.col === c.id && s.dir === -1 ? raw('selected') : ''}>${c.name}: ${b}</option>`;
  })}`;
}

// The table's chart: any number, money or formula column over a date column,
// for the chosen range. Choices are per table and kept while HQ is open.
function tableChart(sec) {
  const cols = sec.table.columns;
  const nums = cols.filter(c => M.NUMERIC.has(c.type));
  const dates = cols.filter(c => c.type === 'date');
  if (!nums.length || !dates.length || !sec.rows.length) return null;
  const st = tstate(sec.id);
  const h = sec.table.headline;
  const colId = nums.some(c => c.id === st.chartCol) ? st.chartCol : nums.some(c => c.id === h.column) ? h.column : nums[0].id;
  const dateId = dates.some(c => c.id === st.chartDate) ? st.chartDate : dates.some(c => c.id === h.dateColumn) ? h.dateColumn : dates[0].id;
  const from = S.range ? addDays(today(), -(S.range - 1)) : null;
  // Narrow screens get fewer, wider bars (weekly beyond ~6 weeks).
  const { bucket, series } = M.columnSeries(sec, colId, dateId, { from, maxBars: innerWidth < 600 ? 42 : 120 });
  const col = M.colById(sec, colId);
  return { nums, dates, colId, dateId, bucket, series, col, unit: M.formulaUnit(sec, col) };
}

function chartControls(sec, ch) {
  const sel = (key, label, list, cur) => html`<label class="chart-pick"><span class="sr-only">${label}</span><select id="${key}-${sec.id}" data-change="tableChart" data-key="${key}" data-sec="${sec.id}">${list.map(c => html`<option value="${c.id}" ${c.id === cur ? raw('selected') : ''}>${c.name}</option>`)}</select></label>`;
  return html`<div class="chart-controls">
    ${ch.nums.length > 1 ? sel('chartCol', 'Chart column', ch.nums, ch.colId) : html`<span class="small muted">${ch.col.name}</span>`}
    ${ch.dates.length > 1 ? html`<span class="small muted">by</span>${sel('chartDate', 'Date column', ch.dates, ch.dateId)}` : ''}
    <span class="small muted">per ${ch.bucket}</span>
    ${rangeChips()}
  </div>`;
}

export function tableBody(sec) {
  const sm = summary(sec);
  const st = tstate(sec.id);
  const ch = tableChart(sec);
  if (ch?.series.length) {
    S.mounts.push(() => {
      const el = $('#sec-chart');
      if (el) Charts.columns(el, ch.series, { color: sec.color, bucket: ch.bucket, sensitive: ch.unit === 'currency', label: `${ch.col.name} per ${ch.bucket}`, fmtAxis: v => unitFmt(v, ch.unit, { compact: true }), fmtValue: p => unitFmt(p.value, ch.unit) });
    });
  }
  return html`
    ${sec.sample ? sampleBanner() : ''}
    <section class="card hero">
      <div class="hero-head">
        <div><h2 class="label">${sm.label}</h2><p class="hero-value">${sm.empty ? '—' : sm.value}</p>${sm.delta || ''}${sm.progress || ''}</div>
        <div class="hero-side"><div class="btn-row">
          <button type="button" class="btn" data-act="importCSV" data-sec="${sec.id}">${icon('upload')} Import</button>
          <button type="button" class="btn" data-act="exportCSV" data-sec="${sec.id}" ${sec.rows.length ? '' : raw('disabled')}>${icon('download')} Export</button>
          <button type="button" class="btn primary" data-act="addRow" data-sec="${sec.id}">${icon('plus')} Add row</button>
        </div></div>
      </div>
      ${ch ? html`<h2 class="sr-only">Trend: ${ch.col.name} per ${ch.bucket}</h2>${chartControls(sec, ch)}${ch.series.length ? html`<div id="sec-chart" class="chart"></div>` : html`<p class="muted small pad-y">No ${ch.col.name.toLowerCase()} in this period.</p>`}` : ''}
    </section>
    ${breakdownCard(sec)}
    <section class="card flush" aria-labelledby="rows-h-${sec.id}">
      <h2 id="rows-h-${sec.id}" class="sr-only">Rows</h2>
      <div class="table-tools">
        <label class="search-box">${icon('search')}<span class="sr-only">Filter rows</span><input id="tq-${sec.id}" type="search" placeholder="Filter ${plural(sec.rows.length, 'row')}" value="${st.q}" data-input="filter" data-sec="${sec.id}" autocomplete="off"></label>
        ${sec.table.columns.length ? html`<label class="sort-box"><span class="sr-only">Sort by</span><select id="ts-${sec.id}" data-change="sortSelect" data-sec="${sec.id}">${sortOptions(sec)}</select></label>` : ''}
      </div>
      <div id="tbl-${sec.id}">${tableHTML(sec)}</div>
    </section>`;
}

// "By category" totals, as a ranked list with proportional bars.
function breakdownCard(sec) {
  const b = M.tableBreakdown(sec);
  if (!b || !b.groups.length) return '';
  const top = Math.max(...b.groups.map(g => Math.abs(g.value)), 1);
  const money$ = b.unit === 'currency';
  return html`<section class="card" aria-labelledby="bd-${sec.id}">
    <div class="card-head"><h2 id="bd-${sec.id}">${b.measure} by ${b.by.toLowerCase()}</h2><span class="muted small">${b.period || 'All rows'}</span></div>
    <ul class="bars" role="list">${b.groups.map(g => html`<li>
      <span class="bar-label">${g.key}<span class="muted small"> · ${plural(g.count, 'row')}</span></span>
      <span class="bar-track c-${sec.color}"><progress max="${top}" value="${Math.abs(g.value)}" aria-label="${g.key}"></progress></span>
      <span class="bar-val num">${amtIf(unitFmt(g.value, b.unit), money$)}${b.total ? html` <span class="muted small">${Math.round((g.value / b.total) * 100)}%</span>` : ''}</span>
    </li>`)}</ul>
  </section>`;
}

export function refreshTable(sec) {
  settleHolds();
  const el = document.getElementById(`tbl-${sec.id}`);
  if (el) setHTML(el, tableHTML(sec));
  const sel = document.getElementById(`ts-${sec.id}`);
  if (sel) setHTML(sel, sortOptions(sec));
}
