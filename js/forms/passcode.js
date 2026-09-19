// Passcode fields: strength estimate (entropy, not character rules) and checks.
import { html } from '../ui.js';

// ---------- passcodes ----------
// Strength is an entropy estimate, not a character-class checklist: common
// words, keyboard runs, repeats and sequences (abc, 321) count as a single
// character, then length × log2(alphabet). The vault is only as strong as the
// passcode against offline guessing, so at least MIN_BITS is required; a
// four-word passphrase such as "correct horse battery staple" clears it easily.
export const MIN_BITS = 60;
const WEAK_PARTS = ['password', 'passcode', 'passw0rd', 'qwerty', 'asdf', 'zxcv', 'letmein', 'welcome', 'iloveyou', 'admin', 'login', 'monkey', 'dragon', 'master', 'secret', 'hello', 'freedom', 'sunshine', 'princess', 'football', 'baseball', 'shadow', 'summer', 'winter', 'test', 'changeme'];
export function entropyBits(p) {
  if (!p) return 0;
  let s = p.toLowerCase();
  for (const w of WEAK_PARTS) s = s.split(w).join(''); // a whole common word ≈ 1 guess
  let eff = 0;
  for (let i = 0; i < s.length; i++) {
    const a = s.charCodeAt(i), b = s.charCodeAt(i - 1), c = s.charCodeAt(i - 2);
    const repeat = i >= 2 && a === b && b === c;
    const run = i >= 2 && ((a - b === 1 && b - c === 1) || (a - b === -1 && b - c === -1));
    if (!repeat && !run) eff++;
  }
  const pool = (/[a-z]/.test(p) ? 26 : 0) + (/[A-Z]/.test(p) ? 26 : 0) + (/\d/.test(p) ? 10 : 0) + (/[^A-Za-z0-9]/.test(p) ? 33 : 0);
  return Math.round(eff * Math.log2(Math.max(pool, 2)));
}
export const strength = p => {
  const bits = entropyBits(p);
  return bits < 30 ? 0 : bits < 45 ? 1 : bits < MIN_BITS ? 2 : bits < 80 ? 3 : 4;
};
const HINT = 'Use a short phrase of 4 or more unrelated words, like “orange tiger lamp river”.';
export function passFields(label = 'Passcode') {
  return html`
    <label>${label}<input name="pass" id="pass" type="password" required minlength="10" autocomplete="new-password" aria-describedby="pass-hint"></label>
    <div class="strength"><meter id="pass-meter" min="0" max="4" low="3" high="3.5" optimum="4" value="0" aria-label="Passcode strength"></meter><span id="pass-hint" class="small muted" aria-live="polite">${HINT}</span></div>
    <label>Confirm ${label.toLowerCase()}<input name="pass2" type="password" required minlength="10" autocomplete="new-password"></label>`;
}
export function wireStrength(root) {
  const input = root.querySelector('#pass');
  const meter = root.querySelector('#pass-meter');
  const hint = root.querySelector('#pass-hint');
  input.addEventListener('input', () => {
    const s = strength(input.value);
    meter.value = s;
    hint.textContent = !input.value ? HINT : ['Too easy to guess', 'Too weak: add another word or two', 'Almost: add one more word', 'Strong', 'Very strong'][s];
  });
}
export function passError(f) {
  const p = String(f.get('pass'));
  if (p.length < 10) return ['pass', 'Use at least 10 characters. A few words are easiest to remember.'];
  if (entropyBits(p) < MIN_BITS) return ['pass', `Too easy to guess. ${HINT}`];
  if (p !== f.get('pass2')) return ['pass2', "Passcodes don't match."];
  return null;
}
