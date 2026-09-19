// Settings: preferences, connections, sections, damaged data, passwords and the vault.
import { html, $, raw, icon, ago, LOCALE } from '../ui.js';
import * as C from '../connectors.js';
import { S, section, money, plural } from '../store.js';

// ---------- settings ----------
const COMMON_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'EGP', 'AED', 'SAR', 'CHF', 'JPY', 'INR', 'MXN', 'BRL', 'CNY'];
function currencyOptions(selected) {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : COMMON_CURRENCIES;
  let names = null;
  try { names = new Intl.DisplayNames(LOCALE, { type: 'currency' }); } catch { /* older browser */ }
  const opt = c => html`<option value="${c}" ${c === selected ? raw('selected') : ''}>${c}${names ? ` · ${names.of(c)}` : ''}</option>`;
  return html`<optgroup label="Common">${COMMON_CURRENCIES.filter(c => all.includes(c)).map(opt)}</optgroup><optgroup label="All currencies">${all.filter(c => !COMMON_CURRENCIES.includes(c)).map(opt)}</optgroup>`;
}

export function connStatus(c) {
  const st = c.status || {};
  if (st.error) return { bad: true, text: `${st.error}${st.lastOk ? ` Last good sync ${ago(st.lastOk)}.` : ''}` };
  const left = C.keyDaysLeft(c);
  const renew = left == null || left > 10 ? '' : left > 0 ? ` · Key expires in ${plural(left, 'day')}: edit to paste a new one` : ' · Key has expired: edit to paste a new one';
  if (!st.lastOk) return { bad: !!renew, text: `Not synced yet${renew}` };
  const s = st.summary;
  const what = s && (s.added || s.updated) ? ` · ${[s.added && `${s.added} added`, s.updated && `${s.updated} updated`].filter(Boolean).join(', ')}` : '';
  return { bad: !!(renew || s?.warning), text: `Synced ${ago(st.lastOk)}${what}${s?.warning ? ` · ${s.warning}` : ''}${renew}` };
}

function connectionsCard() {
  const conns = S.data.connections;
  const hours = S.data.settings.syncHours;
  const relay = S.data.relay;
  const needsRelay = conns.some(c => C.KINDS[c.kind]?.mode === 'relay');
  let relayHost = '';
  try { relayHost = relay.url ? new URL(relay.url).host : ''; } catch { /* shown as not set */ }
  return html`<section class="card" aria-labelledby="set-conn">
    <div class="card-head"><h2 id="set-conn">Connections</h2><button type="button" class="btn small" data-act="addConnection">${icon('plus')} Add</button></div>
    <p class="muted small">Fill sections automatically from YouTube, Instagram, TikTok, Shopify and your banks. Keys are kept inside your encrypted vault and sent only to that service (or to your own relay). Everything is read-only: HQ can never post, buy or move money.</p>
    <div class="form-grid">
      <label>Sync automatically<select id="set-sync" data-change="setting" data-key="syncHours">${C.SYNC_HOURS.map(h => html`<option value="${h}" ${hours === h ? raw('selected') : ''}>${h ? `Every ${plural(h, 'hour')}` : 'Off (only when I press Sync)'}</option>`)}</select></label>
    </div>
    <p class="muted small">HQ syncs while it's open: on unlock, when you come back to it, and on schedule. <span id="sync-state" role="status">${S.syncing ? 'Syncing…' : ''}</span></p>
    ${conns.length ? html`<ul class="rows" role="list">${conns.map(c => {
      const st = connStatus(c);
      const sec = section(c.target);
      return html`<li class="row static">
        <span class="badge sm c-${sec?.color ?? 0}">${icon(sec?.icon || 'refresh')}</span>
        <span class="row-main"><span class="row-title">${c.name}</span>
          <span class="row-sub">${C.KINDS[c.kind]?.name || c.kind} → ${sec ? sec.name : 'no section'} · ${st.bad ? html`<span class="stale">${icon('warn', 'warn-ico')} ${st.text}</span>` : st.text}</span></span>
        <button type="button" class="btn small" data-act="syncNow" data-id="${c.id}">${icon('refresh')} Sync</button>
        <button type="button" class="icon-btn ghost" data-act="editConnection" data-id="${c.id}" aria-label="Edit ${c.name}">${icon('edit')}</button>
      </li>`;
    })}</ul>` : ''}
    <div class="btn-row">
      <button type="button" class="btn small" data-act="relaySettings">Relay${relayHost ? `: ${relayHost}` : needsRelay ? ' (needed, not set up)' : ' (for Shopify, TikTok and banks)'}</button>
    </div>
  </section>`;
}

export function viewSettings() {
  const st = S.data.settings;
  S.mounts.push(async () => {
    const el = $('#storage-info');
    if (!el || !navigator.storage?.estimate) return;
    const [est, persisted] = await Promise.all([navigator.storage.estimate(), navigator.storage.persisted?.() ?? false]);
    el.textContent = `Using ${Math.max(1, Math.round(est.usage / 1024)).toLocaleString(LOCALE)} KB on this device. ${persisted ? 'Storage is persistent, so the browser won’t clear it.' : 'Storage isn’t marked persistent. Installing HQ to your home screen stops the browser from clearing it. Keep a recent backup either way.'}`;
  });
  return {
    title: 'Settings',
    body: html`
      <section class="card" aria-labelledby="set-prefs">
        <h2 id="set-prefs">Preferences</h2>
        <div class="form-grid">
          <label>Your name<input id="set-name" value="${S.data.profile.name}" maxlength="40" data-change="setting" data-key="name" autocomplete="given-name"></label>
          <label>Currency<select id="set-cur" data-change="setting" data-key="currency">${currencyOptions(st.currency)}</select></label>
          <label>Auto-lock after<select id="set-lock" data-change="setting" data-key="autoLockMin">${[1, 5, 15, 30].map(m => html`<option value="${m}" ${st.autoLockMin === m ? raw('selected') : ''}>${plural(m, 'minute')}</option>`)}</select></label>
          <label>Appearance<select id="set-theme" data-change="setting" data-key="theme">${[['system', 'Match this device'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => html`<option value="${k}" ${st.theme === k ? raw('selected') : ''}>${l}</option>`)}</select></label>
          <label>Flag values as stale after<select id="set-stale" data-change="setting" data-key="staleDays">${[1, 3, 7, 14, 30].map(m => html`<option value="${m}" ${st.staleDays === m ? raw('selected') : ''}>${plural(m, 'day')}</option>`)}</select></label>
        </div>
      </section>

      ${connectionsCard()}

      <section class="card" aria-labelledby="set-secs">
        <div class="card-head"><h2 id="set-secs">Sections</h2><button type="button" class="btn small" data-act="newSection">${icon('plus')} New</button></div>
        <p class="muted small">This order is used on Home and in the menu.</p>
        <ul class="rows" role="list">${S.data.sections.map((s, i, all) => html`<li class="row static">
          <span class="badge sm c-${s.color}">${icon(s.icon)}</span>
          <span class="row-main"><span class="row-title">${s.name}</span></span>
          <label class="check small"><input type="checkbox" id="home-${s.id}" data-change="toggleHome" data-sec="${s.id}" ${s.home ? raw('checked') : ''}> On Home</label>
          <button type="button" class="icon-btn ghost" data-act="move" data-sec="${s.id}" data-v="-1" aria-label="Move ${s.name} up" ${i === 0 ? raw('disabled') : ''}>${icon('up')}</button>
          <button type="button" class="icon-btn ghost" data-act="move" data-sec="${s.id}" data-v="1" aria-label="Move ${s.name} down" ${i === all.length - 1 ? raw('disabled') : ''}>${icon('down')}</button>
        </li>`)}</ul>
      </section>

      ${S.data.quarantine.length ? html`<section class="card attention" aria-labelledby="set-q">
        <h2 id="set-q">${icon('warn', 'warn-ico')} Damaged data</h2>
        <p class="muted small">These sections failed HQ's integrity check. They're kept exactly as found and included in backups. If one is a readable older copy, you can recover it as a new section.</p>
        <ul class="rows" role="list">${S.data.quarantine.map(q => html`<li class="row static">
          <span class="row-main"><span class="row-title">${q.title}</span><span class="row-sub">${q.problem} · set aside ${ago(q.at)}${q.missing ? ' · nothing left to recover' : ''}</span></span>
          ${q.missing ? '' : html`<button type="button" class="btn small" data-act="qRecover" data-id="${q.id}">Recover copy</button>`}
          <button type="button" class="btn small danger" data-act="qDelete" data-id="${q.id}">Delete</button>
        </li>`)}</ul>
      </section>` : ''}

      <section class="card" aria-labelledby="set-pw">
        <h2 id="set-pw">Passwords</h2>
        <p>HQ deliberately doesn't store your Apple or Chrome passwords. If one app held every password, that app would be the only thing an attacker needs. iCloud Keychain and Google Password Manager already protect them with hardware-backed encryption, Face ID and breach alerts. Use a <strong>Security checklist</strong> section to track 2FA across your accounts.</p>
        <div class="btn-row">
          <a class="btn" href="https://passwords.google.com/checkup" target="_blank" rel="noopener noreferrer">${icon('link')} Google Password Checkup</a>
          <a class="btn" href="https://myaccount.google.com/security" target="_blank" rel="noopener noreferrer">${icon('link')} Google security</a>
          <a class="btn" href="https://account.apple.com" target="_blank" rel="noopener noreferrer">${icon('link')} Apple Account</a>
        </div>
        <p class="muted small">On iPhone: Settings → Passwords → Security Recommendations.</p>
      </section>

      <section class="card" aria-labelledby="set-vault">
        <h2 id="set-vault">Vault</h2>
        <ul class="facts">
          <li>${icon('check')} Encrypted on this device with AES-256-GCM. The key comes from your passcode (PBKDF2, ${(S.session?.iter || 600000).toLocaleString(LOCALE)} rounds, tuned to this device) and never leaves memory.</li>
          <li>${icon('check')} Nothing leaves this device except requests to services you connect. Backups stay encrypted with your passcode.</li>
          <li>${icon('check')} Locks after ${plural(st.autoLockMin, 'minute')} idle or in the background. Repeated wrong passcodes are slowed down.</li>
        </ul>
        ${S.unlockMs > 3000 ? html`<p class="small stale">${icon('warn', 'warn-ico')} Unlocking took ${Math.round(S.unlockMs / 1000)} seconds on this device, probably because the vault was set up on a faster one. Change the passcode (you can reuse the same one) to re-tune it for this device.</p>` : ''}
        <p class="muted small" id="storage-info"></p>
        <div class="btn-row">
          <button type="button" class="btn" data-act="backup">${icon('download')} Download encrypted backup</button>
          <button type="button" class="btn" data-act="restore">${icon('upload')} Restore backup</button>
          <button type="button" class="btn" data-act="changePass">Change passcode</button>
          <button type="button" class="btn danger" data-act="erase">${icon('trash')} Erase everything</button>
        </div>
      </section>
      <p class="fine">HQ 3 · local-first · no tracking</p>`,
  };
}
