// This is still a partial manifest shape: this PR only defines the fields
// needed to validate sync-server plugin loading. These types stay local until
// the shared plugin contract package is introduced later in the stack.

type JsonRecord = Record<string, unknown>;
type ManifestBase = {
  name: string;
  version: string;
  description?: string;
};
export type PluginRouteManifest = {
  path: string;
  methods: string[];
  auth?: 'anonymous' | 'authenticated' | 'admin';
  description?: string;
};
type SyncServerManifestConfig = {
  entry: string;
  routes?: PluginRouteManifest[];
};
export type Manifest = ManifestBase & {
  type: 'syncserver';
  syncserver: SyncServerManifestConfig;
};
export type SyncServerManifest = Manifest;
export type RuntimeManifest = Manifest & {
  entry?: string;
  routes?: PluginRouteManifest[];
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
  };
}
