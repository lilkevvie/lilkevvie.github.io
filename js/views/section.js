// A section's page: its header (with the Live chip) and, for trackers, the items.
import { html, $, icon, today, addDays, ago } from '../ui.js';
import * as M from '../model.js';
import * as Charts from '../charts.js';
import * as C from '../connectors.js';
import { S, section, unitFmt, amtIf } from '../store.js';
import { deltaHTML, summary, sampleBanner, rangeChips, seriesFor } from './common.js';
import { tableBody } from './table.js';
import { connStatus } from './settings.js';

export function viewSection(sec) {
  const conn = C.feeding(S.data, sec.id);
  const st = conn && connStatus(conn);
  const actions = html`${conn ? html`<button type="button" class="chip live${st.bad ? ' bad' : ''}" data-act="syncNow" data-id="${conn.id}" title="${conn.name}: ${st.text}. Click to sync now.">${icon(st.bad ? 'warn' : 'refresh')} ${conn.status?.error ? "Sync failed" : conn.status?.lastOk ? `Live · ${ago(conn.status.lastOk)}` : 'Live'}</button>` : ''}<button type="button" class="icon-btn" data-act="sectionSettings" data-sec="${sec.id}" aria-label="Section settings" title="Section settings">${icon('settings')}</button>`;
  return { title: sec.name, actions, body: sec.type === 'tracker' ? trackerBody(sec) : tableBody(sec) };
}

function trackerBody(sec) {
  const { unit, good, netWorth } = sec.tracker;
  const sensitive = unit === 'currency';
  const sm = summary(sec);
  const pairs = M.pairsOf([sec]);
  const hasHistory = sec.items.some(i => i.history.length > 1);
  if (hasHistory) {
    const pts = seriesFor(pairs);
    S.mounts.push(() => {
      const el = $('#sec-chart');
      if (el) Charts.area(el, pts, { color: sec.color, sensitive, label: `${sec.name} total over time`, fmtAxis: v => unitFmt(v, unit, { compact: true }), fmtValue: v => unitFmt(v, unit) });
    });
  }
  const staleDays = S.data.settings.staleDays;
  const start30 = addDays(today(), -30);
  const items = sec.items.map(it => {
    const then = M.valueOn(it, start30);
    const itemGood = netWorth && it.liability ? ({ up: 'down', down: 'up' }[good] || 'none') : good;
    const stale = M.isStale(it, staleDays);
    const prog = M.goalProgress(it, good);
    return html`<li><button type="button" class="row" data-act="editItem" data-sec="${sec.id}" data-id="${it.id}">
      <span class="row-main">
        <span class="row-title">${it.name}${netWorth && it.liability ? html` <span class="tag">Owed</span>` : ''}</span>
        <span class="row-sub">${it.link ? `${M.describeLink(S.data, it.link)} · ` : ''}${it.note ? `${it.note} · ` : ''}${stale ? html`<span class="stale">${icon('warn', 'warn-ico')} updated ${ago(it.updatedAt)}</span>` : `updated ${ago(it.updatedAt)}`}</span>
        ${prog != null ? html`<span class="goal"><progress class="c-${sec.color}" max="100" value="${Math.round(prog * 100)}" aria-label="Progress toward target"></progress><span class="small muted">${Math.round(prog * 100)}% of ${amtIf(unitFmt(it.target, unit), sensitive)}</span></span>` : ''}
      </span>
      ${it.history.length > 1 ? Charts.sparkline(it.history.slice(-30).map(p => p[1]), sec.color) : ''}
      <span class="row-end"><span class="row-val">${amtIf(unitFmt(it.value, unit), sensitive)}</span>${then != null ? deltaHTML(it.value, then, { unit, good: itemGood, period: '30d', sensitive }) : ''}</span>
    </button></li>`;
  });

  return html`
    ${sec.sample ? sampleBanner() : ''}
    <section class="card hero">
      <div class="hero-head">
        <div><h2 class="label">${sm.label}</h2><p class="hero-value">${sm.empty ? '—' : sm.value}</p>${sm.delta || ''}</div>
        <div class="hero-side">
          <div class="btn-row">
            <button type="button" class="btn" data-act="addItem" data-sec="${sec.id}">${icon('plus')} Add item</button>
            ${sec.items.length ? html`<button type="button" class="btn primary" data-act="dailyUpdate" data-sec="${sec.id}">${icon('refresh')} Update values</button>` : ''}
          </div>
          ${hasHistory ? rangeChips() : ''}
        </div>
      </div>
      ${hasHistory ? html`<div id="sec-chart" class="chart"></div>` : ''}
    </section>
    ${sec.items.length ? html`<section class="card list-card" aria-labelledby="items-h-${sec.id}"><h2 id="items-h-${sec.id}" class="sr-only">Items</h2><ul class="rows" role="list">${items}</ul></section>` : html`
      <section class="card empty"><span class="badge lg c-${sec.color}">${icon(sec.icon)}</span><h2>Nothing tracked yet</h2>
      <p class="muted">Add an item for each thing you want to follow${netWorth ? ', such as an account or a card' : ''}. Update its value whenever it changes and HQ draws the trend.</p>
      <button type="button" class="btn primary" data-act="addItem" data-sec="${sec.id}">${icon('plus')} Add first item</button></section>`}`;
}
