let fileList = new Map();

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
  const pathSegments = url.pathname.split('/').filter(Boolean); // Split and remove empty segments
  
  switch(url.pathname) {
    case '/plugins/list':
      console.log('Intercepting /plugins/list request');
      handlePluginList(event);
      break;

    default:
      const pluginsIndex = pathSegments.indexOf('plugins');
      const dataIndex = pathSegments.indexOf('data');
      if (pluginsIndex !== -1 && dataIndex === pluginsIndex + 1 && pathSegments.length > dataIndex + 1) {
        debugger;
        const slug = pathSegments[dataIndex + 1];
        let fileName = pathSegments.slice(dataIndex + 2).join('/').split('?')[0];
        event.respondWith(handlePlugin(slug, fileName.replace("?import", "")));
      }
  }
});

function handlePluginList(event) {
  event.respondWith(
    new Promise(async (resolve) => {
      const clientsList = await self.clients.matchAll();
      if (clientsList.length > 0) {
        const client = clientsList[0]; // Send to the first active client

        const channel = new MessageChannel();
        channel.port1.onmessage = (messageEvent) => {
          console.log('Response received from Web Worker:', messageEvent.data);
          resolve(new Response(JSON.stringify(messageEvent.data), {
            headers: { 'Content-Type': 'application/json' }
          }));
        };

        client.postMessage({ type: 'plugin-list' }, [channel.port2]);
      } else {
        resolve(new Response(JSON.stringify({ error: 'No active clients to process' }), {
          headers: { 'Content-Type': 'application/json' }
        }));
      }
    })
  );
}

async function handlePlugin(slug, fileName) {
  for (const key of fileList.keys()) {
    if (key.startsWith(`${slug}/`)) {
      if (key.endsWith(`/${fileName}`)) {
        const content = fileList.get(key);
        const contentType = getContentType(fileName);
        return new Response(content, { headers: { 'Content-Type': contentType } });
      }
    }
  }

  const clientsList = await self.clients.matchAll();
  if (clientsList.length === 0) {
    return new Response(JSON.stringify({ error: 'No active clients to process' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const client = clientsList[0];
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (messageEvent) => {
      let responseData;
      try {
        responseData = typeof messageEvent.data === 'string' ? JSON.parse(messageEvent.data) : messageEvent.data;
      } catch (error) {
        console.error('Failed to parse messageEvent data:', error);
        resolve(new Response('Invalid response format', { status: 500 }));
        return;
      }

      if (responseData && Array.isArray(responseData)) {
        responseData.forEach(({ name, content }) => {
          fileList.set(`${slug}/${name}`, content);
        });
      }

      const fileToCheck = fileName.length > 0 ? fileName : 'mf-manifest.json';

      if (fileList.has(`${slug}/${fileToCheck}`)) {
        const content = fileList.get(`${slug}/${fileToCheck}`);
        const contentType = getContentType(fileToCheck);
        resolve(new Response(content, { headers: { 'Content-Type': contentType } }));
      } else {
        resolve(new Response('File not found', { status: 404 }));
      }
    };

    client.postMessage({ type: 'plugin-files', eventData: { pluginName: slug } }, [channel.port2]);
  });
}

function getContentType(fileName) {
  const extension = fileName.split('.').pop().toLowerCase();
  const mimeTypes = {
    'html': 'text/html',
    'css': 'text/css',
    'js': 'application/javascript',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml'
  };
  return mimeTypes[extension] || 'application/octet-stream';
}
