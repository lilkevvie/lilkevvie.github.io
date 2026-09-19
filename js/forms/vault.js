// Backups and the passcode: restore a backup, change the passcode.
import { html, icon, modal, confirmDialog, toast, download, pickFile, today, ago } from '../ui.js';
import { Vault } from '../vault.js';
import * as M from '../model.js';
import { S, hooks } from '../store.js';
import { flushSave, pullAndMerge } from '../persist.js';
import { go } from '../views.js';
import { fieldError } from './field.js';
import { passFields, wireStrength, passError } from './passcode.js';

// ---------- backup / restore / passcode ----------
export async function restoreFlow() {
  const file = await pickFile('.json,application/json');
  if (!file) return;
  if (file.size > 60 * 1024 * 1024) { toast('That file is too large to be an HQ backup.'); return; }
  let parsed;
  try { parsed = Vault.parseBackup(await file.text()); } catch (e) { toast(e.message); return; }
  const hasCurrent = await Vault.exists();
  modal({
    title: 'Restore backup',
    submit: 'Restore',
    danger: hasCurrent,
    body: html`
      <p>Backup file <strong>${file.name}</strong>${parsed.savedAt ? `, saved ${ago(parsed.savedAt)}` : ''}.</p>
      <label>The backup's passcode<input name="pass" type="password" required autocomplete="off" autofocus></label>
      ${hasCurrent ? html`<p class="stale small">${icon('warn', 'warn-ico')} Restoring replaces all HQ data on this device.</p>
        <label class="check"><input type="checkbox" name="keep" checked> Download a backup of the current data first</label>` : ''}`,
    onSubmit: async (f, d) => {
      const form = d.querySelector('form');
      let opened, data;
      try {
        opened = await Vault.openBackup(parsed, String(f.get('pass')));
        data = M.normalize(opened.data);
      } catch (e) {
        return fieldError(form, 'pass', e.message);
      }
      if (hasCurrent && f.get('keep')) {
        try {
          download(`hq-backup-before-restore-${today()}.json`, await Vault.exportBackup(), 'application/json');
        } catch (e) {
          const go = await confirmDialog({
            title: 'Couldn’t copy the current data',
            body: html`<p>${e.message} If you continue, what's on this device now is replaced and can't be recovered.</p>`,
            confirm: 'Replace anyway', danger: true,
          });
          if (!go) return false;
        }
      }
      await flushSave();
      hooks.startSession(await Vault.installBackup(parsed, opened, data), data);
      hooks.opened(opened.damaged, opened.qmissing);
      toast('Backup restored.');
    },
  });
}

export function changePassModal() {
  modal({
    title: 'Change passcode',
    submit: 'Change',
    body: html`
      <label>Current passcode<input name="current" type="password" required autocomplete="current-password" autofocus></label>
      ${passFields('New passcode')}
      <p class="muted small">Backups you already downloaded keep the old passcode.</p>`,
    onOpen: wireStrength,
    onSubmit: async (f, d) => {
      const form = d.querySelector('form');
      try {
        await Vault.unlock(String(f.get('current')));
      } catch (e) {
        const wait = Math.ceil((e.wait || 0) / 1000);
        return fieldError(form, 'current', ['wrong', 'throttled'].includes(e.message) ? (wait ? `Wrong passcode. Wait ${wait}s before trying again.` : 'Wrong passcode.') : e.message);
      }
      const err = passError(f);
      if (err) return fieldError(form, err[0], err[1]);
      await flushSave();
      try {
        S.session = await Vault.rekey(S.session, String(f.get('pass')), S.data);
      } catch (e) {
        if (!e.conflict) throw e;
        await pullAndMerge();
        toast('Another window just saved. Its changes are loaded now. Change the passcode again.');
        return;
      }
      S.unlockMs = 0; // re-tuned for this device
      toast('Passcode changed.');
    },
  });
}
