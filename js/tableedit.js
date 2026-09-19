// Table editing without the row dialog: edit a cell in place (desktop, with
// a mouse), and act on several ticked rows at once (set a column, export,
// delete). Keyboard and touch users get the same results through the row
// editor and the row checkboxes.
import { html, setHTML, holdUI, modal, confirmDialog, toast, download, today, numInput } from './ui.js';
import * as M from './model.js';
import { toCSV } from './csv.js';
import { S, section, plural } from './store.js';
import { commit } from './persist.js';
import { tstate, refreshTable, selectedRows, INLINE, inlineEditing } from './views.js';
import { rowModal, fieldError } from './forms.js';

// ---------- inline cell editing ----------
function editorFor(col, v, id) {
  switch (col.type) {
    case 'date': return html`<input id="${id}" class="cell-input" type="date" value="${v || ''}" aria-label="${col.name}">`;
    case 'number': case 'currency': return html`<input id="${id}" class="cell-input r${col.type === 'currency' ? ' amt' : ''}" inputmode="decimal" autocomplete="off" value="${typeof v === 'number' ? numInput(v) : ''}" aria-label="${col.name}">`;
    case 'select': return html`<input id="${id}" class="cell-input" list="${id}-dl" autocomplete="off" value="${v || ''}" aria-label="${col.name}"><datalist id="${id}-dl">${col.options.map(o => html`<option value="${o}"></option>`)}</datalist>`;
    case 'url': return html`<input id="${id}" class="cell-input" inputmode="url" autocapitalize="off" spellcheck="false" value="${v || ''}" aria-label="${col.name}">`;
    default: return html`<input id="${id}" class="cell-input" maxlength="500" value="${v ?? ''}" aria-label="${col.name}">`;
  }
}

// Keyboard grid over the table's cells (desktop): arrows, Home/End and
// PageUp/PageDown move across every cell, including the select and edit
// columns. Enter or F2 edits a data cell, Space (or Enter) ticks the select
// cell, Enter on the edit cell opens the row editor. One Tab stop per grid.
export function cellKey(e, td) {
  const row = td.parentElement;
  const cells = tr => [...tr.querySelectorAll('td[data-grid]')];
  const control = td.querySelector(':scope > input[type=checkbox], :scope > button');
  if (!td.matches('[data-act=cellEdit]') && control && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    tstate(td.dataset.sec || row.dataset.sec).focusCell = td.id;
    control.click();
    return;
  }
  // Data cells holding a control: Space/Enter toggles a checkbox cell; Enter
  // opens a link cell's link (F2 edits it, as in a spreadsheet).
  if (td.matches('[data-act=cellEdit]')) {
    const box = td.querySelector('input[type=checkbox]');
    const link = td.querySelector('a[href]');
    if (box && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); tstate(td.dataset.sec).focusCell = td.id; box.click(); return; }
    if (link && e.key === 'Enter') { e.preventDefault(); link.click(); return; }
  }
  const at = cells(row).indexOf(td);
  const rows = [...row.parentElement.children];
  const ri = rows.indexOf(row);
  const inRow = (tr, i) => { const c = cells(tr); return c[Math.max(0, Math.min(c.length - 1, i))]; };
  let next = null;
  switch (e.key) {
    case 'ArrowRight': next = cells(row)[at + 1]; break;
    case 'ArrowLeft': next = cells(row)[at - 1]; break;
    case 'ArrowDown': next = rows[ri + 1] && inRow(rows[ri + 1], at); break;
    case 'ArrowUp': next = rows[ri - 1] && inRow(rows[ri - 1], at); break;
    case 'Home': next = e.ctrlKey ? inRow(rows[0], 0) : cells(row)[0]; break;
    case 'End': next = e.ctrlKey ? inRow(rows.at(-1), Infinity) : cells(row).at(-1); break;
    case 'PageDown': next = inRow(rows[Math.min(rows.length - 1, ri + 10)], at); break;
    case 'PageUp': next = inRow(rows[Math.max(0, ri - 10)], at); break;
    case 'Enter': case 'F2': e.preventDefault(); cellEdit(td, true); return;
    default: return;
  }
  e.preventDefault();
  if (next) moveTo(next);
}

function moveTo(td) {
  const table = td.closest('table');
  table.querySelectorAll('td[tabindex="0"]').forEach(c => c.setAttribute('tabindex', '-1'));
  td.setAttribute('tabindex', '0');
  tstate(td.dataset.sec || td.closest('tr').dataset.sec).focusCell = td.id;
  td.focus();
}
const refocus = id => setTimeout(() => { const el = document.getElementById(id); if (el) moveTo(el); }, 0);

export function cellEdit(td, fromKeyboard = false) {
  const sec = section(td.dataset.sec);
  const row = sec?.rows.find(r => r.id === td.dataset.row);
  const col = sec && M.colById(sec, td.dataset.col);
  if (!row || !col) return;
  if (td.id) tstate(sec.id).focusCell = td.id;
  if (!INLINE.has(col.type) || !inlineEditing()) { rowModal(sec, row); return; }
  if (td.querySelector('.cell-input')) return;
  const cellElId = td.id;
  const id = `ce-${row.id}-${col.id}`;
  setHTML(td, editorFor(col, row.v[col.id], id));
  const input = td.querySelector('input');
  input.focus();
  if (input.type !== 'date') input.select();
  // While the editor is open, merges from other windows and sync results
  // wait, exactly as they do for an open dialog. Leaving the field, leaving
  // the page, or locking all end the edit the same way (`leave`).
  const release = holdUI(() => input.isConnected, () => leave());
  let done = false;
  const finish = save => {
    if (done) return;
    if (save) {
      const res = M.coerce(col, input.value);
      if (!res.ok) {
        input.setCustomValidity(col.type === 'date' ? 'Enter a valid date.' : col.type === 'url' ? 'Enter a web address like example.com' : 'Enter a number, e.g. 1250.50');
        input.reportValidity();
        input.addEventListener('input', () => input.setCustomValidity(''), { once: true });
        return false;
      }
      done = true;
      release();
      const before = row.v[col.id] ?? null;
      if (res.value === before) { refreshTable(sec); return true; }
      row.v = { ...row.v, [col.id]: res.value };
      if (col.type === 'select' && res.value && !col.options.includes(res.value) && col.options.length < 100) col.options.push(res.value);
      M.touch(row);
      commit('Saved.', () => { row.v = { ...row.v, [col.id]: before }; M.touch(row); commit('Restored.', null, sec); }, sec);
      return true;
    }
    done = true;
    release();
    refreshTable(sec);
    return true;
  };
  // Enter and Escape return focus to the cell, so keyboard editing flows on.
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (finish(true) && cellElId) refocus(cellElId); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); if (cellElId) refocus(cellElId); }
  });
  // Leaving saves a valid value; an invalid one is dropped (and said so)
  // rather than trapping focus.
  function leave() {
    if (done) return;
    if (finish(true) === false) { toast(`${col.name} not saved: ${input.validationMessage}`); finish(false); }
  }
  input.addEventListener('blur', leave);
}

// ---------- selection ----------
export function selRow(el) {
  const sec = section(el.dataset.sec);
  const st = tstate(sec.id);
  if (el.checked) st.sel.add(el.dataset.row); else st.sel.delete(el.dataset.row);
  refreshTable(sec);
  // In the keyboard grid focus returns to the select cell, otherwise to the box.
  const cellEl = document.getElementById(`gsel-${el.dataset.row}`);
  if (cellEl) moveTo(cellEl); else document.getElementById(`sel-${el.dataset.row}`)?.focus();
}

export function selAll(el) {
  const sec = section(el.dataset.sec);
  const st = tstate(sec.id);
  const shown = [...document.querySelectorAll(`#tbl-${CSS.escape(sec.id)} [data-change=selRow]`)].map(x => x.dataset.row);
  for (const id of shown) if (el.checked) st.sel.add(id); else st.sel.delete(id);
  refreshTable(sec);
  document.getElementById(`selall-${sec.id}`)?.focus();
}

export function bulkClear(el) {
  const sec = section(el.dataset.sec);
  tstate(sec.id).sel.clear();
  refreshTable(sec);
  document.getElementById(`selall-${sec.id}`)?.focus();
}

// ---------- bulk actions ----------
export async function bulkDelete(el) {
  const sec = section(el.dataset.sec);
  const rows = selectedRows(sec);
  if (!rows.length) return;
  const ok = await confirmDialog({ title: `Delete ${plural(rows.length, 'row')}?`, body: html`<p>You can undo this right after.</p>`, confirm: 'Delete', danger: true });
  if (!ok || !S.session) return;
  const gone = new Set(rows.map(r => r.id));
  const before = sec.rows.slice();
  sec.rows = sec.rows.filter(r => !gone.has(r.id));
  for (const r of rows) M.logDeletion(S.data, 'row', r.id, sec.id);
  tstate(sec.id).sel.clear();
  commit(`Deleted ${plural(rows.length, 'row')}.`, () => {
    const alive = new Set(sec.rows.map(r => r.id));
    sec.rows = before.filter(r => gone.has(r.id) || alive.has(r.id));
    for (const r of rows) M.unlogDeletion(S.data, r.id);
    commit('Restored.', null, sec);
  }, sec);
}

export function bulkExport(el) {
  const sec = section(el.dataset.sec);
  const rows = selectedRows(sec);
  const { header, rows: cells } = M.exportTable(sec, tstate(sec.id).sort, rows);
  download(`${sec.name.replace(/[^\w\- ]+/g, '').trim() || 'export'}-selected-${today()}.csv`, toCSV(header, cells), 'text/csv;charset=utf-8');
  toast(`Exported ${plural(rows.length, 'row')}. The CSV file is not encrypted.`);
}

const setField = col => {
  switch (col.type) {
    case 'checkbox': return html`<label>Value<select name="value"><option value="yes">Checked</option><option value="">Not checked</option></select></label>`;
    case 'date': return html`<label>Value<input name="value" type="date"></label>`;
    case 'number': case 'currency': return html`<label>Value <span class="muted">(leave empty to clear)</span><input name="value" inputmode="decimal" autocomplete="off" class="${col.type === 'currency' ? 'amt' : ''}"></label>`;
    case 'select': return html`<label>Value <span class="muted">(leave empty to clear)</span><input name="value" list="bulk-dl" autocomplete="off"><datalist id="bulk-dl">${col.options.map(o => html`<option value="${o}"></option>`)}</datalist></label>`;
    case 'tags': return html`<label>Tags <span class="muted">(comma separated; replaces the row's tags, empty clears)</span><input name="value" autocomplete="off"></label>`;
    default: return html`<label>Value <span class="muted">(leave empty to clear)</span><input name="value" autocomplete="off" maxlength="${col.type === 'longtext' ? 5000 : 500}"></label>`;
  }
};

export function bulkSet(el) {
  const sec = section(el.dataset.sec);
  const rows = selectedRows(sec);
  const cols = sec.table.columns.filter(c => c.type !== 'formula');
  if (!rows.length || !cols.length) return;
  let col = cols[0];
  modal({
    title: `Set a column for ${plural(rows.length, 'row')}`,
    submit: 'Apply',
    body: html`
      <label>Column<select name="col" data-bulk-col>${cols.map(c => html`<option value="${c.id}">${c.name}</option>`)}</select></label>
      <div data-bulk-field>${setField(col)}</div>`,
    onOpen: d => d.querySelector('[data-bulk-col]').addEventListener('change', e => {
      col = M.colById(sec, e.target.value);
      setHTML(d.querySelector('[data-bulk-field]'), setField(col));
    }),
    onSubmit: (f, d) => {
      const res = M.coerce(col, col.type === 'checkbox' ? !!f.get('value') : f.get('value'));
      if (!res.ok) return fieldError(d.querySelector('form'), 'value', col.type === 'date' ? 'Enter a valid date.' : col.type === 'url' ? 'Enter a web address like example.com' : 'Enter a number, e.g. 1250.50');
      const live = new Set(sec.rows.map(r => r.id));
      const targets = rows.filter(r => live.has(r.id));
      const before = targets.map(r => [r, r.v[col.id] ?? null]);
      for (const r of targets) { r.v = { ...r.v, [col.id]: res.value }; M.touch(r); }
      if (M.CHOICES.has(col.type)) for (const o of [].concat(res.value ?? [])) if (!col.options.includes(o) && col.options.length < 100) col.options.push(o);
      commit(`Updated ${col.name} in ${plural(targets.length, 'row')}.`, () => {
        for (const [r, v] of before) { r.v = { ...r.v, [col.id]: v }; M.touch(r); }
        commit('Restored.', null, sec);
      }, sec);
    },
  });
}
