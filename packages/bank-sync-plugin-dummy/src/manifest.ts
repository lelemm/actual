import type { PluginManifest } from '@actual-app/plugins-core-sync-server/types';

export const manifest: PluginManifest = {
  name: 'dummy-bank-sync',
  version: '0.0.1',
  description: 'Dummy bank sync provider for validating plugin loading.',
  type: 'syncserver',
  syncserver: {
    entry: 'syncserver/index.js',
    routes: [
      {
        path: '/status',
        methods: ['GET', 'POST'],
        auth: 'authenticated',
        description: 'Reports whether the dummy provider is available.',
      },
    ],
  },
};
