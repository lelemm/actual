import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';

import { match } from 'path-to-regexp';

const entryPath = process.env.ACTUAL_PLUGIN_ENTRY_PATH;

if (!entryPath) {
  throw new Error('ACTUAL_PLUGIN_ENTRY_PATH is required');
}

const { plugin } = await import(pathToFileURL(entryPath).href);

if (!plugin || !Array.isArray(plugin.routes)) {
  throw new Error('Sync-server plugin entry must export a named plugin');
}

const routeMatchers = new Map();

function getRouteMatcher(path) {
  let routeMatcher = routeMatchers.get(path);
  if (!routeMatcher) {
    routeMatcher = match(path);
    routeMatchers.set(path, routeMatcher);
  }

  return routeMatcher;
}

function findRoute(method, path) {
  for (const route of plugin.routes) {
    if (route.method !== method) {
      continue;
    }

    const matchedPath = getRouteMatcher(route.path)(path);
    if (!matchedPath) {
      continue;
    }

    return { route, params: matchedPath.params };
  }

  return null;
}

function sendResponse(requestId, status, headers, body) {
  process.send?.({
    type: 'response',
    requestId,
    status,
    headers,
    body,
  });
}

function sendContractError(requestId, message) {
  sendResponse(
    requestId,
    500,
    { 'Content-Type': 'application/json' },
    {
      error: 'plugin_contract_error',
      message,
    },
  );
}

function getMessageId(pluginSlug) {
  const safeOrigin = pluginSlug.replace(/[^a-zA-Z0-9_-]/g, '-');
  return `${safeOrigin}-${Date.now()}-${randomUUID()}`;
}

function sendSecretIPC(message, pluginSlug) {
  if (!process.send) {
    throw new Error('Not running as a forked process');
  }

  return new Promise((resolve, reject) => {
    const messageId = getMessageId(pluginSlug);
    const timeout = setTimeout(() => {
      process.off('message', handler);
      reject(new Error('Timed out waiting for secret-response'));
    }, 10_000);

    const handler = response => {
      if (
        response.type === 'secret-response' &&
        response.messageId === messageId
      ) {
        process.off('message', handler);
        clearTimeout(timeout);

        if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response.data);
        }
      }
    };

    process.on('message', handler);

    try {
      process.send({
        ...message,
        messageId,
      });
    } catch (error) {
      process.off('message', handler);
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error('Failed to send IPC'));
    }
  });
}

function createSecrets(message) {
  const { pluginSlug, fileId } = message;
  if (!pluginSlug) {
    throw new Error('Plugin slug not found');
  }

  return {
    async get(key) {
      const result = await sendSecretIPC(
        {
          type: 'secret-get',
          name: `${pluginSlug}_${key}`,
          ...(fileId ? { fileId } : {}),
          user: message.user,
        },
        pluginSlug,
      );

      return result?.value;
    },
    async save(key, value) {
      await sendSecretIPC(
        {
          type: 'secret-set',
          name: `${pluginSlug}_${key}`,
          value,
          ...(fileId ? { fileId } : {}),
          user: message.user,
        },
        pluginSlug,
      );
    },
  };
}

function createPluginRequest(message, params) {
  return {
    method: message.method,
    path: message.path,
    headers: message.headers ?? {},
    query: message.query ?? {},
    body: message.body,
    params,
    user: message.user,
    pluginSlug: message.pluginSlug,
    fileId: message.fileId,
    json: async () => message.body ?? {},
    text: async () =>
      typeof message.body === 'string'
        ? message.body
        : message.body == null
          ? ''
          : JSON.stringify(message.body),
    secrets: createSecrets(message),
  };
}

function isPluginResponse(response) {
  return (
    response &&
    typeof response === 'object' &&
    typeof response.status === 'number' &&
    response.status >= 100 &&
    response.status <= 599
  );
}

async function handleRequest(message) {
  const matchedRoute = findRoute(message.method, message.path);
  if (!matchedRoute) {
    sendContractError(
      message.requestId,
      `No handler exported for ${message.method} ${message.path}`,
    );
    return;
  }

  try {
    const response = await matchedRoute.route.handler(
      createPluginRequest(message, matchedRoute.params),
    );

    if (!isPluginResponse(response)) {
      sendContractError(
        message.requestId,
        `Handler for ${message.method} ${message.path} returned an invalid response`,
      );
      return;
    }

    sendResponse(
      message.requestId,
      response.status,
      response.headers,
      response.body,
    );
  } catch (error) {
    sendResponse(
      message.requestId,
      500,
      { 'Content-Type': 'application/json' },
      {
        error: 'plugin_error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    );
  }
}

process.on('message', message => {
  if (message?.type === 'request') {
    void handleRequest(message);
  }
});

process.send?.({ type: 'ready' });
