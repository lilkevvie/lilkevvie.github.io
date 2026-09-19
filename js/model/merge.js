// Three-way merge of two windows' edits (see persist.js).
import { MAX_DELETED } from './constants.js';

const now = () => Date.now();

// ---------- concurrent edits (two windows) ----------
// Three-way merge of this window's unsaved edits (`local`) with what another
// window saved (`disk`), relative to the last save both had seen (`base`).
// All three must be normalized, so only real edits count as changes.
// Every setting, every section's own settings, and every row / item is
// merged on its own: whatever changed on one side only is kept, so edits that
// don't touch the same thing never collide. The same row, item or setting
// changed on both sides keeps the saved version and is reported.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Returns the winning value; records a conflict when both sides changed it differently.
function pick3(b, l, d, label, conflicts) {
  if (same(l, b)) return d;
  if (same(d, b) || same(d, l)) return l;
  conflicts.push(label);
  return d;
}

// Merges two versions of a list of {id} objects against their base.
// Order follows the saved list, with this window's additions appended.
function mergeList(b = [], l = [], d = [], label, conflicts) {
  const B = new Map(b.map(x => [x.id, x]));
  const L = new Map(l.map(x => [x.id, x]));
  const D = new Map(d.map(x => [x.id, x]));
  let clashes = 0;
  const out = new Map();
  for (const id of new Set([...D.keys(), ...L.keys(), ...B.keys()])) {
    const bx = B.get(id), lx = L.get(id), dx = D.get(id);
    if (!bx) { out.set(id, dx || lx); continue; } // added on one side
    if (!lx && !dx) continue; // deleted on both
    if (!lx) { // deleted here
      if (same(dx, bx)) continue;
      clashes++; out.set(id, dx); continue; // edited elsewhere: keep the edit
    }
    if (!dx) { // deleted elsewhere
      if (same(lx, bx)) continue;
      clashes++; out.set(id, lx); continue; // edited here: keep the edit
    }
    if (same(lx, bx)) out.set(id, dx);
    else if (same(dx, bx) || same(dx, lx)) out.set(id, lx);
    else { clashes++; out.set(id, dx); }
  }
  if (clashes) conflicts.push(`${clashes} ${clashes === 1 ? 'entry' : 'entries'} in ${label}`);
  const order = [...d.map(x => x.id), ...l.map(x => x.id)];
  const seen = new Set();
  return order.filter(id => out.has(id) && !seen.has(id) && seen.add(id)).map(id => out.get(id));
}

function mergeSection(b, l, d, conflicts) {
  const list = l.type === 'tracker' ? 'items' : 'rows';
  if (b.type !== l.type || l.type !== d.type) return d;
  const meta = s => { const { items, rows, rev, updatedAt, ...m } = s; return m; };
  const m = pick3(meta(b), meta(l), meta(d), `settings of ${d.name}`, conflicts);
  return {
    ...m,
    [list]: mergeList(b[list], l[list], d[list], d.name, conflicts),
    rev: Math.max(l.rev || 0, d.rev || 0) + 1,
    updatedAt: Math.max(l.updatedAt || 0, d.updatedAt || 0),
  };
}

/** @param {import('./types.js').Data} base @param {import('./types.js').Data} local @param {import('./types.js').Data} disk @returns {{data: import('./types.js').Data, conflicts: string[]}} */
export function mergeConcurrent(base, local, disk) {
  const conflicts = [];
  const B = new Map(base.sections.map(s => [s.id, s]));
  const L = new Map(local.sections.map(s => [s.id, s]));
  const D = new Map(disk.sections.map(s => [s.id, s]));
  const merged = new Map();
  for (const id of new Set([...D.keys(), ...L.keys(), ...B.keys()])) {
    const b = B.get(id), l = L.get(id), d = D.get(id);
    if (!b) { merged.set(id, d || l); continue; }
    if (!l && !d) continue;
    if (!l) { if (!same(d, b)) { conflicts.push(`${d.name} (deleted here, edited in the other window, so it was kept)`); merged.set(id, d); } continue; }
    if (!d) { if (!same(l, b)) { conflicts.push(`${l.name} (deleted in the other window, edited here, so it was kept)`); merged.set(id, l); } continue; }
    // Changed on one side only (the common case): take that side unchanged.
    if (same(l, b)) merged.set(id, d);
    else if (same(d, b) || same(d, l)) merged.set(id, l);
    else merged.set(id, mergeSection(b, l, d, conflicts));
  }

  const ids = x => x.sections.map(s => s.id);
  const order = [...pick3(ids(base), ids(local), ids(disk), 'section order', []), ...ids(disk), ...ids(local)];
  const seen = new Set();
  const sections = order.filter(id => merged.has(id) && !seen.has(id) && seen.add(id)).map(id => merged.get(id));

  const keys = new Set([...Object.keys(base.settings), ...Object.keys(local.settings), ...Object.keys(disk.settings)]);
  const settings = Object.fromEntries([...keys].map(k => [k, pick3(base.settings[k], local.settings[k], disk.settings[k], `the “${k}” setting`, conflicts)]));
  const profile = pick3(base.profile, local.profile, disk.profile, 'your name', conflicts);
  // Entry by entry; `at` is when a window noticed the damage, not content.
  const noAt = list => (list || []).map(({ at, ...q }) => q);
  const atOf = new Map([...(disk.quarantine || []), ...(local.quarantine || [])].map(q => [q.id, q.at]));
  // Connections merge by id; their sync status isn't content (the newest try wins).
  const bare = list => (list || []).map(({ status, cursor, ...c }) => c);
  const latest = new Map();
  for (const c of [...(disk.connections || []), ...(local.connections || [])]) {
    const cur = latest.get(c.id);
    if (!cur || (c.status?.lastTry || 0) >= (cur.status?.lastTry || 0)) latest.set(c.id, c);
  }
  const connections = mergeList(bare(base.connections), bare(local.connections), bare(disk.connections), 'connections', conflicts)
    .map(c => ({ ...c, status: latest.get(c.id)?.status || {}, cursor: latest.get(c.id)?.cursor ?? null }));
  const relay = pick3(base.relay || {}, local.relay || {}, disk.relay || {}, 'the relay settings', conflicts);
  const quarantine = mergeList(noAt(base.quarantine), noAt(local.quarantine), noAt(disk.quarantine), 'the damaged-data list', conflicts)
    .map(q => ({ ...q, at: atOf.get(q.id) ?? now() }));

  // Tombstones: union of both sides, minus any whose target still exists
  // (e.g. a delete that was undone).
  const alive = new Set();
  for (const s of sections) { alive.add(s.id); for (const x of s.items || s.rows || []) alive.add(x.id); }
  const tomb = new Map([...disk.deleted, ...local.deleted].filter(t => !alive.has(t.id)).map(t => [t.id, t]));
  const deleted = [...tomb.values()].sort((a, b) => a.at - b.at).slice(-MAX_DELETED);

  return {
    data: { ...disk, profile, settings, sections, quarantine, connections, relay, deleted, deletedBefore: Math.max(local.deletedBefore || 0, disk.deletedBefore || 0) || null },
    conflicts,
  };
}

