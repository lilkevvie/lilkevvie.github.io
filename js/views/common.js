// Pieces several pages share: summaries, deltas, range chips, the sample banner, section links.
import { html, icon, today, addDays } from '../ui.js';
import * as M from '../model.js';
import * as Charts from '../charts.js';
import { S, unitFmt, amtIf } from '../store.js';

export const secHref = s => `#/s/${encodeURIComponent(s.id)}`;

// ---------- summaries shared by Home cards and section headers ----------
export function deltaHTML(now, prev, { unit, good = 'up', period, sensitive }) {
  if (prev == null) return '';
  const d = Math.round((now - prev) * 100) / 100;
  if (!d) return html`<span class="delta flat">No change ${period}</span>`;
  const up = d > 0;
  const tone = good === 'none' ? 'flat' : (up === (good === 'up') ? 'good' : 'bad');
  const pct = prev ? ` (${Math.abs((d / prev) * 100).toFixed(1)}%)` : '';
  return html`<span class="delta ${tone}">${icon(up ? 'up' : 'down')}<span class="sr-only">${up ? 'Up' : 'Down'}</span>${amtIf(`${unitFmt(d, unit, { sign: true, compact: true })}${pct}`, sensitive)} <span class="muted">${period}</span></span>`;
}

export function summary(sec, days = 30) {
  if (sec.type === 'tracker') {
    const { unit, good } = sec.tracker;
    const sensitive = unit === 'currency';
    const pairs = M.pairsOf([sec]);
    const dl = M.periodDelta(pairs, days);
    return {
      value: amtIf(unitFmt(M.trackerTotal(sec), unit), sensitive),
      label: sec.tracker.netWorth && sec.items.some(i => i.liability) ? 'Net total' : 'Total',
      delta: dl ? deltaHTML(dl.now, dl.prev, { unit, good, period: `${days} days`, sensitive }) : '',
      spark: sec.items.some(i => i.history.length > 1) ? Charts.sparkline(M.trackerSeries(pairs, addDays(today(), -(days - 1)), today()).map(p => p.value), sec.color) : '',
      empty: !sec.items.length,
    };
  }
  const h = M.tableHeadline(sec, days);
  if (h.kind === 'progress') {
    return {
      value: html`${h.done} <span class="of">of ${h.total}</span>`,
      label: h.label,
      progress: html`<progress class="c-${sec.color}" max="${h.total || 1}" value="${h.done}" aria-label="${h.done} of ${h.total} checked"></progress>`,
      empty: !sec.rows.length,
    };
  }
  const sensitive = h.unit === 'currency';
  return {
    value: amtIf(unitFmt(h.value, h.unit), sensitive),
    label: h.label,
    delta: deltaHTML(h.value, h.prev, { unit: h.unit, good: 'up', period: `vs prior ${days}`, sensitive }),
    spark: h.series ? Charts.sparkline(h.series.map(p => p.value), sec.color) : '',
    empty: !sec.rows.length,
  };
}

// ---------- pages ----------
export function sampleBanner() {
  if (!S.data.sections.some(s => s.sample)) return '';
  return html`<div class="banner" role="note">${icon('warn')}<p><strong>Some sections contain sample data.</strong> Look around, then clear it. Your sections and columns stay, ready for real numbers.</p><button type="button" class="btn" data-act="clearSample">Clear sample data</button></div>`;
}

export function rangeChips() {
  return html`<div class="chips" role="group" aria-label="Time range">${[[30, '30D'], [90, '90D'], [365, '1Y'], [0, 'All']].map(([d, l]) =>
    html`<button type="button" class="chip ${S.range === d ? 'on' : ''}" aria-pressed="${S.range === d}" data-act="range" data-v="${d}">${l}</button>`)}</div>`;
}

export function seriesFor(pairs) {
  const start = S.range ? addDays(today(), -(S.range - 1)) : M.earliest(pairs);
  return M.downsample(M.trackerSeries(pairs, start, today()));
}
