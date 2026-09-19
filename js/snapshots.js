// End-to-end encryption for the relay's snapshots.
//
// The relay takes a snapshot of balances and followers every few hours so
// days when HQ wasn't opened can be filled in. Those snapshots are stored in
// your Cloudflare account, so they are sealed to a key only HQ holds:
//   - HQ makes an ECDH P-256 key pair. The private key stays inside the
//     encrypted vault; the public key is given to the relay as a secret.
//   - For each snapshot the relay makes a one-off key pair, derives a shared
//     secret with HQ's public key (ECDH → HKDF-SHA-256) and encrypts the
//     snapshot with AES-256-GCM, bound to its source and date.
//   - Only HQ's private key can derive that secret again. Cloudflare (and
//     anyone reading the KV store) sees dates and ciphertext, nothing else.
// relay/worker.js has the matching `seal`.

const te = new TextEncoder();
const CURVE = { name: 'ECDH', namedCurve: 'P-256' };
export const INFO = 'hq-snapshot-v1';

export const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function unb64u(s) {
  if (typeof s !== 'string' || !/^[\w-]*$/.test(s)) throw new Error('bad encoding');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

// A public key as the relay expects it: the raw uncompressed point, base64url.
export const isPublicKey = s => typeof s === 'string' && /^[\w-]{86,88}$/.test(s) && unb64u(s).length === 65 && unb64u(s)[0] === 4;
export const isPrivateJwk = k => !!k && k.kty === 'EC' && k.crv === 'P-256' && ['x', 'y', 'd'].every(p => typeof k[p] === 'string' && /^[\w-]{40,50}$/.test(k[p]));

/** @returns {Promise<{pub: string, priv: {kty: 'EC', crv: 'P-256', x: string, y: string, d: string}}>} */
export async function newSnapshotKey() {
  const kp = await crypto.subtle.generateKey(CURVE, true, ['deriveBits']);
  const pub = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { pub, priv: { kty, crv, x, y, d } };
}

async function aesKey(shared, epk, usage) {
  const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: te.encode(INFO) }, hk, { name: 'AES-GCM', length: 256 }, false, [usage]);
}
const aad = (source, date) => te.encode(`hq-snap|${source}|${date}`);

// Opens one snapshot box { epk, iv, ct } for `source` on `date`. Throws if it
// was sealed to another key, altered, or moved to another source or date.
export async function openSnapshot(priv, source, date, box) {
  const key = await crypto.subtle.importKey('jwk', { ...priv, ext: true }, CURVE, false, ['deriveBits']);
  const epkRaw = unb64u(box?.epk);
  const epk = await crypto.subtle.importKey('raw', epkRaw, CURVE, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: epk }, key, 256);
  const k = await aesKey(shared, epkRaw, 'decrypt');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(box.iv), additionalData: aad(source, date) }, k, unb64u(box.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// The relay's side, here so HQ's tests can check both ends agree.
export async function sealSnapshot(pub, source, date, value) {
  const hq = await crypto.subtle.importKey('raw', unb64u(pub), CURVE, false, []);
  const eph = await crypto.subtle.generateKey(CURVE, true, ['deriveBits']);
  const epkRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: hq }, eph.privateKey, 256);
  const k = await aesKey(shared, epkRaw, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(source, date) }, k, te.encode(JSON.stringify(value))));
  return { epk: b64u(epkRaw), iv: b64u(iv), ct: b64u(ct) };
}

// Opens every snapshot in a relay answer. Returns [{ date, ...value }] and
// how many couldn't be opened (for example after replacing the key).
export async function openAll(priv, source, history) {
  const out = [];
  let failed = 0;
  if (!priv || !Array.isArray(history)) return { opened: out, failed };
  for (const h of history.slice(-400)) {
    if (!h || typeof h.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(h.date) || !h.box) continue;
    try {
      const v = await openSnapshot(priv, source, h.date, h.box);
      if (v && typeof v === 'object') out.push({ ...v, date: h.date });
    } catch { failed++; }
  }
  return { opened: out, failed };
}
