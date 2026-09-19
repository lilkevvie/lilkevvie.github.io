// Encrypted vault.
//
// Layout in IndexedDB (store "kv"):
//   head        { v:3, kdf, cipher, iter, salt, rev, records:[names], savedAt }   (not secret)
//   r:index     { iv, ct }   profile, settings, section order, tombstones, and
//                            the SHA-256 of every section record's ciphertext
//   r:s:<id>    { iv, ct }   one record per section
//
// All records are AES-256-GCM under a key derived from the passcode
// (PBKDF2-SHA256, at least 600k rounds, tuned to ~1 s on the device). Each
// record's name is its associated data, so records can't be renamed or swapped. The index is re-encrypted on every save and
// pins the exact ciphertext of every section, so an old copy of one section
// (or a mix of records from different moments) is detected on unlock. Only
// sections whose contents changed are re-encrypted. `rev` makes a stale
// window's save fail instead of silently overwriting newer data.
//
// Not preventable without a server: someone with the device can restore an
// entire older copy of the vault (for example from a backup) - that is a
// complete, consistent earlier state, not a mix.

let DB_NAME = 'hq';
const STORE = 'kv';
const HEAD = 'head';
const ITERATIONS = 600000; // OWASP 2023 recommendation for PBKDF2-HMAC-SHA256
const MIN_ITER = 100000;
const MAX_ITER = 2000000; // caps the unlock cost a crafted backup could impose
const te = new TextEncoder();
const td = new TextDecoder();
const aad = name => te.encode(`hq-v3|${name}`);
const failKey = () => `${DB_NAME}.fails`;
const legacyV1Key = () => `${DB_NAME}.vault.v1`; // v1 lived in localStorage
const LEGACY_V2 = 'vault'; // v2 was one IndexedDB record

export const instanceId = Math.random().toString(36).slice(2);
const listeners = [];
function openChannel() {
  if (!('BroadcastChannel' in self)) return null;
  const c = new BroadcastChannel(`${DB_NAME}-vault`);
  c.addEventListener('message', e => {
    if (e.data?.from !== instanceId) listeners.forEach(fn => fn(e.data));
  });
  return c;
}
let channel = openChannel();
const post = msg => channel?.postMessage({ ...msg, from: instanceId });

let dbPromise;
// Tests use a separate database so they can never touch real data.
export function useDatabase(name) {
  DB_NAME = name;
  dbPromise?.then(d => d.close()).catch(() => {});
  dbPromise = null;
  channel?.close();
  channel = openChannel();
}

function db() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Storage is busy in another window. Close it and try again.'));
  });
  return dbPromise;
}

async function readAll() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, 'readonly');
    const s = t.objectStore(STORE);
    const keys = s.getAllKeys();
    const vals = s.getAll();
    t.oncomplete = () => resolve(new Map(keys.result.map((k, i) => [k, vals.result[i]])));
    t.onerror = () => reject(t.error);
  });
}

// Atomic write. With expectedRev, aborts with {conflict:true} if another
// window saved since. `replace` clears the store first (in the same transaction).
async function write({ expectedRev = null, replace = false, head, puts = [], dels = [] }) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, 'readwrite');
    const s = t.objectStore(STORE);
    let conflict = false;
    const apply = () => {
      if (replace) s.clear();
      for (const [n, v] of puts) s.put(v, `r:${n}`);
      for (const n of dels) s.delete(`r:${n}`);
      s.put(head, HEAD);
      // Garbage-collect any section/quarantine record the new head doesn't
      // list (e.g. left behind by a merge in another window). Everything
      // still referenced was written or kept above, in this transaction.
      const keep = new Set(head.records.map(n => `r:${n}`));
      const keys = s.getAllKeys(IDBKeyRange.bound('r:q:', 'r:s:\uffff')); // one key per section, not per row
      keys.onsuccess = () => keys.result.forEach(k => { if (typeof k === 'string' && /^r:[sq]:/.test(k) && !keep.has(k)) s.delete(k); });
    };
    if (expectedRev == null) apply();
    else {
      const g = s.get(HEAD);
      g.onsuccess = () => {
        if (!g.result || g.result.rev !== expectedRev) { conflict = true; t.abort(); return; }
        apply();
      };
    }
    t.oncomplete = () => resolve();
    t.onabort = () => reject(conflict ? Object.assign(new Error('Another window saved at the same moment.'), { conflict: true }) : (t.error || new Error('Could not save. Storage may be full.')));
  });
}

function validHead(h) {
  return !!h && h.v === 3 && h.salt instanceof Uint8Array && h.salt.length === 16 &&
    Number.isInteger(h.iter) && h.iter >= MIN_ITER && h.iter <= MAX_ITER &&
    Number.isInteger(h.rev) && h.rev >= 0 && Array.isArray(h.records) && h.records.includes('index') &&
    h.records.every(n => typeof n === 'string' && /^(index|[sq]:[\w-]{1,64})$/.test(n));
}
const validRec = r => !!r && r.iv instanceof Uint8Array && r.iv.length === 12 && r.ct instanceof Uint8Array && r.ct.length >= 16;

// Key-derivation cost is tuned per device: as many PBKDF2 rounds as take
// about kdf.targetMs here (never fewer than ITERATIONS, never more than
// MAX_ITER). The chosen count is stored in the head, so unlocking always uses
// what the vault was made with.
export const kdf = { targetMs: 1000 };
async function calibrate() {
  if (!kdf.targetMs) return ITERATIONS;
  const probe = 100000;
  const t0 = performance.now();
  await deriveKey('calibration', crypto.getRandomValues(new Uint8Array(16)), probe);
  const ms = Math.max(1, performance.now() - t0);
  const n = Math.round((probe * kdf.targetMs) / ms / 10000) * 10000;
  return Math.min(MAX_ITER, Math.max(ITERATIONS, n));
}

async function deriveKey(pass, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', te.encode(pass.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptRec(key, name, json) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(name) }, key, te.encode(json)));
  return { iv, ct };
}
async function decryptRec(key, name, rec) {
  return td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv, additionalData: aad(name) }, key, rec.ct));
}
const digest = async bytes => b64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

// data -> named JSON records. The index here excludes the ciphertext hashes,
// which are sealed in at write time.
// The index also carries each section's title, so a damaged section can
// still be named when it can't be opened.
export function snapshot(data) {
  const recs = new Map();
  recs.set('index', JSON.stringify({ ...data, sections: data.sections.map(s => s.id), _titles: Object.fromEntries(data.sections.map(s => [s.id, s.name])) }));
  for (const s of data.sections) recs.set(`s:${s.id}`, JSON.stringify(s));
  return recs;
}

// Rebuilds the data object a session last saved (the merge base).
export function dataFrom(cache) {
  const { _titles, ...index } = JSON.parse(cache.get('index'));
  return { ...index, sections: index.sections.filter(id => cache.has(`s:${id}`)).map(id => JSON.parse(cache.get(`s:${id}`))) };
}

// Encrypts `changed` section records, then a fresh index pinning every
// section's ciphertext hash. Returns what to write plus the new hash map.
async function seal(key, recs, changed, prevHashes) {
  const puts = await Promise.all(changed.map(async n => [n, await encryptRec(key, n, recs.get(n))]));
  const hashes = new Map([...prevHashes].filter(([n]) => recs.has(n)));
  for (const [n, r] of puts) hashes.set(n, await digest(r.ct));
  const index = JSON.parse(recs.get('index'));
  index._records = Object.fromEntries([...recs.keys()].filter(n => n !== 'index').map(n => [n, hashes.get(n)]));
  puts.push(['index', await encryptRec(key, 'index', JSON.stringify(index))]);
  return { puts, hashes };
}

// Decrypts the index first: failure there means a wrong passcode. A section
// that fails to decrypt, or whose ciphertext isn't the one the index pins,
// was tampered with, rolled back on its own, or corrupted. Everything else
// opens; each damaged section is reported together with its raw record, so
// the caller can quarantine it (see Vault.quarantine) instead of losing it.
// The same applies to backups, which therefore always restore.
async function openAll(key, head, get) {
  const idxRec = get('index');
  if (!validRec(idxRec)) throw new Error('The vault is damaged.');
  let index;
  try { index = JSON.parse(await decryptRec(key, 'index', idxRec)); } catch { throw Object.assign(new Error('wrong'), { wrong: true }); }
  const pinned = index._records;
  delete index._records;
  if (!Array.isArray(index.sections) || !pinned || typeof pinned !== 'object') throw new Error('The vault is damaged.');
  const titles = index._titles || {};
  const cache = new Map();
  const hashes = new Map();
  const sections = [];
  const damaged = [];
  for (const id of index.sections) {
    const name = `s:${id}`;
    const rec = get(name);
    let problem = null;
    let json;
    let h;
    if (!head.records.includes(name) || !validRec(rec)) problem = 'missing';
    else {
      h = await digest(rec.ct);
      if (pinned[name] !== h) problem = 'doesn’t match its index (altered or rolled back)';
      else {
        try { json = await decryptRec(key, name, rec); } catch { problem = 'can’t be decrypted'; }
      }
    }
    if (problem) {
      damaged.push({ id, title: String(titles[id] || 'Untitled section'), problem, rec: validRec(rec) ? rec : null, hash: h || null });
      continue;
    }
    cache.set(name, json);
    hashes.set(name, h);
    sections.push(JSON.parse(json));
  }
  // Quarantined records are kept byte-for-byte; check they're still intact.
  const quarantine = Array.isArray(index.quarantine) ? index.quarantine : [];
  const qmissing = [];
  for (const q of quarantine) {
    if (q.missing) continue;
    const rec = get(`q:${q.id}`);
    if (!validRec(rec) || (await digest(rec.ct)) !== q.hash) qmissing.push(q.id);
  }
  // Damaged sections leave the section list on the next save (they move to
  // the quarantine in the same write).
  const kept = { ...index, sections: sections.map(s => s.id) };
  if (damaged.length) kept._titles = Object.fromEntries(Object.entries(titles).filter(([id]) => kept.sections.includes(id)));
  cache.set('index', JSON.stringify(kept));
  const { _titles, ...clean } = index;
  const qnames = new Set(head.records.filter(n => n.startsWith('q:')));
  return { data: { ...clean, sections }, cache, hashes, damaged, qmissing, qnames };
}

// ---------- legacy formats (upgraded on first unlock) ----------
async function findLegacy(all) {
  const r2 = all.get(LEGACY_V2);
  if (r2 && r2.v === 2 && r2.salt instanceof Uint8Array && r2.iv instanceof Uint8Array && r2.ct instanceof Uint8Array) {
    return { v: 2, salt: r2.salt, iter: r2.iter, iv: r2.iv, ct: r2.ct, aad: te.encode('hq-vault-v2') };
  }
  try {
    const o = JSON.parse(localStorage.getItem(legacyV1Key()));
    if (o && o.v === 1) return { v: 1, salt: unb64(o.salt), iter: o.iter, iv: unb64(o.iv), ct: unb64(o.ct), aad: null };
  } catch { /* none */ }
  return null;
}
async function openLegacy(L, pass) {
  if (!Number.isInteger(L.iter) || L.iter < MIN_ITER || L.iter > MAX_ITER) throw new Error('The old vault is damaged.');
  const key = await deriveKey(pass, L.salt, L.iter);
  let pt;
  try {
    pt = await crypto.subtle.decrypt(L.aad ? { name: 'AES-GCM', iv: L.iv, additionalData: L.aad } : { name: 'AES-GCM', iv: L.iv }, key, L.ct);
  } catch {
    throw Object.assign(new Error('wrong'), { wrong: true });
  }
  return { key, salt: L.salt, iter: L.iter, data: JSON.parse(td.decode(pt)) };
}

// ---------- guess throttling ----------
// A speed bump for someone holding the device. The real protection against
// offline guessing is the PBKDF2 cost plus passcode strength.
function fails() {
  try { return JSON.parse(localStorage.getItem(failKey())) || { count: 0, until: 0 }; } catch { return { count: 0, until: 0 }; }
}
function recordFail() {
  const f = fails();
  f.count += 1;
  if (f.count >= 5) f.until = Date.now() + Math.min(30000 * 2 ** (f.count - 5), 3600000);
  try { localStorage.setItem(failKey(), JSON.stringify(f)); } catch { /* storage blocked */ }
  return f;
}
function clearFails() {
  try { localStorage.removeItem(failKey()); } catch { /* storage blocked */ }
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// All writes are serialized so an older, slower save can never land after a newer one.
let chain = Promise.resolve();
const queue = fn => {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
};

const newHead = (session, recs, rev, qnames = []) => ({ v: 3, kdf: 'PBKDF2-SHA256', cipher: 'AES-256-GCM', iter: session.iter, salt: session.salt, rev, records: [...recs.keys(), ...qnames], savedAt: new Date().toISOString() });

// Writes a complete vault for `data` under an existing key (setup, re-key,
// legacy upgrade, legacy backup restore).
async function writeFresh(session, data, { expectedRev = null } = {}) {
  const recs = snapshot(data);
  const { puts, hashes } = await seal(session.key, recs, [...recs.keys()].filter(n => n !== 'index'), new Map());
  const rev = expectedRev == null ? 1 : expectedRev + 1;
  await write({ expectedRev, replace: true, head: newHead(session, recs, rev), puts });
  return { ...session, rev, cache: recs, hashes, qnames: new Set(), pendingQ: new Map() };
}

export const Vault = {
  supported() {
    return !!(self.isSecureContext && crypto?.subtle && self.indexedDB);
  },

  // 'v3' | 'legacy' | null
  async state() {
    const all = await readAll();
    if (validHead(all.get(HEAD))) return 'v3';
    return (await findLegacy(all)) ? 'legacy' : null;
  },

  async exists() {
    return (await this.state()) !== null;
  },

  lockedFor() {
    return Math.max(0, fails().until - Date.now());
  },

  // First-time setup. Refuses to overwrite anything already stored.
  create(pass, data) {
    return queue(async () => {
      if (await this.state()) throw new Error('HQ is already set up on this device.');
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iter = await calibrate();
      const session = await writeFresh({ key: await deriveKey(pass, salt, iter), salt, iter }, data);
      navigator.storage?.persist?.().catch(() => {});
      post({ type: 'replaced' });
      return session;
    });
  },

  // New passcode, same data. Fails with {conflict} if another window saved first.
  // Quarantined records stay encrypted under the old key, so they must be
  // recovered or deleted first.
  rekey(session, pass, data) {
    if (data.quarantine?.some(q => !q.missing)) return Promise.reject(new Error('Recover or delete the damaged data (Settings → Damaged data) before changing your passcode.'));
    return queue(async () => {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iter = await calibrate();
      const next = await writeFresh({ key: await deriveKey(pass, salt, iter), salt, iter }, data, { expectedRev: session.rev });
      post({ type: 'replaced' });
      return next;
    });
  },

  // Returns { session, data } for v3, or { legacy, data, ... } for an old
  // format - call upgradeLegacy() with the normalized data to convert it.
  async unlock(pass) {
    const wait = this.lockedFor();
    if (wait) throw Object.assign(new Error('throttled'), { wait });
    const all = await readAll();
    const head = all.get(HEAD);
    try {
      if (validHead(head)) {
        const key = await deriveKey(pass, head.salt, head.iter);
        const { data, cache, hashes, damaged, qmissing, qnames } = await openAll(key, head, n => all.get(`r:${n}`));
        clearFails();
        const session = { key, salt: head.salt, iter: head.iter, rev: head.rev, cache, hashes, qnames, pendingQ: new Map() };
        this.quarantine(session, data, damaged); // set aside, never dropped
        return { session, data, damaged, qmissing };
      }
      const L = await findLegacy(all);
      if (!L) throw new Error('No vault on this device.');
      const opened = await openLegacy(L, pass);
      clearFails();
      return { legacy: L.v, data: opened.data, opened };
    } catch (e) {
      if (!e.wrong) throw e;
      const f = recordFail();
      throw Object.assign(new Error('wrong'), { wait: Math.max(0, f.until - Date.now()) });
    }
  },

  // Converts an unlocked legacy vault to v3 (same passcode) and removes the old copy.
  upgradeLegacy(res, data) {
    return queue(async () => {
      const session = await writeFresh({ key: res.opened.key, salt: res.opened.salt, iter: res.opened.iter }, data);
      try { localStorage.removeItem(legacyV1Key()); } catch { /* ignore */ }
      post({ type: 'replaced' });
      return session;
    });
  },

  // Reads what's saved now (after another window wrote), with the same key -
  // no passcode prompt. Doesn't touch the session: the caller adopts
  // { rev, cache, hashes } together with its merged data, in one step.
  async readLatest(session) {
    await chain;
    const all = await readAll();
    const head = all.get(HEAD);
    if (!validHead(head) || b64(head.salt) !== b64(session.salt)) throw new Error('The vault was replaced.');
    const { data, cache, hashes, qnames } = await openAll(session.key, head, n => all.get(`r:${n}`));
    return { data, rev: head.rev, cache, hashes, qnames };
  },

  // Convenience for tests: read the latest and adopt it wholesale.
  async reload(session) {
    const latest = await this.readLatest(session);
    Object.assign(session, { rev: latest.rev, cache: latest.cache, hashes: latest.hashes, qnames: latest.qnames });
    return latest.data;
  },

  // Sets damaged sections aside instead of losing them: adds an entry per
  // section to data.quarantine and stages its raw record, byte-for-byte, to be
  // stored as q:<id> by the next save - in the same atomic write that drops
  // the broken s:<id> record. Nothing is ever deleted implicitly.
  quarantine(session, data, damaged) {
    if (!damaged.length) return;
    data.quarantine ||= [];
    for (const x of damaged) {
      if (data.quarantine.some(q => q.id === x.id)) continue;
      data.quarantine.push({ id: x.id, title: x.title, problem: x.problem, at: Date.now(), hash: x.hash, missing: !x.rec });
      if (x.rec) session.pendingQ.set(x.id, x.rec);
    }
  },

  // Tries to decrypt a quarantined record. It works when the record is a
  // genuine older copy (the rollback case); it fails if it was corrupted.
  async openQuarantined(session, entry) {
    const rec = session.pendingQ.get(entry.id) || await this._raw(`r:q:${entry.id}`);
    if (!validRec(rec) || (await digest(rec.ct)) !== entry.hash) throw new Error('This data is no longer stored on this device.');
    try {
      return JSON.parse(await decryptRec(session.key, `s:${entry.id}`, rec));
    } catch {
      throw new Error('This data is corrupted and can’t be opened.');
    }
  },

  // The snapshot is taken synchronously, so later edits can't leak into this save.
  save(session, data) {
    const recs = snapshot(data);
    const qwant = new Set((data.quarantine || []).filter(q => !q.missing).map(q => `q:${q.id}`));
    return queue(async () => {
      const changed = [...recs.keys()].filter(n => n !== 'index' && session.cache.get(n) !== recs.get(n));
      const qputs = [...session.pendingQ].filter(([id]) => qwant.has(`q:${id}`)).map(([id, rec]) => [`q:${id}`, rec]);
      const dels = [
        ...[...session.cache.keys()].filter(n => !recs.has(n)),
        ...qputs.map(([n]) => `s:${n.slice(2)}`).filter(n => !recs.has(n)), // moved to quarantine
        ...[...session.qnames].filter(n => !qwant.has(n)), // deleted from quarantine by the user
      ];
      if (!changed.length && !dels.length && !qputs.length && session.cache.get('index') === recs.get('index')) return;
      const { puts, hashes } = await seal(session.key, recs, changed, session.hashes);
      puts.push(...qputs);
      await write({ expectedRev: session.rev, head: newHead(session, recs, session.rev + 1, [...qwant]), puts, dels });
      session.rev += 1;
      session.cache = recs;
      session.hashes = hashes;
      session.qnames = qwant;
      for (const [n] of qputs) session.pendingQ.delete(n.slice(2));
      post({ type: 'saved', rev: session.rev });
    });
  },

  async exportBackup() {
    await chain;
    const all = await readAll();
    const head = all.get(HEAD);
    if (!validHead(head)) {
      // An old-format vault is exported as-is, in a form parseBackup accepts.
      const L = await findLegacy(all);
      if (!L) throw new Error('Nothing to back up yet.');
      const body = { iter: L.iter, salt: b64(L.salt), iv: b64(L.iv), ct: b64(L.ct) };
      return JSON.stringify(L.v === 2 ? { app: 'HQ', v: 2, ...body } : { v: 1, kdf: 'PBKDF2-SHA256', ...body });
    }
    // Every stored record goes in as-is, damaged or quarantined ones included;
    // restoring opens whatever is intact and quarantines the rest.
    const records = {};
    for (const n of head.records) {
      const r = all.get(`r:${n}`);
      if (validRec(r)) records[n] = { iv: b64(r.iv), ct: b64(r.ct) };
    }
    if (!records.index) throw new Error('The vault is damaged; backup aborted.');
    return JSON.stringify({ app: 'HQ', v: 3, kdf: head.kdf, cipher: head.cipher, iter: head.iter, salt: b64(head.salt), savedAt: head.savedAt, records });
  },

  // Parses and structurally validates a backup (v3, or a v1/v2 one to upgrade)
  // without touching storage.
  parseBackup(text) {
    let o;
    try { o = JSON.parse(text); } catch { throw new Error("That file isn't an HQ backup."); }
    const legacy = o && ((o.app === 'HQ' && o.v === 2) || (o.v === 1 && o.kdf === 'PBKDF2-SHA256'));
    if (!o || (!legacy && !(o.app === 'HQ' && o.v === 3))) throw new Error("That file isn't an HQ backup.");
    try {
      if (legacy) {
        const L = { v: o.v, salt: unb64(o.salt), iter: o.iter, iv: unb64(o.iv), ct: unb64(o.ct), aad: o.v === 2 ? te.encode('hq-vault-v2') : null };
        if (L.salt.length !== 16 || L.iv.length !== 12) throw new Error();
        return { legacy: L, savedAt: typeof o.savedAt === 'string' ? o.savedAt : null };
      }
      const names = Object.keys(o.records || {});
      const head = { v: 3, kdf: 'PBKDF2-SHA256', cipher: 'AES-256-GCM', iter: o.iter, salt: unb64(o.salt), rev: 1, records: names, savedAt: o.savedAt };
      const recs = new Map(names.map(n => [n, { iv: unb64(o.records[n].iv), ct: unb64(o.records[n].ct) }]));
      if (!validHead(head) || ![...recs.values()].every(validRec)) throw new Error();
      return { head, recs, savedAt: typeof o.savedAt === 'string' ? o.savedAt : null };
    } catch {
      throw new Error('The backup file is damaged.');
    }
  },

  // Proves the passcode opens the backup before anything is written, and
  // reports any damaged sections (restored into the quarantine, not lost).
  async openBackup(parsed, pass) {
    try {
      if (parsed.legacy) {
        const o = await openLegacy(parsed.legacy, pass);
        return { data: o.data, key: o.key, salt: o.salt, iter: o.iter, legacy: true, damaged: [], qmissing: [] };
      }
      const key = await deriveKey(pass, parsed.head.salt, parsed.head.iter);
      const opened = await openAll(key, parsed.head, n => parsed.recs.get(n));
      return { ...opened, key, salt: parsed.head.salt, iter: parsed.head.iter };
    } catch (e) {
      throw new Error(e.wrong ? "That passcode doesn't open this backup." : e.message);
    }
  },

  // Replaces everything on this device with an opened backup. `data` is the
  // normalized contents (used to rebuild legacy backups in the v3 format).
  installBackup(parsed, opened, data) {
    return queue(async () => {
      const base = { key: opened.key, salt: opened.salt, iter: opened.iter };
      let session;
      if (opened.legacy) session = await writeFresh(base, data);
      else {
        const head = { ...parsed.head, rev: 1, savedAt: new Date().toISOString() };
        await write({ replace: true, head, puts: [...parsed.recs] });
        session = { ...base, rev: 1, cache: opened.cache, hashes: opened.hashes, qnames: opened.qnames, pendingQ: new Map() };
        this.quarantine(session, data, opened.damaged || []);
      }
      try { localStorage.removeItem(legacyV1Key()); } catch { /* ignore */ }
      clearFails();
      post({ type: 'replaced' });
      return session;
    });
  },

  wipe() {
    return queue(async () => {
      const d = await db();
      await new Promise((resolve, reject) => {
        const t = d.transaction(STORE, 'readwrite');
        t.objectStore(STORE).clear();
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
      try { localStorage.removeItem(legacyV1Key()); } catch { /* ignore */ }
      clearFails();
      post({ type: 'replaced' });
    });
  },

  // Test helper: raw access to a stored record.
  async _raw(name, value) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, value === undefined ? 'readonly' : 'readwrite');
      const s = t.objectStore(STORE);
      const r = value === undefined ? s.get(name) : s.put(value, name);
      t.oncomplete = () => resolve(r.result);
      t.onerror = () => reject(t.error);
    });
  },

  onExternalChange(fn) {
    listeners.push(fn);
  },
};
