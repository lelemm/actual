export type ActualPluginType = 'frontend' | 'syncserver' | 'mixed';

export type ActualPluginManifest = {
  name: string;
  version: string;
  description?: string;
  author?: string;
  type: ActualPluginType;
  frontend?: {
    entry: string;
  };
  syncserver?: {
    entry: string;
    routes?: Array<{
      path: string;
      methods: string[];
      auth?: 'anonymous' | 'authenticated' | 'admin';
      description?: string;
    }>;
    bankSync?: {
      enabled: boolean;
      displayName: string;
      endpoints: {
        status?: string;
        accounts?: string;
        transactions?: string;
      };
      description?: string;
      requiresAuth?: boolean;
      setup?: {
        type: 'plugin' | 'json';
      };
    };
  };
  url?: string;
  enabled?: boolean;
  pluginType?: 'server' | 'client';
  minimumActualVersion?: string;
  main?: string;
  entry?: string;
  plugin?: Blob;
};

export function isFrontendPlugin(manifest: ActualPluginManifest): boolean {
  return manifest.type === 'frontend' || manifest.type === 'mixed';
}

export function isSyncServerPlugin(manifest: ActualPluginManifest): boolean {
  return manifest.type === 'syncserver' || manifest.type === 'mixed';
}

export function validateActualPluginManifest(
  manifest: unknown,
): ActualPluginManifest {
  if (typeof manifest !== 'object' || manifest == null) {
    throw new Error('Plugin manifest must be an object');
  }

  const candidate = manifest as Partial<ActualPluginManifest>;
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

  return candidate as ActualPluginManifest;
}
