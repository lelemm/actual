import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type * as ApiModule from '@actual-app/api';
import { safeUnzip } from '@actual-app/core/server/util/zip';

import { createEncryptedDatabase } from './encrypted-database';
import { assertJsonSafe, SERVER_RPC_METHODS } from './rpc-methods';

type InitMessage = {
  type: 'init';
  requestId: string;
  fileId: string;
  groupId: string;
  encryptKeyId: string | null;
  budgetKey: string | null;
  databaseKey: string;
  cacheKey: string;
  mirrorRoot: string;
  snapshot: Uint8Array;
  rebuild: boolean;
  name: string | null;
  timeZone: string;
};

type CommandMessage =
  | InitMessage
  | { type: 'catch-up'; requestId: string }
  | { type: 'rpc'; requestId: string; method: string; args: unknown[] }
  | { type: 'schedule'; requestId: string }
  | {
      type: 'sync-result';
      requestId: string;
      data?: Uint8Array;
      error?: string;
    }
  | { type: 'shutdown' };

type Api = typeof ApiModule;
let api: Api;
let apiInternal: Awaited<ReturnType<typeof ApiModule.init>>;
const syncRequests = new Map<
  string,
  { resolve: (value: Uint8Array) => void; reject: (error: Error) => void }
>();
let commandQueue = Promise.resolve();

function send(message: unknown) {
  process.send?.(message);
}

function reply(requestId: string, data?: unknown, error?: unknown) {
  if (error) {
    send({
      type: 'response',
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : 'mirror-command-failed',
    });
  } else {
    send({ type: 'response', requestId, ok: true, data });
  }
}

async function syncTransport(data: Uint8Array) {
  const requestId = crypto.randomUUID();
  return new Promise<Uint8Array>((resolve, reject) => {
    syncRequests.set(requestId, { resolve, reject });
    send({ type: 'sync', requestId, data: Buffer.from(data) });
  });
}

async function reconcile() {
  try {
    await api.sync();
  } catch {
    throw new Error('mirror-reconciliation-failed');
  }
}

async function bootstrap(message: InitMessage) {
  process.env.ACTUAL_SQLITE_MODULE = 'better-sqlite3-multiple-ciphers';
  process.env.ACTUAL_MIRROR_DATABASE_KEY = message.databaseKey;
  process.env.ACTUAL_MIRROR_CACHE_KEY = message.cacheKey;
  process.env.ACTUAL_DISABLE_BACKUPS = 'true';
  process.env.TZ = message.timeZone;

  const budgetDir = join(message.mirrorRoot, message.fileId);
  const databasePath = join(budgetDir, 'db.sqlite');
  if (message.rebuild) {
    await rm(budgetDir, { recursive: true, force: true });
  }
  await mkdir(budgetDir, { recursive: true, mode: 0o700 });

  try {
    await readFile(databasePath);
  } catch {
    const entries = safeUnzip(message.snapshot, {
      maxArchiveSize: 50 * 1024 * 1024,
      maxEntrySize: 200 * 1024 * 1024,
      maxTotalUncompressedSize: 250 * 1024 * 1024,
    });
    const database = entries['db.sqlite'];
    const metadataBytes = entries['metadata.json'];
    if (!database || !metadataBytes) {
      throw new Error('invalid-budget-snapshot');
    }
    const metadata = JSON.parse(Buffer.from(metadataBytes).toString('utf8'));
    await writeFile(
      join(budgetDir, 'metadata.json'),
      JSON.stringify({
        ...metadata,
        id: message.fileId,
        budgetName: message.name || metadata.budgetName,
        cloudFileId: message.fileId,
        groupId: message.groupId,
        encryptKeyId: message.encryptKeyId,
        resetClock: true,
        lastUploaded: new Intl.DateTimeFormat('en-CA', {
          timeZone: message.timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date()),
      }),
      { mode: 0o600 },
    );
    createEncryptedDatabase(database, databasePath, message.databaseKey);
  }

  api = await import('@actual-app/api');
  apiInternal = await api.init({
    dataDir: message.mirrorRoot,
    syncTransport,
    encryptionKeys:
      message.encryptKeyId && message.budgetKey
        ? [{ id: message.encryptKeyId, base64: message.budgetKey }]
        : [],
  });
  await api.loadBudget(message.fileId);
  await reconcile();
}

async function handleCommand(message: Exclude<CommandMessage, InitMessage>) {
  switch (message.type) {
    case 'catch-up':
      await reconcile();
      reply(message.requestId);
      break;
    case 'rpc': {
      if (!SERVER_RPC_METHODS.has(message.method)) {
        throw new Error('rpc-method-not-allowed');
      }
      if (!Array.isArray(message.args)) {
        throw new Error('invalid-rpc-arguments');
      }
      await reconcile();
      const method = api[message.method as keyof Api];
      if (typeof method !== 'function') {
        throw new Error('rpc-method-not-available');
      }
      const result = await Reflect.apply(method, api, message.args);
      await reconcile();
      reply(message.requestId, assertJsonSafe(result));
      break;
    }
    case 'schedule':
      await reconcile();
      await apiInternal.send('schedule/force-run-service', true);
      await reconcile();
      reply(message.requestId);
      break;
    case 'shutdown':
      await api.shutdown();
      process.exit(0);
      break;
    case 'sync-result':
      break;
    default:
      throw new Error('unknown-mirror-command');
  }
}

process.on('message', (message: CommandMessage) => {
  if (message.type === 'sync-result') {
    const pending = syncRequests.get(message.requestId);
    if (!pending) return;
    syncRequests.delete(message.requestId);
    if (message.error || !message.data) {
      pending.reject(new Error(message.error || 'empty-sync-response'));
    } else {
      pending.resolve(new Uint8Array(message.data));
    }
    return;
  }

  if (message.type === 'init') {
    commandQueue = commandQueue
      .then(() => bootstrap(message))
      .then(() => reply(message.requestId))
      .catch(error => reply(message.requestId, undefined, error));
    return;
  }

  commandQueue = commandQueue
    .then(() => handleCommand(message))
    .catch(error =>
      reply('requestId' in message ? message.requestId : '', undefined, error),
    );
});

process.on('disconnect', () => process.exit(0));
