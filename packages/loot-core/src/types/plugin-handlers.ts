import type { ActualPluginManifest } from '@actual-app/plugins-core/types/actualPluginManifest';
import type { PluginFileCollection } from '@actual-app/plugins-core/types/plugin-files';

export type PluginHandlers = {
  'plugin-files': (args: {
    pluginUrl: string;
  }) => Promise<PluginFileCollection>;
  'plugin-sync-server-install': (args: {
    zipBytes: number[];
  }) => Promise<{ manifest: ActualPluginManifest }>;
  'plugin-sync-server-list': () => Promise<ActualPluginManifest[]>;
  'plugin-sync-server-register-dev': (args: {
    manifestUrl: string;
  }) => Promise<{ manifest: ActualPluginManifest }>;
  'cors-proxy': (args: {
    url: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  }) => Promise<
    | string
    | { data: number[]; contentType: string; isBinary: true }
    | { error: string; details?: string }
  >;
};
