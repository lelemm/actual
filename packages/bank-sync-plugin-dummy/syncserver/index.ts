import {
  defineSyncServerPlugin,
  json,
  route,
} from '@actual-app/plugins-core-sync-server/plugin';

function statusHandler() {
  return json({
    status: 'ok',
    data: {
      configured: true,
      provider: 'dummy-bank-sync',
    },
  });
}

export const plugin = defineSyncServerPlugin({
  routes: [
    route('GET', '/status', statusHandler),
    route('POST', '/status', statusHandler),
  ],
});
