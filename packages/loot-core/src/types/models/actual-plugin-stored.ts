import type { ActualPluginManifest } from '@actual-app/plugins-core/types/actualPluginManifest';

export type ActualPluginStored = {
  plugin?: Blob;
  enabled: boolean;
  source?: 'indexeddb' | 'sync-server';
} & ActualPluginManifest;
