# HQ: personal dashboard

One private place for everything you track: bank balances, investments, store sales, followers, subscriptions, goals, checklists, or anything new you think of. It's an installable web app (PWA). All data is encrypted on your device.

## How it's organized

Everything lives in **sections**. There are two kinds, and together they cover any kind of data without code changes:

| Kind | Holds | Examples |
|---|---|---|
| **Tracker** | Named items with one value each and a dated history. Money trackers can count toward **net worth**, with debts subtracted. | Bank accounts, investments, followers, goals with targets, weight |
| **Table** | Rows with columns you define: text, long text, number, money, date, choice, checkbox, link, **tags** (several choices per row), and **formula** (e.g. `{Revenue} - {Cost}`, computed per row, never stored). | Sales, orders, subscriptions, security checklist, workouts, content log |

- **New section**: pick a template (Bank accounts, Investments, Social media, Store sales, Subscriptions, Goals, Security checklist, Daily log) or start blank. Every section shows up on Home automatically.
- **Add data**: the **+** button (or press **N**) adds to any section. **Daily update** refreshes every tracked value in one screen. **Import** loads a CSV into any table: you map each column and review the guessed types.
- **Headline numbers**: each table shows a total, 30-day total with trend, average, count or checked-off progress. You choose it in section settings, along with an optional **breakdown** by a choice column (e.g. spend per category).
- **Reminders**: pick a date column and a window, and rows due soon or overdue show on Home under *Coming up*. Monthly or yearly dates (renewals) roll forward by themselves.
- **Templates**: any section's setup (not its data) can be exported as a small file and imported again, on this or another device.
- **Automatic updates**: connect YouTube, Instagram, TikTok, Shopify and your banks under Settings → Connections (see below).
- **Links between sections**: a tracker item can take its value from a table instead of being typed in: a column's total, total over the last 30 days, latest or average value, or the number of rows. For example, "Store revenue, last 30 days" follows your Store sales table, and it keeps its own history like any other item.
- **Tables**: click a cell to edit it in place (on a computer; on a phone, tap a row). On a computer the cells also work from the keyboard: arrow keys to move, Enter to edit. Tick rows to change a column, export or delete them all at once. Chart any number, money or formula column per day, week or month. A table holds up to 20,000 rows; an import or connection that would go past that stops and says how many rows didn't fit, and nothing already saved is ever dropped.
- **Search** (**/**) covers every section, item and row.

## Security model

- **Encryption:** AES-256-GCM with a key derived from your passcode (PBKDF2-SHA256). The cost is tuned to about one second on the device that creates the vault or changes the passcode, never below 600,000 iterations, and stored with the vault. The key is non-extractable and exists only in memory while unlocked.
- **Passcodes** are scored by estimated entropy, not character rules: common words, keyboard runs, repeats and sequences count for almost nothing. Setup requires about 60 bits, which a phrase of four unrelated words clears easily.
- **Storage layout:**
  - Each section is its own encrypted record in IndexedDB.
  - Each record is bound to its name as associated data, so records can't be renamed or swapped.
  - The index record is re-encrypted on every save and pins the SHA-256 of every section's ciphertext. Putting back an older copy of one section, mixing records from different moments, or storage corruption is detected on unlock. Everything else opens normally, and the affected section is **quarantined, never deleted**:
    - It's kept byte-for-byte, still pinned by the index, and included in backups.
    - It's listed under Settings → Damaged data. If it's a readable older copy, you can recover it as a new section. It's removed only if you explicitly choose Delete.
    - Backups follow the same rule, so a backup always restores: intact sections open, damaged ones go to quarantine.
    - Changing the passcode is refused until the quarantine is empty, because those records can only be read with the current key.
  - **Limit:** someone with access to the device could restore an entire, internally consistent older vault (for example an old backup). Without a server, nothing can detect that.
  - A save re-encrypts only the sections that changed.
  - A revision counter stops a stale window from overwriting newer data. Other windows merge the change automatically with a three-way merge, row by row, item by item and setting by setting, with no passcode prompt. Only the same row or setting edited in both windows at once is a conflict: the saved version wins and you are told. A dialog you're typing in is never interrupted: the merge waits until it closes.
- **Saving is immediate.** Every change is written straight away, and edits made while a write is in progress are combined into the next write. A "Saving…/Saved" indicator shows the state, and the browser warns you if you try to leave mid-write.
- **Upgrades are lossless.** Vaults and backups from older HQ formats are recognized and converted the first time you unlock them with their passcode. Setup never overwrites existing data.
- **Nothing leaves the device** except the read-only requests of connections you add (see Live connections). There is no HQ server, analytics or third-party code, and the security policy lets the page talk only to YouTube's channel-statistics endpoint, Meta's Graph API and a `*.workers.dev` relay. Once your relay is deployed, replace `https://*.workers.dev` with its exact address in `index.html` and `_headers`: otherwise injected code (unlikely, given the protections below) could send data to any Worker.
- **While unlocked**, decrypted data and connection keys are in the page's memory, as in any app that shows them. Anything that can run code in the page could read them, which is why the page loads no third-party code, allows no inline script and enforces Trusted Types. Locking (manual, idle or background) drops them. A compromised device or browser extension with access to the page is out of scope.
- **Browser protections:**
  - Strict Content-Security-Policy, including `default-src 'none'`.
  - Trusted Types enforcement: the only HTML sink (`setHTML`) accepts nothing but output of the auto-escaping `html` template. Charts are built with that template too.
  - `javascript:` and other non-http links are never rendered.
  - CSV export guards against spreadsheet formula injection.
- **Locking:**
  - Auto-lock after 1–30 minutes idle or in the background. Locking clears data, dialogs, notifications and the tab title.
  - After 5 wrong passcodes, each further attempt waits longer. This slows down guessing on the device itself. Protection against offline guessing comes from the key-derivation cost and passcode strength, and setup rejects weak passcodes.
  - Changing the passcode requires the current one.
- **Privacy mode** (eye icon) blurs every amount, including amounts in charts and tables. Amount fields in forms stay hidden until you tap into one, and dialogs never auto-focus an amount field.
- **Backups** are the encrypted records. Restoring asks for the backup's passcode and test-decrypts every record before anything is written, and offers to save the current data first.
- **Passwords are intentionally out of scope.** Keep them in iCloud Keychain or Google Password Manager. A *Security checklist* section tracks 2FA and password-checkup status instead.
- **There is no passcode recovery.** Keep a recent backup.

## Run it on this computer

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Open http://localhost:8787. The self-test runs at http://localhost:8787/tests.html:
- unit tests for parsing, the model, formulas (loops, cost), reminders across DST, templates, CSV, merging and the vault (tamper, swap, single-record rollback, conflicts, re-key, legacy upgrades)
- a randomized merge property test (150 rounds), a 20,000-row soak test and fuzzing of CSV, stored data and backup parsing
- connector tests against faked services: idempotent re-sync, take-over of hand-kept items, failures, sealed snapshots, the relay's auth header, and merging
- the relay itself (`relay/worker.js` uses only web-standard APIs, so the real file runs in the test page against a fake KV store and fake upstream services): token, origin, method and CORS rules, signed balances, sealed and correctly dated snapshots, the encrypted TikTok token, Shopify time zones and truncation, and "your own source" never fetching an address HQ supplies
- UI flow tests that drive the real app against throwaway `hq-test*` databases, which are deleted afterwards (including adding a connection and checking its key is never shown again)
- an accessibility audit of every screen and dialog, at phone and desktop width: every control labelled, every button named, dialogs titled, icons hidden from screen readers, ids unique

The test mode only works on localhost, and only when tests.html embeds the app. In production the app refuses to run inside any frame.

## Install on your phone

A PWA must be served over HTTPS. Host this folder on any static host; the code contains no personal data, so public hosting is safe. You don't need to deploy `tests.html`, `js/tests.js`, `serve.ps1` or the `relay` folder (the relay goes to Cloudflare separately).

**Give HQ its own origin** (its own domain or subdomain). Browsers isolate storage per origin, so HQ shouldn't share one with other sites you run. For example, every GitHub Pages *project* under `yourname.github.io` shares a single origin. Use a custom domain there, or a dedicated user site.

- **Netlify / Cloudflare Pages:** `_headers` applies the full security headers (CSP with `frame-ancestors 'none'`, `X-Frame-Options: DENY`, HSTS, etc.).
- **GitHub Pages:** it can't send headers. The meta CSP and HQ's refusal to run inside a frame still apply.

**Check the deployment** once it's live (replace the address):

```
curl -sI https://hq.yourdomain.com/ | grep -iE "content-security-policy|x-frame-options|strict-transport|x-content-type"
```

You should see all four headers (on GitHub Pages only the meta CSP applies, so the command shows none). Then open the site, press F12 → Console and confirm there are no CSP errors. If you change the CSP, try it as `Content-Security-Policy-Report-Only` first.

Then open the URL on your phone:

- **iPhone (Safari):** Share → Add to Home Screen. Installing also stops Safari from clearing the data after a week of not using the site.
- **Android (Chrome):** ⋮ → Install app.

Each device keeps its own vault. Move data between devices with backup and restore.

## Files

| File | Purpose |
|---|---|
| `js/ui.js` | Safe HTML templates, Trusted Types sink, locale-aware parsing/formatting, dialogs, toasts |
| `js/vault.js` | Encryption, per-section records, pinned hashes, revisions, backups, legacy upgrades |
| `js/model.js` | Sections: construction, templates, tombstones, normalization and migration; re-exports the rest of the model. Pure, with no DOM. |
| `js/model/` | The rest of the model by feature: `constants`, `base` (ids, rows, items), `formula`, `tracker` math, `table` math and CSV, `merge` (two windows), `sample` data, `links` (tracker items fed by a table), and `types` (JSDoc types for the whole data format) |
| `js/store.js` | Shared session state and formatting helpers (no dependencies beyond ui.js) |
| `js/persist.js` | The save pipeline: immediate, coalesced, three-way merging with other windows |
| `js/views.js` + `js/views/` | Rendering: routing and the shell, with pages by area: `common` (summaries), `home`, `section`, `table` (cells, chart, selection, keyboard grid), `search`, `settings` |
| `js/forms.js` + `js/forms/` | Every dialog, by feature: `sections`, `data` (items, rows, daily update, CSV), `vault` (restore, passcode), `connections`, `passcode` strength, `field` errors |
| `js/tableedit.js` | Editing a cell in place, and bulk actions on ticked rows |
| `js/charts.js` | Dependency-free SVG charts with hover, keyboard and table views |
| `js/csv.js` | RFC 4180 CSV parsing and injection-safe export |
| `js/connectors.js` | Live connections: safe fetch, one definition per service, idempotent upsert into sections |
| `js/sync.js` | Automatic sync: schedule, one window at a time, applies results only while no dialog is open |
| `js/app.js` | Entry point: events, lock screen, onboarding, session lifecycle |
| `js/snapshots.js` | End-to-end encryption for the relay's snapshots (ECDH P-256 + HKDF + AES-GCM); the relay has the matching `seal` |
| `js/tests.js` + `js/tests/` | Self-test runner and suites by area: `basics`, `model`, `vault`, `connectors` (including the relay itself), `lint`, `app` (UI flows) |
| `relay/worker.js` | The optional relay you deploy to Cloudflare for Shopify, TikTok and banks (read-only) |

## Live connections (automatic updates)

Settings → **Connections** fills sections automatically. HQ syncs while it's open: when you unlock it, when you come back to it, and on a schedule (every 6 hours by default; 1–24 hours or off). A laptop that slept through the 6-hour mark catches up within minutes of waking. **Sync** on a connection, or the **Live** chip on its section, syncs right away.

While HQ is closed, the relay can keep working, if you turn it on: every 6 hours it takes a snapshot of your balances and TikTok followers, and the next sync fills in the days you missed. Shopify doesn't need this; it fills missed days from its order history. YouTube and Instagram are called directly from the app, so they get a point only on days you open HQ.

**Snapshots are end-to-end encrypted and off by default.** They're stored in your Cloudflare account (KV) for up to 13 months, so HQ seals each one to a key only your vault holds. Relay → *Turn on encrypted snapshots* makes a key pair: the private half stays in the encrypted vault, and you give the public half to the relay as `HQ_SNAPSHOT_KEY`. For each snapshot the relay makes a one-off key pair, derives a shared secret with HQ's public key (ECDH P-256, then HKDF-SHA-256) and encrypts with AES-256-GCM, bound to its source and date. The relay can lock snapshots but never open them. Cloudflare, or anyone who gets your KV data, sees dates and scrambled bytes, never balances or account names. Without `HQ_SNAPSHOT_KEY` the relay stores no snapshots at all; delete the secret to stop them. Snapshots are dated by your calendar day: HQ tells the relay its time zone.

- Re-syncing never duplicates anything: each item or row remembers the external id it came from and is updated in place. An item you were already updating by hand with the same name (for example "YouTube") is taken over, so its history continues.
- Sample data in the target section is cleared the first time real numbers arrive.
- A failure keeps the last good values, shows what went wrong on the connection and the section's chip, and retries at most every 15 minutes.
- Keys live inside the encrypted vault (so they're in encrypted backups too), are sent only to their own service, and are never shown again after you save them. To change one, type a new one. To remove one, remove the connection; its section and data stay.
- Everything is read-only. No connector can post, buy or move money.

| Connect | How | What you need |
|---|---|---|
| **YouTube** | Direct from HQ | A YouTube Data API v3 key (Google Cloud Console → APIs & Services → Credentials). Restrict it to the YouTube Data API and, under Website restrictions, to your HQ address (for YouTube only, HQ sends its site address, never the page, so the restriction works). Your channel ID (`UC…`, from YouTube Studio → Settings → Channel → Advanced). |
| **Instagram** | Direct from HQ | An Instagram professional (Business/Creator) account linked to a Facebook Page, a Meta developer app, a long-lived access token and your Instagram user ID. Long-lived tokens last 60 days; HQ reminds you 10 days before, and you edit the connection to paste a new one. |
| **Shopify** | Through your relay | A custom app in Shopify admin (Settings → Apps → Develop apps) with only the `read_orders` scope. Fills one row per day with orders and revenue. Shopify only returns the last 60 days unless the app is granted `read_all_orders`. |
| **Banks & cards** | Through your relay | [SimpleFIN Bridge](https://beta-bridge.simplefin.org) (simplest; a small yearly fee) or a Plaid account. You link each bank on SimpleFIN's or Plaid's own site; HQ and the relay never see bank passwords, and both services are read-only. Card and loan balances count as money owed; an overpaid card counts as money you have. |
| **TikTok** | Through your relay | A TikTok developer app with the Login Kit and the `user.info.stats` scope, and a refresh token from authorizing it once. |
| **Your own source** | Through your relay | Any JSON API, with no new code: list it under `CUSTOM_SOURCES` on the relay (a name, its https address and any key headers). Then add a connection, give the source name and a path such as `data.followers`. A number fills one tracker item, an object of numbers fills one item each, and a list of objects fills table rows (properties match your column names; pick an ID property so re-syncs update rows instead of adding them). HQ only ever sends the source's name, never an address, so the relay can't be used to fetch anything you didn't list. |

### The relay (for Shopify, banks and TikTok)

Those services refuse requests from web pages, and their keys shouldn't sit in a phone app anyway. The relay is a ~200-line Cloudflare Worker (free plan) that **you** deploy to your own Cloudflare account. It holds those keys as encrypted secrets, answers only read requests, only from your HQ address, and only with your relay token. HQ stores just the relay's address and token.

1. Install [Node.js](https://nodejs.org), then in the `relay` folder run `npx wrangler login`.
2. Create the relay's storage with `npx wrangler kv namespace create HQ_KV`, paste the id it prints into `wrangler.toml` and remove the `#` signs there. TikTok needs it for its rotating refresh token (kept encrypted with a key derived from `HQ_TOKEN`), and encrypted snapshots need it too.
3. Make a long random token, for example with `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`.
4. Set the secrets you need (each command asks for the value; nothing is written to a file):
   ```
   npx wrangler secret put HQ_TOKEN
   npx wrangler secret put ALLOWED_ORIGIN        # e.g. https://hq.yourdomain.com
   npx wrangler secret put SHOPIFY_STORE         # your-store.myshopify.com
   npx wrangler secret put SHOPIFY_TOKEN
   npx wrangler secret put SIMPLEFIN_ACCESS_URL  # or PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ACCESS_TOKENS
   npx wrangler secret put TIKTOK_CLIENT_KEY     # and TIKTOK_CLIENT_SECRET, TIKTOK_REFRESH_TOKEN
   npx wrangler secret put HQ_SNAPSHOT_KEY       # optional: the public key from HQ → Relay
   npx wrangler secret put CUSTOM_SOURCES        # optional: {"stats":{"url":"https://api.example.com/me","headers":{"X-Api-Key":"…"}}}
   ```
5. `npx wrangler deploy`. It prints an address like `https://hq-relay.yourname.workers.dev`.
6. In HQ: Settings → Connections → **Relay**, paste the address and the token. HQ checks the relay answers before saving. It also shows setup problems the relay reports, such as a missing ALLOWED_ORIGIN or KV namespace.

HQ's security policy only allows `*.workers.dev` relay addresses. To use your own domain for the relay, add it to `connect-src` in `index.html` and `_headers`.

