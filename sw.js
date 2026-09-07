/* HN Tracker service worker.

   The shell is precached so the app launches without the network. The story
   feed never is: headlines go stale in minutes, so HN API requests always go
   to the network and a failure is reported rather than papered over.

   There is no hand-bumped cache version. On every launch the page asks the
   worker to revalidate the precached URLs with conditional requests, which
   come back 304 and cost a handful of headers. Anything that changed is
   written into the cache and takes effect on the next launch, quietly. The
   version constant that has to be remembered is exactly the step that gets
   forgotten, and forgetting it is silent. */

const CACHE = 'hn-shell';

const SHELL = [
  './',
  './index.html',
  './watch.html',
  './app.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './fonts/atkinson-hyperlegible-400.woff2',
  './fonts/atkinson-hyperlegible-700.woff2'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // the HN API is never cached

  // Only the app's own two entry URLs are answered from the cache. Serving the
  // shell for every path in scope would hand a wrong URL a page whose relative
  // asset links then resolve against the wrong directory and 404.
  if (request.mode === 'navigate') {
    const root = new URL('./', self.location).pathname;
    const page = url.pathname === root ? './index.html'
      : url.pathname === root + 'index.html' ? './index.html'
      : url.pathname === root + 'watch.html' ? './watch.html'
      : null;
    if (page) {
      event.respondWith((async () => {
        // The query string names the video, so match on the path alone.
        const cached = await caches.match(page);
        return cached || fetch(request);
      })());
    }
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    return fetch(request);
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'revalidate') {
    event.waitUntil(revalidate());
  }
});

async function revalidate() {
  const cache = await caches.open(CACHE);
  await Promise.all(SHELL.map(async url => {
    try {
      // cache: 'no-cache' forces a conditional request rather than a blind
      // refetch, so an unchanged file costs one 304.
      const fresh = await fetch(new Request(url, { cache: 'no-cache' }));
      if (fresh && fresh.ok) await cache.put(url, fresh.clone());
    } catch (err) {
      // Offline, or the file is briefly unreachable. Keep what is cached.
    }
  }));
}
