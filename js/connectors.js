// Live connections: pull numbers from your accounts into sections, on unlock
// and every few hours while HQ is open.
//
// Each connection's credentials are stored inside the encrypted vault like
// everything else and are only ever sent to that service (or to your own
// relay). Two kinds of connector:
//   direct - the service allows calls from a web page (YouTube, Instagram)
//   relay  - the service only allows server calls (Shopify Admin, bank
//            aggregators, TikTok). HQ talks to a tiny relay YOU deploy
//            (relay/worker.js, a free Cloudflare Worker) that holds those
//            API keys; HQ only holds the relay's own access token. The relay
//            also takes a snapshot every few hours, so days when HQ wasn't
//            opened are filled in on the next sync.
//
// Connectors return plain values; applyResult() upserts them into the target
// section by a stable external id, so re-syncing never duplicates anything.

import { today, addDays, round2 } from './ui.js';
import * as M from './model.js';
import { openAll } from './snapshots.js';

export const SYNC_HOURS = [0, 1, 3, 6, 12, 24];
export const GRAPH_VERSION = 'v23.0'; // Meta Graph API; bump when Meta retires it
const TIMEOUT_MS = 20000;
const MAX_BYTES = 2 * 1024 * 1024;
const DAY = 86400000;

// ---------- safe fetch ----------
// https only, no cookies, no referrer (unless a service needs the origin to
// check a key restriction), timeout, streamed size cap, JSON only.
/** @param {string} url @param {{method?: string, headers?: Record<string,string>, body?: any, referrerPolicy?: ReferrerPolicy, fetchImpl?: typeof fetch}} [opts] @returns {Promise<any>} */
export async function fetchJSON(url, { method = 'GET', headers = {}, body, referrerPolicy = 'no-referrer', fetchImpl = fetch } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new Error('The address is not valid.'); }
  if (u.protocol !== 'https:') throw new Error('Only https:// addresses are allowed.');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res, text;
  try {
    try {
      res = await fetchImpl(u.href, { method, headers, body, credentials: 'omit', referrerPolicy, cache: 'no-store', redirect: 'error', signal: ctl.signal });
    } catch (e) {
      throw new Error(e?.name === 'AbortError' ? 'The service took too long to answer.' : 'Couldn’t reach the service (offline, blocked, or the address is wrong).');
    }
    text = await readCapped(res, ctl);
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = json?.error?.message || json?.error_description || json?.error || json?.message;
    throw new Error(res.status === 401 || res.status === 403 ? `Access was refused (${res.status}). Check the key or token${typeof msg === 'string' ? ` (“${msg.slice(0, 120)}”)` : ''}.` : `The service answered ${res.status}${typeof msg === 'string' ? `: ${msg.slice(0, 160)}` : ''}.`);
  }
  if (json == null) throw new Error('The service didn’t send JSON.');
  return json;
}

// Reads at most MAX_BYTES: a declared oversize body is refused up front and
// a streamed one is cut off as soon as it passes the cap.
async function readCapped(res, ctl) {
  const tooBig = () => { ctl.abort(); return new Error('The service sent more data than expected.'); };
  if (Number(res.headers?.get?.('content-length')) > MAX_BYTES) throw tooBig();
  const reader = res.body?.getReader?.();
  if (!reader) {
    const t = await res.text();
    if (t.length > MAX_BYTES) throw tooBig();
    return t;
  }
  const dec = new TextDecoder();
  let size = 0, out = '';
  for (;;) {
    let chunk;
    try { chunk = await reader.read(); } catch { throw new Error('The service took too long to answer.'); }
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_BYTES) { reader.cancel().catch(() => {}); throw tooBig(); }
    out += dec.decode(chunk.value, { stream: true });
  }
  return out + dec.decode();
}

const num = v => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const need = (v, what) => { if (v == null) throw new Error(`The service didn’t return ${what}.`); return v; };
const isDay = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

// Every relay call carries this device's time zone, so the relay dates its
// snapshots by your calendar day rather than UTC's.
export const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
function relayCall(data, path, fetchImpl) {
  const r = data.relay || {};
  if (!r.url || !r.token) throw new Error('Set up your relay first (Settings → Connections → Relay).');
  const tz = `${path.includes('?') ? '&' : '?'}tz=${encodeURIComponent(localZone())}`;
  return fetchJSON(`${r.url.replace(/\/+$/, '')}${path}${tz}`, { headers: { Authorization: `Bearer ${r.token}` }, fetchImpl });
}
// Snapshots since the last sync (the relay keeps up to a year).
const sinceParam = conn => `since=${encodeURIComponent(conn.cursor || addDays(today(), -30))}`;

// Opens the relay's sealed snapshots with the private key in the vault.
// Without a key (snapshots off) there are none; ones that won't open (the
// key was replaced) are skipped and reported.
async function snapshotsIn(data, source, j) {
  const history = Array.isArray(j?.history) ? j.history : [];
  if (!history.length) return { opened: [], warning: null };
  const priv = data.relay?.snapKey?.priv;
  if (!priv) return { opened: [], warning: 'The relay sent snapshots, but this vault has no snapshot key. Create one under Relay.' };
  const { opened, failed } = await openAll(priv, source, history);
  return { opened, warning: failed ? `${failed} snapshot${failed === 1 ? '' : 's'} couldn’t be opened (made with a different key) and were skipped.` : null };
}

// ---------- connector kinds ----------
// fields: shown in the add/edit form; `secret` fields are never shown again.
// target/unit/netWorth/columns: which sections it can fill (see fits()).
// template: section template to create when the user picks "new section".
// expiresDays: the service's key lifetime, for a renewal reminder.
export const KINDS = {
  youtube: {
    name: 'YouTube channel', mode: 'direct', target: 'tracker', unit: 'number', template: 'social',
    help: 'Uses a YouTube Data API key (Google Cloud Console → APIs & Services → Credentials). Restrict it to the YouTube Data API v3 and, under “Website restrictions”, to your HQ address. HQ sends YouTube only its site address (never the page) so that restriction works.',
    fields: [
      { key: 'apiKey', label: 'API key', secret: true },
      { key: 'channelId', label: 'Channel ID (starts with UC)', pattern: '^UC[\\w-]{20,30}$' },
    ],
    async run(conn, { fetchImpl }) {
      const { apiKey, channelId } = conn.secrets;
      // Website-restricted keys are checked against the Referer, so send
      // the origin (not the path or #route) for this call only.
      const j = await fetchJSON(`https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${encodeURIComponent(channelId)}&key=${encodeURIComponent(apiKey)}`, { fetchImpl, referrerPolicy: 'strict-origin' });
      const ch = need(j.items?.[0], 'that channel');
      const subs = need(num(ch.statistics?.subscriberCount), 'a subscriber count');
      return { items: [{ ext: `yt:${channelId}`, name: 'YouTube', note: String(ch.snippet?.title || '').slice(0, 60), value: subs }] };
    },
  },
  instagram: {
    name: 'Instagram (Business or Creator)', mode: 'direct', target: 'tracker', unit: 'number', template: 'social', expiresDays: 60,
    help: 'Uses Meta’s official Graph API: an Instagram professional account linked to a Facebook Page, and a long-lived access token from a Meta developer app. Those tokens last 60 days; HQ reminds you to paste a new one.',
    fields: [
      { key: 'accessToken', label: 'Access token', secret: true },
      { key: 'userId', label: 'Instagram user ID (numbers)', pattern: '^\\d{5,25}$' },
    ],
    async run(conn, { fetchImpl }) {
      const { accessToken, userId } = conn.secrets;
      const j = await fetchJSON(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(userId)}?fields=username,followers_count&access_token=${encodeURIComponent(accessToken)}`, { fetchImpl });
      return { items: [{ ext: `ig:${userId}`, name: 'Instagram', note: j.username ? `@${String(j.username).slice(0, 40)}` : '', value: need(num(j.followers_count), 'a follower count') }] };
    },
  },
  tiktok: {
    name: 'TikTok', mode: 'relay', target: 'tracker', unit: 'number', template: 'social',
    help: 'Through your relay (TikTok only allows server calls). Set the TikTok keys on the relay. Days when HQ wasn’t open are filled in from the relay’s snapshots.',
    fields: [],
    async run(conn, { data, fetchImpl }) {
      const j = await relayCall(data, `/tiktok/user?${sinceParam(conn)}`, fetchImpl);
      const { opened, warning } = await snapshotsIn(data, 'tiktok', j);
      const history = opened.filter(h => num(h.follower_count) != null).map(h => [h.date, num(h.follower_count)]);
      return {
        items: [{ ext: 'tt:me', name: 'TikTok', note: j.display_name ? String(j.display_name).slice(0, 60) : '', value: need(num(j.follower_count), 'a follower count'), history }],
        cursor: today(),
        warning,
      };
    },
  },
  shopify: {
    name: 'Shopify store sales', mode: 'relay', target: 'table', template: 'sales', columns: ['Date', 'Orders', 'Revenue'],
    help: 'Through your relay, with a read-only Admin API token (scope: read_orders). Fills one row per day with orders and revenue; days since the last sync are filled in too.',
    fields: [],
    async run(conn, { data, fetchImpl }) {
      const since = conn.cursor || addDays(today(), -90);
      const j = await relayCall(data, `/shopify/daily?since=${encodeURIComponent(since)}`, fetchImpl);
      const days = Array.isArray(j.days) ? j.days : need(null, 'daily sales');
      const rows = days.filter(d => isDay(d?.date)).map(d => ({
        ext: `shop:${d.date}`, values: { Date: d.date, Orders: num(d.orders) ?? 0, Revenue: round2(num(d.revenue) ?? 0) },
      }));
      return {
        rows,
        cursor: addDays(today(), -2), // re-read the last 2 days: late orders/refunds
        warning: j.truncated ? `Only the first ${Number(j.counted) || 'several thousand'} orders were counted; some days are incomplete.` : null,
      };
    },
  },
  banks: {
    name: 'Bank & card balances', mode: 'relay', target: 'tracker', unit: 'currency', netWorth: true, template: 'accounts',
    help: 'Through your relay, using SimpleFIN Bridge or Plaid (set up on the relay). Read-only: balances can be seen, money can never be moved. You connect your banks on SimpleFIN’s or Plaid’s own pages; HQ never sees bank passwords. Days when HQ wasn’t open are filled in from the relay’s snapshots.',
    fields: [],
    async run(conn, { data, fetchImpl }) {
      const j = await relayCall(data, `/banks/accounts?${sinceParam(conn)}`, fetchImpl);
      const { opened, warning } = await snapshotsIn(data, 'banks', j);
      return { items: bankItems(j, opened), cursor: today(), warning };
    },
  },
  // Any JSON API you list on your relay (CUSTOM_SOURCES): new data sources
  // without new code. HQ only ever names the source; the address and its
  // keys live on the relay.
  custom: {
    name: 'Your own source → numbers', mode: 'relay', target: 'tracker', unit: null, template: 'tracker',
    help: 'Reads any JSON API you list under CUSTOM_SOURCES on your relay (see the README). Point to a number, e.g. data.followers, and it becomes one item named after this connection. Point to an object of numbers, e.g. data.stats, and each becomes its own item.',
    fields: [
      { key: 'source', label: 'Source name on the relay', pattern: '^[a-z0-9-]{1,40}$' },
      { key: 'path', label: 'Path to the number(s), e.g. data.followers (blank = the whole answer)', optional: true, pattern: '^[^\\s]{0,200}$' },
    ],
    async run(conn, { data, fetchImpl }) {
      const { source, path = '' } = conn.secrets;
      const j = await relayCall(data, `/custom/${encodeURIComponent(source)}`, fetchImpl);
      const v = pathIn(j?.data, path);
      if (num(v) != null) return { items: [{ ext: `custom:${source}:${path}`, name: conn.name.slice(0, 60), value: num(v) }] };
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const items = Object.entries(v).filter(([, x]) => num(x) != null).slice(0, 100).map(([k, x]) => ({ ext: `custom:${source}:${path}.${k}`, name: k.slice(0, 60), value: num(x) }));
        if (items.length) return { items };
      }
      throw new Error(`Nothing numeric at “${path || '(the whole answer)'}”. Check the path.`);
    },
  },
  customrows: {
    name: 'Your own source → table rows', mode: 'relay', target: 'table', columns: [], template: 'table',
    help: 'Reads any JSON API you list under CUSTOM_SOURCES on your relay. Point to a list of objects, e.g. data.orders; each becomes a row, and properties fill the columns with the same names. The ID property keeps rows from being added twice.',
    fields: [
      { key: 'source', label: 'Source name on the relay', pattern: '^[a-z0-9-]{1,40}$' },
      { key: 'path', label: 'Path to the list, e.g. data.orders (blank = the whole answer)', optional: true, pattern: '^[^\\s]{0,200}$' },
      { key: 'idKey', label: 'ID property of each item, e.g. id or date', pattern: '^[^\\s]{1,60}$' },
    ],
    async run(conn, { data, fetchImpl }) {
      const { source, path = '', idKey } = conn.secrets;
      const j = await relayCall(data, `/custom/${encodeURIComponent(source)}`, fetchImpl);
      const list = pathIn(j?.data, path);
      if (!Array.isArray(list)) throw new Error(`There’s no list at “${path || '(the whole answer)'}”. Check the path.`);
      const rows = list.filter(o => o && typeof o === 'object' && o[idKey] != null && typeof o[idKey] !== 'object').slice(0, 5000).map(o => ({
        ext: `custom:${source}:${String(o[idKey]).slice(0, 60)}`,
        values: Object.fromEntries(Object.entries(o).filter(([, x]) => x == null || ['string', 'number', 'boolean'].includes(typeof x) || Array.isArray(x))),
      }));
      return { rows, warning: rows.length < list.length ? `${list.length - rows.length} item(s) had no “${idKey}” and were skipped.` : null };
    },
  },
};

// "data.items.0.value" → that value; blank path → the whole object.
export function pathIn(obj, path) {
  let v = obj;
  for (const k of String(path || '').split('.').filter(Boolean)) {
    if (v == null || typeof v !== 'object' || !Object.hasOwn(v, k)) return undefined;
    v = v[k];
  }
  return v;
}

// Relay bank endpoints return signed balances from your point of view
// (positive = yours, negative = owed): { accounts: [{ id, name, org, balance }] },
// plus sealed snapshots that open to { date, accounts: [{ id, balance }] }.
// A card you overpaid is therefore an asset, not a debt.
function bankItems(j, snapshots = []) {
  const list = Array.isArray(j?.accounts) ? j.accounts : need(null, 'accounts');
  const past = new Map();
  for (const snap of snapshots) {
    if (!isDay(snap?.date) || !Array.isArray(snap.accounts)) continue;
    for (const a of snap.accounts) {
      if (a?.id == null || num(a.balance) == null) continue;
      const k = String(a.id);
      if (!past.has(k)) past.set(k, []);
      past.get(k).push([snap.date, num(a.balance)]);
    }
  }
  return list.filter(a => a && a.id != null && num(a.balance) != null).slice(0, 200).map(a => {
    const bal = num(a.balance);
    const owed = bal < 0;
    return {
      ext: `bank:${String(a.id).slice(0, 80)}`,
      name: String(a.name || 'Account').slice(0, 60),
      note: String(a.org || '').slice(0, 80),
      value: round2(Math.abs(bal)),
      liability: owed,
      // Past points are stored the same way as the current one (a positive
      // amount, owed or not); a sign flip between then and now is rare.
      history: (past.get(String(a.id)) || []).filter(([, v]) => (v < 0) === owed).map(([d, v]) => [d, round2(Math.abs(v))]),
    };
  });
}

// ---------- applying results ----------
// Upserts by external id (item.source.ext / row.source.ext). Returns a short summary.
/** @param {import('./model/types.js').Section} sec @param {{items?: Array<{ext: string, name: string, note?: string, value: number, liability?: boolean, history?: Array<[string, number]>}>, rows?: Array<{ext: string, values: Record<string, unknown>}>}} result @param {string} [t] @returns {{added: number, updated: number, skipped?: number, warning?: string}} */
export function applyResult(sec, result, t = today()) {
  let added = 0, updated = 0, skipped = 0;
  if (sec.type === 'tracker') {
    const oldest = M.EARLIEST();
    for (const r of result.items || []) {
      // An item you've been updating by hand with the same name is taken
      // over, so its history continues instead of starting a duplicate.
      let it = sec.items.find(i => i.source?.ext === r.ext)
        || sec.items.find(i => !i.source?.ext && !i.link && i.name.toLowerCase() === r.name.toLowerCase());
      if (it && !it.source?.ext) it.source = { kind: 'connector', ext: r.ext };
      if (!it) {
        it = M.makeItem({ name: r.name, note: r.note, value: r.value, liability: !!r.liability });
        it.history = [];
        it.source = { kind: 'connector', ext: r.ext };
        sec.items.push(it);
        added++;
      } else {
        if (r.note) it.note = r.note;
        if (sec.tracker.netWorth && r.liability != null) it.liability = !!r.liability;
        if (Math.round(it.value * 100) !== Math.round(r.value * 100)) updated++;
      }
      // Snapshots from days HQ wasn't open (the relay's), then today's value.
      for (const [d, v] of r.history || []) if (d < t && d >= oldest) M.recordValue(it, v, d);
      M.recordValue(it, r.value, t); // also marks it as checked today, so it isn't flagged stale
    }
  } else {
    const byName = new Map(sec.table.columns.map(c => [c.name.toLowerCase(), c]));
    // One lookup table per sync (not a scan per row), and never past the
    // table's limit: rows that don't fit are counted and reported instead.
    const byExt = new Map(sec.rows.filter(x => x.source?.ext).map(x => [x.source.ext, x]));
    let room = M.MAX_ROWS - sec.rows.length;
    for (const r of result.rows || []) {
      const v = {};
      for (const [name, val] of Object.entries(r.values || {})) {
        const col = byName.get(name.toLowerCase());
        if (!col || col.type === 'formula') continue;
        const res = M.coerce(col, val);
        if (res.ok) v[col.id] = res.value;
      }
      const row = byExt.get(r.ext);
      if (!row) {
        if (room <= 0) { skipped++; continue; }
        const nr = M.newRow(v);
        nr.source = { kind: 'connector', ext: r.ext };
        sec.rows.push(nr);
        byExt.set(r.ext, nr);
        room--;
        added++;
      } else if (Object.entries(v).some(([k, x]) => row.v[k] !== x)) {
        row.v = { ...row.v, ...v };
        M.touch(row);
        updated++;
      }
    }
  }
  return skipped ? { added, updated, skipped, warning: `The table is full (${M.MAX_ROWS.toLocaleString()} rows): ${skipped} new row${skipped === 1 ? '' : 's'} not added. Delete old rows or use another table.` } : { added, updated };
}

// ---------- scheduling ----------
// Due when the last success is older than the interval; after a failure,
// retried no more than every 15 minutes.
export const isDue = (conn, hours, now = Date.now()) => hours > 0 && (!conn.status?.lastOk || now - conn.status.lastOk >= hours * 3600000) && (!conn.status?.lastTry || now - conn.status.lastTry >= 15 * 60000);

// Days until a key that expires needs replacing (null if it doesn't expire).
export function keyDaysLeft(conn, now = Date.now()) {
  const days = KINDS[conn.kind]?.expiresDays;
  if (!days || !conn.secretsAt) return null;
  return Math.ceil((conn.secretsAt + days * DAY - now) / DAY);
}

// Sections a connection of this kind can fill: the right type and unit
// (followers never land in a money section), net worth for balances, and
// for tables the columns it writes to (matched by name).
export function fits(sec, kind) {
  if (!sec || !kind || sec.type !== kind.target) return false;
  if (sec.type === 'tracker') return (!kind.unit || sec.tracker.unit === kind.unit) && (!kind.netWorth || sec.tracker.netWorth);
  const names = new Set(sec.table.columns.filter(c => c.type !== 'formula').map(c => c.name.toLowerCase()));
  return (kind.columns || []).every(n => names.has(n.toLowerCase()));
}
// Why a section doesn't fit (for the error shown on the connection).
function misfit(sec, kind) {
  if (sec.type !== kind.target) return `“${sec.name}” is a ${sec.type}, but this connection fills a ${kind.target}.`;
  if (sec.type === 'table') return `“${sec.name}” no longer has the ${kind.columns.join(', ')} columns this connection fills.`;
  return kind.unit === 'currency' ? `“${sec.name}” must be a money section that counts toward net worth.` : `“${sec.name}” must hold plain numbers, not money.`;
}

// Relay addresses: https on Cloudflare Workers, the only relay host HQ's
// content-security policy lets the app talk to.
export function relayUrlError(v) {
  let u;
  try { u = new URL(v); } catch { return 'Enter the full address, e.g. https://hq-relay.yourname.workers.dev'; }
  if (u.protocol !== 'https:') return 'The relay must use https://';
  if (!u.hostname.endsWith('.workers.dev')) return 'Use your *.workers.dev address (HQ’s security policy only allows those).';
  if (u.username || u.password || u.search || u.hash) return 'Enter just the address, without a path query or login.';
  return null;
}

// Which connection feeds a section (for the "Live" chip).
export const feeding = (data, secId) => data.connections.find(c => c.target === secId && KINDS[c.kind]);

// Phase 1 (async, network): fetch a connection's data. Works on a copy of
// what it needs, so nothing in the live data is touched while waiting.
// Never throws: returns { ok, result } or { ok: false, error }.
/** @param {import('./model/types.js').Connection} conn @param {import('./model/types.js').Data} data @param {typeof fetch} [fetchImpl] @returns {Promise<{ok: true, result: any} | {ok: false, error: string}>} */
export async function fetchConnection(conn, data, fetchImpl = globalThis.fetch?.bind(globalThis)) {
  const kind = KINDS[conn.kind];
  try {
    if (!kind) throw new Error('This connection type is no longer supported.');
    for (const f of kind.fields) if (!f.optional && !conn.secrets?.[f.key]) throw new Error(`${f.label.replace(/,.*/, '')} is missing. Edit the connection.`);
    const result = await kind.run({ ...conn, secrets: { ...conn.secrets } }, { data: { relay: { ...data.relay } }, fetchImpl });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

// Phase 2 (sync): apply an outcome to the CURRENT data. Looked up by id at
// this moment, so a merge from another window during the fetch is harmless.
/** @param {import('./model/types.js').Data} data @param {string} connId @param {{ok: boolean, result?: any, error?: string}} outcome @param {number} [at] @returns {null | {ok: false, error: string} | {ok: true, sec: import('./model/types.js').Section, summary: {added: number, updated: number, warning?: string}}} */
export function applyOutcome(data, connId, outcome, at = Date.now()) {
  const conn = data.connections.find(c => c.id === connId);
  if (!conn) return null; // removed meanwhile
  const fail = error => { conn.status = { ...conn.status, lastTry: at, error }; return { ok: false, error }; };
  if (!outcome.ok) return fail(outcome.error);
  const kind = KINDS[conn.kind];
  const sec = data.sections.find(s => s.id === conn.target);
  if (!sec) return fail('Its section was deleted. Edit the connection to pick another.');
  if (!fits(sec, kind)) return fail(`${misfit(sec, kind)} Edit the connection to pick another.`);
  if (sec.sample) M.clearSample(sec); // real numbers replace the examples
  const summary = applyResult(sec, outcome.result);
  const warnings = [summary.warning, outcome.result.warning].filter(Boolean);
  if (warnings.length) summary.warning = warnings.join(' ').slice(0, 200); else delete summary.warning;
  delete summary.skipped;
  if (outcome.result.cursor) conn.cursor = outcome.result.cursor;
  M.touch(sec);
  conn.status = { lastTry: at, lastOk: at, error: null, summary };
  return { ok: true, sec, summary };
}
