// GitHub Pages cannot set the isolation headers required by SQLite's worker.
// Load the app only after our service worker has added them to the document.
async function start() {
  await navigator.serviceWorker.register(
    `${import.meta.env.BASE_URL}pages-sw.js`,
    { scope: import.meta.env.BASE_URL, updateViaCache: 'none' },
  );

  if (!crossOriginIsolated) {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>(resolve => {
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => resolve(),
          { once: true },
        );
      });
    }
    if (sessionStorage.getItem('pages-isolation-reload')) {
      throw new Error('This browser could not enable cross-origin isolation.');
    }
    sessionStorage.setItem('pages-isolation-reload', 'true');
    window.location.reload();
    return;
  }

  sessionStorage.removeItem('pages-isolation-reload');
  await import('./index');
}

void start().catch(error => {
  document.body.textContent = `Unable to start Actual: ${error.message}`;
});
