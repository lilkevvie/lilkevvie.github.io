// Shared session state and small formatting helpers. Depends only on ui.js,
// so every other module can import it without creating an import cycle.
import { html, fmtMoney, fmtUnit, LOCALE } from './ui.js';

export const S = {
  session: null,     // { key, salt, iter, rev, cache, hashes } while unlocked
  data: null,        // decrypted, normalized data while unlocked
  screen: null,      // 'app' | 'lock' | 'onboarding' | 'unsupported'
  range: 90,         // chart range in days (0 = all)
  tables: new Map(), // per-table UI state: filter, sort, page size
  mounts: [],        // chart renderers for the current view
  idle: null,
  hiddenAt: 0,
  saveState: 'saved', // 'saved' | 'saving' | 'error'
  reloadWaiting: false,
  merging: false,
  updateReady: null, // a waiting service worker (new version)
  syncing: false,    // live connections are being fetched (sync.js)
  unlockMs: 0,       // how long the last unlock took (slow = vault tuned elsewhere)
};

// Session transitions live in app.js; lower layers call them through here
// instead of importing app.js.
export const hooks = {
  lock: async () => {},
  startSession: () => {},
  opened: () => {}, // (damaged, qmissing) after unlock or restore
};

export const section = id => S.data.sections.find(s => s.id === id);
export const cur = () => S.data.settings.currency;
export const money = (v, o) => fmtMoney(v, cur(), o);
export const unitFmt = (v, unit, o) => fmtUnit(v, unit, cur(), o);
export const amtIf = (s, sensitive) => (sensitive ? html`<span class="amt">${s}</span>` : s);
export const plural = (n, word, many = `${word}s`) => `${n.toLocaleString(LOCALE)} ${n === 1 ? word : many}`;
export const saveLabel = st => ({ saving: 'Saving…', saved: 'Saved', error: 'Not saved' }[st]);
