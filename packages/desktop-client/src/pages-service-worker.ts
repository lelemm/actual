/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
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
      const response = await fetch(
        event.request.mode === 'navigate'
          ? new URL('index.html', self.registration.scope)
          : event.request,
      );
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
