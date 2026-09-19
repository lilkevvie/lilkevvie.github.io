// Links between sections: a tracker item whose value comes from a table,
// e.g. "Store revenue, last 30 days" from the Store sales table, or "Open
// orders" counted from an Orders table. The item keeps its own dated
// history, so it charts like any other; the value is recalculated whenever
// data changes and once a day on unlock. Tables never depend on trackers,
// so links can't form loops.
import { today, addDays, round2 } from '../ui.js';
import { NUMERIC } from './constants.js';
import { cellValue, formulaUnit } from './formula.js';
import { recordValue } from './tracker.js';

export const LINK_AGGS = {
  sum: 'Total of all rows',
  sum30: 'Total, last 30 days',
  latest: 'Most recent value',
  average: 'Average of all rows',
  count: 'Number of rows',
};

/** @typedef {{sec: string, col: string|null, agg: keyof LINK_AGGS}} Link */

// Tables and columns an item in a tracker of `unit` can link to. Units must
// match, so a count or a plain number never lands in a money total (or net
// worth): money trackers get money columns (and formulas that are money);
// others get plain numbers and row counts.
export function linkTargets(data, unit = 'number') {
  const money = unit === 'currency';
  return data.sections.filter(s => s.type === 'table').map(s => ({
    sec: s,
    cols: s.table.columns.filter(c => NUMERIC.has(c.type) && (formulaUnit(s, c) === 'currency') === money),
    count: !money,
  })).filter(t => t.cols.length || t.count);
}

const dateCol = sec => sec.table.columns.find(c => c.id === sec.table.headline.dateColumn && c.type === 'date') || sec.table.columns.find(c => c.type === 'date') || null;

/** @param {import('./types.js').Data} data @param {Link} link @returns {number|null} null when the table or column is gone */
export function linkValue(data, link, t = today()) {
  const sec = data.sections.find(s => s.id === link?.sec && s.type === 'table');
  if (!sec || !LINK_AGGS[link.agg]) return null;
  if (link.agg === 'count') return sec.rows.length;
  const col = sec.table.columns.find(c => c.id === link.col && NUMERIC.has(c.type));
  if (!col) return null;
  const dc = dateCol(sec);
  const num = r => { const v = cellValue(sec, col, r); return typeof v === 'number' && Number.isFinite(v) ? v : null; };
  let rows = sec.rows;
  if (link.agg === 'sum30') {
    if (!dc) return null;
    const from = addDays(t, -29);
    rows = rows.filter(r => typeof r.v[dc.id] === 'string' && r.v[dc.id] >= from && r.v[dc.id] <= t);
  }
  if (link.agg === 'latest') {
    // By date when the table has one, otherwise the last row added.
    const withVal = rows.filter(r => num(r) != null && (!dc || (typeof r.v[dc.id] === 'string' && r.v[dc.id] <= t)));
    if (!withVal.length) return 0;
    const pick = dc ? withVal.reduce((a, b) => (b.v[dc.id] >= a.v[dc.id] ? b : a)) : withVal.at(-1);
    return round2(num(pick));
  }
  const vals = rows.map(num).filter(v => v != null);
  if (link.agg === 'average') return vals.length ? round2(vals.reduce((s, v) => s + v, 0) / vals.length) : 0;
  return round2(vals.reduce((s, v) => s + v, 0));
}

export const describeLink = (data, link) => {
  const sec = data.sections.find(s => s.id === link?.sec);
  if (!sec) return 'Linked table was deleted';
  const col = sec.table.columns.find(c => c.id === link.col);
  return link.agg === 'count' ? `Rows in ${sec.name}` : `${sec.name} → ${col?.name ?? '(deleted column)'}, ${LINK_AGGS[link.agg].toLowerCase()}`;
};

// Recalculates every linked item. A changed value, or the first check of a
// new day, is recorded as today's point. Returns the sections that changed.
export function refreshLinks(data, t = today()) {
  const changed = new Set();
  for (const sec of data.sections) {
    if (sec.type !== 'tracker') continue;
    for (const it of sec.items) {
      if (!it.link) continue;
      const v = linkValue(data, it.link, t);
      if (v == null) continue;
      const last = it.history.at(-1);
      if (last && last[0] === t && Math.round(last[1] * 100) === Math.round(v * 100) && Math.round(it.value * 100) === Math.round(v * 100)) continue;
      recordValue(it, v, t);
      changed.add(sec);
    }
  }
  return [...changed];
}
