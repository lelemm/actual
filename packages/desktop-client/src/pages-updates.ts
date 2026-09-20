// Reuse the isolation worker registered before the Pages app starts.
export function registerPagesUpdates(onNeedRefresh: () => void) {
  const registration = navigator.serviceWorker
    .getRegistration(import.meta.env.BASE_URL)
    .then(registration => {
      if (!registration) return;

      const checkWaiting = () => {
        if (registration.waiting) onNeedRefresh();
      };
      const watchInstalling = () => {
        registration.installing?.addEventListener('statechange', checkWaiting);
      };
      registration.addEventListener('updatefound', watchInstalling);
      watchInstalling();
      checkWaiting();

      const checkForUpdates = () => {
        if (document.visibilityState === 'visible') {
          void registration.update().catch(() => {
            // An offline check should not interrupt the open budget.
          });
        }
      };
      window.addEventListener('focus', checkForUpdates);
      window.setInterval(checkForUpdates, 5 * 60 * 1000);
      checkForUpdates();
      return registration;
    });

  return async () => {
    const waiting = (await registration)?.waiting;
    if (!waiting) {
      window.location.reload();
      return;
    }
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => window.location.reload(),
      { once: true },
    );
    waiting.postMessage({ type: 'SKIP_WAITING' });
  };
}
