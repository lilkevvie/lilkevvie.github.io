// Creating a section and its settings dialog (columns, formulas, summary, reminders).
import { html, raw, setHTML, icon, modal, confirmDialog, toast, download, pickFile, SECTION_ICONS } from '../ui.js';
import * as M from '../model.js';
import { S, section, unitFmt, plural } from '../store.js';
import { commit } from '../persist.js';
import { go, secHref } from '../views.js';
import { fieldError } from './field.js';

function iconPicker(current) {
  return html`<fieldset class="picker"><legend>Icon</legend><div class="icon-grid">${SECTION_ICONS.map(n => html`
    <label class="pick"><input type="radio" name="icon" value="${n}" ${n === current ? raw('checked') : ''}><span class="pick-face" title="${n}">${icon(n)}</span><span class="sr-only">${n}</span></label>`)}</div></fieldset>`;
}
function colorPicker(current) {
  return html`<fieldset class="picker"><legend>Color</legend><div class="swatches">${Array.from({ length: M.PALETTE_SIZE }, (_, i) => html`
    <label class="pick"><input type="radio" name="color" value="${i}" ${i === current ? raw('checked') : ''}><span class="swatch c-${i}"></span><span class="sr-only">Color ${i + 1}</span></label>`)}</div></fieldset>`;
}

export function newSectionModal() {
  modal({
    title: 'New section',
    submit: 'Create',
    wide: true,
    body: html`
      <fieldset class="templates"><legend>Start from</legend>
        ${M.TEMPLATES.map((t, i) => html`<label class="tpl"><input type="radio" name="tpl" value="${t.id}" ${i === 0 ? raw('checked') : ''}>
          <span class="tpl-face"><span class="badge c-${i % M.PALETTE_SIZE}">${icon(t.icon)}</span><span><strong>${t.name}</strong><span class="muted small">${t.desc}</span></span></span></label>`)}
      </fieldset>
      <label>Name<input name="name" maxlength="${M.MAX_NAME}" placeholder="${M.TEMPLATES[0].name}"></label>
      <label class="check"><input type="checkbox" name="sample"> Fill with sample data</label>
      <p class="muted small">Have a template file someone shared? <button type="button" class="link inline-link" data-tpl-import>Import a template…</button></p>`,
    onOpen: d => {
      d.querySelector('[data-tpl-import]').addEventListener('click', async () => {
        const file = await pickFile('.json,application/json');
        if (!file) return;
        try {
          if (file.size > 256 * 1024) throw new Error('That file is too large to be a template.');
          const sec = M.sectionFromTemplate(S.data, JSON.parse(await file.text()));
          d.dismiss();
          S.data.sections.push(sec);
          go(secHref(sec));
          commit(`Added “${sec.name}” from a template.`);
        } catch (e) {
          toast(e instanceof SyntaxError ? "That file isn't an HQ section template." : e.message);
        }
      });
      const name = d.querySelector('[name=name]');
      d.querySelectorAll('[name=tpl]').forEach(r => r.addEventListener('change', () => { name.placeholder = M.TEMPLATES.find(t => t.id === r.value).name; }));
      setTimeout(() => d.querySelector('[name=tpl]:checked').focus(), 0);
    },
    onSubmit: f => {
      const t = M.TEMPLATES.find(x => x.id === f.get('tpl'));
      const sec = t.make(S.data);
      sec.name = String(f.get('name')).trim() || t.name;
      if (f.get('sample')) M.addSample(sec);
      S.data.sections.push(sec);
      go(secHref(sec));
      commit(`Created ${sec.name}.`);
    },
  });
}

export function sectionSettingsModal(sec) {
  const isT = sec.type === 'tracker';
  const colRow = c => html`<li class="col-row" data-col="${c.id}" data-new="${c.isNew ? 1 : ''}">
    <input name="col-name" value="${c.name}" maxlength="${M.MAX_COL_NAME}" required aria-label="Column name">
    <select name="col-type" aria-label="Column type">${Object.entries(M.COLUMN_TYPES).map(([k, v]) => html`<option value="${k}" ${k === c.type ? raw('selected') : ''}>${v}</option>`)}</select>
    <input name="col-opts" value="${(c.options || []).join(', ')}" placeholder="Choices, comma separated" aria-label="Choices" ${M.CHOICES.has(c.type) ? '' : raw('hidden')}>
    <input name="col-formula" value="${isT ? '' : M.formulaToNames(c.formula || '', sec.table.columns)}" maxlength="${M.MAX_FORMULA}" placeholder="e.g. {Revenue} - {Cost}" aria-label="Formula: use + - * / ( ) and {Column}" spellcheck="false" autocomplete="off" ${c.type === 'formula' ? '' : raw('hidden')}>
    <span class="formula-preview small" data-preview aria-live="polite" ${c.type === 'formula' ? '' : raw('hidden')}></span>
    <span class="col-btns">
      <button type="button" class="icon-btn ghost" data-colmove="-1" aria-label="Move column up">${icon('up')}</button>
      <button type="button" class="icon-btn ghost" data-colmove="1" aria-label="Move column down">${icon('down')}</button>
      <button type="button" class="icon-btn ghost" data-coldel aria-label="Remove column">${icon('trash')}</button>
    </span></li>`;
  const h = !isT && sec.table.headline;

  modal({
    title: 'Section settings',
    wide: true,
    extra: html`<button type="button" class="btn danger" data-del>${icon('trash')} Delete section</button>`,
    body: html`
      ${isT ? '' : html`<div class="tabs-bar" role="tablist" aria-label="Section settings">
        ${[['general', 'General'], ['columns', 'Columns'], ['summary', 'Summary']].map(([k, l], i) => html`<button type="button" role="tab" id="st-${k}" aria-controls="sp-${k}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-tab="${k}">${l}</button>`)}
      </div>`}
      <div role="${isT ? 'group' : 'tabpanel'}" id="sp-general" data-panel="general" aria-labelledby="${isT ? '' : 'st-general'}" class="panel">
      <label>Name<input name="name" value="${sec.name}" maxlength="${M.MAX_NAME}" required></label>
      ${iconPicker(sec.icon)}
      ${colorPicker(sec.color)}
      <label class="check"><input type="checkbox" name="home" ${sec.home ? raw('checked') : ''}> Show on Home</label>
      ${isT ? html`
        <div class="form-grid">
          <label>Values are<select name="unit">${Object.entries(M.UNITS).map(([k, v]) => html`<option value="${k}" ${k === sec.tracker.unit ? raw('selected') : ''}>${v}</option>`)}</select></label>
          <label>Direction<select name="good">${Object.entries(M.GOOD).map(([k, v]) => html`<option value="${k}" ${k === sec.tracker.good ? raw('selected') : ''}>${v}</option>`)}</select></label>
        </div>
        <label class="check"><input type="checkbox" name="netWorth" ${sec.tracker.netWorth ? raw('checked') : ''}> Count toward net worth (money only)</label>` : ''}
      <p class="muted small">Share this section's setup (never its data): <button type="button" class="link inline-link" data-tpl-export>Export as template</button></p>
      </div>
      ${isT ? '' : html`
        <div role="tabpanel" id="sp-columns" data-panel="columns" aria-labelledby="st-columns" class="panel" hidden>
        <fieldset class="cols"><legend>Columns</legend>
          <ul class="col-list" role="list">${sec.table.columns.map(colRow)}</ul>
          <button type="button" class="btn small" data-coladd>${icon('plus')} Add column</button>
        </fieldset>
        </div>
        <div role="tabpanel" id="sp-summary" data-panel="summary" aria-labelledby="st-summary" class="panel" hidden>
        <fieldset><legend>Headline number</legend>
          <div class="form-grid">
            <label>Show<select name="mode">${Object.entries(M.HEADLINE_MODES).map(([k, v]) => html`<option value="${k}" ${k === h.mode ? raw('selected') : ''}>${v}</option>`)}</select></label>
            <label data-hl="col">Of column<select name="hcol"></select></label>
            <label data-hl="date">Dated by<select name="hdate"></select></label>
          </div>
        </fieldset>
        <fieldset><legend>Breakdown and reminders</legend>
          <div class="form-grid">
            <label>Break totals down by<select name="bd"></select></label>
            <label>Remind me about<select name="rcol"></select></label>
            <label data-hl="rdays">How far ahead<select name="rdays">${M.REMIND_DAYS.map(n => html`<option value="${n}" ${n === sec.table.remind.days ? raw('selected') : ''}>${plural(n, 'day')} before</option>`)}</select></label>
            <label data-hl="rrep">When the date passes<select name="rrep">${Object.entries(M.REPEATS).map(([k, v]) => html`<option value="${k}" ${k === sec.table.remind.repeat ? raw('selected') : ''}>${v}</option>`)}</select></label>
          </div>
          <p class="muted small">A breakdown shows totals per choice (e.g. spend per category). Reminders list upcoming dates on Home.</p>
        </fieldset>
        </div>`}`,
    onOpen: d => {
      d.querySelector('[data-tpl-export]').addEventListener('click', () => {
        download(`${sec.name.replace(/[^\w\- ]+/g, '').trim() || 'section'}.hq-template.json`, JSON.stringify(M.templateFrom(sec), null, 2), 'application/json');
        toast('Template exported. It contains the setup only, no data.');
      });
      // Tabs (tables only): click or arrow keys; a validation error reveals its tab.
      const tabs = [...d.querySelectorAll('[role=tab]')];
      const show = key => tabs.forEach(t => {
        const on = t.dataset.tab === key;
        t.setAttribute('aria-selected', on);
        t.tabIndex = on ? 0 : -1;
        d.querySelector(`[data-panel=${t.dataset.tab}]`).hidden = !on;
      });
      tabs.forEach((t, i) => {
        t.addEventListener('click', () => show(t.dataset.tab));
        t.addEventListener('keydown', e => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
          show(next.dataset.tab);
          next.focus();
        });
      });
      d.querySelector('form').addEventListener('invalid', e => {
        const p = e.target.closest('[data-panel]');
        if (p?.hidden) show(p.dataset.panel);
      }, true);
      d.querySelector('[data-del]').addEventListener('click', async () => {
        const n = isT ? sec.items.length : sec.rows.length;
        const ok = await confirmDialog({ title: `Delete ${sec.name}?`, body: html`<p>This removes the section and its ${plural(n, isT ? 'item' : 'row')}${isT ? ' with all history' : ''}. You can undo right after.</p>`, confirm: 'Delete', danger: true });
        if (!ok) return;
        d.dismiss();
        const idx = S.data.sections.indexOf(sec);
        S.data.sections.splice(idx, 1);
        M.logDeletion(S.data, 'section', sec.id);
        go('#/');
        commit(`Deleted ${sec.name}.`, () => { S.data.sections.splice(idx, 0, sec); M.unlogDeletion(S.data, sec.id); go(secHref(sec)); commit('Restored.'); });
      });
      if (isT) return;

      // Headline pickers follow the columns being edited, live.
      const hcol = d.querySelector('[name=hcol]');
      const hdate = d.querySelector('[name=hdate]');
      const bd = d.querySelector('[name=bd]');
      const rcol = d.querySelector('[name=rcol]');
      const mode = d.querySelector('[name=mode]');
      const chosen = { col: h.column, date: h.dateColumn, bd: sec.table.breakdown.column, rcol: sec.table.remind.column };
      const liveCols = () => [...d.querySelectorAll('.col-row')].map(li => ({ id: li.dataset.col, name: li.querySelector('[name=col-name]').value.trim() || 'Untitled', type: li.querySelector('[name=col-type]').value }));
      const refreshHeadline = () => {
        const cols = liveCols();
        const m = mode.value;
        const want = m === 'progress' ? c => c.type === 'checkbox' : c => M.NUMERIC.has(c.type);
        const fill = (sel, list, cur, none = 'Automatic') => setHTML(sel, html`<option value="">${none}</option>${list.map(c => html`<option value="${c.id}" ${c.id === cur ? raw('selected') : ''}>${c.name}</option>`)}`);
        fill(hcol, cols.filter(want), chosen.col);
        fill(hdate, cols.filter(c => c.type === 'date'), chosen.date);
        fill(bd, cols.filter(c => M.GROUPABLE.has(c.type)), chosen.bd, 'No breakdown');
        fill(rcol, cols.filter(c => c.type === 'date'), chosen.rcol, 'No reminders');
        d.querySelector('[data-hl=col]').hidden = m === 'count';
        d.querySelector('[data-hl=date]').hidden = m !== 'period';
        d.querySelector('[data-hl=rdays]').hidden = !rcol.value;
        d.querySelector('[data-hl=rrep]').hidden = !rcol.value;
      };
      hcol.addEventListener('change', () => { chosen.col = hcol.value || null; });
      hdate.addEventListener('change', () => { chosen.date = hdate.value || null; });
      bd.addEventListener('change', () => { chosen.bd = bd.value || null; });
      rcol.addEventListener('change', () => { chosen.rcol = rcol.value || null; refreshHeadline(); });
      mode.addEventListener('change', refreshHeadline);

      // Live preview of each formula on the first row, with the reason when blank.
      const refreshPreviews = () => {
        const lis = [...d.querySelectorAll('.col-row')];
        const cols = liveCols();
        const draft = cols.map((c, i) => (c.type !== 'formula' ? c : { ...c, formula: M.formulaToIds(lis[i].querySelector('[name=col-formula]').value, cols, c.id).text }));
        const temp = { table: { columns: draft } };
        const row = sec.rows[0];
        lis.forEach((li, i) => {
          const out = li.querySelector('[data-preview]');
          if (draft[i].type !== 'formula') return;
          const res = M.formulaToIds(li.querySelector('[name=col-formula]').value, cols, cols[i].id);
          let text;
          if (res.error) text = `⚠ ${res.error}`;
          else if (M.formulaCycle(draft)) text = '⚠ Formulas depend on each other in a loop.';
          else if (!row) text = 'A preview appears once the table has a row.';
          else {
            const v = M.cellValue(temp, draft[i], row);
            text = v == null ? `First row: blank. ${M.formulaBlankReason(temp, draft[i], row)}` : `First row: ${unitFmt(v, M.formulaUnit(temp, draft[i]))}`;
          }
          out.textContent = text;
          out.classList.toggle('bad', text.startsWith('⚠'));
        });
      };
      const onColsChange = () => { refreshHeadline(); refreshPreviews(); };
      d.querySelector('.col-list').addEventListener('input', onColsChange);
      d.querySelector('.col-list').addEventListener('change', onColsChange);

      const list = d.querySelector('.col-list');
      const wire = li => {
        li.querySelector('[name=col-type]').addEventListener('change', e => {
          li.querySelector('[name=col-opts]').hidden = !M.CHOICES.has(e.target.value);
          li.querySelector('[name=col-formula]').hidden = e.target.value !== 'formula';
          li.querySelector('[data-preview]').hidden = e.target.value !== 'formula';
        });
        li.querySelector('[data-coldel]').addEventListener('click', () => {
          ((li.nextElementSibling || li.previousElementSibling)?.querySelector('input') || d.querySelector('[data-coladd]')).focus();
          li.remove();
          refreshHeadline();
        });
        li.querySelectorAll('[data-colmove]').forEach(b => b.addEventListener('click', () => {
          if (b.dataset.colmove === '-1') li.previousElementSibling?.before(li);
          else li.nextElementSibling?.after(li);
          b.focus();
          refreshHeadline();
        }));
      };
      list.querySelectorAll('.col-row').forEach(wire);
      d.querySelector('[data-coladd]').addEventListener('click', () => {
        const tmp = document.createElement('ul');
        setHTML(tmp, colRow({ ...M.makeColumn('', 'text'), isNew: true }));
        const li = tmp.firstElementChild;
        list.appendChild(li);
        wire(li);
        li.querySelector('input').focus();
        refreshHeadline();
      });
      refreshHeadline();
      refreshPreviews();
    },
    onSubmit: async (f, d) => {
      const form = d.querySelector('form');
      const name = String(f.get('name')).trim();
      if (!name) return fieldError(form, 'name', 'Give the section a name.');
      if (!isT) {
        const lis = [...d.querySelectorAll('.col-row')];
        const names = lis.map(li => li.querySelector('[name=col-name]').value.trim().toLowerCase());
        const bad = names.findIndex((n, i) => !n || names.indexOf(n) !== i);
        if (bad >= 0) {
          const el = lis[bad].querySelector('[name=col-name]');
          el.setCustomValidity(names[bad] ? 'Column names must be unique.' : 'Name this column.');
          el.reportValidity();
          el.addEventListener('input', () => el.setCustomValidity(''), { once: true });
          return false;
        }
        const next = lis.map(li => ({
          id: li.dataset.col,
          name: li.querySelector('[name=col-name]').value.trim(),
          type: li.querySelector('[name=col-type]').value,
          options: [...new Set(li.querySelector('[name=col-opts]').value.split(',').map(s => s.trim()).filter(Boolean))].slice(0, 100),
        }));
        // Formulas: validate against the columns as they'll be saved, and store with ids.
        for (let i = 0; i < next.length; i++) {
          if (next[i].type !== 'formula') continue;
          const input = lis[i].querySelector('[name=col-formula]');
          const res = M.formulaToIds(input.value, next, next[i].id);
          if (res.error) {
            input.setCustomValidity(res.error);
            input.reportValidity();
            input.addEventListener('input', () => input.setCustomValidity(''), { once: true });
            return false;
          }
          next[i].formula = res.text;
        }
        const loop = M.formulaCycle(next);
        if (loop) {
          const i = next.findIndex(c => c.name === loop);
          const input = lis[i].querySelector('[name=col-formula]');
          input.setCustomValidity(`Formulas can't depend on each other in a loop (“${loop}” ends up using itself).`);
          input.reportValidity();
          input.addEventListener('input', () => input.setCustomValidity(''), { once: true });
          return false;
        }
        const hasData = id => sec.rows.some(r => r.v[id] != null && r.v[id] !== '' && r.v[id] !== false);
        const lose = sec.table.columns.filter(c => !next.some(n => n.id === c.id) && hasData(c.id));
        const retyped = next.filter(n => sec.table.columns.find(c => c.id === n.id && c.type !== n.type) && hasData(n.id));
        if (lose.length || retyped.length) {
          const ok = await confirmDialog({
            title: 'Change columns?',
            body: html`${lose.length ? html`<p>Removing <strong>${lose.map(c => c.name).join(', ')}</strong> deletes that data from every row.</p>` : ''}${retyped.length ? html`<p>Changing the type of <strong>${retyped.map(c => c.name).join(', ')}</strong> converts existing values. Values that don't fit are cleared.</p>` : ''}`,
            confirm: 'Apply', danger: true,
          });
          if (!ok) return false;
        }
        for (const n of next) {
          const old = sec.table.columns.find(c => c.id === n.id);
          if (old && old.type !== n.type) {
            for (const r of sec.rows) {
              const v = r.v[n.id];
              const conv = M.coerce(n, typeof v === 'boolean' ? (v ? 'yes' : '') : v);
              r.v[n.id] = conv.ok ? conv.value : null;
            }
          }
        }
        const keep = new Set(next.map(n => n.id));
        for (const c of sec.table.columns) if (!keep.has(c.id)) for (const r of sec.rows) delete r.v[c.id];
        sec.table.columns = next;
        const wanted = f.get('mode');
        sec.table.headline = { mode: wanted, column: f.get('hcol') || null, dateColumn: f.get('hdate') || null };
        M.fixHeadline(sec);
        const isType = (id, types) => next.some(c => c.id === id && types.has(c.type));
        sec.table.breakdown = { column: isType(f.get('bd'), M.GROUPABLE) ? f.get('bd') : null };
        sec.table.remind = { column: isType(f.get('rcol'), new Set(['date'])) ? f.get('rcol') : null, days: Number(f.get('rdays')) || 7, repeat: M.REPEATS[f.get('rrep')] ? f.get('rrep') : 'none' };
        M.rollRepeating({ sections: [sec] });
        if (sec.table.headline.mode !== wanted) toast(`That headline needs a matching column, so it shows “${M.HEADLINE_MODES[sec.table.headline.mode]}”.`);
        S.tables.delete(sec.id);
      } else {
        sec.tracker.unit = f.get('unit');
        sec.tracker.good = f.get('good');
        sec.tracker.netWorth = !!f.get('netWorth') && sec.tracker.unit === 'currency';
      }
      Object.assign(sec, { name, icon: f.get('icon') || sec.icon, color: Number(f.get('color')), home: !!f.get('home') });
      commit('Section updated.', null, sec);
    },
  });
}
