// Entry point: event delegation, lock screen, onboarding, session lifecycle, boot.
import {
  html, raw, setHTML, $, icon, modal, confirmDialog, closeAllDialogs, toast, clearToast, download, uiBusy, settleHolds,
  dialogOpen, onDialogsClosed, setSubmitGuard, applyTheme, storedTheme, today, sid,
} from './ui.js';
import { Vault, useDatabase } from './vault.js';
import * as M from './model.js';
import { S, hooks, section, plural } from './store.js';
import { commit, flushSave, queueSave, hasUnsaved, syncFromOtherWindow, resetSaves } from './persist.js';
import { render, go, route, tstate, visibleRows, refreshTable } from './views.js';
import {
  fieldError, passFields, wireStrength, passError, newSectionModal, sectionSettingsModal, itemModal, rowModal,
  dailyUpdateModal, quickAddModal, importCSV, exportCSV, restoreFlow, changePassModal, connectionModal, relayModal,
} from './forms.js';
import { syncConnections, startAutoSync, stopAutoSync } from './sync.js';
import * as TE from './tableedit.js';

const app = $('#app');

// ======================================================================
// delegated actions
// ======================================================================
const ACT = {
  lock: () => lock(),
  privacy() { S.data.settings.privacy = !S.data.settings.privacy; commit(); },
  range(el) { S.range = Number(el.dataset.v); render(); },
  newSection: () => newSectionModal(),
  quickAdd: () => quickAddModal(),
  dailyUpdate: el => dailyUpdateModal(el.dataset.sec, el.dataset.v === 'stale'),
  sectionSettings: el => sectionSettingsModal(section(el.dataset.sec)),
  addItem: el => itemModal(section(el.dataset.sec)),
  editItem(el) {
    const s = section(el.dataset.sec);
    const it = s?.items.find(i => i.id === el.dataset.id);
    if (it) itemModal(s, it);
  },
  addRow: el => rowModal(section(el.dataset.sec)),
  editRow(el) {
    const s = section(el.dataset.sec);
    const r = s?.rows.find(x => x.id === el.dataset.id);
    if (r) rowModal(s, r);
  },
  openSection(el) {
    if (el.dataset.q) tstate(el.dataset.sec).q = el.dataset.q;
    go(`#/s/${encodeURIComponent(el.dataset.sec)}`);
  },
  sort(el) {
    const s = section(el.dataset.sec);
    const current = visibleRows(s).sort;
    tstate(s.id).sort = { col: el.dataset.col, dir: current?.col === el.dataset.col ? -current.dir : 1 };
    refreshTable(s);
    document.querySelector(`#tbl-${CSS.escape(s.id)} [data-act=sort][data-col="${CSS.escape(el.dataset.col)}"]`)?.focus();
  },
  more(el) { const s = section(el.dataset.sec); tstate(s.id).limit += 500; refreshTable(s); },
  importCSV: el => importCSV(section(el.dataset.sec)),
  exportCSV: el => exportCSV(section(el.dataset.sec)),
  async clearSample() {
    const ok = await confirmDialog({ title: 'Clear sample data?', body: html`<p>Sample items and rows are removed. Your sections, columns and security checklist stay.</p>`, confirm: 'Clear' });
    if (!ok) return;
    S.data.sections.filter(s => s.sample).forEach(M.clearSample);
    commit('Sample data cleared.');
  },
  move(el) {
    const a = S.data.sections;
    const i = a.findIndex(s => s.id === el.dataset.sec);
    const j = i + Number(el.dataset.v);
    if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
    commit();
    const q = `[data-act=move][data-sec="${CSS.escape(el.dataset.sec)}"]`;
    (document.querySelector(`${q}[data-v="${el.dataset.v}"]:not([disabled])`) || document.querySelector(`${q}:not([disabled])`))?.focus();
  },
  async backup() {
    try {
      await flushSave();
      download(`hq-backup-${today()}.json`, await Vault.exportBackup(), 'application/json');
      toast('Encrypted backup downloaded. It opens with your current passcode.');
    } catch (e) { toast(e.message); }
  },
  restore: () => restoreFlow(),
  changePass: () => changePassModal(),
  qRecover: el => recoverQuarantined(el),
  qDelete: el => deleteQuarantined(el),
  applyUpdate: () => applyUpdate(),
  addConnection: () => connectionModal(),
  editConnection(el) {
    const c = S.data.connections.find(x => x.id === el.dataset.id);
    if (c) connectionModal(c);
  },
  relaySettings: () => relayModal(),
  syncNow: el => syncConnections({ ids: [el.dataset.id] }),
  cellEdit: el => TE.cellEdit(el),
  bulkSet: el => TE.bulkSet(el),
  bulkExport: el => TE.bulkExport(el),
  bulkDelete: el => TE.bulkDelete(el),
  bulkClear: el => TE.bulkClear(el),
  erase() {
    modal({
      title: 'Erase everything',
      submit: 'Erase',
      danger: true,
      body: html`<p>This permanently deletes HQ's data from this device. Backups you downloaded are not affected.</p><label>Type ERASE to confirm<input name="confirm" required autocomplete="off" autocapitalize="characters"></label>`,
      onSubmit: async (f, d) => {
        if (String(f.get('confirm')).trim().toUpperCase() !== 'ERASE') return fieldError(d.querySelector('form'), 'confirm', 'Type ERASE to confirm.');
        resetSaves();
        await Vault.wipe();
        history.replaceState(null, '', location.pathname + location.search);
        renderOnboarding();
      },
    });
  },
};

const CHANGE = {
  toggleCell(el) {
    const s = section(el.dataset.sec);
    const r = s?.rows.find(x => x.id === el.dataset.row);
    if (!r) return;
    r.v[el.dataset.col] = el.checked;
    M.touch(r);
    commit(null, null, s);
  },
  sortSelect(el) {
    const s = section(el.dataset.sec);
    const [col, dir] = el.value.split(':');
    tstate(s.id).sort = col ? { col, dir: Number(dir) } : null;
    refreshTable(s);
  },
  toggleHome(el) { section(el.dataset.sec).home = el.checked; commit(); },
  tableChart(el) { tstate(el.dataset.sec)[el.dataset.key] = el.value; render(); },
  selRow: el => TE.selRow(el),
  selAll: el => TE.selAll(el),
  setting(el) {
    const k = el.dataset.key;
    if (k === 'name') {
      const v = el.value.trim().slice(0, 40);
      if (!v) { el.value = S.data.profile.name; return; }
      S.data.profile.name = v;
    } else S.data.settings[k] = k === 'currency' || k === 'theme' ? el.value : Number(el.value);
    if (k === 'autoLockMin') bumpIdle();
    commit('Saved.');
    if (k === 'syncHours') syncConnections(); // a shorter interval may make some due now
  },
};

let inputTimer;
const INPUT = {
  filter(el) {
    const s = section(el.dataset.sec);
    const st = tstate(s.id);
    st.q = el.value;
    st.limit = 100;
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => refreshTable(s), 120);
  },
  liveSearch(el) {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => {
      history.replaceState(null, '', `#/search?q=${encodeURIComponent(el.value)}`);
      render();
    }, 200);
  },
};

// While another window's changes are being merged in, the UI is read-only.
const busy = () => {
  if (!S.merging) return false;
  toast('Syncing with another window…');
  return true;
};

app.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || !app.contains(el) || S.screen !== 'app') return;
  if (busy()) { e.preventDefault(); return; }
  // Clicks on controls inside a clickable row or cell belong to the control.
  const ctl = e.target.closest('input, a, button, label, select, textarea');
  if (ctl && ctl !== el && el.contains(ctl)) return;
  const fn = ACT[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});
// Arrow keys / Enter on a focused table cell (the grid in tableedit.js).
app.addEventListener('keydown', e => {
  const td = e.target.closest?.('td[data-grid]');
  if (!td || e.target !== td || S.screen !== 'app' || e.altKey || e.metaKey) return;
  if (busy()) return;
  TE.cellKey(e, td);
});
app.addEventListener('change', e => {
  const el = e.target.closest('[data-change]');
  if (!el || S.screen !== 'app') return;
  if (busy()) { render(); return; } // undo the visual toggle
  CHANGE[el.dataset.change]?.(el, e);
});
app.addEventListener('input', e => {
  const el = e.target.closest('[data-input]');
  if (el && S.screen === 'app') INPUT[el.dataset.input]?.(el, e);
});
app.addEventListener('submit', e => {
  const form = e.target.closest('[data-submit="search"]');
  if (!form) return;
  e.preventDefault();
  go(`#/search?q=${encodeURIComponent(new FormData(form).get('q') || '')}`);
});
document.addEventListener('keydown', e => {
  if (S.screen !== 'app' || S.merging || dialogOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (e.key === '/') {
    e.preventDefault();
    const box = document.getElementById('side-q');
    if (box?.offsetParent) box.focus(); else go('#/search');
  } else if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    quickAddModal();
  }
});

// ======================================================================
// lock screen & onboarding
// ======================================================================
function lockShell(screen, inner) {
  endSession();
  S.screen = screen;
  app.className = '';
  setHTML(app, html`<main class="lock" id="main"><div class="lock-card"><span class="brand-mark lg">${icon('logo')}</span>${inner}</div></main>`);
}

function renderUnsupported() {
  lockShell('unsupported', html`<h1>HQ</h1><p class="muted">This browser can't run HQ's encrypted vault here. Open HQ over <strong>https://</strong> in Safari, Chrome, Edge or Firefox. Private browsing may also block storage.</p>`);
}

export function renderOnboarding() {
  lockShell('onboarding', html`
    <h1>Set up HQ</h1>
    <p class="muted">Everything is encrypted on this device with a passcode only you know. There is no account and <strong>no way to reset a forgotten passcode</strong>, so choose one you'll remember.</p>
    <form id="setup" class="stack" novalidate>
      <label>What should we call you?<input name="name" required maxlength="40" autocomplete="given-name" autofocus></label>
      ${passFields()}
      <fieldset class="starter"><legend>Start with these sections <span class="muted small">(add or remove any later)</span></legend>
        ${M.TEMPLATES.filter(t => t.id !== 'tracker' && t.id !== 'table').map(t => html`<label class="check"><input type="checkbox" name="tpl" value="${t.id}" ${M.DEFAULT_TEMPLATES.includes(t.id) ? raw('checked') : ''}> ${t.name}</label>`)}
      </fieldset>
      <label class="check"><input type="checkbox" name="sample" checked> Fill them with sample data so I can look around</label>
      <button class="btn primary big">Create my dashboard</button>
    </form>
    <button type="button" class="link" id="restore">Restore from a backup file</button>`);
  wireStrength(app);
  $('#setup').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const f = new FormData(form);
    const name = String(f.get('name')).trim();
    if (!name) return fieldError(form, 'name', 'Enter your name.');
    const err = passError(f);
    if (err) return fieldError(form, err[0], err[1]);
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    btn.textContent = 'Encrypting…';
    try {
      const built = M.blankData(name);
      for (const id of f.getAll('tpl')) {
        const sec = M.TEMPLATES.find(t => t.id === id).make(built);
        if (f.get('sample')) M.addSample(sec);
        built.sections.push(sec);
      }
      // Stored exactly as any later load will see it, so other windows
      // compare like with like when merging.
      const data = M.normalize(built);
      startSession(await Vault.create(String(f.get('pass')), data), data);
    } catch (ex) {
      console.error(ex);
      btn.disabled = false;
      btn.textContent = 'Create my dashboard';
      toast(ex.message || 'Could not create the vault.');
    }
  });
  $('#restore').addEventListener('click', restoreFlow);
}

export function renderLock(msg = '', upgrade = false) {
  lockShell('lock', html`
    <h1>HQ</h1>
    <p class="muted">${upgrade ? 'Unlock once to upgrade your vault to the new format.' : 'Locked'}</p>
    <form id="unlock" class="stack" novalidate>
      <label class="sr-only" for="unlock-pass">Passcode</label>
      <input id="unlock-pass" name="pass" type="password" required autocomplete="current-password" placeholder="Passcode" autofocus aria-describedby="unlock-msg">
      <p class="err" id="unlock-msg" role="alert">${msg}</p>
      <button class="btn primary big">Unlock</button>
    </form>
    <button type="button" class="link" id="forgot">Forgot passcode?</button>`);
  const form = $('#unlock');
  const input = $('#unlock-pass');
  const msgEl = $('#unlock-msg');
  const btn = form.querySelector('button');
  let countdown;
  const throttle = ms => {
    clearInterval(countdown);
    const until = Date.now() + ms;
    btn.disabled = true;
    const tick = () => {
      if (S.screen !== 'lock') { clearInterval(countdown); return; }
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) { clearInterval(countdown); btn.disabled = false; msgEl.textContent = 'Try again.'; return; }
      msgEl.textContent = `Too many wrong tries. Wait ${left}s.`;
    };
    tick();
    countdown = setInterval(tick, 1000);
  };
  if (Vault.lockedFor()) throttle(Vault.lockedFor());
  input.focus();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!input.value) { msgEl.textContent = 'Enter your passcode.'; return; }
    btn.disabled = true;
    btn.textContent = 'Unlocking…';
    try {
      const t0 = performance.now();
      const res = await Vault.unlock(input.value);
      S.unlockMs = performance.now() - t0; // a vault tuned on a faster device is slow here
      clearInterval(countdown);
      if (res.legacy) {
        const data = M.normalize(res.data);
        startSession(await Vault.upgradeLegacy(res, data), data);
        toast('Your vault was upgraded to the new format.');
      } else {
        startSession(res.session, M.normalize(res.data));
        adoptDamaged(res.damaged, res.qmissing);
      }
    } catch (ex) {
      btn.textContent = 'Unlock';
      btn.disabled = false;
      input.select();
      if (ex.wait) throttle(ex.wait);
      else msgEl.textContent = ex.message === 'wrong' ? 'Wrong passcode.' : ex.message;
    }
  });
  $('#forgot').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Forgot your passcode?',
      body: html`<p>HQ can't recover it, and nobody else can either: your data is encrypted with it.</p><p>You can restore a backup whose passcode you remember. You'll be offered a copy of the current (locked) data first.</p>`,
      confirm: 'Choose a backup…',
    });
    if (ok) restoreFlow();
  });
}

// After unlock or restore: sections that failed their integrity check are set
// aside (quarantined), byte-for-byte, never deleted. The user decides later
// in Settings → Damaged data whether to recover a readable copy or delete.
function adoptDamaged(damaged = [], qmissing = []) {
  // The vault already listed newly damaged sections in S.data.quarantine;
  // saving now moves their records aside in one atomic write.
  let changed = damaged.length > 0;
  for (const q of S.data.quarantine) if (qmissing.includes(q.id) && !q.missing) { q.missing = true; changed = true; }
  if (changed) commit();
  if (!damaged.length) return;
  modal({
    title: 'Some data was set aside',
    submit: 'Review in Settings',
    body: html`
      <p>${plural(damaged.length, 'section')} failed HQ's integrity check. Everything else is open and working.</p>
      <ul class="facts">${damaged.map(x => html`<li>${icon('warn', 'warn-ico')} <span><strong>${x.title}</strong>: ${x.problem}</span></li>`)}</ul>
      <p class="muted small">This can happen when storage is corrupted, or if someone altered HQ's data on this device. Nothing was deleted: the affected data is kept exactly as found and included in backups. In Settings you can recover a readable copy as a new section, or delete it.</p>`,
    onSubmit: () => go('#/settings'),
  });
}

async function recoverQuarantined(el) {
  const entry = S.data.quarantine.find(q => q.id === el.dataset.id);
  if (!entry) return;
  let raw;
  try {
    raw = await Vault.openQuarantined(S.session, entry);
  } catch (e) {
    toast(e.message);
    return;
  }
  const [sec] = M.normalize({ version: M.VERSION, sections: [raw] }).sections;
  if (!sec) { toast('That data isn’t a readable section.'); return; }
  Object.assign(sec, { id: sid(), name: `${sec.name} (recovered)`.slice(0, M.MAX_NAME), sample: false });
  S.data.sections.push(sec);
  S.data.quarantine = S.data.quarantine.filter(q => q !== entry);
  go(`#/s/${encodeURIComponent(sec.id)}`);
  commit(`Recovered an older copy of “${entry.title}”. The damaged version couldn't be opened, so check this copy for anything newer that's missing.`, null, sec);
}

async function deleteQuarantined(el) {
  const entry = S.data.quarantine.find(q => q.id === el.dataset.id);
  if (!entry) return;
  const ok = await confirmDialog({
    title: `Delete “${entry.title}”?`,
    body: html`<p>The damaged data is permanently removed from this device. Backups you already downloaded still contain it.</p>`,
    confirm: 'Delete', danger: true,
  });
  if (!ok) return;
  S.data.quarantine = S.data.quarantine.filter(q => q !== entry);
  commit('Damaged data deleted.');
}

// ======================================================================
// session lifecycle
// ======================================================================
export function startSession(session, data) {
  S.session = session;
  S.data = data;
  S.screen = 'app';
  S.tables.clear();
  S.hiddenAt = 0;
  S.reloadWaiting = false;
  const r = route();
  if (!location.hash || location.hash === '#' || (r.name === 's' && !section(r.id))) history.replaceState(null, '', `${location.pathname}${location.search}#/`);
  render();
  bumpIdle();
  rollDates();
  startAutoSync();
}

// Repeating reminders (e.g. monthly renewals) move to their next date once
// the current one passes. Checked on unlock and whenever HQ comes back to
// the foreground.
function rollDates() {
  if (S.screen !== 'app') return;
  const changed = M.rollRepeating(S.data);
  // A linked item gets its point for a new day even when nothing else changed.
  const linked = M.refreshLinks(S.data);
  if (changed.length || linked.length) commit(null, null, ...changed, ...linked);
}

function endSession() {
  stopAutoSync();
  S.session = null;
  S.data = null;
  S.screen = null;
  S.tables.clear();
  S.reloadWaiting = false;
  resetSaves();
  clearTimeout(S.idle);
  clearToast();
  closeAllDialogs();
  document.title = 'HQ';
  document.body.classList.remove('private');
}

export async function lock(msg) {
  if (S.screen !== 'app') return;
  settleHolds(); // finish an in-place edit so what was typed is saved before locking
  await flushSave();
  renderLock(msg);
}

function bumpIdle() {
  if (S.screen !== 'app') return;
  clearTimeout(S.idle);
  S.idle = setTimeout(() => lock('Locked after inactivity.'), S.data.settings.autoLockMin * 60000);
}
['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev => document.addEventListener(ev, bumpIdle, { passive: true }));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) S.hiddenAt = Date.now();
  else if (S.screen === 'app' && S.hiddenAt && Date.now() - S.hiddenAt > S.data.settings.autoLockMin * 60000) lock('Locked while HQ was in the background.');
  else { rollDates(); syncConnections(); }
});
// Saves start immediately, so this only matters for a write still in flight.
window.addEventListener('beforeunload', e => {
  if (S.screen === 'app' && hasUnsaved()) { e.preventDefault(); e.returnValue = ''; }
});
window.addEventListener('pagehide', () => { if (S.screen === 'app' && hasUnsaved()) queueSave(); });

onDialogsClosed(() => { if (S.reloadWaiting) syncFromOtherWindow(); });
hooks.lock = msg => lock(msg);
hooks.startSession = (session, data) => startSession(session, data);
hooks.opened = (damaged, qmissing) => adoptDamaged(damaged, qmissing);
// Dialog submits are held back while another window's changes are merging in.
setSubmitGuard(() => !busy());

// Another window saved: merge its changes (no passcode). Replaced or erased: lock or restart.
Vault.onExternalChange(async msg => {
  if (S.screen === 'app') {
    if (msg.type === 'saved' && msg.rev > S.session.rev) syncFromOtherWindow();
    else if (msg.type === 'replaced') {
      if (await Vault.exists()) lock('HQ was replaced or re-keyed in another window. Unlock to continue.');
      else renderOnboarding();
    }
  } else if (S.screen === 'onboarding' || S.screen === 'lock') {
    const exists = await Vault.exists();
    if (exists && S.screen === 'onboarding') renderLock('HQ was set up in another window.');
    else if (!exists && S.screen === 'lock') renderOnboarding();
  }
});

// ======================================================================
// boot
// ======================================================================
// The self-test page (tests.html) runs the real app in an iframe against a
// throwaway database. That mode is only honoured on localhost, only when
// embedded by tests.html on the same origin, and only for hq-test* names.
function testDatabase() {
  const db = new URLSearchParams(location.search).get('db');
  if (!db || !/^hq-test[\w-]{0,24}$/.test(db)) return null;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) || window.top === window.self) return null;
  try {
    const top = window.top.location;
    return top.origin === location.origin && /\/tests\.html$/.test(top.pathname) ? db : null;
  } catch {
    return null;
  }
}

// Offline support plus "update available": a new version waits until the
// user chooses to switch (pending saves are flushed first), then reloads.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol !== 'https:') return;
  const offer = worker => {
    S.updateReady = worker;
    render();
    toast('A new version of HQ is ready.', { label: 'Update now', fn: applyUpdate });
  };
  navigator.serviceWorker.register('sw.js').then(reg => {
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
    setInterval(() => reg.update().catch(() => {}), 6 * 3600000);
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}
async function applyUpdate() {
  if (!S.updateReady) return;
  if (S.screen === 'app') await flushSave();
  S.updateReady.postMessage('skipWaiting');
}

async function boot() {
  applyTheme(storedTheme());
  const testDb = testDatabase();
  // Clickjacking guard for hosts that can't send frame-ancestors (GitHub Pages).
  if (window.top !== window.self && !testDb) { document.body.textContent = 'HQ cannot be shown inside another page.'; return; }
  if (testDb) {
    useDatabase(testDb);
    window.__hq = { S, M, commit, uiBusy, onDialogsClosed };
  }
  registerServiceWorker();
  if (!Vault.supported()) return renderUnsupported();
  try {
    const state = await Vault.state();
    if (state === 'v3') renderLock();
    else if (state === 'legacy') renderLock('', true);
    else renderOnboarding();
  } catch (e) {
    console.error(e);
    renderUnsupported();
  }
}
boot();
