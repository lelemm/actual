import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import { send } from '@actual-app/core/platform/client/connection';
import type { ActualPluginStored } from '@actual-app/core/types/models/actual-plugin-stored';
import type { ActualPluginInitialized } from '@actual-app/plugins-core/types/actualPlugin';
import type { ActualPluginEntry } from '@actual-app/plugins-core/types/actualPluginEntry';
import {
  isFrontendPlugin,
  isSyncServerPlugin,
  validateActualPluginManifest,
} from '@actual-app/plugins-core/types/actualPluginManifest';
import type { ActualPluginManifest } from '@actual-app/plugins-core/types/actualPluginManifest';
import { createInstance } from '@module-federation/enhanced/runtime';

import { useFeatureFlag } from '#hooks/useFeatureFlag';

import { loadPlugins, loadPluginsScript } from './core/pluginLoader';
import type {
  BankSyncProviderLinkRegistration,
  BankSyncProviderSetupRegistration,
} from './core/pluginLoader';
import { getAllPlugins } from './core/pluginStore';
import { getPluginSharedDependencies } from './pluginSharedDependencies';

let mfInstance: ReturnType<typeof createInstance> | null = null;

export type ActualPluginsContextType = {
  plugins: ActualPluginInitialized[];
  pluginStore: ActualPluginStored[];
  refreshPluginStore: (
    devUrl?: string,
    forceInitialize?: boolean,
  ) => Promise<void>;
  bankSyncProviderSetups: Map<string, BankSyncProviderSetupRegistration>;
  bankSyncProviderLinks: Map<string, BankSyncProviderLinkRegistration>;
};

const defaultContextValue: ActualPluginsContextType = {
  plugins: [],
  pluginStore: [],
  refreshPluginStore: () => Promise.resolve(),
  bankSyncProviderSetups: new Map(),
  bankSyncProviderLinks: new Map(),
};

const ActualPluginsContext =
  createContext<ActualPluginsContextType>(defaultContextValue);

export { ActualPluginsContext };

export function ActualPluginsProvider({ children }: { children: ReactNode }) {
  const pluginsEnabled = useFeatureFlag('plugins');

  const [plugins, setPlugins] = useState<ActualPluginInitialized[]>([]);
  const [pluginStore, setPluginStore] = useState<ActualPluginStored[]>([]);
  const [initialized, setinitialized] = useState(false);
  const initializedRef = useRef(initialized);
  initializedRef.current = initialized;
  const pluginStoreLengthRef = useRef(pluginStore.length);
  pluginStoreLengthRef.current = pluginStore.length;

  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      const handleRuntimeError = (event: PromiseRejectionEvent) => {
        if (event.reason?.message?.includes('Federation Runtime')) {
          console.warn(
            'Module federation runtime error detected, resetting initialization state',
          );
          setinitialized(false);
          // Prevent the error from propagating further
          event.preventDefault();
        }
      };

      window.addEventListener('unhandledrejection', handleRuntimeError);

      return () => {
        window.removeEventListener('unhandledrejection', handleRuntimeError);
      };
    }
  }, []);

  useEffect(() => {
    if (!mfInstance) {
      try {
        const newInstance = createInstance({
          name: '@actual/host-app',
          remotes: [],
          shared: getPluginSharedDependencies(),
        });

        mfInstance = newInstance;
      } catch (error) {
        console.warn(
          'Failed to initialize Module Federation instance early:',
          error,
        );
      }
    }
  }, []);

  const [bankSyncProviderSetups, setBankSyncProviderSetups] = useState<
    Map<string, BankSyncProviderSetupRegistration>
  >(new Map());
  const [bankSyncProviderLinks, setBankSyncProviderLinks] = useState<
    Map<string, BankSyncProviderLinkRegistration>
  >(new Map());

  const handleLoadPlugins = useCallback(
    async (pluginsEntries: Map<string, ActualPluginEntry>) => {
      setBankSyncProviderSetups(new Map());
      setBankSyncProviderLinks(new Map());
      // We pass these references so plugin activation can call them.
      await loadPlugins({
        pluginsEntries,
        setPlugins,
        setBankSyncProviderSetups,
        setBankSyncProviderLinks,
      });
    },
    [],
  );

  const isLoadingRef = useRef(false);

  const handleLoadPluginsScript = useCallback(
    async (pluginsData: ActualPluginStored[], devUrl?: string) => {
      if (initializedRef.current && !devUrl) return;

      if (isLoadingRef.current) return;

      isLoadingRef.current = true;

      try {
        await waitForPluginServiceWorker();

        const devPlugin = devUrl ? await prepareDevPlugin(devUrl) : undefined;
        const frontendPlugins = pluginsData.filter(
          plugin => plugin.enabled !== false && isFrontendPlugin(plugin),
        );
        setinitialized(
          await loadPluginsScript({
            pluginsData: frontendPlugins,
            handleLoadPlugins,
            devUrl: devPlugin?.frontendEntry,
            mfInstance,
          }),
        );
      } finally {
        isLoadingRef.current = false;
      }
    },
    [handleLoadPlugins],
  );

  const refreshPluginStore = useCallback(
    async (devUrl?: string, forceInitialize?: boolean) => {
      if (!pluginsEnabled && !forceInitialize) return;

      const pluginsFromDB = (await getAllPlugins()) as ActualPluginStored[];
      const syncServerPlugins = await getSyncServerPlugins();
      const syncServerPluginNames = new Set(
        syncServerPlugins.map(plugin => plugin.name),
      );
      const mergedPlugins = [
        ...syncServerPlugins,
        ...pluginsFromDB.filter(
          plugin => !syncServerPluginNames.has(plugin.name),
        ),
      ];

      if (
        mergedPlugins.length !== pluginStoreLengthRef.current ||
        (devUrl && devUrl !== '') ||
        forceInitialize
      ) {
        await handleLoadPluginsScript(mergedPlugins, devUrl);
      }
      setPluginStore(mergedPlugins);
    },
    [handleLoadPluginsScript, pluginsEnabled],
  );

  const contextValue: ActualPluginsContextType = {
    plugins,
    pluginStore,
    refreshPluginStore,
    bankSyncProviderSetups,
    bankSyncProviderLinks,
  };

  return (
    <ActualPluginsContext.Provider value={contextValue}>
      {children}
    </ActualPluginsContext.Provider>
  );
}

// Hook for accessing plugins context - works with or without provider
export function useActualPlugins() {
  return useContext(ActualPluginsContext);
}

async function getSyncServerPlugins(): Promise<ActualPluginStored[]> {
  const serverUrl = await send('get-server-url');
  if (!serverUrl) {
    return [];
  }

  try {
    const manifests = (await send(
      'plugin-sync-server-list',
    )) as ActualPluginManifest[];

    return manifests.map(manifest => ({
      ...manifest,
      enabled: true,
      url: `sync-server:${manifest.name}`,
      source: 'sync-server',
    }));
  } catch (error) {
    console.warn('Failed to load sync-server plugins:', error);
    return [];
  }
}

async function waitForPluginServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.warn('[plugins] service workers are unavailable');
    return;
  }

  const registration = await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) {
    console.debug('[plugins] service worker is controlling the page', {
      scope: registration.scope,
    });
    return;
  }

  console.debug('[plugins] waiting for service worker controller', {
    scope: registration.scope,
  });

  await new Promise<void>(resolve => {
    const timeout = window.setTimeout(() => {
      navigator.serviceWorker.removeEventListener(
        'controllerchange',
        handleControllerChange,
      );
      console.warn(
        '[plugins] timed out waiting for service worker controller; plugin-data requests may fall through',
      );
      resolve();
    }, 5000);

    function handleControllerChange() {
      window.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener(
        'controllerchange',
        handleControllerChange,
      );
      console.debug('[plugins] service worker controller is now active');
      resolve();
    }

    navigator.serviceWorker.addEventListener(
      'controllerchange',
      handleControllerChange,
    );
  });
}

async function prepareDevPlugin(
  devUrl: string,
): Promise<{ frontendEntry?: string }> {
  const manifestUrl = normalizeDevManifestUrl(devUrl);
  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch dev plugin manifest: ${manifestUrl}`);
  }

  const manifest = validateActualPluginManifest(await response.json());

  if (isSyncServerPlugin(manifest)) {
    const serverUrl = await send('get-server-url');
    if (!serverUrl) {
      throw new Error(
        `Dev plugin '${manifest.name}' requires a sync server before it can be enabled.`,
      );
    }

    await send('plugin-sync-server-register-dev', { manifestUrl });
  }

  if (!isFrontendPlugin(manifest)) {
    return {};
  }

  return {
    frontendEntry: new URL(
      getDevFrontendEntry(manifest.frontend!.entry),
      manifestUrl,
    ).toString(),
  };
}

function getDevFrontendEntry(entry: string) {
  return entry.startsWith('frontend/')
    ? entry.slice('frontend/'.length)
    : entry;
}

function normalizeDevManifestUrl(devUrl: string): string {
  if (devUrl.endsWith('/')) {
    return new URL('manifest.json', devUrl).toString();
  }

  return devUrl;
}
