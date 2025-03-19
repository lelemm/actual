import React, {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';

import { getDatabase } from 'loot-core/platform/server/indexeddb';
import { type ActualPluginStored } from 'loot-core/types/models/actual-plugin-stored';

import {
  ActualPluginEntry,
  type ActualPluginManifest,
} from '../../../plugins-core/src';
import {
  type ActualPlugin,
  type ActualPluginInitalized,
} from '../../../plugins-core/src/types/actualPlugin';
import { useFeatureFlag } from '../hooks/useFeatureFlag';

import { init, loadRemote } from '@module-federation/enhanced/runtime';
import { pushModal as basePushModal } from 'loot-core/client/modals/modalsSlice';
import { useDispatch } from '../redux';

// Context and Provider
type ActualPluginsContextType = {
  plugins: ActualPluginInitalized[];
  pluginStore: ActualPluginStored[];
  refreshPluginStore: () => Promise<void>;
};

const ActualPluginsContext = createContext<
  ActualPluginsContextType | undefined
>(undefined);

type ActualPluginsProviderProps = {
  children: ReactNode;
};
export function ActualPluginsProvider({
  children,
}: ActualPluginsProviderProps) {
  const pluginsEnabled = useFeatureFlag('plugins');
  const [plugins, setPlugins] = useState<ActualPluginInitalized[]>([]);
  const [pluginStore, setPluginStore] = useState<ActualPluginStored[]>([]);
  const [pluginsModules, setPluginsModules] = useState<
    Map<string, ActualPluginEntry>
  >(new Map());
  const dispatch = useDispatch();

  const loadPluginsScript = async (plugins: ActualPluginStored[]) => {
    init({
      name: '@actual/host-app',
      remotes: plugins.map(plugin => ({
        name: plugin.name,
        alias: plugin.name,
        entry: `plugin-data/${encodeURIComponent(plugin.url)}`,
      })),
      shared: {
        react: {
          strategy: 'loaded-first',
        },
      },
    });

    const loadedPlugins: Map<string, ActualPluginEntry> = new Map();
    for (let plugin of plugins) {
      loadedPlugins.set(
        plugin.name,
        await loadRemote<ActualPluginEntry>(plugin.name),
      );
    }

    setPluginsModules(loadedPlugins);
    loadPlugins(loadedPlugins);
  };

  const refreshPluginStore = useCallback(async () => {
    const plugins = await getAllPlugins();

    if (plugins.length !== pluginStore.length) {
      loadPluginsScript(plugins);
    }

    setPluginStore(plugins);
  }, []);

  const loadPlugins = useCallback(
    (pluginsEntries: Map<string, ActualPluginEntry>) => {
      try {
        const list: ActualPluginInitalized[] = [];
        [...pluginsEntries.entries()].forEach(keyValue => {
          const plugin = (
            keyValue[1] as unknown as { default: ActualPluginEntry }
          ).default;
          const toInitialize = plugin({
            toolKit: {
              functions: {
                pushModal: (modalName: string) =>
                  dispatch(
                    basePushModal({
                      modal: { name: `plugin-${keyValue[0]}-${modalName}` },
                    }),
                  ),
              },
            },
          });

          list.push(toInitialize);
        });
        setPlugins(list);
      } catch (error) {
        console.error('Failed to load plugins:', error);
      }
    },
    [plugins, refreshPluginStore, pluginsModules],
  );

  return (
    <ActualPluginsContext.Provider
      value={{ plugins, pluginStore, refreshPluginStore }}
    >
      {children}
    </ActualPluginsContext.Provider>
  );
}

// Hook
export const useActualPlugins = () => {
  const context = useContext(ActualPluginsContext);
  if (!context) {
    throw new Error(
      'useActualPlugins must be used within an ActualPluginsProvider',
    );
  }
  return context;
};

async function persistPlugin(
  scriptBlob: Blob,
  manifest: ActualPluginManifest,
): Promise<void> {
  const db = await getDatabase();

  const transaction = db.transaction(['plugins'], 'readwrite');
  const objectStore = transaction.objectStore('plugins');
  const storedPlugin: ActualPluginStored = manifest as ActualPluginStored;
  storedPlugin.plugin = scriptBlob;

  objectStore.put(storedPlugin);
}

type GitHubAsset = {
  name: string;
  browser_download_url: string;
};

async function fetchWithHeader(url: string): Promise<Response> {
  return await fetch(url, {
    headers: {
      'x-requested-with': 'actual-budget'
    }
  });
}
export async function fetchRelease(
  owner: string,
  repo: string,
  releasePath: string,
): Promise<{ version: string; scriptUrl: string; manifestUrl: string }> {
  const apiUrl = `https://cors-anywhere.herokuapp.com/https://api.github.com/repos/${owner}/${repo}/releases/${releasePath}`;
  const response = await fetchWithHeader(apiUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch release metadata for ${repo}`);
  }

  const releaseData = await response.json();
  const version = releaseData.tag_name;
  const scriptUrl = releaseData.assets.filter((f: GitHubAsset) =>
    f.name.endsWith('.zip'),
  )[0]?.browser_download_url;
  const manifestUrl = releaseData.assets.filter(
    (f: GitHubAsset) => f.name === 'manifest.json',
  )[0]?.browser_download_url;

  return { version, scriptUrl, manifestUrl };
}

export function parseGitHubRepoUrl(
  url: string,
): { owner: string; repo: string } | null {
  try {
    const parsedUrl = new URL(url);

    if (!parsedUrl.hostname.includes('github.com')) {
      throw new Error('Not a valid GitHub URL');
    }

    const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
    if (pathParts.length >= 2) {
      const owner = pathParts[0];
      const repo = pathParts[1];
      return { owner, repo };
    }
    throw new Error('URL does not contain owner and repository name');
  } catch (error) {
    console.error(`Error parsing GitHub URL: ${url}`, error);
    return null;
  }
}

async function loadPluginFromRepo(
  loadedPlugins: ActualPluginInitalized[],
  repo: string,
): Promise<ActualPluginInitalized | null> {
  try {
    const parsedRepo = parseGitHubRepoUrl(repo);
    if (parsedRepo == null) throw new Error(`Invalid repo ${repo}`);

    console.log(`Checking for updates for plugin ${repo}...`);

    const {
      version: latestVersion,
      scriptUrl,
      manifestUrl,
    } = await fetchRelease(parsedRepo.owner, parsedRepo.repo, 'latest');

    let response = await fetchWithHeader(
      `https://cors-anywhere.herokuapp.com/${manifestUrl}`,
    );

    if (!response.ok) {
      throw new Error(`Failed to download plugin manifest for ${repo}`);
    }

    const manifest = (await response.json()) as ActualPluginManifest;

    const foundPlugin = loadedPlugins.find(
      plugin => plugin.name === manifest.name,
    );
    if (foundPlugin) return foundPlugin;

    const storedPlugin = await getStoredPlugin(manifest);

    let zipBlob = null;
    if (!storedPlugin || storedPlugin.version !== latestVersion) {
      console.log(`Downloading plugin “${repo}” v${latestVersion}...`);
      //need to change the cors proxy at some point:
      response = await fetchWithHeader(
        `https://cors-anywhere.herokuapp.com/${scriptUrl}`,
      );

      if (!response.ok) {
        throw new Error(`Failed to download plugin script for ${repo}`);
      }

      const zipArrayBuffer = await response.arrayBuffer();
      const zipBytes = new Uint8Array(zipArrayBuffer);

      if (!zipBytes) {
        return null;
      }

      zipBlob = new Blob([zipBytes], { type: 'application/zip' });
    } else {
      zipBlob = await storedPlugin.plugin;
      console.log(
        `Using cached version of plugin “${repo}” v${latestVersion}...`,
      );
    }

    if (!zipBlob) {
      return null;
    }

    console.log(`Plugin “${repo}” loaded successfully.`);
    await persistPlugin(zipBlob, manifest);
  } catch (error) {
    console.error(`Error saving plugin “${repo}”:`, error);
    return null;
  }
}

async function getStoredPlugin(
  manifest: ActualPluginManifest,
): Promise<ActualPluginManifest | null> {
  const db = await getDatabase(); // Open the database
  const transaction = db.transaction(['plugins'], 'readonly');
  const objectStore = transaction.objectStore('plugins');

  return new Promise((resolve, reject) => {
    const req = objectStore.get(manifest.url);

    req.onsuccess = () => {
      resolve(req.result || null); // Resolve with the result
    };

    req.onerror = () => {
      reject(req.error); // Reject with the error
    };
  });
}

async function getAllPlugins(): Promise<ActualPluginStored[]> {
  const db = await getDatabase(); // Open the database
  const transaction = db.transaction(['plugins'], 'readonly');
  const objectStore = transaction.objectStore('plugins');

  return new Promise((resolve, reject) => {
    const req = objectStore.getAll();

    req.onsuccess = () => {
      resolve(req.result); // Resolve with the array of rows
    };

    req.onerror = () => {
      reject(req.error); // Reject with the error
    };
  });
}

export async function installPluginFromManifest(
  loadedPlugins: ActualPlugin[],
  manifest: ActualPluginManifest,
): Promise<void> {
  try {
    const foundPlugin = loadedPlugins.find(
      plugin => plugin.name === manifest.name,
    );
    if (foundPlugin) return;

    console.log(
      `Downloading plugin “${manifest.name}” v${manifest.version}...`,
    );

    const parsedRepo = parseGitHubRepoUrl(manifest.url);
    if (parsedRepo == null) throw new Error(`Invalid repo ${manifest.url}`);

    const { scriptUrl } = await fetchRelease(
      parsedRepo.owner,
      parsedRepo.repo,
      `tags/${manifest.version}`,
    );

    //need to change the cors proxy at some point:
    const response = await fetchWithHeader(
      `https://cors-anywhere.herokuapp.com/${scriptUrl}`,
    );

    if (!response.ok) {
      throw new Error(`Failed to download plugin script for ${manifest.name}`);
    }

    const zipArrayBuffer = await response.arrayBuffer();
    const zipBytes = new Uint8Array(zipArrayBuffer);

    if (!zipBytes) {
      return null;
    }

    const blob = new Blob([zipBytes], { type: 'application/zip' });

    console.log(`Plugin “${manifest.name}” loaded successfully.`);
    await persistPlugin(blob, manifest);
  } catch (error) {
    console.error(`Error saving plugin “${manifest.name}”:`, error);
    return null;
  }
}
