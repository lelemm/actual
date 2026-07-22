import type { ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';

import { secretsService } from '#services/secrets-service';

import { getErrorMessage } from './plugin-errors.js';
import type { Manifest, RuntimeManifest } from './plugin-manifest.js';

export type JsonRecord = Record<string, unknown>;

export type PluginResponse = {
  status?: number;
  headers?: Record<string, string | number | readonly string[]>;
  body?: unknown;
};

export type PendingRequest = {
  resolve: (data: PluginResponse) => void;
  reject: (error: Error) => void;
};

export type OnlinePlugin = {
  slug: string;
  manifest: RuntimeManifest;
  originalManifest: Manifest;
  process: ChildProcess;
  ready: boolean;
  pendingRequests: Map<string, PendingRequest>;
};

type SecretPluginMessage =
  | {
      type: 'secret-set';
      messageId: string;
      name: string;
      value: string;
      fileId?: unknown;
    }
  | {
      type: 'secret-get';
      messageId: string;
      name: string;
      fileId?: unknown;
    };

function isRecord(value: unknown): value is JsonRecord {
  return value != null && typeof value === 'object';
}

// Accepts only the two secret IPC messages the manager knows how to answer.
function isSecretPluginMessage(
  message: unknown,
): message is SecretPluginMessage {
  return (
    isRecord(message) &&
    (message.type === 'secret-set' || message.type === 'secret-get') &&
    typeof message.messageId === 'string' &&
    typeof message.name === 'string' &&
    (message.type === 'secret-get' || typeof message.value === 'string')
  );
}

export function handlePluginMessage(
  pluginSlug: string,
  message: unknown,
  onlinePlugins: Map<string, OnlinePlugin>,
): void {
  const plugin = onlinePlugins.get(pluginSlug);
  if (!plugin || !isRecord(message)) {
    return;
  }

  if (message.type === 'response') {
    resolvePluginRequest(plugin, message);
  } else if (message.type === 'error') {
    rejectPluginRequest(plugin, message);
  } else if (isSecretPluginMessage(message)) {
    void handleSecretOperation(pluginSlug, message, onlinePlugins);
  }
}

export async function sendPluginRequest(
  pluginSlug: string,
  requestData: JsonRecord,
  onlinePlugins: Map<string, OnlinePlugin>,
): Promise<PluginResponse> {
  const plugin = onlinePlugins.get(pluginSlug);

  if (!plugin) {
    throw new Error(`Plugin ${pluginSlug} is not online`);
  }

  if (!plugin.ready) {
    throw new Error(`Plugin ${pluginSlug} is not ready`);
  }

  const requestId = `${pluginSlug}-${Date.now()}-${randomUUID()}`;

  return new Promise<PluginResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      plugin.pendingRequests.delete(requestId);
      reject(new Error(`Request to plugin ${pluginSlug} timed out`));
    }, 30000);

    plugin.pendingRequests.set(requestId, {
      resolve: (data: PluginResponse) => {
        clearTimeout(timeout);
        resolve(data);
      },
      reject: (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });

    plugin.process.send({
      type: 'request',
      requestId,
      ...requestData,
    });
  });
}

export function bindPluginProcessEvents(
  pluginSlug: string,
  childProcess: ChildProcess,
  onlinePlugins: Map<string, OnlinePlugin>,
): void {
  childProcess.on('message', message => {
    handlePluginMessage(pluginSlug, message, onlinePlugins);
  });

  childProcess.on('error', error => {
    console.error(`Plugin ${pluginSlug} error:`, error);
  });

  childProcess.on('exit', code => {
    console.log(`Plugin ${pluginSlug} exited with code ${code}`);
    onlinePlugins.delete(pluginSlug);
  });
}

export async function waitForPluginReady(
  pluginSlug: string,
  childProcess: ChildProcess,
  onlinePlugins: Map<string, OnlinePlugin>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Plugin ${pluginSlug} did not respond within timeout`));
    }, 10000);

    const readyHandler = (message: unknown) => {
      if (isRecord(message) && message.type === 'ready') {
        clearTimeout(timeout);
        const plugin = onlinePlugins.get(pluginSlug);
        if (plugin) {
          plugin.ready = true;
        }
        childProcess.removeListener('message', readyHandler);
        resolve(undefined);
      }
    };

    childProcess.on('message', readyHandler);
  });
}

export async function stopPluginProcess(plugin: OnlinePlugin): Promise<void> {
  return new Promise<void>(resolve => {
    plugin.process.once('exit', () => resolve());
    plugin.process.kill();
  });
}

async function handleSecretOperation(
  pluginSlug: string,
  message: SecretPluginMessage,
  onlinePlugins: Map<string, OnlinePlugin>,
): Promise<void> {
  const plugin = onlinePlugins.get(pluginSlug);
  if (!plugin) {
    return;
  }

  const { messageId, type, name, fileId } = message;
  const secretFileId = typeof fileId === 'string' ? fileId : undefined;

  try {
    if (type === 'secret-set') {
      secretsService.set(name, message.value, secretFileId);

      plugin.process.send({
        type: 'secret-response',
        messageId,
        data: { success: true },
      });
    } else if (type === 'secret-get') {
      const exists = secretsService.exists(name, secretFileId);
      const secretValue = exists
        ? secretsService.get(name, secretFileId)
        : undefined;

      plugin.process.send({
        type: 'secret-response',
        messageId,
        data: { value: secretValue },
      });
    }
  } catch (error) {
    plugin.process.send({
      type: 'secret-response',
      messageId,
      error: getErrorMessage(error),
    });
  }
}

function resolvePluginRequest(plugin: OnlinePlugin, message: JsonRecord): void {
  const { requestId, status, headers, body } = message;
  if (typeof requestId !== 'string' || typeof status !== 'number') {
    return;
  }

  const pendingRequest = plugin.pendingRequests.get(requestId);
  if (!pendingRequest) {
    return;
  }

  pendingRequest.resolve({
    status,
    headers: isRecord(headers)
      ? (headers as PluginResponse['headers'])
      : undefined,
    body,
  });
  plugin.pendingRequests.delete(requestId);
}

function rejectPluginRequest(plugin: OnlinePlugin, message: JsonRecord): void {
  const { requestId, error } = message;
  if (typeof requestId !== 'string') {
    return;
  }

  const pendingRequest = plugin.pendingRequests.get(requestId);
  if (!pendingRequest) {
    return;
  }

  pendingRequest.reject(
    new Error(typeof error === 'string' ? error : 'Plugin error'),
  );
  plugin.pendingRequests.delete(requestId);
}
