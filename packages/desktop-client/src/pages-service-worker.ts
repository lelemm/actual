/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', event => {
  // First load needs isolation immediately. Updates wait for "Update now".
  if (!self.registration.active) event.waitUntil(self.skipWaiting());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      // Pages has no SPA rewrites; serve the entry point for app navigation.
      const response =
        event.request.mode === 'navigate'
          ? await fetch(new URL('index.html', self.registration.scope), {
              cache: 'no-cache',
            })
          : await fetch(event.request);
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    })(),
  );
});

export {};
