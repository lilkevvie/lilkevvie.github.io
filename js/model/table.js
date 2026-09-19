// Table math: headlines, breakdowns, charts, reminders, sorting, filtering,
// typed input (coerce) and CSV import/export.
import { today, addDays, addMonths, daysBetween, round2, parseNum, parseDate, safeUrl } from '../ui.js';
import { CHOICES, MAX_COL_NAME, MAX_ROWS, MAX_TAGS, NUMERIC } from './constants.js';
import { cellValue, formulaUnit } from './formula.js';
import { makeColumn, newRow, touch, uniqueName, clampStr } from './base.js';

export const colById = (sec, id) => sec.table.columns.find(c => c.id === id) || null;

export function cellNumber(sec, row, col) {
  const v = cellValue(sec, col, row);
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** @param {import('./types.js').TableSection} sec @param {number} [windowDays] */
export function tableHeadline(sec, windowDays = 30) {
  const h = sec.table.headline;
  const col = colById(sec, h.column);
  const unit = col ? formulaUnit(sec, col) : 'number';
  const rows = sec.rows;
  switch (h.mode) {
    case 'progress': {
      const done = rows.filter(r => r.v[col.id] === true).length;
      return { kind: 'progress', done, total: rows.length, label: col.name };
    }
    case 'period': {
      const dc = colById(sec, h.dateColumn);
      const t = today();
      const start = addDays(t, -(windowDays - 1));
      const prevStart = addDays(start, -windowDays);
      const byDay = new Map();
      let cur = 0, prev = 0, prevHas = false;
      for (const r of rows) {
        const d = r.v[dc.id];
        if (typeof d !== 'string') continue;
        const n = cellNumber(sec, r, col);
        if (d >= start && d <= t) { cur += n; byDay.set(d, (byDay.get(d) || 0) + n); }
        else if (d >= prevStart && d < start) { prev += n; prevHas = true; }
      }
      const series = [];
      for (let d = start; d <= t; d = addDays(d, 1)) series.push({ date: d, value: round2(byDay.get(d) || 0) });
      return { kind: 'value', unit, value: round2(cur), prev: prevHas ? round2(prev) : null, series, label: `${col.name}, last ${windowDays} days` };
    }
    case 'sum':
      return { kind: 'value', unit, value: round2(rows.reduce((s, r) => s + cellNumber(sec, r, col), 0)), prev: null, label: `Total ${col.name.toLowerCase()}` };
    case 'average': {
      const vals = rows.map(r => cellValue(sec, col, r)).filter(v => typeof v === 'number');
      return { kind: 'value', unit, value: vals.length ? round2(vals.reduce((s, v) => s + v, 0) / vals.length) : 0, prev: null, label: `Average ${col.name.toLowerCase()}` };
    }
    default:
      return { kind: 'value', unit: 'number', value: rows.length, prev: null, label: 'Rows' };
  }
}

// Any number, money or formula column totalled per day, week (dated by its
// Monday) or month over a date column, for the table's chart. With no
// bucket given, one is picked so the chart has at most ~maxBars bars.
// Returns { bucket, series: [{ date, value }] } with empty buckets as 0.
/** @param {import('./types.js').TableSection} sec @param {string} colId @param {string} dateId @param {{from?: string|null, to?: string, bucket?: 'day'|'week'|'month'|null, maxBars?: number}} [opts] @returns {{bucket: 'day'|'week'|'month', series: Array<{date: string, value: number}>}} */
export function columnSeries(sec, colId, dateId, { from = null, to = today(), bucket = null, maxBars = 120 } = {}) {
  const col = colById(sec, colId), dc = colById(sec, dateId);
  if (!col || !NUMERIC.has(col.type) || !dc || dc.type !== 'date') return { bucket: 'day', series: [] };
  const sums = [];
  let first = null;
  for (const r of sec.rows) {
    const d = r.v[dc.id];
    if (typeof d !== 'string' || d > to || (from && d < from)) continue;
    const v = cellValue(sec, col, r);
    if (typeof v !== 'number') continue;
    sums.push([d, v]);
    if (!first || d < first) first = d;
  }
  if (!first) return { bucket: 'day', series: [] };
  const start = from || first;
  const span = daysBetween(start, to);
  bucket ||= span <= maxBars ? 'day' : span <= 7 * maxBars ? 'week' : 'month';
  const key = d => (bucket === 'month' ? `${d.slice(0, 7)}-01` : bucket === 'week' ? addDays(d, -((new Date(`${d}T12:00`).getDay() + 6) % 7)) : d);
  const next = k => (bucket === 'month' ? addMonths(k, 1) : addDays(k, bucket === 'week' ? 7 : 1));
  const byKey = new Map();
  for (const [d, v] of sums) byKey.set(key(d), (byKey.get(key(d)) || 0) + v);
  const series = [];
  for (let k = key(start), n = 0; k <= key(to) && n < 5000; k = next(k), n++) series.push({ date: k, value: round2(byKey.get(k) || 0) });
  return { bucket, series };
}

// "Spend by category": totals the headline's number column (or counts rows)
// per value of the breakdown column. Uses the same 30-day window as a
// period headline. Top 7 groups, the rest folded into "Other".
export function tableBreakdown(sec, windowDays = 30) {
  const by = colById(sec, sec.table.breakdown?.column);
  if (!by) return null;
  const h = sec.table.headline;
  const metric = h.mode !== 'count' && h.mode !== 'progress' ? colById(sec, h.column) : null;
  let rows = sec.rows;
  const dc = h.mode === 'period' ? colById(sec, h.dateColumn) : null;
  if (dc) {
    const start = addDays(today(), -(windowDays - 1));
    rows = rows.filter(r => typeof r.v[dc.id] === 'string' && r.v[dc.id] >= start && r.v[dc.id] <= today());
  }
  const groups = new Map();
  for (const r of rows) {
    const raw = r.v[by.id];
    // A row with several tags counts toward each of them.
    const keys = by.type === 'tags' ? (Array.isArray(raw) && raw.length ? raw : ['(none)'])
      : [by.type === 'checkbox' ? (raw ? 'Yes' : 'No') : String(raw ?? '').trim() || '(blank)'];
    for (const key of keys) {
      const g = groups.get(key) || { key, value: 0, count: 0 };
      g.value += metric ? cellNumber(sec, r, metric) : 1;
      g.count += 1;
      groups.set(key, g);
    }
  }
  let list = [...groups.values()].sort((a, b) => b.value - a.value);
  if (list.length > 8) {
    const rest = list.slice(7);
    list = [...list.slice(0, 7), { key: 'Other', value: rest.reduce((s, g) => s + g.value, 0), count: rest.reduce((s, g) => s + g.count, 0), other: true }];
  }
  list.forEach(g => { g.value = round2(g.value); });
  return {
    by: by.name,
    unit: metric ? formulaUnit(sec, metric) : 'number',
    measure: metric ? metric.name : 'Rows',
    period: dc ? `last ${windowDays} days` : null,
    groups: list,
    // Shares only make sense when each row is in exactly one group.
    total: by.type === 'tags' ? null : round2(list.reduce((s, g) => s + g.value, 0)),
  };
}

// Rows whose reminder date is overdue (up to `overdue` days) or due within
// the section's reminder window. Sorted soonest first.
export function upcoming(data, overdue = 14, t = today()) {
  const out = [];
  for (const sec of data.sections) {
    if (sec.type !== 'table') continue;
    const col = colById(sec, sec.table.remind?.column);
    if (!col) continue;
    const until = addDays(t, sec.table.remind.days);
    const from = addDays(t, -overdue);
    for (const row of sec.rows) {
      const d = row.v[col.id];
      if (typeof d === 'string' && d >= from && d <= until) out.push({ sec, row, col, date: d, days: daysBetween(t, d) });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Is this cell a reminder that's due (for highlighting in the table)?
export function dueState(sec, col, row, t = today()) {
  const r = sec.table.remind;
  if (!r || r.column !== col.id || typeof row.v[col.id] !== 'string') return null;
  const days = daysBetween(t, row.v[col.id]);
  return days < 0 ? { days, kind: 'overdue' } : days <= r.days ? { days, kind: 'soon' } : null;
}

// Repeating reminders (monthly/yearly renewals): any date that has passed is
// moved forward by whole periods to the next one on or after `t`. Returns the
// sections that changed so the caller can save them.
export const REPEATS = { none: 'Doesn’t repeat', monthly: 'Repeats monthly', yearly: 'Repeats yearly' };
export function rollRepeating(data, t = today()) {
  const changed = [];
  for (const sec of data.sections) {
    const r = sec.type === 'table' && sec.table.remind;
    if (!r?.column || r.repeat === 'none' || !REPEATS[r.repeat]) continue;
    const months = r.repeat === 'yearly' ? 12 : 1;
    let any = false;
    for (const row of sec.rows) {
      let d = row.v[r.column];
      if (typeof d !== 'string' || d >= t) continue;
      for (let k = 1; d < t && k < 1200; k++) d = addMonths(row.v[r.column], months * k);
      row.v = { ...row.v, [r.column]: d };
      touch(row);
      any = true;
    }
    if (any) changed.push(sec);
  }
  return changed;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// Default sort: newest first by the first date column, else insertion order.
export function defaultSort(sec) {
  const dc = sec.table.columns.find(c => c.type === 'date');
  return dc ? { col: dc.id, dir: -1 } : null;
}

export function sortRows(sec, rows, sort) {
  const col = sort && colById(sec, sort.col);
  if (!col) return rows;
  const key = r => {
    const v = cellValue(sec, col, r);
    return v == null || v === '' ? null : col.type === 'checkbox' ? Number(v) : v;
  };
  const cmp = NUMERIC.has(col.type) || col.type === 'checkbox' ? (a, b) => a - b
    : col.type === 'date' ? (a, b) => (a < b ? -1 : a > b ? 1 : 0)
      : (a, b) => collator.compare(String(a), String(b));
  return rows.map(r => [key(r), r]).sort((a, b) => {
    if (a[0] == null) return b[0] == null ? 0 : 1; // blanks last either way
    if (b[0] == null) return -1;
    return cmp(a[0], b[0]) * sort.dir;
  }).map(x => x[1]);
}

export function filterRows(sec, rows, q, cellText) {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  const cols = sec.table.columns;
  return rows.filter(r => cols.some(c => {
    const v = cellValue(sec, c, r);
    return v != null && (cellText(c, v).toLowerCase().includes(needle) || String(v).toLowerCase().includes(needle));
  }));
}

// Coerce raw input (form field or CSV cell) into the stored value for a column.
// Returns { ok, value }. Empty input is always ok and stored as null.
/** @param {import('./types.js').Column} col @param {unknown} input @returns {{ok: true, value: any} | {ok: false}} */
export function coerce(col, input) {
  if (col.type === 'formula') return { ok: true, value: null }; // computed, never entered
  if (col.type === 'checkbox') {
    if (typeof input === 'boolean') return { ok: true, value: input };
    const s = String(input ?? '').trim().toLowerCase();
    return { ok: true, value: ['true', 'yes', 'y', 'x', '1', '✓', 'done', 'on'].includes(s) };
  }
  const s = String(input ?? '').trim();
  if (!s) return { ok: true, value: null };
  switch (col.type) {
    case 'number': case 'currency': {
      const n = parseNum(s);
      return Number.isNaN(n) ? { ok: false } : { ok: true, value: col.type === 'currency' ? round2(n) : n };
    }
    case 'date': {
      const d = parseDate(s);
      return d ? { ok: true, value: d } : { ok: false };
    }
    case 'url': {
      const u = safeUrl(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
      return u && /\./.test(new URL(u).hostname) ? { ok: true, value: u } : { ok: false };
    }
    case 'select':
      return { ok: true, value: s.slice(0, 200) };
    case 'tags': {
      // "a, b; c" or an array → unique tags (case-insensitive), in order.
      const seen = new Set();
      const tags = (Array.isArray(input) ? input.map(String) : s.split(/[,;]/)).map(t => t.trim().slice(0, 40)).filter(t => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
      return { ok: true, value: tags.length ? tags.slice(0, MAX_TAGS) : null };
    }
    case 'longtext':
      return { ok: true, value: s.slice(0, 5000) };
    default:
      return { ok: true, value: s.slice(0, 500) };
  }
}

// Guess a column type from sample CSV values.
export function inferType(name, values) {
  const vals = values.map(v => String(v ?? '').trim()).filter(Boolean).slice(0, 200);
  if (!vals.length) return 'text';
  const share = fn => vals.filter(fn).length / vals.length;
  if (vals.every(v => /^(true|false|yes|no|y|n|x|✓|0|1)$/i.test(v)) && vals.some(v => !/^[01]$/.test(v))) return 'checkbox';
  if (share(v => parseDate(v)) >= 0.9) return 'date';
  if (share(v => !Number.isNaN(parseNum(v))) >= 0.9) return vals.some(v => /\p{Sc}/u.test(v)) || /price|cost|revenue|amount|total|sales|balance|spend|income|\$/i.test(name) ? 'currency' : 'number';
  if (vals.every(v => /^https?:\/\//i.test(v))) return 'url';
  const distinct = new Set(vals);
  if (vals.length >= 6 && distinct.size <= Math.max(2, vals.length / 4) && distinct.size <= 12) return 'select';
  return vals.some(v => v.length > 120) ? 'longtext' : 'text';
}

// ---------- CSV import / export ----------
// Undo the ' we prepend on export against spreadsheet formula injection.
const unguard = v => (typeof v === 'string' && /^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);

// Step 1: propose a target for every CSV header.
export function planImport(sec, table) {
  const [header = [], ...body] = table;
  const taken = new Set(sec.table.columns.map(c => c.name.toLowerCase()));
  const used = new Set();
  const headers = header.map((h, i) => {
    const name = clampStr(String(h).trim() || `Column ${i + 1}`, MAX_COL_NAME);
    const values = body.map(r => unguard(r[i]));
    const match = sec.table.columns.find(c => c.type !== 'formula' && c.name.toLowerCase() === name.toLowerCase() && !used.has(c.id));
    if (match) { used.add(match.id); return { i, name, values, target: match.id }; }
    const unique = uniqueName(taken, name);
    taken.add(unique.toLowerCase());
    return { i, name: unique, values, target: 'new', type: inferType(name, values) };
  });
  return { headers, body };
}

// Step 2: build rows from the (possibly user-edited) plan. Pure: returns what
// to add; the caller commits it.
export function applyImport(sec, plan, room = MAX_ROWS - sec.rows.length) {
  const newCols = [];
  const targets = plan.headers.map(h => {
    if (h.target === 'skip') return null;
    if (h.target === 'new') {
      const c = makeColumn(h.name, h.type);
      newCols.push(c);
      return c;
    }
    return colById(sec, h.target);
  });
  let bad = 0;
  const rows = [];
  for (const r of plan.body.slice(0, Math.max(0, room))) {
    const v = {};
    plan.headers.forEach((h, k) => {
      const col = targets[k];
      if (!col) return;
      const res = coerce(col, unguard(r[h.i]));
      if (res.ok) { if (res.value != null && !(col.id in v && v[col.id] != null)) v[col.id] = res.value; }
      else bad++;
    });
    if (Object.values(v).some(x => x != null && x !== false)) rows.push(newRow(v));
  }
  for (const c of newCols) if (CHOICES.has(c.type)) c.options = [...new Set(rows.flatMap(r => r.v[c.id] ?? []))].slice(0, 50);
  return { rows, newCols, bad, truncated: Math.max(0, plan.body.length - Math.max(0, room)) };
}

// All rows (never the on-screen filter), or just `only` (a bulk selection),
// in the current sort, as CSV-ready cells.
/** @param {import('./types.js').TableSection} sec @param {{col: string, dir: number}|null} sort @param {import('./types.js').Row[]} [only] @returns {{header: string[], rows: Array<Array<[any, boolean]>>}} */
export function exportTable(sec, sort, only = sec.rows) {
  const cols = sec.table.columns;
  const rows = sortRows(sec, only, sort || defaultSort(sec)).map(r => cols.map(c => {
    const v = cellValue(sec, c, r);
    if (c.type === 'checkbox') return [v ? 'yes' : 'no', false];
    if (c.type === 'tags') return [Array.isArray(v) ? v.join(', ') : '', true];
    return [v ?? '', !NUMERIC.has(c.type)];
  }));
  return { header: cols.map(c => c.name), rows };
}

