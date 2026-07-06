import type {
  BankSyncConfig,
  PluginManifest,
  PluginRoute,
} from '@actual-app/plugins-core-sync-server/types';

// Manifest validation stays in sync-server, while the manifest contract types
// come from the shared sync-server plugin package.

type JsonRecord = Record<string, unknown>;
type SyncServerManifestConfig = NonNullable<PluginManifest['syncserver']>;
export type PluginRouteManifest = PluginRoute;
export type BankSyncManifest = BankSyncConfig;
export type Manifest = PluginManifest & {
  type: 'syncserver';
  frontend?: never;
  syncserver: SyncServerManifestConfig;
};
export type SyncServerManifest = Manifest;
export type RuntimeManifest = Manifest & {
  entry?: string;
  routes?: SyncServerManifestConfig['routes'];
  bankSync?: SyncServerManifestConfig['bankSync'];
};

function isRecord(value: unknown): value is JsonRecord {
  return value != null && typeof value === 'object';
}

// Type guard for plugins that need sync-server runtime handling.
export function isSyncServerPlugin(
  manifest: Manifest,
): manifest is SyncServerManifest {
  return manifest.type === 'syncserver';
}

// Validates the shared manifest before any plugin code is imported or served.
export function validateManifest(manifest: unknown): Manifest {
  if (!isRecord(manifest)) {
    throw new Error('Plugin manifest must be an object');
  }

  const candidate = manifest as Partial<Manifest>;

  if (!candidate.name || typeof candidate.name !== 'string') {
    throw new Error('Plugin manifest must specify a name');
  }

  if (!candidate.version || typeof candidate.version !== 'string') {
    throw new Error('Plugin manifest must specify a version');
  }

  if (candidate.type !== 'syncserver') {
    throw new Error("Plugin manifest type must be 'syncserver'");
  }

  if (typeof candidate.syncserver?.entry !== 'string') {
    throw new Error('Sync-server plugins must specify syncserver.entry');
  }

  return candidate as Manifest;
}

// Flattens sync-server manifest fields so the runtime has one shape to read.
export function toRuntimeManifest(manifest: Manifest): RuntimeManifest {
  return {
    ...manifest,
    entry: manifest.syncserver.entry,
    routes: manifest.syncserver.routes,
    bankSync: manifest.syncserver.bankSync,
  };
}
