// Live connections: add or edit a connection, and set up the relay.
import { html, raw, setHTML, icon, modal, confirmDialog, toast, sid } from '../ui.js';
import { newSnapshotKey } from '../snapshots.js';
import * as C from '../connectors.js';
import { syncConnections } from '../sync.js';
import * as M from '../model.js';
import { S, section } from '../store.js';
import { commit } from '../persist.js';
import { fieldError } from './field.js';

// ---------- live connections ----------
// Keys are typed by you, stored only inside the encrypted vault, and never
// shown again: editing a connection leaves a key field blank to keep it.
export function connectionModal(conn) {
  const isNew = !conn;
  const kindIds = Object.keys(C.KINDS);
  let kindId = conn?.kind || kindIds[0];
  const targetOptions = kind => {
    const fitting = S.data.sections.filter(s => C.fits(s, kind));
    const tpl = M.TEMPLATES.find(t => t.id === kind.template);
    const cur = conn && conn.kind === kindId ? conn.target : fitting.find(s => s.template === kind.template)?.id;
    return html`${fitting.map(s => html`<option value="${s.id}" ${s.id === cur ? raw('selected') : ''}>${s.name}</option>`)}<option value="new" ${!fitting.some(s => s.id === cur) ? raw('selected') : ''}>New section: ${tpl.name}</option>`;
  };
  const kindBody = () => {
    const kind = C.KINDS[kindId];
    const same = conn && conn.kind === kindId;
    const relayMissing = kind.mode === 'relay' && !(S.data.relay.url && S.data.relay.token);
    return html`
      <p class="muted small">${kind.help}</p>
      ${relayMissing ? html`<p class="small stale">${icon('warn', 'warn-ico')} This needs your relay. Set it up first with the Relay button under Settings → Connections (steps in the README).</p>` : ''}
      ${kind.fields.map(f => html`<label>${f.label}<input name="f-${f.key}" ${f.secret ? raw('type="password"') : ''} autocomplete="off" spellcheck="false" autocapitalize="off" maxlength="2000"
        value="${!f.secret && same ? conn.secrets[f.key] || '' : ''}" placeholder="${f.secret && same && conn.secrets[f.key] ? 'Saved. Leave blank to keep it.' : ''}"></label>`)}
      <label>Fill this section<select name="target">${targetOptions(kind)}</select></label>`;
  };
  modal({
    title: isNew ? 'Add a connection' : `Edit ${conn.name}`,
    extra: isNew ? '' : html`<button type="button" class="btn danger" data-del>${icon('trash')} Remove</button>`,
    body: html`
      ${isNew ? html`<label>Connect<select name="kind" data-kind>${kindIds.map(k => html`<option value="${k}">${C.KINDS[k].name}</option>`)}</select></label>` : ''}
      <label>Name<input name="name" required maxlength="${M.MAX_NAME}" value="${conn?.name || C.KINDS[kindId].name}"></label>
      <div data-kind-body>${kindBody()}</div>`,
    onOpen: d => {
      const form = d.querySelector('form');
      d.querySelector('[data-kind]')?.addEventListener('change', e => {
        const was = C.KINDS[kindId].name;
        kindId = e.target.value;
        if (form.elements.name.value === was) form.elements.name.value = C.KINDS[kindId].name;
        setHTML(d.querySelector('[data-kind-body]'), kindBody());
      });
      d.querySelector('[data-del]')?.addEventListener('click', () => {
        d.dismiss();
        const list = S.data.connections;
        const idx = list.indexOf(conn);
        if (idx < 0) return;
        list.splice(idx, 1);
        commit(`Removed ${conn.name}. Its section and data stay.`, () => { list.splice(idx, 0, conn); commit('Restored.'); });
      });
    },
    onSubmit: (f, d) => {
      const form = d.querySelector('form');
      const kind = C.KINDS[kindId];
      const name = String(f.get('name')).trim();
      if (!name) return fieldError(form, 'name', 'Enter a name.');
      const same = conn && conn.kind === kindId;
      const secrets = {};
      for (const fl of kind.fields) {
        const v = String(f.get(`f-${fl.key}`) || '').trim();
        const kept = fl.secret && same ? conn.secrets[fl.key] : '';
        if (!v && !kept && !fl.optional) return fieldError(form, `f-${fl.key}`, `Enter the ${fl.label.replace(/,.*/, '').toLowerCase()}.`);
        if (v && fl.pattern && !new RegExp(fl.pattern).test(v)) return fieldError(form, `f-${fl.key}`, `That doesn’t look like a valid ${fl.label.toLowerCase()}.`);
        secrets[fl.key] = v || kept;
      }
      let target = String(f.get('target'));
      if (target === 'new' || !C.fits(section(target), kind)) {
        const sec = M.TEMPLATES.find(t => t.id === kind.template).make(S.data);
        S.data.sections.push(sec);
        target = sec.id;
      }
      const c = conn || { id: sid(), kind: kindId, status: {}, cursor: null };
      const newKeys = !same || JSON.stringify(c.secrets) !== JSON.stringify(secrets);
      const changed = newKeys || c.target !== target;
      Object.assign(c, { kind: kindId, name, secrets, target });
      if (newKeys) c.secretsAt = Date.now();
      if (changed) Object.assign(c, { status: {}, cursor: null }); // sync afresh with the new settings
      if (isNew) S.data.connections.push(c);
      commit(isNew ? `Added ${name}.` : 'Saved.');
      if (changed) syncConnections({ ids: [c.id] });
    },
  });
}

// Snapshots are off until you create a key here and give its public half to
// the relay; the relay can then lock snapshots, and only this vault can open them.
function snapBody() {
  const k = S.data.relay.snapKey;
  if (!k) {
    return html`<p class="muted small">The relay can record your balances and TikTok followers every 6 hours, so days you don’t open HQ still get a point. Snapshots are stored in your Cloudflare account, locked with a key that only this vault can open: Cloudflare sees dates and scrambled data, never amounts.</p>
      <button type="button" class="btn small" data-snap-new>Turn on encrypted snapshots</button>`;
  }
  return html`<p class="muted small">Give this public key to the relay. It can lock snapshots with it but never open them; the matching private key stays in this vault.</p>
    <div class="copy-row"><input id="snap-pub" readonly value="${k.pub}" aria-label="Snapshot public key" spellcheck="false"><button type="button" class="btn small" data-snap-copy>Copy</button></div>
    <p class="muted small">In the <code>relay</code> folder run <code>npx wrangler secret put HQ_SNAPSHOT_KEY</code> and paste it. To stop snapshots, delete that secret.</p>
    <button type="button" class="btn small ghost" data-snap-new>Replace key…</button>`;
}

// The relay is a tiny server you deploy (relay/worker.js) for services that
// don't allow calls from a web page. HQ holds only its address and token.
export function relayModal() {
  const r = S.data.relay;
  const relayIds = () => S.data.connections.filter(c => C.KINDS[c.kind]?.mode === 'relay').map(c => c.id);
  modal({
    title: 'Relay',
    body: html`
      <p class="muted small">Shopify, TikTok and bank aggregators only answer servers, not web pages. Your relay is a free Cloudflare Worker that <em>you</em> deploy from <code>relay/worker.js</code>. It holds those services’ keys, and HQ reaches it with the token below. Setup steps are in the README.</p>
      <label>Relay address<input name="url" type="url" required inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://hq-relay.yourname.workers.dev" value="${r.url}"></label>
      <label>Relay token<input name="token" type="password" autocomplete="off" spellcheck="false" maxlength="300" placeholder="${r.token ? 'Saved. Leave blank to keep it.' : 'The HQ_TOKEN you set on the relay'}"></label>
      <fieldset class="snap"><legend>Snapshots while HQ is closed <span class="muted">(optional)</span></legend><div data-snap>${snapBody()}</div></fieldset>`,
    extra: r.url ? html`<button type="button" class="btn danger" data-del>Forget relay</button>` : '',
    onOpen: d => {
      d.querySelector('[data-del]')?.addEventListener('click', () => {
        d.dismiss();
        const was = { ...S.data.relay };
        S.data.relay = { url: '', token: '', snapKey: null };
        commit('Relay removed.', () => { S.data.relay = was; commit('Restored.'); });
      });
      d.querySelector('[data-snap]').addEventListener('click', async e => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.dataset.snapCopy != null) {
          try { await navigator.clipboard.writeText(S.data.relay.snapKey.pub); toast('Public key copied.'); } catch { d.querySelector('#snap-pub')?.select(); }
          return;
        }
        if (btn.dataset.snapNew != null) {
          if (S.data.relay.snapKey && !(await confirmDialog({ title: 'Replace the snapshot key?', body: html`<p>Snapshots the relay already took were locked to the old key and can’t be opened after this. Put the new public key on the relay right away.</p>`, confirm: 'Replace', danger: true }))) return;
          S.data.relay = { ...S.data.relay, snapKey: await newSnapshotKey() };
          commit('Snapshot key created. Now give the public key to the relay.');
          setHTML(d.querySelector('[data-snap]'), snapBody());
          d.querySelector('#snap-pub')?.focus();
        }
      });
    },
    onSubmit: async (f, d) => {
      const form = d.querySelector('form');
      const url = String(f.get('url')).trim().replace(/\/+$/, '');
      const err = C.relayUrlError(url);
      if (err) return fieldError(form, 'url', err);
      const token = String(f.get('token')).trim() || r.token;
      if (token.length < 24) return fieldError(form, 'token', 'Use the long random token you set on the relay (at least 24 characters).');
      let problem = null;
      try {
        const h = await C.fetchJSON(`${url}/health`, { headers: { Authorization: `Bearer ${token}` } });
        const warnings = Array.isArray(h.warnings) ? h.warnings.filter(x => typeof x === 'string').map(x => x.slice(0, 160)) : [];
        const mine = S.data.relay.snapKey?.pub || null;
        if (typeof h.snapshotKey === 'string' && h.snapshotKey !== mine) warnings.push(mine ? 'Its snapshot key isn’t this vault’s: set HQ_SNAPSHOT_KEY to the public key shown here.' : 'It has a snapshot key, but this vault has none: create one here and put it on the relay.');
        if (warnings.length) problem = `the relay needs attention: ${warnings.join(' ')}`;
      } catch (e) { problem = `the relay didn’t answer: ${e.message}`; }
      S.data.relay = { ...S.data.relay, url, token };
      // Relay connections that failed for lack of a relay can try right away.
      for (const c of S.data.connections) if (relayIds().includes(c.id)) c.status = { ...c.status, lastTry: null };
      commit(problem ? `Saved, but ${problem}` : 'Relay connected.');
      // Warnings are shown first; a sync would replace the message with its own.
      if (!problem && relayIds().length) syncConnections({ ids: relayIds() });
    },
  });
}
