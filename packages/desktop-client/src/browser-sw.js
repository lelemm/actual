// Log installation event
self.addEventListener('install', (event) => {
  console.log('Service Worker installing...');
  self.skipWaiting(); // Forces activation immediately
});

// Log activation event
self.addEventListener('activate', (event) => {
  console.log('Service Worker activated!');
  self.clients.claim(); // Takes control of uncontrolled pages
});

// Log fetch requests
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname === '/plugins/list') {
    console.log('Intercepting /plugins/list request');

    event.respondWith(
      new Promise(async (resolve) => {
        // Send request to the main app to process via the Web Worker
        const clientsList = await self.clients.matchAll();
        if (clientsList.length > 0) {
          const client = clientsList[0]; // Send to the first active client
          
          // Send message to Web Worker via client
          const channel = new MessageChannel();
          channel.port1.onmessage = (messageEvent) => {
            console.log('Response received from Web Worker:', messageEvent.data);
            resolve(new Response(JSON.stringify(messageEvent.data), {
              headers: { 'Content-Type': 'application/json' }
            }));
          };

          client.postMessage({ type: 'plugin-list' }, [channel.port2]);
        } else {
          // No active clients, return fallback response
          resolve(new Response(JSON.stringify({ error: 'No active clients to process' }), {
            headers: { 'Content-Type': 'application/json' }
          }));
        }
      })
    );
    return;
  }
  console.log('Intercepting fetch request for:', event.request.url);
});
