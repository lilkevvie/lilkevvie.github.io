// Dependency-free SVG charts, built with the same auto-escaping html`` as the
// rest of the app. Colors come from CSS classes (c-0..c-7), never inline
// styles, so the strict CSP (style-src 'self') holds.
import { html, fmtDate, setHTML } from './ui.js';

function niceTicks(min, max, count) {
  if (min === max) { min -= Math.abs(min) * 0.1 || 1; max += Math.abs(max) * 0.1 || 1; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const err = raw / mag;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

const f1 = n => Math.round(n * 10) / 10;

// Points may stand for a day, a week (dated by its Monday) or a month.
const when = (date, bucket = 'day', style = 'long') => (bucket === 'month' ? fmtDate(date, { month: style === 'axis' ? 'short' : 'long', year: style === 'axis' ? '2-digit' : 'numeric' })
  : bucket === 'week' ? `${style === 'axis' ? '' : 'Week of '}${fmtDate(date, { month: 'short', day: 'numeric', ...(style === 'table' ? { year: 'numeric' } : {}) })}`
    : style === 'axis' ? fmtDate(date) : fmtDate(date, style === 'table' ? { year: 'numeric', month: 'short', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' }));
const tipHTML = (date, value, bucket) => html`<div class="tip-date">${when(date, bucket)}</div><div class="tip-val">${value}</div>`;

function placeTip(el, tip, px, py) {
  const w = el.clientWidth;
  const tw = tip.offsetWidth;
  tip.style.left = `${Math.max(0, Math.min(w - tw, px - tw / 2))}px`;
  tip.style.top = `${Math.max(-8, py - tip.offsetHeight - 12)}px`;
}

function tableFor(pts, fmt, label, sensitive, bucket) {
  return html`<details class="table-view"><summary>Show as table</summary><div class="scroll"><table><caption class="sr-only">${label}</caption>
    <thead><tr><th scope="col">${bucket === 'month' ? 'Month' : bucket === 'week' ? 'Week' : 'Date'}</th><th scope="col" class="r">Value</th></tr></thead>
    <tbody>${pts.slice().reverse().map(p => html`<tr><td>${when(p.date, bucket, 'table')}</td><td class="r num${sensitive ? ' amt' : ''}">${fmt(p)}</td></tr>`)}</tbody>
  </table></div></details>`;
}

// Hover/touch + keyboard (arrow keys) inspection for any chart.
function interact(svgEl, n, show, hide) {
  let idx = n - 1;
  const at = e => {
    const r = svgEl.getBoundingClientRect();
    return (e.clientX - r.left) / r.width;
  };
  svgEl.addEventListener('pointermove', e => show(at(e)));
  svgEl.addEventListener('pointerdown', e => show(at(e)));
  svgEl.addEventListener('pointerleave', hide);
  svgEl.addEventListener('focus', () => show(null, idx));
  svgEl.addEventListener('blur', hide);
  svgEl.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    idx = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : Math.max(0, Math.min(n - 1, idx + (e.key === 'ArrowLeft' ? -1 : 1)));
    show(null, idx);
  });
}

export function area(el, pts, o) {
  if (pts.length < 2) {
    setHTML(el, html`<div class="chart-empty">The trend appears once there are two days of history.</div>`);
    return;
  }
  const W = Math.max(240, el.clientWidth || 600);
  const H = o.height || 220;
  const pad = { t: 12, r: 10, b: 24, l: o.axisWidth ?? 54 };
  const vals = pts.map(p => p.value);
  let min = Math.min(...vals);
  const max = Math.max(...vals);
  if (o.zero) min = Math.min(0, min);
  const ticks = niceTicks(min, max, o.ticks || 3);
  const y0 = ticks[0];
  const y1 = ticks[ticks.length - 1];
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const last = pts.length - 1;
  const x = i => f1(pad.l + (i * iw) / last);
  const y = v => f1(pad.t + ih - ((v - y0) / (y1 - y0 || 1)) * ih);
  const base = pad.t + ih;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join('');
  const sens = o.sensitive ? ' amt' : '';

  setHTML(el, html`<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" class="c-${o.color}" role="img" tabindex="0" aria-label="${o.label}. Use arrow keys to read values.">
    ${ticks.map(t => html`<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text class="tick${sens}" x="${pad.l - 8}" y="${y(t)}" dy="0.32em" text-anchor="end">${o.fmtAxis(t)}</text>`)}
    <text class="tick" x="${x(0)}" y="${H - 6}" text-anchor="start">${fmtDate(pts[0].date)}</text>
    <text class="tick" x="${x(last)}" y="${H - 6}" text-anchor="end">${fmtDate(pts[last].date)}</text>
    <path class="area" d="${line}L${x(last)},${base}L${x(0)},${base}Z"/>
    <path class="line" d="${line}"/>
    <circle class="dot" cx="${x(last)}" cy="${y(pts[last].value)}" r="4"/>
    <g class="hover" visibility="hidden"><line class="cross" y1="${pad.t}" y2="${base}"/><circle class="dot" r="5"/></g>
  </svg><div class="chart-tip${sens}" hidden></div>${o.table === false ? '' : tableFor(pts, p => o.fmtValue(p.value), o.label, o.sensitive)}`);

  const svgEl = el.querySelector('svg');
  const g = el.querySelector('.hover');
  const [cross, dot] = g.children;
  const tip = el.querySelector('.chart-tip');
  interact(svgEl, pts.length, (frac, forced) => {
    const i = forced ?? Math.max(0, Math.min(last, Math.round(((frac * W) - pad.l) / (iw / last))));
    const cx = x(i), cy = y(pts[i].value);
    g.setAttribute('visibility', 'visible');
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx);
    dot.setAttribute('cx', cx); dot.setAttribute('cy', cy);
    tip.hidden = false;
    setHTML(tip, tipHTML(pts[i].date, o.fmtValue(pts[i].value)));
    const r = svgEl.getBoundingClientRect();
    placeTip(el, tip, cx * (r.width / W), cy * (r.height / H));
  }, () => { g.setAttribute('visibility', 'hidden'); tip.hidden = true; });
}

function barPath(x, top, w, base) {
  const h = base - top;
  if (h <= 0.5) return '';
  const r = Math.min(4, h, w / 2);
  return `M${f1(x)},${f1(base)}V${f1(top + r)}Q${f1(x)},${f1(top)} ${f1(x + r)},${f1(top)}H${f1(x + w - r)}Q${f1(x + w)},${f1(top)} ${f1(x + w)},${f1(top + r)}V${f1(base)}Z`;
}

export function columns(el, pts, o) {
  const W = Math.max(240, el.clientWidth || 600);
  const H = o.height || 200;
  const pad = { t: 12, r: 6, b: 24, l: o.axisWidth ?? 50 };
  const vals = pts.map(p => p.value);
  const lo = Math.min(0, ...vals);
  const ticks = niceTicks(lo, Math.max(...vals, lo + 1), 3);
  const y0 = ticks[0];
  const top = ticks[ticks.length - 1];
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const band = iw / pts.length;
  const bw = Math.min(24, Math.max(2, band - 2));
  const y = v => pad.t + ih - ((v - y0) / (top - y0 || 1)) * ih;
  const zero = y(0);
  const sens = o.sensitive ? ' amt' : '';
  const every = Math.ceil(pts.length / 5);
  const bars = pts.map((p, i) => {
    const bx = pad.l + i * band + (band - bw) / 2;
    return p.value >= 0 ? barPath(bx, y(p.value), bw, zero) : `M${f1(bx)},${f1(zero)}H${f1(bx + bw)}V${f1(y(p.value))}H${f1(bx)}Z`;
  });

  setHTML(el, html`<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" class="c-${o.color}" role="img" tabindex="0" aria-label="${o.label}. Use arrow keys to read values.">
    ${ticks.map(t => html`<line class="${t === 0 ? 'baseline' : 'grid'}" x1="${pad.l}" x2="${W - pad.r}" y1="${f1(y(t))}" y2="${f1(y(t))}"/><text class="tick${sens}" x="${pad.l - 8}" y="${f1(y(t))}" dy="0.32em" text-anchor="end">${o.fmtAxis(t)}</text>`)}
    ${bars.map((d, i) => (d ? html`<path class="bar" data-i="${i}" d="${d}"/>` : ''))}
    ${pts.map((p, i) => (i === pts.length - 1 || (i % every === 0 && pts.length - 1 - i >= every / 2)
      ? html`<text class="tick" x="${f1(pad.l + i * band + band / 2)}" y="${H - 6}" text-anchor="middle">${when(p.date, o.bucket, 'axis')}</text>` : ''))}
    <line class="cross hover-band" visibility="hidden" y1="${pad.t}" y2="${pad.t + ih}"/>
  </svg><div class="chart-tip${sens}" hidden></div>${o.table === false ? '' : tableFor(pts, o.fmtValue, o.label, o.sensitive, o.bucket)}`);

  const svgEl = el.querySelector('svg');
  const tip = el.querySelector('.chart-tip');
  const barEls = [...el.querySelectorAll('.bar')];
  const band$ = el.querySelector('.hover-band');
  interact(svgEl, pts.length, (frac, forced) => {
    const i = forced ?? Math.max(0, Math.min(pts.length - 1, Math.floor(((frac * W) - pad.l) / band)));
    const hit = barEls.find(b => Number(b.dataset.i) === i);
    barEls.forEach(b => b.classList.toggle('dim', b !== hit));
    const cx = f1(pad.l + i * band + band / 2);
    band$.setAttribute('x1', cx); band$.setAttribute('x2', cx);
    band$.setAttribute('visibility', hit ? 'hidden' : 'visible');
    tip.hidden = false;
    setHTML(tip, tipHTML(pts[i].date, o.fmtValue(pts[i]), o.bucket));
    const r = svgEl.getBoundingClientRect();
    placeTip(el, tip, cx * (r.width / W), Math.min(y(pts[i].value), zero) * (r.height / H));
  }, () => { barEls.forEach(b => b.classList.remove('dim')); band$.setAttribute('visibility', 'hidden'); tip.hidden = true; });
}

export function sparkline(values, color) {
  if (values.length < 2) return '';
  const W = 96, H = 28, p = 3;
  const min = Math.min(...values), max = Math.max(...values);
  const x = i => f1(p + (i * (W - 2 * p)) / (values.length - 1));
  const y = v => f1(H - p - ((v - min) / (max - min || 1)) * (H - 2 * p));
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('');
  const l = values.length - 1;
  return html`<svg class="spark c-${color}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true" focusable="false"><path class="line" d="${d}"/><circle class="dot" cx="${x(l)}" cy="${y(values[l])}" r="2.5"/></svg>`;
}
