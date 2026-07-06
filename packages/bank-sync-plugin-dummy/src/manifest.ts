import type { PluginManifest } from '@actual-app/plugins-core-sync-server/types';

export const manifest: PluginManifest = {
  name: 'dummy-bank-sync',
  version: '0.0.1',
  description: 'Dummy bank sync provider for validating plugin loading.',
  type: 'mixed',
  frontend: {
    entry: 'frontend/mf-manifest.json',
  },
  syncserver: {
    entry: 'syncserver/index.js',
    routes: [
      {
        path: '/status',
        methods: ['GET', 'POST'],
        auth: 'authenticated',
        description: 'Reports whether the dummy provider is available.',
      },
      {
        path: '/accounts',
        methods: ['POST'],
        auth: 'authenticated',
        description: 'Returns deterministic dummy accounts.',
      },
      {
        path: '/transactions',
        methods: ['POST'],
        auth: 'authenticated',
        description: 'Returns deterministic dummy transactions.',
      },
    ],
    bankSync: {
      enabled: true,
      displayName: 'Dummy Bank',
      description: 'Fake bank sync provider for validating plugin flows.',
      requiresAuth: false,
      setup: {
        type: 'json',
      },
      endpoints: {
        status: '/status',
        accounts: '/accounts',
        transactions: '/transactions',
      },
    },
  },
};
