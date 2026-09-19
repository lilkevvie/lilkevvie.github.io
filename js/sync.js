// Automatic sync of live connections: on unlock, when HQ comes back to the
// foreground, and on a timer while it's open, each connection that hasn't
// synced within the chosen interval (default 6 hours) is refreshed.
//
// Only one window syncs at a time (Web Locks), and it merges in other
// windows' saves first, so two windows never fetch the same thing twice.
// Fetching happens in the background; results are applied only while no
// dialog is open, so nothing the user is editing changes underneath them.
import { toast, uiBusy, onDialogsClosed } from './ui.js';
import * as C from './connectors.js';
import { S } from './store.js';
import { commit, flushSave, pullAndMerge } from './persist.js';

let running = false;
let timer = null;
let waiters = [];
onDialogsClosed(() => waiters.splice(0).forEach(f => f()));
const noDialog = () => (uiBusy() ? new Promise(r => waiters.push(r)) : null);

function showState() {
  const el = document.getElementById('sync-state');
  if (el) el.textContent = S.syncing ? 'Syncing…' : '';
}

// ids: sync just these (the "Sync now" buttons); otherwise whatever is due.
// Resolves to [[name, {ok, error?, summary?}], ...] for what was synced.
/** @param {{ids?: string[]|null}} [opts] @returns {Promise<Array<[string, {ok: boolean, error?: string}]>>} */
export async function syncConnections({ ids = null } = {}) {
  if (S.screen !== 'app' || running || !S.data.connections.length) return [];
  const session = S.session;
  const live = () => S.screen === 'app' && S.session === session;
  const due = () => S.data.connections.filter(c => (ids ? ids.includes(c.id) : C.isDue(c, S.data.settings.syncHours)));
  if (!due().length) return [];

  const work = async () => {
    running = true;
    S.syncing = true;
    showState();
    const outcomes = [];
    try {
      await flushSave();
      await pullAndMerge(); // no-op unless another window saved meanwhile
      for (const c of live() ? due() : []) {
        const outcome = await C.fetchConnection(c, S.data);
        await noDialog();
        if (!live()) break;
        const res = C.applyOutcome(S.data, c.id, outcome);
        if (res) outcomes.push([c.name, res]);
        commit();
      }
    } finally {
      running = false;
      S.syncing = false;
      showState();
    }
    return outcomes;
  };

  const outcomes = navigator.locks?.request
    ? await navigator.locks.request('hq-sync', { ifAvailable: true }, lock => (lock ? work() : []))
    : await work();
  if (ids && live()) {
    const failed = outcomes.find(([, r]) => !r.ok);
    toast(failed ? `${failed[0]}: ${failed[1].error}`
      : !outcomes.length ? 'Another HQ window is syncing right now.'
      : outcomes.length === 1 ? `${outcomes[0][0]} is up to date.` : `${outcomes.length} connections are up to date.`);
  }
  return outcomes;
}

export function startAutoSync() {
  stopAutoSync();
  syncConnections();
  // Checks often but only syncs what's due, so a laptop that slept through
  // the 6-hour mark catches up within minutes of waking.
  timer = setInterval(() => syncConnections(), 10 * 60000);
}

export function stopAutoSync() {
  clearInterval(timer);
  timer = null;
  waiters.splice(0).forEach(f => f());
}
