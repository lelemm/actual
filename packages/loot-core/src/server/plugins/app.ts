// @ts-strict-ignore
import type { ActualPluginManifest } from '@actual-app/plugins-core/types/actualPluginManifest';
import type { PluginFileCollection } from '@actual-app/plugins-core/types/plugin-files';

import * as asyncStorage from '#platform/server/asyncStorage';
import { fetch } from '#platform/server/fetch';
import * as idb from '#platform/server/indexeddb';
import { logger } from '#platform/server/log';
import { createApp } from '#server/app';
import { getServer } from '#server/server-config';
import type { ActualPluginStored } from '#types/models';

import { extractZipToMap } from './pluginUtil';

export type PluginsHandlers = {
  'plugin-files': typeof getPluginFiles;
  'plugin-sync-server-install': typeof installSyncServerPlugin;
  'plugin-sync-server-list': typeof listSyncServerPlugins;
  'plugin-sync-server-register-dev': typeof registerSyncServerDevPlugin;
  'cors-proxy': typeof corsProxy;
};

export const app = createApp<PluginsHandlers>();

app.method('plugin-files', getPluginFiles);
app.method('plugin-sync-server-install', installSyncServerPlugin);
app.method('plugin-sync-server-list', listSyncServerPlugins);
app.method('plugin-sync-server-register-dev', registerSyncServerDevPlugin);
app.method('cors-proxy', corsProxy);

async function getPluginFiles({
  pluginUrl,
}: {
  pluginUrl: string;
}): Promise<PluginFileCollection> {
  const decodedPluginUrl = decodeURIComponent(pluginUrl);

  if (decodedPluginUrl.startsWith('sync-server:')) {
    return getSyncServerPluginFiles(
      decodedPluginUrl.slice('sync-server:'.length),
    );
  }

  const { store } = idb.getStore(await idb.getDatabase(), 'plugins');
  const item = (await idb.get(store, decodedPluginUrl)) as unknown as
    | ActualPluginStored
    | undefined;

  if (item == null) {
    throw new Error('Plugin does not exist: ' + decodedPluginUrl);
  }

  if (item.plugin == null) {
    throw new Error('Plugin does not have local files: ' + item.name);
  }

  const filesMap = await extractZipToMap(item.plugin);

  return [...filesMap.entries()].map(([name, content]) => ({
    name: normalizeFrontendFileName(name.toString()),
    content: content.toString(),
  })) as PluginFileCollection;
}

function normalizeFrontendFileName(fileName: string) {
  return fileName.startsWith('frontend/')
    ? fileName.slice('frontend/'.length)
    : fileName;
}

async function getPluginServerHeaders() {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    throw new Error('unauthorized');
  }

  return {
    'X-ACTUAL-TOKEN': userToken,
  };
}

function getPluginServerBaseUrl() {
  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('no-server-configured');
  }

  return `${serverConfig.BASE_SERVER}/plugins-api`;
}

async function installSyncServerPlugin({
  zipBytes,
}: {
  zipBytes: number[];
}): Promise<{ manifest: ActualPluginManifest }> {
  const response = await fetch(`${getPluginServerBaseUrl()}/install`, {
    method: 'POST',
    headers: {
      ...(await getPluginServerHeaders()),
      'Content-Type': 'application/zip',
    },
    body: new Uint8Array(zipBytes),
  });

  return unwrapPluginServerResponse(response);
}

async function listSyncServerPlugins(): Promise<ActualPluginManifest[]> {
  const response = await fetch(`${getPluginServerBaseUrl()}/list`, {
    headers: await getPluginServerHeaders(),
  });
  const result = await unwrapPluginServerResponse<{
    plugins: ActualPluginManifest[];
  }>(response);
  return result.plugins;
}

async function registerSyncServerDevPlugin({
  manifestUrl,
}: {
  manifestUrl: string;
}): Promise<{ manifest: ActualPluginManifest }> {
  const response = await fetch(`${getPluginServerBaseUrl()}/dev/register`, {
    method: 'POST',
    headers: {
      ...(await getPluginServerHeaders()),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ manifestUrl }),
  });

  return unwrapPluginServerResponse(response);
}

async function getSyncServerPluginFiles(
  pluginName: string,
): Promise<PluginFileCollection> {
  const response = await fetch(
    `${getPluginServerBaseUrl()}/files/${encodeURIComponent(pluginName)}`,
    {
      headers: await getPluginServerHeaders(),
    },
  );
  const result = await unwrapPluginServerResponse<{
    files: PluginFileCollection;
  }>(response);
  return result.files;
}

async function unwrapPluginServerResponse<T>(response: Response): Promise<T> {
  const text = await response.text();

  if (!response.ok) {
    throw new Error(text || `Plugin server request failed: ${response.status}`);
  }

  const parsed = JSON.parse(text);
  if (parsed.status !== 'ok') {
    throw new Error(parsed.reason || parsed.error || 'Plugin request failed');
  }

  return parsed.data as T;
}

async function corsProxy({
  url,
  method = 'GET',
  body,
  headers,
}: {
  url: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  try {
    const userToken = await asyncStorage.getItem('user-token');

    if (!userToken) {
      return { error: 'unauthorized' };
    }

    const serverConfig = getServer();
    if (!serverConfig) {
      return { error: 'no-server-configured' };
    }

    const proxyUrl =
      serverConfig.CORS_PROXY + `?url=${encodeURIComponent(url)}`;
    const defaultHeaders = {
      'x-requested-with': 'actual-budget',
      'user-agent': 'Actual-Budget-Plugin-System',
    };

    const response = await fetch(proxyUrl, {
      method: 'POST',
      headers: {
        'X-ACTUAL-TOKEN': userToken,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({
        method,
        body,
        headers: {
          ...defaultHeaders,
          ...headers,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      try {
        return JSON.parse(errorText);
      } catch {
        return { error: 'network-failure', details: errorText };
      }
    }

    const contentType = response.headers.get('content-type');
    const isLikelyJson =
      contentType?.includes('application/json') ||
      url.toLowerCase().includes('.json') ||
      url.toLowerCase().includes('/manifest') ||
      url.toLowerCase().includes('manifest.json');

    if (isLikelyJson) {
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } else if (contentType?.includes('text/')) {
      return response.text();
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
      data: Array.from(new Uint8Array(arrayBuffer)),
      contentType,
      isBinary: true,
    };
  } catch (error) {
    logger.error('CORS proxy error:', error);
    return {
      error: 'network-failure',
      details: error instanceof Error ? error.message : String(error),
    };
  }
}
