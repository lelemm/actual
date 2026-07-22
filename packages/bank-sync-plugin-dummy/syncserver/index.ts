// This is just a shell plugin to test the sync-server. It has no behavior yet.
export const plugin = {
  routes: [
    {
      method: 'GET',
      path: '/status',
      handler: statusHandler,
    },
    {
      method: 'POST',
      path: '/status',
      handler: statusHandler,
    },
  ],
};

function statusHandler() {
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: {
      status: 'ok',
      data: {
        configured: true,
        provider: 'dummy-bank-sync',
      },
    },
  };
}
