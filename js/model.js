// Data model and all pure logic (no DOM) - unit tested in tests.js.
//
// Everything the user tracks is a *section* of one of two kinds:
//   tracker - named items holding one value each, with a dated history
//             (balances, followers, goals, weight...)
//   table   - rows with user-defined typed columns
//             (sales, orders, subscriptions, checklists, workouts...)
// A new kind of data never needs code: the user makes a section and picks columns.
//
// Sync-readiness for the connectors phase: every section/item/row has a stable
// id, an updatedAt and a `rev` counter bumped on each change. Sections and items
// carry a `source` ({kind:'manual'} or a connector; rows may carry one too -
// absent means manual). Hard deletes are recorded in `data.deleted`
// (tombstones); when old tombstones are pruned, `data.deletedBefore` records
// the cut-off so a device that last synced earlier knows to do a full resync.
//
// This file holds sections themselves: construction, templates, tombstones
// and normalization. The rest of the model lives in ./model/ by feature and
// is re-exported here, so callers import everything from model.js:
//   constants.js  limits, column kinds, headline modes
//   base.js       ids, rows, items, touch
//   formula.js    formula columns
//   tracker.js    tracker math
//   table.js      table math, typed input, CSV
//   merge.js      three-way merge between windows
//   sample.js     sample data
//   links.js      tracker items fed by a table column

import { sid, safeUrl } from './ui.js';
import {
  VERSION, PALETTE_SIZE, HARD_MAX_ROWS, MAX_HISTORY, MAX_DELETED, MAX_NAME, MAX_COL_NAME, UNITS, GOOD,
  COLUMN_TYPES, NUMERIC, GROUPABLE, MAX_TAGS, REMIND_DAYS, HEADLINE_MODES,
} from './model/constants.js';
import { clampStr, makeColumn, makeItem, newRow, uniqueName } from './model/base.js';
import { MAX_FORMULA, formulaToIds, formulaCycle } from './model/formula.js';
import { REPEATS, coerce } from './model/table.js';
import { LINK_AGGS } from './model/links.js';

export * from './model/constants.js';
export * from './model/base.js';
export * from './model/formula.js';
export * from './model/tracker.js';
export * from './model/table.js';
export * from './model/merge.js';
export * from './model/sample.js';
export * from './model/links.js';

const now = () => Date.now();

// ---------- construction ----------
function base(data, { name, icon, type, template }) {
  return {
    id: sid(), name, icon, type, template: template || 'custom',
    color: data ? data.sections.length % PALETTE_SIZE : 0,
    home: true, sample: false, source: { kind: 'manual' }, createdAt: now(), updatedAt: now(),
  };
}

export function makeTracker(data, { name, icon = 'trend', unit = 'number', netWorth = false, good = 'up', template }) {
  return { ...base(data, { name, icon, type: 'tracker', template }), tracker: { unit, netWorth, good }, items: [] };
}


export function makeTable(data, { name, icon = 'list', columns, headline = {}, breakdown = null, remind = null, template }) {
  const cols = columns.map(([n, type, options]) => makeColumn(n, type, Array.isArray(options) ? options : []));
  const byName = n => (n ? cols.find(c => c.name === n)?.id ?? null : null);
  // Formula columns are written with {Name} references in templates.
  columns.forEach(([, type, f], i) => { if (type === 'formula') cols[i].formula = formulaToIds(f, cols).text; });
  const section = {
    ...base(data, { name, icon, type: 'table', template }),
    table: {
      columns: cols,
      headline: { mode: headline.mode || 'count', column: byName(headline.column), dateColumn: byName(headline.date) },
      breakdown: { column: byName(breakdown) },
      remind: { column: byName(remind?.column), days: remind?.days || 7, repeat: remind?.repeat || 'none' },
    },
    rows: [],
  };
  fixHeadline(section);
  return section;
}

// ---------- shareable section templates ----------
// The setup of a section (never its rows/items), as a small JSON file.
export function templateFrom(sec) {
  const { id, rows, items, sample, source, createdAt, updatedAt, rev, ...setup } = structuredClone(sec);
  return { app: 'HQ', kind: 'section-template', v: 1, section: setup };
}

// Builds a new, empty section from a template file with fresh ids; every
// internal reference (formulas, headline, breakdown, reminders) is remapped.
export function sectionFromTemplate(data, obj) {
  if (!obj || obj.app !== 'HQ' || obj.kind !== 'section-template' || obj.v !== 1 || !obj.section) throw new Error("That file isn't an HQ section template.");
  const raw = { ...structuredClone(obj.section), items: [], rows: [] };
  const [sec] = normalize({ version: VERSION, sections: [raw] }).sections;
  if (!sec) throw new Error('That template is damaged.');
  Object.assign(sec, { id: sid(), template: 'custom', sample: false, color: data.sections.length % PALETTE_SIZE, source: { kind: 'manual' }, createdAt: now(), updatedAt: now(), rev: 0 });
  if (sec.type === 'table') {
    const map = new Map(sec.table.columns.map(c => [c.id, sid(8)]));
    const re = id => map.get(id) ?? null;
    for (const c of sec.table.columns) {
      if (c.type === 'formula') c.formula = String(c.formula || '').replace(/\{#([\w-]+)\}/g, (m, k) => (map.has(k) ? `{#${map.get(k)}}` : m));
      c.id = map.get(c.id);
    }
    const t = sec.table;
    t.headline = { ...t.headline, column: re(t.headline.column), dateColumn: re(t.headline.dateColumn) };
    t.breakdown = { column: re(t.breakdown.column) };
    t.remind = { ...t.remind, column: re(t.remind.column) };
    if (formulaCycle(t.columns)) throw new Error('That template has formulas that depend on each other in a loop.');
    fixHeadline(sec);
  }
  return sec;
}


const SECURITY_ITEMS = [
  'Two-factor authentication on your Apple Account',
  'Two-factor authentication (2-Step Verification) on Google',
  'Two-factor authentication on every bank account',
  'Two-step authentication on Shopify',
  'Two-step verification on TikTok',
  'Two-factor authentication on Instagram',
  'Ran Google Password Checkup and fixed flagged passwords',
  'Cleared iPhone Security Recommendations (Settings → Passwords)',
  'Recovery email and phone are current everywhere',
];

export const TEMPLATES = [
  { id: 'accounts', name: 'Bank accounts', icon: 'bank', desc: 'Checking, savings, cards and loans. Counts toward net worth.',
    make: d => makeTracker(d, { name: 'Bank accounts', icon: 'bank', unit: 'currency', netWorth: true, template: 'accounts' }) },
  { id: 'investments', name: 'Investments', icon: 'chart', desc: 'Brokerage, retirement, crypto. Counts toward net worth.',
    make: d => makeTracker(d, { name: 'Investments', icon: 'chart', unit: 'currency', netWorth: true, template: 'investments' }) },
  { id: 'social', name: 'Social media', icon: 'users', desc: 'Followers or subscribers per platform, tracked daily.',
    make: d => makeTracker(d, { name: 'Social media', icon: 'users', unit: 'number', template: 'social' }) },
  { id: 'sales', name: 'Store sales', icon: 'bag', desc: 'Daily orders and revenue for your store.',
    make: d => makeTable(d, { name: 'Store sales', icon: 'bag', template: 'sales',
      columns: [['Date', 'date'], ['Orders', 'number'], ['Revenue', 'currency'], ['Notes', 'text']],
      headline: { mode: 'period', column: 'Revenue', date: 'Date' } }) },
  { id: 'subscriptions', name: 'Subscriptions', icon: 'repeat', desc: 'What you pay for every month and when it renews.',
    make: d => makeTable(d, { name: 'Subscriptions', icon: 'repeat', template: 'subscriptions',
      columns: [['Name', 'text'], ['Monthly cost', 'currency'], ['Yearly cost', 'formula', '{Monthly cost} * 12'], ['Renews', 'date'], ['Category', 'select', ['Business', 'Personal', 'Entertainment', 'Software']], ['Link', 'url']],
      headline: { mode: 'sum', column: 'Monthly cost' }, breakdown: 'Category', remind: { column: 'Renews', days: 7, repeat: 'monthly' } }) },
  { id: 'goals', name: 'Goals', icon: 'target', desc: 'Savings goals with a target and progress bar.',
    make: d => makeTracker(d, { name: 'Goals', icon: 'target', unit: 'currency', template: 'goals' }) },
  { id: 'security', name: 'Security checklist', icon: 'shield', desc: '2FA and password health across your accounts.',
    make: d => {
      const s = makeTable(d, { name: 'Security checklist', icon: 'shield', template: 'security',
        columns: [['Item', 'text'], ['Done', 'checkbox'], ['Notes', 'text']], headline: { mode: 'progress', column: 'Done' } });
      const [item, done] = s.table.columns;
      s.rows = SECURITY_ITEMS.map(t => newRow({ [item.id]: t, [done.id]: false }));
      return s;
    } },
  { id: 'log', name: 'Daily log', icon: 'calendar', desc: 'A dated journal of anything: workouts, posts, hours worked.',
    make: d => makeTable(d, { name: 'Daily log', icon: 'calendar', template: 'log',
      columns: [['Date', 'date'], ['What', 'text'], ['Amount', 'number'], ['Notes', 'longtext']],
      headline: { mode: 'period', column: 'Amount', date: 'Date' } }) },
  { id: 'tracker', name: 'Blank tracker', icon: 'trend', desc: 'Any numbers you want to follow over time.',
    make: d => makeTracker(d, { name: 'New tracker', icon: 'trend', unit: 'number' }) },
  { id: 'table', name: 'Blank table', icon: 'list', desc: 'Your own columns for any kind of records.',
    make: d => makeTable(d, { name: 'New table', icon: 'list', columns: [['Name', 'text'], ['Date', 'date'], ['Amount', 'number'], ['Notes', 'text']], headline: { mode: 'count' } }) },
];
export const DEFAULT_TEMPLATES = ['accounts', 'investments', 'social', 'sales', 'subscriptions', 'security'];

export function blankData(name) {
  return {
    version: VERSION,
    profile: { name },
    settings: { currency: 'USD', autoLockMin: 5, staleDays: 7, privacy: false, theme: 'system' },
    sections: [],
    deleted: [],
    quarantine: [],
    connections: [],
    relay: { url: '', token: '', snapKey: null },
    createdAt: now(),
  };
}


// ---------- tombstones ----------
export function logDeletion(data, kind, id, sec = null) {
  data.deleted.push({ kind, id, sec, at: now() });
  if (data.deleted.length > MAX_DELETED) {
    const dropped = data.deleted.splice(0, data.deleted.length - MAX_DELETED);
    data.deletedBefore = Math.max(data.deletedBefore || 0, dropped[dropped.length - 1].at);
  }
}
export function unlogDeletion(data, id) {
  const i = data.deleted.findLastIndex(d => d.id === id);
  if (i >= 0) data.deleted.splice(i, 1);
}

// ---------- normalization & migration ----------
const ts = v => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null);

// Items and rows filled by a connection remember its external id, so a
// re-sync updates them instead of adding duplicates.
const rowSource = s => (s && typeof s.ext === 'string' && s.ext.length <= 100 ? { kind: 'connector', ext: s.ext } : null);
// A tracker item fed by a table column (see model/links.js).
const itemLink = l => (l && typeof l.sec === 'string' && /^[\w-]{1,64}$/.test(l.sec) && LINK_AGGS[l.agg] && (l.agg === 'count' || (typeof l.col === 'string' && /^[\w-]{1,64}$/.test(l.col)))
  ? { sec: l.sec, col: l.agg === 'count' ? null : l.col, agg: l.agg } : null);
const dedupeBySource = list => {
  const seen = new Set();
  return list.filter(x => !x.source || (!seen.has(x.source.ext) && seen.add(x.source.ext)));
};

// Every load goes through this so damaged or older data can't crash the UI.
/** @param {any} d anything read from storage or a backup  @returns {import('./model/types.js').Data} */
export function normalize(d) {
  if (!d || typeof d !== 'object') throw new Error('Vault contents are unreadable.');
  if (d.version === 1) d = migrateV1(d);
  if (d.version !== VERSION) throw new Error(`This vault was made by a newer version of HQ (v${d.version}).`);
  d.profile = { name: clampStr(d.profile?.name, 40, 'there') || 'there' };
  const s = d.settings || {};
  d.settings = {
    currency: /^[A-Z]{3}$/.test(s.currency) ? s.currency : 'USD',
    autoLockMin: [1, 5, 15, 30].includes(s.autoLockMin) ? s.autoLockMin : 5,
    staleDays: [1, 3, 7, 14, 30].includes(s.staleDays) ? s.staleDays : 7,
    privacy: !!s.privacy,
    theme: ['system', 'light', 'dark'].includes(s.theme) ? s.theme : 'system',
    syncHours: [0, 1, 3, 6, 12, 24].includes(s.syncHours) ? s.syncHours : 6,
  };
  d.deleted = Array.isArray(d.deleted) ? d.deleted.filter(x => x && typeof x.id === 'string').slice(-MAX_DELETED) : [];
  d.deletedBefore = Number.isFinite(d.deletedBefore) ? d.deletedBefore : null;
  // Live connections (see connectors.js). Credentials live only in here, i.e.
  // inside the encrypted vault.
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  d.connections = (Array.isArray(d.connections) ? d.connections : []).filter(c => c && typeof c.kind === 'string' && /^[a-z]{2,20}$/.test(c.kind)).slice(0, 50).map(c => ({
    id: typeof c.id === 'string' && /^[\w-]{1,64}$/.test(c.id) ? c.id : sid(),
    kind: c.kind,
    name: clampStr(c.name, MAX_NAME, 'Connection') || 'Connection',
    secrets: Object.fromEntries(Object.entries(c.secrets && typeof c.secrets === 'object' ? c.secrets : {}).filter(([k]) => /^[a-zA-Z]{1,30}$/.test(k)).map(([k, v]) => [k, str(v, 2000)])),
    target: typeof c.target === 'string' ? c.target : null,
    cursor: typeof c.cursor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.cursor) ? c.cursor : null,
    secretsAt: ts(c.secretsAt), // when its keys were last entered (some expire)
    status: { lastTry: ts(c.status?.lastTry), lastOk: ts(c.status?.lastOk), error: c.status?.error ? str(c.status.error, 200) : null, summary: c.status?.summary && typeof c.status.summary === 'object' ? { added: Number(c.status.summary.added) || 0, updated: Number(c.status.summary.updated) || 0, warning: c.status.summary.warning ? str(c.status.summary.warning, 200) : null } : null },
  }));
  // snapKey: the key pair the relay seals snapshots to (see snapshots.js).
  // The private half never leaves the vault.
  const sk = d.relay?.snapKey;
  const b64 = (v, lo, hi) => typeof v === 'string' && v.length >= lo && v.length <= hi && /^[\w-]+$/.test(v);
  const keyOk = sk && b64(sk.pub, 86, 88) && sk.priv?.kty === 'EC' && sk.priv.crv === 'P-256' && ['x', 'y', 'd'].every(p => b64(sk.priv[p], 40, 50));
  d.relay = {
    url: str(d.relay?.url, 300),
    token: str(d.relay?.token, 300),
    snapKey: keyOk ? { pub: sk.pub, priv: { kty: 'EC', crv: 'P-256', x: sk.priv.x, y: sk.priv.y, d: sk.priv.d } } : null,
  };
  // Sections set aside after failing an integrity check (see Vault.quarantine).
  d.quarantine = (Array.isArray(d.quarantine) ? d.quarantine : [])
    .filter(q => q && typeof q.id === 'string' && /^[\w-]{1,64}$/.test(q.id))
    .map(q => ({ id: q.id, title: clampStr(q.title, MAX_NAME, 'Untitled section'), problem: clampStr(q.problem, 120), at: ts(q.at) ?? now(), hash: typeof q.hash === 'string' ? q.hash : null, missing: !!q.missing || typeof q.hash !== 'string' }));
  d.createdAt = ts(d.createdAt) ?? now();
  const seen = new Set();
  d.sections = (Array.isArray(d.sections) ? d.sections : []).filter(x => x && (x.type === 'tracker' || x.type === 'table'));
  for (const sec of d.sections) {
    if (typeof sec.id !== 'string' || !/^[\w-]{1,64}$/.test(sec.id) || seen.has(sec.id)) sec.id = sid();
    seen.add(sec.id);
    sec.name = clampStr(sec.name, MAX_NAME, 'Untitled') || 'Untitled';
    sec.icon = typeof sec.icon === 'string' ? sec.icon : 'list';
    sec.template = typeof sec.template === 'string' ? sec.template : 'custom';
    sec.color = Number.isInteger(sec.color) ? ((sec.color % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE : 0;
    sec.home = sec.home !== false;
    sec.sample = !!sec.sample;
    sec.source = sec.source && typeof sec.source.kind === 'string' ? sec.source : { kind: 'manual' };
    sec.createdAt = ts(sec.createdAt) ?? now();
    sec.updatedAt = ts(sec.updatedAt) ?? sec.createdAt;
    sec.rev = Number.isInteger(sec.rev) ? sec.rev : 0;
    if (sec.type === 'tracker') {
      sec.tracker = { unit: UNITS[sec.tracker?.unit] ? sec.tracker.unit : 'number', netWorth: !!sec.tracker?.netWorth, good: GOOD[sec.tracker?.good] ? sec.tracker.good : 'up' };
      sec.items = (Array.isArray(sec.items) ? sec.items : []).filter(Boolean).map(it => ({
        id: typeof it.id === 'string' ? it.id : sid(), name: clampStr(it.name, MAX_NAME, 'Untitled') || 'Untitled', note: clampStr(it.note, 80),
        value: Number.isFinite(it.value) ? it.value : 0, liability: !!it.liability,
        target: Number.isFinite(it.target) && it.target > 0 ? it.target : null, source: rowSource(it.source), link: itemLink(it.link), updatedAt: ts(it.updatedAt), rev: Number.isInteger(it.rev) ? it.rev : 0,
        history: (Array.isArray(it.history) ? it.history : []).filter(p => Array.isArray(p) && /^\d{4}-\d{2}-\d{2}$/.test(p[0]) && Number.isFinite(p[1])).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-MAX_HISTORY),
      }));
      sec.items = dedupeBySource(sec.items);
    } else {
      sec.table = sec.table && typeof sec.table === 'object' ? sec.table : {};
      const names = new Set();
      sec.table.columns = (Array.isArray(sec.table.columns) ? sec.table.columns : []).filter(c => c && COLUMN_TYPES[c.type]).map(c => {
        const name = uniqueName(names, clampStr(c.name, MAX_COL_NAME, 'Column') || 'Column');
        names.add(name.toLowerCase());
        return {
          id: typeof c.id === 'string' && /^[\w-]{1,64}$/.test(c.id) ? c.id : sid(8), name, type: c.type,
          options: Array.isArray(c.options) ? c.options.map(String).slice(0, 100) : [],
          ...(c.type === 'formula' ? { formula: String(c.formula ?? '').slice(0, MAX_FORMULA) } : {}),
        };
      });
      const cols = sec.table.columns;
      const isCol = (id, types) => cols.some(c => c.id === id && types.has(c.type));
      sec.table.headline = sec.table.headline && typeof sec.table.headline === 'object' ? sec.table.headline : { mode: 'count' };
      const bd = sec.table.breakdown;
      sec.table.breakdown = { column: bd && isCol(bd.column, GROUPABLE) ? bd.column : null };
      const rm = sec.table.remind;
      sec.table.remind = { column: rm && isCol(rm.column, new Set(['date'])) ? rm.column : null, days: REMIND_DAYS.includes(rm?.days) ? rm.days : 7, repeat: REPEATS[rm?.repeat] ? rm.repeat : 'none' };
      sec.rows = (Array.isArray(sec.rows) ? sec.rows : []).filter(r => r && r.v && typeof r.v === 'object').slice(-HARD_MAX_ROWS).map(r => ({ ...r, id: typeof r.id === 'string' ? r.id : sid(), source: rowSource(r.source), v: conformCells(sec.table.columns, r.v), createdAt: ts(r.createdAt) ?? now(), updatedAt: ts(r.updatedAt) ?? now() }));
      sec.rows = dedupeBySource(sec.rows);
      fixHeadline(sec);
    }
  }
  return d;
}

function migrateV1(o) {
  const d = blankData(o.profile?.name || 'there');
  Object.assign(d.settings, o.settings || {});
  if (o.accounts?.length) {
    const s = makeTracker(d, { name: 'Accounts', icon: 'bank', unit: 'currency', netWorth: true, template: 'accounts' });
    s.items = o.accounts.map(a => ({ ...makeItem({ name: a.name, note: a.institution || '', value: a.balance, liability: a.type === 'credit' || a.type === 'loan' }), updatedAt: ts(a.updatedAt) }));
    d.sections.push(s);
  }
  const names = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube' };
  if (o.social?.some(p => p.followers)) {
    const s = makeTracker(d, { name: 'Social media', icon: 'users', template: 'social' });
    s.items = o.social.filter(p => p.followers).map(p => ({ ...makeItem({ name: names[p.id] || p.id, note: p.handle, value: p.followers }), history: (p.history || []).map(h => [h.date, h.value]) }));
    d.sections.push(s);
  }
  if (o.store?.daily?.length) {
    const s = TEMPLATES.find(t => t.id === 'sales').make(d);
    const [dc, oc, rc] = s.table.columns;
    s.rows = o.store.daily.map(x => newRow({ [dc.id]: x.date, [oc.id]: x.orders, [rc.id]: x.sales }));
    d.sections.push(s);
  }
  return d;
}

// Every cell matches its column's type, and cells of deleted columns are
// dropped. Values that already fit are returned untouched (same object if
// nothing changed), so this is cheap on every load.
const fits = {
  checkbox: v => typeof v === 'boolean',
  number: v => typeof v === 'number' && Number.isFinite(v),
  currency: v => typeof v === 'number' && Number.isFinite(v),
  date: v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v),
  url: v => typeof v === 'string' && !!safeUrl(v),
  tags: v => Array.isArray(v) && v.length > 0 && v.length <= MAX_TAGS && v.every(t => typeof t === 'string' && t && t.length <= 40),
};
export function conformCells(columns, v) {
  let out = null;
  const ids = new Set(columns.map(c => c.id));
  for (const k of Object.keys(v)) if (!ids.has(k)) { out ||= { ...v }; delete out[k]; }
  for (const c of columns) {
    const x = v[c.id];
    if (c.type === 'formula') { if (c.id in v) { out ||= { ...v }; delete out[c.id]; } continue; } // computed, never stored
    if (x == null || (fits[c.type] ? fits[c.type](x) : typeof x === 'string')) continue;
    const res = coerce(c, typeof x === 'boolean' ? (x ? 'yes' : '') : x);
    out ||= { ...v };
    out[c.id] = res.ok ? res.value : null;
  }
  return out || v;
}


// Keep headline references valid. Explicit user choices are kept when they
// still fit the mode; otherwise the first suitable column is used.
export function fixHeadline(sec) {
  const cols = sec.table.columns;
  const h = sec.table.headline;
  const fits = (id, pred) => cols.some(c => c.id === id && pred(c));
  if (!HEADLINE_MODES[h.mode]) h.mode = 'count';
  const wantCol = h.mode === 'progress' ? c => c.type === 'checkbox' : c => NUMERIC.has(c.type);
  if (!fits(h.column, wantCol)) h.column = null;
  if (!fits(h.dateColumn, c => c.type === 'date')) h.dateColumn = null;
  if (h.mode !== 'count') h.column ??= (h.mode === 'progress' ? cols.find(wantCol) : cols.find(c => c.type === 'currency') || cols.find(wantCol))?.id ?? null;
  if (h.mode === 'period') h.dateColumn ??= cols.find(c => c.type === 'date')?.id ?? null;
  if (h.mode === 'period' && h.column && !h.dateColumn) h.mode = 'sum';
  if (h.mode !== 'count' && !h.column) h.mode = 'count';
}

