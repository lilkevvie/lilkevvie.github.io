// Tracker math: histories, totals, series, deltas, staleness and goals.
import { today, addDays, daysBetween, round2 } from '../ui.js';
import { EARLIEST, MAX_HISTORY, MAX_POINTS } from './constants.js';

const now = () => Date.now();

export function upsertHistory(item, date, value) {
  const h = item.history;
  const i = h.findIndex(p => p[0] === date);
  if (i >= 0) h[i][1] = value;
  else {
    h.push([date, value]);
    if (h.length > 1 && h[h.length - 2][0] > date) h.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }
  if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
}

// Records a value for a date. Backfilling a past date only edits history;
// the newest entry is the current value.
/** @param {import('./types.js').Item} item @param {number} value @param {string} [date] ISO date, not in the future */
export function recordValue(item, value, date = today()) {
  if (date > today() || date < EARLIEST()) throw new Error('That date is out of range.');
  const v = round2(value);
  upsertHistory(item, date, v);
  item.rev = (item.rev || 0) + 1;
  if (item.history[item.history.length - 1][0] === date) {
    item.value = v;
    item.updatedAt = now();
  }
}

export const signed = (sec, item, v) => (sec.tracker.netWorth && item.liability ? -v : v);

export function trackerTotal(sec) {
  return round2(sec.items.reduce((s, it) => s + signed(sec, it, it.value), 0));
}

// Daily series start..end (inclusive), carrying each item's last value forward.
export function trackerSeries(pairs, start, end) {
  const n = Math.max(0, daysBetween(start, end) + 1);
  const dates = new Array(n);
  for (let i = 0, d = start; i < n; i++, d = addDays(d, 1)) dates[i] = d;
  const totals = new Array(n).fill(0);
  for (const { sec, item } of pairs) {
    const h = item.history;
    let j = -1;
    for (let i = 0; i < n; i++) {
      while (j + 1 < h.length && h[j + 1][0] <= dates[i]) j++;
      if (j >= 0) totals[i] += signed(sec, item, h[j][1]);
    }
  }
  return dates.map((date, i) => ({ date, value: round2(totals[i]) }));
}

// Keeps charts fast for long ranges: last point of each bucket (so the newest
// value is always exact). Bucketed points also carry `sum` for column charts.
export function downsample(pts, max = MAX_POINTS, mode = 'last') {
  if (pts.length <= max) return pts;
  const size = Math.ceil(pts.length / max);
  const out = [];
  for (let i = pts.length; i > 0; i -= size) {
    const chunk = pts.slice(Math.max(0, i - size), i);
    const last = chunk[chunk.length - 1];
    out.unshift(mode === 'sum' ? { ...last, value: round2(chunk.reduce((a, p) => a + p.value, 0)) } : last);
  }
  return out;
}

export function earliest(pairs) {
  let min = today();
  for (const { item } of pairs) if (item.history[0] && item.history[0][0] < min) min = item.history[0][0];
  return min;
}

export const pairsOf = secs => secs.flatMap(sec => sec.items.map(item => ({ sec, item })));
export const netWorthSections = data => data.sections.filter(s => s.type === 'tracker' && s.tracker.netWorth && s.tracker.unit === 'currency');

export function valueOn(item, date) {
  let v = null;
  for (const [d, x] of item.history) { if (d <= date) v = x; else break; }
  return v;
}

// Compares only items that already existed `days` ago, so adding a new
// account doesn't masquerade as growth. Returns null if none did.
export function periodDelta(pairs, days = 30) {
  const start = addDays(today(), -days);
  let cur = 0, prev = 0, any = false;
  for (const { sec, item } of pairs) {
    const then = valueOn(item, start);
    if (then == null) continue;
    any = true;
    cur += signed(sec, item, item.value);
    prev += signed(sec, item, then);
  }
  return any ? { now: round2(cur), prev: round2(prev) } : null;
}

export function isStale(item, days) {
  return !item.updatedAt || now() - item.updatedAt > days * 86400000;
}

// 0..1 progress toward target; "lower is better" measures from the first value.
export function goalProgress(item, good) {
  if (!item.target) return null;
  if (good === 'down') {
    const start = item.history[0]?.[1] ?? item.value;
    if (start <= item.target) return item.value <= item.target ? 1 : 0;
    return Math.max(0, Math.min(1, (start - item.value) / (start - item.target)));
  }
  return Math.max(0, Math.min(1, item.value / item.target));
}

