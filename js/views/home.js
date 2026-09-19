// Home (net worth, coming up, every section at a glance) and the sections list.
import { html, $, icon, fmtDate, ago, LOCALE } from '../ui.js';
import * as M from '../model.js';
import * as Charts from '../charts.js';
import { S, section, money, plural } from '../store.js';
import { deltaHTML, summary, sampleBanner, rangeChips, seriesFor, secHref } from './common.js';
import { rowLabel } from './table.js';

export function viewHome() {
  const d = S.data;
  const nwPairs = M.pairsOf(M.netWorthSections(d));
  const staleDays = d.settings.staleDays;
  const stale = d.sections.filter(s => s.type === 'tracker').flatMap(s => s.items.filter(i => M.isStale(i, staleDays)).map(i => ({ s, i })));
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  let hero = '';

  if (nwPairs.length) {
    const net = nwPairs.reduce((a, { sec, item }) => a + M.signed(sec, item, item.value), 0);
    const dl = M.periodDelta(nwPairs, 30);
    const pts = seriesFor(nwPairs);
    S.mounts.push(() => {
      const el = $('#nw-chart');
      if (el) Charts.area(el, pts, { color: 0, sensitive: true, label: 'Net worth over time', fmtAxis: v => money(v, { compact: true }), fmtValue: v => money(v) });
    });
    hero = html`
      <section class="card hero" aria-labelledby="nw-h">
        <div class="hero-head">
          <div><h2 id="nw-h" class="label">Net worth</h2><p class="hero-value"><span class="amt">${money(net)}</span></p>${dl ? deltaHTML(dl.now, dl.prev, { unit: 'currency', period: 'vs 30 days ago', sensitive: true }) : ''}</div>
          <div class="hero-side"><button type="button" class="btn primary" data-act="dailyUpdate">${icon('refresh')} Daily update</button>${rangeChips()}</div>
        </div>
        <div id="nw-chart" class="chart"></div>
      </section>`;
  }

  const cards = d.sections.filter(s => s.home).map(s => {
    const sm = summary(s);
    return html`<a class="card sec-card" href="${secHref(s)}">
      <span class="sec-card-head"><span class="badge c-${s.color}">${icon(s.icon)}</span><span class="sec-name">${s.name}</span>${s.sample ? html`<span class="tag">Sample</span>` : ''}</span>
      ${sm.empty ? html`<span class="muted small">Empty. Open it to add data.</span>` : html`
        <span class="label">${sm.label}</span>
        <span class="value">${sm.value}</span>
        ${sm.progress || ''}
        <span class="sec-card-foot">${sm.delta || ''}${sm.spark || ''}</span>`}
    </a>`;
  });

  return {
    title: 'Home',
    body: html`
      <p class="greeting">${greet}, ${d.profile.name}. <span class="muted">${new Date().toLocaleDateString(LOCALE, { weekday: 'long', month: 'long', day: 'numeric' })}</span></p>
      ${S.updateReady ? html`<div class="banner" role="note">${icon("refresh")}<p><strong>A new version of HQ is ready.</strong> Your data is saved first, then HQ reloads.</p><button type="button" class="btn primary" data-act="applyUpdate">Update now</button></div>` : ""}
      ${sampleBanner()}
      ${hero}
      ${stale.length ? html`<section class="card attention" aria-labelledby="stale-h">
        <div class="card-head"><h2 id="stale-h">${icon('warn', 'warn-ico')} ${plural(stale.length, 'value')} not updated in ${staleDays}+ days</h2><button type="button" class="btn small" data-act="dailyUpdate" data-v="stale">Update now</button></div>
        <p class="muted small">${stale.slice(0, 6).map(x => `${x.i.name} (${x.s.name})`).join(' · ')}${stale.length > 6 ? ` +${stale.length - 6} more` : ''}</p>
      </section>` : ''}
      ${comingUp()}
      <div class="sec-grid">
        ${cards}
        <button type="button" class="card sec-card add-card" data-act="newSection">${icon('plus')}<span>New section</span><span class="muted small">Track anything: pick a template or build your own columns</span></button>
      </div>`,
  };
}

// Reminders from every table with a reminder date column.
function comingUp() {
  const list = M.upcoming(S.data);
  if (!list.length) return '';
  const when = d => (d < 0 ? `${plural(-d, 'day')} overdue` : d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : `In ${d} days`);
  return html`<section class="card" aria-labelledby="up-h">
    <div class="card-head"><h2 id="up-h">${icon('calendar')} Coming up</h2><span class="muted small">${plural(list.length, 'reminder')}</span></div>
    <ul class="rows" role="list">${list.slice(0, 8).map(x => html`<li><button type="button" class="row" data-act="editRow" data-sec="${x.sec.id}" data-id="${x.row.id}">
      <span class="badge sm c-${x.sec.color}">${icon(x.sec.icon)}</span>
      <span class="row-main"><span class="row-title">${rowLabel(x.sec, x.row)}</span><span class="row-sub">${x.sec.name} · ${x.col.name} ${fmtDate(x.date, { month: 'short', day: 'numeric' })}</span></span>
      <span class="due ${x.days < 0 ? 'overdue' : 'soon'}">${x.days < 0 ? icon('warn', 'warn-ico') : ''}${when(x.days)}</span>
    </button></li>`)}</ul>
    ${list.length > 8 ? html`<p class="muted small pad">+${list.length - 8} more</p>` : ''}
  </section>`;
}

export function viewSections() {
  return {
    title: 'Sections',
    body: html`
      ${sampleBanner()}
      <ul class="card rows" role="list">
        ${S.data.sections.map(s => {
          const sm = summary(s);
          return html`<li><a class="row" href="${secHref(s)}">
            <span class="badge c-${s.color}">${icon(s.icon)}</span>
            <span class="row-main"><span class="row-title">${s.name}</span><span class="row-sub">${s.type === 'tracker' ? plural(s.items.length, 'item') : plural(s.rows.length, 'row')}</span></span>
            <span class="row-end"><span class="row-val">${sm.empty ? '' : sm.value}</span></span>${icon('chevron', 'chev')}
          </a></li>`;
        })}
        <li><button type="button" class="row add-row" data-act="newSection"><span class="badge dashed">${icon('plus')}</span><span class="row-main"><span class="row-title">New section</span><span class="row-sub">Template or fully custom</span></span></button></li>
      </ul>`,
  };
}
