// Entering data: tracker items, table rows, the daily update, quick add and CSV.
import { html, raw, icon, modal, toast, download, pickFile, today, fmtDate, ago, numInput, parseNum, LOCALE } from '../ui.js';
import * as M from '../model.js';
import { parseCSV, toCSV } from '../csv.js';
import { S, section, unitFmt, amtIf, plural } from '../store.js';
import { commit } from '../persist.js';
import { tstate } from '../views.js';
import { fieldError } from './field.js';
import { newSectionModal, sectionSettingsModal } from './sections.js';

// ---------- tracker items ----------
// An item's value can come from a table instead of being typed in: the
// "src" choice is "manual", "count|<table>" or "col|<table>|<column>".
const parseLink = (src, agg) => {
  const [kind, sec, col] = String(src).split('|');
  if (kind === 'count') return { sec, col: null, agg: 'count' };
  if (kind === 'col') return { sec, col, agg: ['sum', 'sum30', 'latest', 'average'].includes(agg) ? agg : 'sum' };
  return null;
};
function linkField(item, unit) {
  const targets = M.linkTargets(S.data, unit);
  const l = item?.link;
  if ((!targets.length && !l) || item?.source?.ext) return ''; // nothing fitting to link to, or a connection fills it
  const cur = !l ? 'manual' : l.agg === 'count' ? `count|${l.sec}` : `col|${l.sec}|${l.col}`;
  const opt = (v, label) => html`<option value="${v}" ${v === cur ? raw('selected') : ''}>${label}</option>`;
  const offered = targets.some(({ sec: t, cols, count }) => cur === `count|${t.id}` ? count : cols.some(c => cur === `col|${t.id}|${c.id}`));
  return html`<div class="form-grid">
    <label>Value comes from<select name="src">${opt('manual', 'I type it in')}${l && !offered ? opt(cur, `${M.describeLink(S.data, l)} (doesn’t match this section’s unit)`) : ''}${targets.map(({ sec: t, cols, count }) => html`<optgroup label="${t.name}">${cols.map(c => opt(`col|${t.id}|${c.id}`, `${t.name} → ${c.name}`))}${count ? opt(`count|${t.id}`, `${t.name} → number of rows`) : ''}</optgroup>`)}</select></label>
    <label data-agg hidden>Use<select name="agg">${Object.entries(M.LINK_AGGS).filter(([k]) => k !== 'count').map(([k, v]) => html`<option value="${k}" ${l?.agg === k ? raw('selected') : ''}>${v}</option>`)}</select></label>
  </div><p class="muted small" data-link-now aria-live="polite"></p>`;
}

export function itemModal(sec, item) {
  const { unit, netWorth } = sec.tracker;
  const isNew = !item;
  const money$ = unit === 'currency';
  const showLiability = netWorth && money$;
  modal({
    title: isNew ? `Add to ${sec.name}` : `Edit ${item.name}`,
    extra: isNew ? '' : html`<button type="button" class="btn danger" data-del>${icon('trash')} Delete</button>`,
    body: html`
      <label>Name<input name="name" required maxlength="${M.MAX_NAME}" value="${item?.name || ''}" placeholder="${netWorth ? 'e.g. Everyday Checking' : sec.template === 'social' ? 'e.g. TikTok' : 'Name'}" autofocus></label>
      <label>Note <span class="muted">(optional)</span><input name="note" maxlength="80" value="${item?.note || ''}" placeholder="${netWorth ? 'Bank or institution' : 'Handle, detail…'}"></label>
      ${linkField(item, unit)}
      <div class="form-grid" data-manual ${item?.link ? raw('hidden') : ''}>
        <label>${netWorth ? 'Balance' : 'Value'}<input name="value" inputmode="decimal" class="${money$ ? 'amt' : ''}" value="${item ? numInput(item.value) : ''}" placeholder="0" autocomplete="off"></label>
        <label>As of<input name="date" type="date" value="${today()}" min="${M.EARLIEST()}" max="${today()}" required></label>
      </div>
      ${showLiability ? html`<label class="check"><input type="checkbox" name="liability" ${item?.liability ? raw('checked') : ''}> This is money owed (credit card, loan). Enter the balance as a positive number.</label>` : ''}
      <label>Target <span class="muted">(optional, shows a progress bar)</span><input name="target" inputmode="decimal" class="${money$ ? 'amt' : ''}" value="${item?.target != null ? numInput(item.target) : ''}" placeholder="e.g. 10000" autocomplete="off"></label>
      ${item && item.history.length > 1 ? html`<details class="hist"><summary>History (${plural(item.history.length, 'entry', 'entries')})</summary><ul class="hist-list">${item.history.slice().reverse().slice(0, 90).map(([dt, v]) => html`<li><span>${fmtDate(dt, { month: 'short', day: 'numeric', year: 'numeric' })}</span><span class="num">${amtIf(unitFmt(v, unit), money$)}</span></li>`)}</ul></details>` : ''}`,
    onOpen: d => {
      d.querySelector('[data-del]')?.addEventListener('click', () => {
        d.dismiss();
        const idx = sec.items.indexOf(item);
        sec.items.splice(idx, 1);
        M.logDeletion(S.data, 'item', item.id, sec.id);
        commit(`Deleted ${item.name}.`, () => { sec.items.splice(idx, 0, item); M.unlogDeletion(S.data, item.id); commit('Restored.', null, sec); }, sec);
      });
      // "Value comes from": typing it in, or a table (then the value fields hide).
      const src = d.querySelector('[name=src]');
      const sync = () => {
        const linked = src.value !== 'manual';
        d.querySelector('[data-manual]').hidden = linked;
        d.querySelector('[data-agg]').hidden = !src.value.startsWith('col|');
        const link = parseLink(src.value, d.querySelector('[name=agg]').value);
        const v = link && M.linkValue(S.data, link);
        const now = d.querySelector('[data-link-now]');
        now.textContent = link ? `Now: ${v == null ? '—' : unitFmt(v, unit)}` : '';
        now.classList.toggle('amt', money$); // blurred in privacy mode like every amount
      };
      src?.addEventListener('change', sync);
      d.querySelector('[name=agg]')?.addEventListener('change', sync);
      if (src) sync();
    },
    onSubmit: (f, d) => {
      const form = d.querySelector('form');
      const name = String(f.get('name')).trim();
      if (!name) return fieldError(form, 'name', 'Enter a name.');
      const tRaw = String(f.get('target')).trim();
      const target = tRaw ? parseNum(tRaw) : null;
      if (tRaw && (Number.isNaN(target) || target <= 0)) return fieldError(form, 'target', 'Enter a positive number or leave it blank.');
      const link = parseLink(String(f.get('src') || 'manual'), String(f.get('agg') || 'sum'));
      if (link) {
        const it = item || M.makeItem({ name, value: M.linkValue(S.data, link) ?? 0 });
        if (isNew) { it.history = []; sec.items.push(it); }
        Object.assign(it, { name, note: String(f.get('note')).trim(), target, link, liability: showLiability ? !!f.get('liability') : it.liability });
        M.touch(it);
        commit(isNew ? `Added ${name}. It follows ${M.describeLink(S.data, link)}.` : 'Saved.', null, sec); // commit records today's value
        return;
      }
      const value = parseNum(f.get('value'));
      if (Number.isNaN(value)) return fieldError(form, 'value', 'Enter a number, e.g. 1250.50');
      const date = String(f.get('date'));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today() || date < M.EARLIEST()) return fieldError(form, 'date', 'Pick a date within the last 30 years.');
      const it = item || M.makeItem({ name, value });
      if (isNew) it.history = [];
      Object.assign(it, { name, note: String(f.get('note')).trim(), target, link: null, liability: showLiability ? !!f.get('liability') : it.liability });
      // Only a changed value (or a backfill) counts as a new reading, so a
      // rename can't make a stale balance look freshly updated.
      if (isNew || Math.round(value * 100) !== Math.round(it.value * 100) || date !== today()) M.recordValue(it, value, date);
      else it.rev = (it.rev || 0) + 1;
      if (isNew) sec.items.push(it);
      commit(isNew ? `Added ${name}.` : 'Saved.', null, sec);
    },
  });
}

// ---------- table rows ----------
export function rowModal(sec, row) {
  const isNew = !row;
  const cols = sec.table.columns;
  if (!cols.length) { sectionSettingsModal(sec); return; }
  const firstDate = cols.find(c => c.type === 'date');
  const field = (c, i) => {
    const v = row ? row.v[c.id] : (c === firstDate ? today() : null);
    const name = `c${i}`;
    const af = i === 0 ? raw('autofocus') : '';
    switch (c.type) {
      case 'formula': {
        const out = row ? M.cellValue(sec, c, row) : null;
        const money$ = M.formulaUnit(sec, c) === 'currency';
        return html`<div class="ro"><span class="label">${c.name}</span><span class="ro-val num ${money$ ? 'amt' : ''}">${out == null ? '—' : money$ ? unitFmt(out, 'currency') : unitFmt(out, 'number')}</span><span class="muted small">${row ? 'Calculated' : 'Calculated after saving'}: ${M.formulaToNames(c.formula, cols)}</span></div>`;
      }
      case 'checkbox': return html`<label class="check"><input type="checkbox" name="${name}" ${v ? raw('checked') : ''} ${af}> ${c.name}</label>`;
      case 'longtext': return html`<label class="span-all">${c.name}<textarea name="${name}" rows="3" maxlength="5000" ${af}>${v || ''}</textarea></label>`;
      case 'date': return html`<label>${c.name}<input type="date" name="${name}" value="${v || ''}" ${af}></label>`;
      case 'number': case 'currency': return html`<label>${c.name}<input name="${name}" inputmode="decimal" autocomplete="off" class="${c.type === 'currency' ? 'amt' : ''}" value="${typeof v === 'number' ? numInput(v) : ''}" placeholder="${c.type === 'currency' ? '0.00' : '0'}" ${af}></label>`;
      case 'url': return html`<label>${c.name}<input name="${name}" inputmode="url" autocapitalize="off" spellcheck="false" value="${v || ''}" placeholder="example.com" ${af}></label>`;
      case 'tags': {
        const cur = Array.isArray(v) ? v : [];
        const extra = cur.filter(t => !c.options.includes(t));
        return html`<fieldset class="span-all tags-field"><legend>${c.name}</legend>
          ${c.options.length ? html`<div class="tag-picks">${c.options.map(o => html`<label class="check small"><input type="checkbox" name="${name}" value="${o}" ${cur.includes(o) ? raw('checked') : ''}> ${o}</label>`)}</div>` : ''}
          <label class="small">${c.options.length ? 'Other tags' : 'Tags'} <span class="muted">(comma separated)</span><input name="${name}x" value="${extra.join(', ')}" autocomplete="off" maxlength="800" ${af}></label>
        </fieldset>`;
      }
      case 'select': return html`<label>${c.name}<input name="${name}" list="dl-${c.id}" value="${v || ''}" autocomplete="off" ${af}><datalist id="dl-${c.id}">${c.options.map(o => html`<option value="${o}"></option>`)}</datalist></label>`;
      default: return html`<label>${c.name}<input name="${name}" maxlength="500" value="${v ?? ''}" ${af}></label>`;
    }
  };
  modal({
    title: isNew ? `Add to ${sec.name}` : 'Edit row',
    extra: isNew ? html`<label class="check small keep"><input type="checkbox" name="__again"> Add another</label>` : html`<button type="button" class="btn danger" data-del>${icon('trash')} Delete</button>`,
    body: html`<div class="form-grid">${cols.map(field)}</div>`,
    onOpen: d => d.querySelector('[data-del]')?.addEventListener('click', () => {
      d.dismiss();
      const idx = sec.rows.indexOf(row);
      sec.rows.splice(idx, 1);
      M.logDeletion(S.data, 'row', row.id, sec.id);
      commit('Row deleted.', () => { sec.rows.splice(idx, 0, row); M.unlogDeletion(S.data, row.id); commit('Restored.', null, sec); }, sec);
    }),
    onSubmit: (f, d) => {
      const form = d.querySelector('form');
      const v = {};
      const newOptions = [];
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        if (c.type === 'formula') continue; // calculated, not entered
        const input = c.type === 'checkbox' ? !!f.get(`c${i}`) : c.type === 'tags' ? [...f.getAll(`c${i}`), ...String(f.get(`c${i}x`) || '').split(',')] : f.get(`c${i}`);
        const res = M.coerce(c, input);
        if (!res.ok) return fieldError(form, `c${i}`, c.type === 'date' ? 'Enter a valid date.' : c.type === 'url' ? 'Enter a web address like example.com' : 'Enter a number, e.g. 1250.50');
        v[c.id] = res.value;
        if (M.CHOICES.has(c.type) && res.value) for (const o of [].concat(res.value)) if (!c.options.includes(o)) newOptions.push([c, o]);
      }
      const firstInput = cols.findIndex(c => c.type !== 'formula');
      if (cols.every(c => v[c.id] == null || v[c.id] === false)) return fieldError(form, `c${Math.max(0, firstInput)}`, 'Fill in at least one field.');
      if (isNew && sec.rows.length >= M.MAX_ROWS) { toast(`A table can hold up to ${M.MAX_ROWS.toLocaleString(LOCALE)} rows.`); return false; }
      for (const [c, o] of newOptions) if (c.options.length < 100) c.options.push(o);
      if (isNew) sec.rows.push(M.newRow(v));
      else M.touch(Object.assign(row, { v: { ...row.v, ...v } }));
      const again = isNew && f.get('__again');
      commit(isNew ? 'Row added.' : 'Saved.', null, sec);
      if (again) setTimeout(() => rowModal(sec), 0);
    },
  });
}

// ---------- daily update / quick add ----------
export function dailyUpdateModal(onlySec, onlyStale) {
  const staleDays = S.data.settings.staleDays;
  const secs = S.data.sections
    .filter(s => s.type === 'tracker' && (!onlySec || s.id === onlySec))
    .map(s => ({ s, items: s.items.filter(i => !i.link && !i.source?.ext && (!onlyStale || M.isStale(i, staleDays))) }))
    .filter(x => x.items.length);
  if (!secs.length) { toast('Nothing to update yet. Add a tracker item first.'); return; }
  modal({
    title: onlySec ? `Update ${section(onlySec).name}` : onlyStale ? 'Update stale values' : 'Daily update',
    submit: 'Save all',
    body: html`
      <p class="muted small">Change what moved. Saving records today's value for every item shown, which also marks it up to date.</p>
      ${secs.map(({ s, items }) => html`<fieldset class="upd"><legend><span class="badge sm c-${s.color}">${icon(s.icon)}</span> ${s.name}</legend>
        ${items.map(it => html`<label class="inline"><span>${it.name}${M.isStale(it, staleDays) ? html` <span class="stale small">${icon('warn', 'warn-ico')} ${ago(it.updatedAt)}</span>` : ''}${s.tracker.netWorth && it.liability ? html` <span class="muted small">owed</span>` : ''}</span>
          <input name="${it.id}" inputmode="decimal" class="${s.tracker.unit === 'currency' ? 'amt' : ''}" value="${numInput(it.value)}" autocomplete="off" aria-label="${it.name}"></label>`)}
      </fieldset>`)}`,
    onSubmit: (f, d) => {
      const form = d.querySelector('form');
      const updates = [];
      for (const { items } of secs) {
        for (const it of items) {
          const n = parseNum(f.get(it.id));
          if (Number.isNaN(n)) return fieldError(form, it.id, 'Enter a number.');
          updates.push([it, n]);
        }
      }
      for (const [it, n] of updates) M.recordValue(it, n, today());
      commit(`Saved ${plural(updates.length, 'value')} for today.`, null, ...secs.map(x => x.s));
    },
  });
}

export function quickAddModal() {
  if (!S.data.sections.length) { newSectionModal(); return; }
  const d = modal({
    title: 'Add data',
    submit: 'Close',
    body: html`<ul class="rows" role="list">
      ${S.data.sections.map(s => html`<li><button type="button" class="row" data-pick="${s.id}"><span class="badge sm c-${s.color}">${icon(s.icon)}</span><span class="row-main"><span class="row-title">${s.name}</span><span class="row-sub">${s.type === 'tracker' ? 'Add an item' : 'Add a row'}</span></span>${icon('chevron', 'chev')}</button></li>`)}
      <li><button type="button" class="row" data-pick="__new"><span class="badge dashed sm">${icon('plus')}</span><span class="row-main"><span class="row-title">New section…</span><span class="row-sub">A new place for a new kind of data</span></span></button></li>
      ${S.data.sections.some(s => s.type === 'tracker' && s.items.length) ? html`<li><button type="button" class="row" data-pick="__daily"><span class="badge sm c-0">${icon('refresh')}</span><span class="row-main"><span class="row-title">Daily update</span><span class="row-sub">Update all tracked values at once</span></span></button></li>` : ''}
    </ul>`,
    onSubmit: () => {},
  });
  d.querySelector('[data-submit]').hidden = true;
  d.querySelector('footer [data-close]').textContent = 'Close';
  d.querySelector('[data-pick]').focus();
  d.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
    d.dismiss();
    const id = b.dataset.pick;
    if (id === '__new') newSectionModal();
    else if (id === '__daily') dailyUpdateModal();
    else { const s = section(id); if (s.type === 'tracker') itemModal(s); else rowModal(s); }
  }));
}

// ---------- CSV ----------
export async function importCSV(sec) {
  const file = await pickFile('.csv,text/csv,text/plain,.tsv');
  if (!file || S.screen !== 'app') return;
  if (file.size > 10 * 1024 * 1024) { toast('That file is over 10 MB.'); return; }
  const table = parseCSV(await file.text());
  if (table.length < 2) { toast('That file has no data rows.'); return; }
  const plan = M.planImport(sec, table);
  const room = M.MAX_ROWS - sec.rows.length;
  const targetSelect = (h, k) => html`<select name="t${k}" aria-label="Where ${h.name} goes">
    ${sec.table.columns.length ? html`<optgroup label="Existing column">${sec.table.columns.filter(c => c.type !== 'formula').map(c => html`<option value="${c.id}" ${h.target === c.id ? raw('selected') : ''}>${c.name} (${M.COLUMN_TYPES[c.type]})</option>`)}</optgroup>` : ''}
    <optgroup label="New column “${h.name}”">${Object.entries(M.COLUMN_TYPES).filter(([t]) => t !== 'formula').map(([t, l]) => html`<option value="new:${t}" ${h.target === 'new' && h.type === t ? raw('selected') : ''}>New · ${l}</option>`)}</optgroup>
    <option value="skip">Don't import</option></select>`;
  modal({
    title: `Import into ${sec.name}`,
    submit: `Import ${plural(Math.min(plan.body.length, room), 'row')}`,
    wide: true,
    body: html`
      <p><strong>${plural(plan.body.length, 'row')}</strong> in <strong>${file.name}</strong>. Check where each column goes. Types were guessed from the data.</p>
      ${plan.body.length > room ? html`<p class="stale small">${icon('warn', 'warn-ico')} Only ${plural(Math.max(0, room), 'row')} fit (limit ${M.MAX_ROWS.toLocaleString(LOCALE)} per table).</p>` : ''}
      <div class="scroll"><table class="map">
        <thead><tr><th scope="col">From file</th><th scope="col">Goes to</th><th scope="col">Sample values</th></tr></thead>
        <tbody>${plan.headers.map((h, k) => html`<tr><th scope="row">${h.name}</th><td>${targetSelect(h, k)}</td><td class="muted small sample">${h.values.filter(Boolean).slice(0, 3).join(' · ') || '(empty)'}</td></tr>`)}</tbody>
      </table></div>`,
    onSubmit: f => {
      plan.headers.forEach((h, k) => {
        const v = f.get(`t${k}`);
        if (v === 'skip') h.target = 'skip';
        else if (v.startsWith('new:')) { h.target = 'new'; h.type = v.slice(4); }
        else h.target = v;
      });
      const res = M.applyImport(sec, plan, room);
      if (!res.rows.length) { toast('Nothing to import with these choices.'); return false; }
      sec.table.columns.push(...res.newCols);
      sec.rows.push(...res.rows);
      M.fixHeadline(sec);
      const ids = new Set(res.rows.map(r => r.id));
      const colIds = new Set(res.newCols.map(c => c.id));
      const notes = [res.bad && `${plural(res.bad, 'cell')} didn't fit the column type and were left blank`, res.truncated && `${plural(res.truncated, 'row')} over the limit were skipped`].filter(Boolean);
      commit(`Imported ${plural(res.rows.length, 'row')}${notes.length ? `. ${notes.join('; ')}` : ''}.`, () => {
        sec.rows = sec.rows.filter(r => !ids.has(r.id));
        sec.table.columns = sec.table.columns.filter(c => !colIds.has(c.id));
        M.fixHeadline(sec);
        commit('Import undone.', null, sec);
      }, sec);
    },
  });
}

export function exportCSV(sec) {
  const { header, rows } = M.exportTable(sec, tstate(sec.id).sort);
  download(`${sec.name.replace(/[^\w\- ]+/g, '').trim() || 'export'}-${today()}.csv`, toCSV(header, rows), 'text/csv;charset=utf-8');
  toast(`Exported all ${plural(rows.length, 'row')}. The CSV file is not encrypted.`);
}
