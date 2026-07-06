import type {
  BankSyncConfig,
  PluginManifest,
  PluginRoute,
} from '@actual-app/plugins-core-sync-server/types';

// Manifest validation stays in sync-server, while the manifest contract types
// come from the shared sync-server plugin package.

type JsonRecord = Record<string, unknown>;
type FrontendManifestConfig = NonNullable<PluginManifest['frontend']>;
type SyncServerManifestConfig = NonNullable<PluginManifest['syncserver']>;
export type PluginRouteManifest = PluginRoute;
export type BankSyncManifest = BankSyncConfig;
export type Manifest =
  | (PluginManifest & {
      type: 'frontend';
      frontend: FrontendManifestConfig;
      syncserver?: never;
    })
  | (PluginManifest & {
      type: 'syncserver';
      frontend?: never;
      syncserver: SyncServerManifestConfig;
    })
  | (PluginManifest & {
      type: 'mixed';
      frontend: FrontendManifestConfig;
      syncserver: SyncServerManifestConfig;
    });
export type FrontendManifest = Extract<
  Manifest,
  { frontend: FrontendManifestConfig }
>;
export type SyncServerManifest = Extract<
  Manifest,
  { syncserver: SyncServerManifestConfig }
>;
export type RuntimeManifest = Manifest & {
  entry?: string;
  routes?: SyncServerManifestConfig['routes'];
  bankSync?: SyncServerManifestConfig['bankSync'];
};

function isRecord(value: unknown): value is JsonRecord {
  return value != null && typeof value === 'object';
}

// Type guard for plugins that expose frontend assets to desktop-client.
export function isFrontendPlugin(
  manifest: Manifest,
): manifest is FrontendManifest {
  return manifest.type === 'frontend' || manifest.type === 'mixed';
}

// Type guard for plugins that need sync-server runtime handling.
export function isSyncServerPlugin(
  manifest: Manifest,
): manifest is SyncServerManifest {
  return manifest.type === 'syncserver' || manifest.type === 'mixed';
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

  if (
    candidate.type !== 'frontend' &&
    candidate.type !== 'syncserver' &&
    candidate.type !== 'mixed'
  ) {
    throw new Error(
      "Plugin manifest type must be 'frontend', 'syncserver', or 'mixed'",
    );
  }

  if (
    (candidate.type === 'frontend' || candidate.type === 'mixed') &&
    typeof candidate.frontend?.entry !== 'string'
  ) {
    throw new Error('Frontend plugins must specify frontend.entry');
  }

  if (
    (candidate.type === 'syncserver' || candidate.type === 'mixed') &&
    typeof candidate.syncserver?.entry !== 'string'
  ) {
    throw new Error('Sync-server plugins must specify syncserver.entry');
  }

  if (candidate.type === 'frontend' && candidate.syncserver !== undefined) {
    throw new Error('Frontend-only plugins cannot specify syncserver config');
  }

  if (candidate.type === 'syncserver' && candidate.frontend !== undefined) {
    throw new Error('Sync-server-only plugins cannot specify frontend config');
  }

  return candidate as Manifest;
}

// Flattens sync-server manifest fields so the runtime has one shape to read.
export function toRuntimeManifest(manifest: Manifest): RuntimeManifest {
  return {
    ...manifest,
    entry: manifest.syncserver?.entry,
    routes: manifest.syncserver?.routes,
    bankSync: manifest.syncserver?.bankSync,
  };
}
