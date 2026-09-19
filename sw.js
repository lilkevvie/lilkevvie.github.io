// Offline support. Caches only HQ's own code - never user data, which lives
// encrypted in IndexedDB and is never fetched over the network.
const VERSION = 'hq-v3.9.0';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/store.js', 'js/persist.js', 'js/views.js', 'js/forms.js', 'js/ui.js', 'js/vault.js', 'js/model.js', 'js/charts.js', 'js/csv.js', 'js/connectors.js', 'js/sync.js', 'js/tableedit.js', 'js/snapshots.js', 'js/model/links.js',
  'js/views/common.js', 'js/views/home.js', 'js/views/section.js', 'js/views/table.js', 'js/views/search.js', 'js/views/settings.js',
  'js/model/constants.js', 'js/model/base.js', 'js/model/formula.js', 'js/model/tracker.js', 'js/model/table.js', 'js/model/merge.js', 'js/model/sample.js',
  'js/forms/field.js', 'js/forms/passcode.js', 'js/forms/sections.js', 'js/forms/data.js', 'js/forms/vault.js', 'js/forms/connections.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  // No skipWaiting here: the page asks the user first ("Update available"),
  // so a new version never swaps code under an open, unlocked session.
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)));
});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first (so updates land immediately), cache as offline fallback.
// Only same-origin shell GETs are handled; everything else passes through.
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.endsWith('tests.html')) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        e.waitUntil(caches.open(VERSION).then(c => c.put(req, copy)));
      }
      return res;
    } catch {
      return (await caches.match(req, { ignoreSearch: true })) ||
        (req.mode === 'navigate' ? caches.match('index.html') : Response.error());
    }
  })());
});
