// This wrapper is the known sync-server code that the host forks for every
// sync-server plugin. PluginManager validates the plugin entry path, passes it
// as argv[2], then this process imports that untrusted entry and talks to the
// host over IPC.
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';

import { match } from 'path-to-regexp';

type RouteParams = Record<string, string | string[]>;
type HeaderRecord = Record<string, string | number | readonly string[]>;
type PluginResponse = {
  status: number;
  headers?: HeaderRecord;
  body?: unknown;
};
type PluginSecrets = {
  get: (key: string) => Promise<unknown>;
  save: (key: string, value: string) => Promise<void>;
};
type PluginRequest = {
  method: string;
  path: string;
  headers: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
  params: Partial<RouteParams>;
  user?: unknown;
  pluginSlug?: string;
  fileId?: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  secrets: PluginSecrets;
};
type PluginRoute = {
  method: string;
  path: string;
  handler: (request: PluginRequest) => PluginResponse | Promise<PluginResponse>;
};
type PluginDefinition = {
  routes: PluginRoute[];
};
type PluginModule = {
  plugin?: PluginDefinition;
};
type PluginRequestMessage = {
  type: 'request';
  requestId: string;
  method: string;
  path: string;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  user?: unknown;
  pluginSlug?: string;
  fileId?: string;
};
type SecretIPCMessage = {
  type: 'secret-get' | 'secret-set';
  name: string;
  value?: string;
  fileId?: string;
  user?: unknown;
};
type SecretIPCData = {
  value?: unknown;
};
type SecretIPCResponse = {
  type: 'secret-response';
  messageId: string;
  data?: SecretIPCData;
  error?: string;
};
type MatchedRoute = {
  route: PluginRoute;
  params: Partial<RouteParams>;
};

let loadedPlugin: PluginDefinition;

// Narrows IPC payloads before the forked runner reads fields from them.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object';
}

// Accepts only request messages sent by PluginManager over the child IPC pipe.
function isPluginRequestMessage(
  message: unknown,
): message is PluginRequestMessage {
  return (
    isRecord(message) &&
    message.type === 'request' &&
    typeof message.requestId === 'string' &&
    typeof message.method === 'string' &&
    typeof message.path === 'string'
  );
}

// Matches secret responses to the request id that the plugin runner generated.
function isSecretIPCResponse(response: unknown): response is SecretIPCResponse {
  return (
    isRecord(response) &&
    response.type === 'secret-response' &&
    typeof response.messageId === 'string' &&
    (response.error === undefined || typeof response.error === 'string') &&
    (response.data === undefined || isRecord(response.data))
  );
}

const routeMatchers = new Map<string, ReturnType<typeof match<RouteParams>>>();

// Loads the plugin entry that PluginManager validated before forking us.
async function loadPluginEntry(): Promise<PluginDefinition> {
  const entryPath = process.argv[2];

  if (!entryPath) {
    throw new Error('Plugin runner entry path argument is required');
  }

  const { plugin } = (await import(
    pathToFileURL(entryPath).href
  )) as PluginModule;

  if (!plugin || !Array.isArray(plugin.routes)) {
    throw new Error('Sync-server plugin entry must export a named plugin');
  }

  return plugin;
}

// Caches path-to-regexp matchers so repeated plugin calls avoid recompilation.
function getRouteMatcher(
  routePath: string,
): ReturnType<typeof match<RouteParams>> {
  let routeMatcher = routeMatchers.get(routePath);
  if (!routeMatcher) {
    routeMatcher = match<RouteParams>(routePath);
    routeMatchers.set(routePath, routeMatcher);
  }

  return routeMatcher;
}

// Finds the plugin route handler that corresponds to the forwarded request.
function findRoute(method: string, requestPath: string): MatchedRoute | null {
  for (const route of loadedPlugin.routes) {
    if (route.method !== method) {
      continue;
    }

    const matchedPath = getRouteMatcher(route.path)(requestPath);
    if (!matchedPath) {
      continue;
    }

    return { route, params: matchedPath.params };
  }

  return null;
}

// Sends plugin handler output back to the manager through child process IPC.
function sendResponse(
  requestId: string,
  status: number,
  headers: PluginResponse['headers'] | undefined,
  body: unknown,
): void {
  process.send?.({
    type: 'response',
    requestId,
    status,
    headers,
    body,
  });
}

// Reports invalid plugin exports as a plugin contract error, not a server crash.
function sendContractError(requestId: string, message: string): void {
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

// Namespaces secret IPC responses so concurrent secret calls do not cross-talk.
function getMessageId(pluginSlug: string): string {
  const safeOrigin = pluginSlug.replace(/[^a-zA-Z0-9_-]/g, '-');
  return `${safeOrigin}-${Date.now()}-${randomUUID()}`;
}

// Proxies plugin secret calls to the sync server, where persistence lives.
function sendSecretIPC(
  message: SecretIPCMessage,
  pluginSlug: string,
): Promise<SecretIPCData | undefined> {
  const send = process.send?.bind(process);
  if (!send) {
    throw new Error('Not running as a forked process');
  }

  return new Promise<SecretIPCData | undefined>((resolve, reject) => {
    const messageId = getMessageId(pluginSlug);
    const timeout = setTimeout(() => {
      process.off('message', handler);
      reject(new Error('Timed out waiting for secret-response'));
    }, 10_000);

    const handler = (response: unknown) => {
      if (isSecretIPCResponse(response) && response.messageId === messageId) {
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
      send({
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

// Gives plugins a scoped secrets API without exposing the server secret store.
function createSecrets(message: PluginRequestMessage): PluginSecrets {
  const { pluginSlug, fileId } = message;
  if (!pluginSlug) {
    throw new Error('Plugin slug not found');
  }

  return {
    async get(key: string) {
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
    async save(key: string, value: string) {
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

// Adapts manager IPC data into the request object plugin handlers expect.
function createPluginRequest(
  message: PluginRequestMessage,
  params: Partial<RouteParams>,
): PluginRequest {
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

// Enforces the minimal response contract before data leaves the plugin runner.
function isPluginResponse(response: unknown): response is PluginResponse {
  return (
    isRecord(response) &&
    typeof response.status === 'number' &&
    response.status >= 100 &&
    response.status <= 599
  );
}

// Runs one forwarded HTTP request through the plugin's declared route handler.
async function handleRequest(message: PluginRequestMessage): Promise<void> {
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

// Child-process entrypoint: load the plugin, listen for IPC, then signal ready.
async function startPluginRunnerProcess(): Promise<void> {
  loadedPlugin = await loadPluginEntry();

  process.on('message', (message: unknown) => {
    if (isPluginRequestMessage(message)) {
      void handleRequest(message);
    }
  });

  process.send?.({ type: 'ready' });
}

await startPluginRunnerProcess();
