import type { Dispatch as ReactDispatch, SetStateAction } from 'react';

import type { ActualPluginStored } from '@actual-app/core/types/models/actual-plugin-stored';
import type {
  ActualPluginInitialized,
  BankSyncProviderLinkRenderProps,
  BankSyncProviderSetupRenderProps,
  HostContext,
} from '@actual-app/plugins-core/types/actualPlugin';
import type { ActualPluginEntry } from '@actual-app/plugins-core/types/actualPluginEntry';
import type { BasicModalProps } from '@actual-app/plugins-core/types/modalProps';
import {
  createInstance,
  getInstance,
} from '@module-federation/enhanced/runtime';

import { i18nInstance } from '#i18n';
import { getPluginSharedDependencies } from '#plugin/pluginSharedDependencies';

export type BankSyncProviderSetupRegistration = {
  renderSetup: (
    props: BankSyncProviderSetupRenderProps,
    container: HTMLDivElement,
  ) => void | (() => void);
  modalProps?: BasicModalProps;
};

export type BankSyncProviderLinkRegistration = {
  renderLink: (
    props: BankSyncProviderLinkRenderProps,
    container: HTMLDivElement,
  ) => void | (() => void);
  modalProps?: BasicModalProps;
};

export async function loadPlugins({
  pluginsEntries,
  setPlugins,
  setBankSyncProviderSetups,
  setBankSyncProviderLinks,
}: {
  pluginsEntries: Map<string, ActualPluginEntry>;
  setPlugins: ReactDispatch<SetStateAction<ActualPluginInitialized[]>>;
  setBankSyncProviderSetups: ReactDispatch<
    SetStateAction<Map<string, BankSyncProviderSetupRegistration>>
  >;
  setBankSyncProviderLinks: ReactDispatch<
    SetStateAction<Map<string, BankSyncProviderLinkRegistration>>
  >;
}) {
  const loadedList: ActualPluginInitialized[] = [];

  for (const [pluginId, entryModule] of pluginsEntries.entries()) {
    try {
      const pluginEntry =
        (entryModule as unknown as { default: ActualPluginEntry }).default ||
        (entryModule as unknown as { plugin: ActualPluginEntry }).plugin ||
        entryModule;

      if (!pluginEntry || typeof pluginEntry !== 'function') {
        console.error(`Plugin ${pluginId}: Invalid plugin entry module`);
        continue;
      }

      const hostContext = generateContext(
        setBankSyncProviderSetups,
        setBankSyncProviderLinks,
      );

      const rawPlugin = pluginEntry();

      rawPlugin.activate({
        ...hostContext,
        i18nInstance,
      } as unknown as HostContext);

      const initializedPlugin: ActualPluginInitialized = {
        ...rawPlugin,
        initialized: true,
        activate: rawPlugin.activate as (context: HostContext) => void,
      };
      loadedList.push(initializedPlugin);
    } catch (error) {
      console.error(
        `Plugin ${pluginId}: Unexpected error during loading:`,
        error,
      );
      continue;
    }
  }

  setPlugins(loadedList);
}

function generateContext(
  setBankSyncProviderSetups: ReactDispatch<
    SetStateAction<Map<string, BankSyncProviderSetupRegistration>>
  >,
  setBankSyncProviderLinks: ReactDispatch<
    SetStateAction<Map<string, BankSyncProviderLinkRegistration>>
  >,
) {
  return {
    registerBankSyncProviderSetup: (
      providerSlug: string,
      renderSetup: (
        props: BankSyncProviderSetupRenderProps,
        container: HTMLDivElement,
      ) => void | (() => void),
      modalProps?: BasicModalProps,
    ) => {
      setBankSyncProviderSetups(prev => {
        const next = new Map(prev);
        next.set(providerSlug, { renderSetup, modalProps });
        return next;
      });

      return () => {
        setBankSyncProviderSetups(prev => {
          const next = new Map(prev);
          next.delete(providerSlug);
          return next;
        });
      };
    },
    registerBankSyncProviderLink: (
      providerSlug: string,
      renderLink: (
        props: BankSyncProviderLinkRenderProps,
        container: HTMLDivElement,
      ) => void | (() => void),
      modalProps?: BasicModalProps,
    ) => {
      setBankSyncProviderLinks(prev => {
        const next = new Map(prev);
        next.set(providerSlug, { renderLink, modalProps });
        return next;
      });

      return () => {
        setBankSyncProviderLinks(prev => {
          const next = new Map(prev);
          next.delete(providerSlug);
          return next;
        });
      };
    },
  };
}

/**
 * loadPluginsScript - sets up module federation for all plugin scripts,
 * then loads them remotely and triggers plugin activation.
 */
export async function loadPluginsScript({
  pluginsData,
  handleLoadPlugins,
  devUrl = '',
  mfInstance = null,
}: {
  pluginsData: ActualPluginStored[];
  handleLoadPlugins: (
    pluginsEntries: Map<string, ActualPluginEntry>,
  ) => Promise<void>;
  devUrl?: string;
  mfInstance?: ReturnType<typeof createInstance> | null;
}): Promise<boolean> {
  const remotes = [
    ...pluginsData,
    ...(devUrl !== ''
      ? [
          {
            name: 'dev-plugin',
            alias: 'dev-plugin',
            url: null,
            entry: devUrl || '',
          },
        ]
      : []),
  ];

  if (remotes.length === 0) return false;

  try {
    // Use the passed instance or try to get existing one
    let workingMfInstance = mfInstance || getInstance();

    // If no instance available, create one as fallback
    if (!workingMfInstance) {
      console.warn(
        'No Module Federation instance found during plugin loading, creating one...',
      );
      workingMfInstance = createInstance({
        name: '@actual/host-app',
        remotes: [],
        shared: getPluginSharedDependencies(),
      });
    }

    // Register all plugin remotes to the instance
    if (remotes.length > 0) {
      workingMfInstance.registerRemotes(
        remotes.map(plugin => ({
          name: plugin.name,
          alias: plugin.name,
          entry: getRemoteEntry(plugin),
        })),
      );
    }

    // Wait a bit for the runtime to fully register remotes before loading
    await new Promise(resolve => setTimeout(resolve, 100));

    // Now load all plugins using the working instance
    await loadPluginsWithInstance(
      workingMfInstance,
      pluginsData,
      devUrl,
      handleLoadPlugins,
    );
    return true;
  } catch (error) {
    // Log the error but don't fail completely - this might be a re-initialization
    console.warn('Module federation setup warning:', error);
    // Return early if setup failed
    return false;
  }
}

function getRemoteEntry(
  plugin: ActualPluginStored | { name: string; entry: string },
) {
  if (plugin.name === 'dev-plugin' && 'entry' in plugin) {
    return plugin.entry || '';
  }

  const storedPlugin = plugin as ActualPluginStored;
  return `plugin-data/${encodeURIComponent(storedPlugin.url ?? storedPlugin.name)}/${getFrontendEntry(storedPlugin)}?t=${Date.now()}`;
}

function getFrontendEntry(plugin: ActualPluginStored) {
  const entry = plugin.frontend?.entry ?? 'frontend/mf-manifest.json';
  return entry.startsWith('frontend/')
    ? entry.slice('frontend/'.length)
    : entry;
}

async function loadPluginsWithInstance(
  mfInstance: ReturnType<typeof createInstance>,
  pluginsData: ActualPluginStored[],
  devUrl: string,
  handleLoadPlugins: (
    pluginsEntries: Map<string, ActualPluginEntry>,
  ) => Promise<void>,
) {
  // Helper function to load a plugin with retry logic
  async function loadPluginWithRetry(
    pluginName: string,
    isDevPlugin = false,
    devUrl?: string,
    instanceToUse?: ReturnType<typeof createInstance> | null,
  ): Promise<ActualPluginEntry | null> {
    const maxRetries = 3;
    let retryCount = 0;

    while (retryCount < maxRetries) {
      try {
        // Use the passed instance (should always be available now)

        if (!instanceToUse) {
          throw new Error(
            `No MF instance passed to loadPluginWithRetry for ${pluginName}. This should not happen!`,
          );
        }

        console.log('Loading plugin', pluginName);
        const mod =
          await instanceToUse.loadRemote<ActualPluginEntry>(pluginName);

        if (mod) {
          // Inject React Refresh for dev plugins only
          if (isDevPlugin && devUrl) {
            await injectIntoGlobalHook(pluginName, devUrl);
          }

          return mod;
        }
      } catch (error) {
        retryCount++;
        const isLastRetry = retryCount >= maxRetries;

        if (isLastRetry) {
          console.error(
            `Failed to load plugin ${pluginName} after ${maxRetries} attempts:`,
            error,
          );
          if (isDevPlugin) {
            console.info(
              'This might happen during hot reloads - try refreshing the browser',
            );
          }
        } else {
          const delay = Math.pow(2, retryCount - 1) * 1000; // Exponential backoff: 1s, 2s, 4s
          console.warn(
            `Failed to load plugin ${pluginName} (attempt ${retryCount}/${maxRetries}), retrying in ${delay}ms...`,
            error,
          );
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    return null;
  }

  const loadedPlugins: Map<string, ActualPluginEntry> = new Map();

  // Load regular plugins from pluginsData
  for (const plugin of pluginsData) {
    const mod = await loadPluginWithRetry(
      plugin.name,
      false,
      undefined,
      mfInstance,
    );
    if (mod) {
      loadedPlugins.set(plugin.name, mod);
    }
  }

  // Load dev plugin if devUrl is provided
  if (devUrl !== '') {
    const mod = await loadPluginWithRetry(
      'dev-plugin',
      true,
      devUrl,
      mfInstance,
    );
    if (mod) {
      loadedPlugins.set('dev-plugin', mod);
    }
  }

  await handleLoadPlugins(loadedPlugins);
}

async function injectIntoGlobalHook(pluginName: string, pluginEntry: string) {
  if (process.env.NODE_ENV === 'development') {
    try {
      // Get the plugin's base URL
      const pluginBaseUrl = new URL(pluginEntry).origin;
      const refreshUrl = `${pluginBaseUrl}/@react-refresh`;
      // Load the plugin's React Refresh module
      const refreshModule = await import(/* @vite-ignore */ refreshUrl);
      if (refreshModule.injectIntoGlobalHook) {
        // Inject the plugin's React Refresh into the global hook
        refreshModule.injectIntoGlobalHook(window);
        // Set up refresh globals if they don't exist
        if (
          !(
            window as Window & typeof globalThis & { $RefreshReg$?: () => void }
          ).$RefreshReg$
        ) {
          (
            window as Window & typeof globalThis & { $RefreshReg$: () => void }
          ).$RefreshReg$ = () => undefined;
        }
        if (
          !(
            window as Window &
              typeof globalThis & { $RefreshSig$?: () => <T>(type: T) => T }
          ).$RefreshSig$
        ) {
          (
            window as Window &
              typeof globalThis & { $RefreshSig$: () => <T>(type: T) => T }
          ).$RefreshSig$ =
            () =>
            <T>(type: T): T =>
              type;
        }
      }
    } catch (error) {
      console.warn(`Failed to inject React Refresh for ${pluginName}:`, error);
    }
  }
}
