// The save pipeline: immediate, coalesced, and merging with other windows.
import { toast, clearToast, uiBusy } from './ui.js';
import { Vault, dataFrom, snapshot } from './vault.js';
import * as M from './model.js';
import { S, hooks, saveLabel } from './store.js';
import { render } from './views.js';

// Every change is written right away; edits made while a write is in flight
// are coalesced into the next one. Nothing waits on a timer, so closing the
// app a moment after an edit doesn't lose it.
let saving = null;
let pending = false;

export function commit(msg, undo, ...touched) {
  for (const s of touched) if (s) M.touch(s);
  for (const s of M.refreshLinks(S.data)) M.touch(s); // items fed by a table follow its changes
  render();
  queueSave();
  if (msg) toast(msg, undo && { label: 'Undo', fn: () => { if (S.session) undo(); } });
}

export function queueSave() {
  pending = true;
  setSaveState('saving');
  saving ||= drain();
  return saving;
}

export async function flushSave() {
  while (saving) await saving;
}

export const hasUnsaved = () => pending || !!saving;

async function drain() {
  try {
    while (pending && S.session) {
      pending = false;
      const session = S.session;
      try {
        await Vault.save(session, S.data);
      } catch (e) {
        if (session !== S.session) return;
        if (e.conflict) { await pullAndMerge(); continue; }
        console.error(e);
        pending = true;
        setSaveState('error');
        toast('Could not save. Storage may be full.', { label: 'Retry', fn: queueSave });
        return;
      }
    }
    setSaveState('saved');
  } finally {
    saving = null;
  }
}

function setSaveState(state) {
  const was = S.saveState;
  S.saveState = state;
  const el = document.getElementById('save-state');
  if (el) {
    el.dataset.state = state;
    el.textContent = saveLabel(state);
  }
  // Screen readers hear only what matters: a failure, and recovery from one.
  const live = document.getElementById('sr-status');
  if (live && state !== was && (state === 'error' || was === 'error')) live.textContent = state === 'error' ? 'Changes not saved' : state === 'saved' ? 'Changes saved' : '';
}

// Loads what another window saved and three-way merges this window's unsaved
// edits on top. Merges run one at a time. The base, this window's copy and
// the saved copy are all captured and adopted in one synchronous step after
// the read, so nothing can interleave. The UI is read-only while reading.
let syncing = Promise.resolve();
export function pullAndMerge() {
  const run = syncing.then(mergeOnce);
  syncing = run.catch(() => {});
  return run;
}

async function mergeOnce() {
  const session = S.session;
  if (!session) return;
  S.merging = true;
  let latest;
  try {
    latest = await Vault.readLatest(session);
  } catch {
    hooks.lock('HQ was changed in another window. Unlock to continue.');
    return;
  } finally {
    S.merging = false;
  }
  if (session !== S.session || latest.rev === session.rev) return;
  const base = M.normalize(dataFrom(session.cache));
  const disk = M.normalize(latest.data);
  const merged = M.mergeConcurrent(base, S.data, disk);
  // Re-validate: e.g. a column retyped in one window and a row edited in the
  // other must not leave cells of the wrong type behind.
  const data = M.normalize(merged.data);
  const { conflicts } = merged;
  Object.assign(session, { rev: latest.rev, cache: latest.cache, hashes: latest.hashes, qnames: latest.qnames });
  S.data = data;
  clearToast(); // an Undo would act on objects that no longer exist
  render();
  // Write only if the merge holds something the saved copy doesn't, so two
  // windows settle instead of re-saving to each other.
  const mine = snapshot(data);
  if ([...mine].some(([n, j]) => latest.cache.get(n) !== j) || latest.cache.size !== mine.size) pending = true;
  if (conflicts.length) toast(`Also changed in another window: ${conflicts.join('; ')}. The saved version was kept for those.`);
}

// Another window saved. Merge now, or once the open dialog closes, so
// nothing the user is typing gets thrown away.
export async function syncFromOtherWindow() {
  if (S.screen !== 'app') return;
  if (uiBusy()) {
    if (!S.reloadWaiting) toast('Changes from another window will appear when you close this.');
    S.reloadWaiting = true;
    return;
  }
  S.reloadWaiting = false;
  await flushSave(); // our own pending edits go first; a conflict merges
  if (S.session) await pullAndMerge();
  if (pending) queueSave();
}

export function resetSaves() {
  pending = false;
  S.saveState = 'saved';
  S.merging = false;
}
