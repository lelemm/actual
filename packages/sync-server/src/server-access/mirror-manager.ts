import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  create,
  fromBinary,
  SyncRequestSchema,
  SyncResponseSchema,
  toBinary,
} from '@actual-app/crdt';

import { getAccountDb } from '#account-db';
import { FilesService } from '#app-sync/services/files-service';
import type { File, RawFile } from '#app-sync/services/files-service';
import { config } from '#load-config';
import * as simpleSync from '#sync-simple';
import { getPathForUserFile } from '#util/paths';
import type { FileId } from '#util/paths';

import {
  decryptAndValidateSnapshot,
  deriveMirrorKeys,
  getServerAccessKey,
  openServerAccessKey,
  validateEncryptionTest,
} from './crypto';

export type MirrorStatus = 'disabled' | 'starting' | 'ready' | 'degraded';

type PendingCommand = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type MirrorState = {
  fileId: FileId;
  groupId: string;
  encryptKeyId: string | null;
  child: ChildProcess;
  status: Exclude<MirrorStatus, 'disabled'>;
  pending: Map<string, PendingCommand>;
  intentionalStop: boolean;
  restartCount: number;
  restartTimer?: NodeJS.Timeout;
  catchUpLatencyMs: number | null;
  notificationPending: boolean;
  notificationRunning: boolean;
};

const states = new Map<FileId, MirrorState>();
const degradedFiles = new Set<FileId>();
const lifecycleQueues = new Map<FileId, Promise<void>>();
const COMMAND_TIMEOUT_MS = 30_000;
let totalRestartCount = 0;

function serializeLifecycle<T>(fileId: FileId, operation: () => Promise<T>) {
  const previous = lifecycleQueues.get(fileId) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  lifecycleQueues.set(fileId, settled);
  void settled.then(() => {
    if (lifecycleQueues.get(fileId) === settled) {
      lifecycleQueues.delete(fileId);
    }
  });
  return next;
}

function mirrorRoot(fileId: FileId) {
  return join(config.get('serverFiles'), 'mirrors', fileId);
}

function childEntrypoint() {
  return join(
    config.get('projectRoot'),
    'build',
    'server-access',
    'mirror-child.js',
  );
}

function getCurrentFile(fileId: FileId) {
  return new FilesService(getAccountDb()).get(fileId);
}

function sendCommand(
  state: MirrorState,
  command: Record<string, unknown>,
  timeoutMs = COMMAND_TIMEOUT_MS,
) {
  const requestId = crypto.randomUUID();
  return new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.pending.delete(requestId);
      degradeAndRestart(state);
      reject(new Error('mirror-command-timeout'));
    }, timeoutMs);
    state.pending.set(requestId, { resolve, reject, timeout });
    state.child.send({ ...command, requestId }, error => {
      if (!error) return;
      clearTimeout(timeout);
      state.pending.delete(requestId);
      reject(error);
    });
  });
}

function degradeAndRestart(state: MirrorState) {
  state.status = 'degraded';
  degradedFiles.add(state.fileId);
  if (state.child.exitCode == null) {
    state.child.kill();
  } else {
    scheduleRestart(state);
  }
}

function rejectPending(state: MirrorState, reason: string) {
  for (const pending of state.pending.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(reason));
  }
  state.pending.clear();
}

function handleChildSync(
  state: MirrorState,
  message: { requestId: string; data: Uint8Array },
) {
  try {
    const request = fromBinary(SyncRequestSchema, message.data);
    const currentFile = getCurrentFile(state.fileId);
    if (
      !currentFile.serverAccessEnabled ||
      request.fileId !== state.fileId ||
      request.groupId !== state.groupId ||
      request.groupId !== currentFile.groupId ||
      (request.keyId || null) !== state.encryptKeyId ||
      (request.keyId || null) !== currentFile.encryptKeyId ||
      !request.capabilities.includes('server-automation-v1')
    ) {
      throw new Error('mirror-sync-binding-mismatch');
    }

    const { trie, newMessages } = simpleSync.sync(
      request.messages,
      request.since,
      state.groupId,
    );
    const response = create(SyncResponseSchema, {
      merkle: JSON.stringify(trie),
      messages: newMessages,
      capabilities: ['server-automation-v1'],
    });
    state.child.send({
      type: 'sync-result',
      requestId: message.requestId,
      data: Buffer.from(toBinary(SyncResponseSchema, response)),
    });
  } catch (error) {
    state.child.send({
      type: 'sync-result',
      requestId: message.requestId,
      error: error instanceof Error ? error.message : 'mirror-sync-failed',
    });
  }
}

function scheduleRestart(state: MirrorState) {
  if (state.intentionalStop || state.restartTimer) return;
  totalRestartCount++;
  state.status = 'degraded';
  degradedFiles.add(state.fileId);
  const delay = Math.min(60_000, 1_000 * 2 ** Math.min(state.restartCount, 6));
  state.restartTimer = setTimeout(() => {
    states.delete(state.fileId);
    try {
      const file = getCurrentFile(state.fileId);
      if (file.serverAccessEnabled) {
        void startMirror(file, { restartCount: state.restartCount + 1 });
      }
    } catch {
      // The budget was removed while waiting to restart.
    }
  }, delay);
}

async function startMirrorNow(
  file: File,
  {
    rebuild = false,
    restartCount = 0,
  }: { rebuild?: boolean; restartCount?: number } = {},
) {
  if (
    !file.serverAccessEnabled ||
    !file.groupId ||
    !file.serverAccessSealedKey
  ) {
    return;
  }
  if (!file.automationTimeZone) return;
  await stopMirrorNow(file.id);

  const serverKey = await getServerAccessKey();
  if (!serverKey || serverKey.fingerprint !== file.serverAccessFingerprint) {
    degradedFiles.add(file.id);
    return;
  }

  let seed: Buffer | null = null;
  let databaseKey: Buffer | null = null;
  let cacheKey: Buffer | null = null;
  try {
    seed = await openServerAccessKey(file.serverAccessSealedKey, file);
    validateEncryptionTest(file, seed);
    const snapshotBytes = await readFile(getPathForUserFile(file.id));
    const snapshot = decryptAndValidateSnapshot(file, snapshotBytes, seed);
    ({ databaseKey, cacheKey } = deriveMirrorKeys(seed, file.id));

    const child = fork(childEntrypoint(), [], {
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      execArgv: [],
    });
    const state: MirrorState = {
      fileId: file.id,
      groupId: file.groupId,
      encryptKeyId: file.encryptKeyId ?? null,
      child,
      status: 'starting',
      pending: new Map(),
      intentionalStop: false,
      restartCount,
      catchUpLatencyMs: null,
      notificationPending: false,
      notificationRunning: false,
    };
    states.set(file.id, state);

    child.on('message', message => {
      const childMessage = message as {
        type: string;
        requestId: string;
        ok?: boolean;
        data?: unknown;
        error?: string;
      };
      if (childMessage.type === 'sync') {
        handleChildSync(
          state,
          childMessage as { requestId: string; data: Uint8Array; type: string },
        );
        return;
      }
      if (childMessage.type !== 'response') return;
      const pending = state.pending.get(childMessage.requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      state.pending.delete(childMessage.requestId);
      if (childMessage.ok) {
        pending.resolve(childMessage.data);
      } else {
        pending.reject(
          new Error(childMessage.error || 'mirror-command-failed'),
        );
      }
    });
    child.on('exit', () => {
      rejectPending(state, 'mirror-process-exited');
      scheduleRestart(state);
    });
    child.on('error', () => scheduleRestart(state));

    await sendCommand(
      state,
      {
        type: 'init',
        fileId: file.id,
        groupId: file.groupId,
        encryptKeyId: file.encryptKeyId ?? null,
        budgetKey: file.encryptKeyId ? seed.toString('base64') : null,
        databaseKey: databaseKey.toString('hex'),
        cacheKey: cacheKey.toString('hex'),
        mirrorRoot: mirrorRoot(file.id),
        snapshot,
        rebuild,
        name: file.name,
        timeZone: file.automationTimeZone,
      },
      120_000,
    );
    state.status = 'ready';
    degradedFiles.delete(file.id);
  } catch {
    degradedFiles.add(file.id);
    const state = states.get(file.id);
    if (state) {
      state.status = 'degraded';
      state.child.kill();
    }
  } finally {
    seed?.fill(0);
    databaseKey?.fill(0);
    cacheKey?.fill(0);
  }
}

export function startMirror(
  file: File,
  options: { rebuild?: boolean; restartCount?: number } = {},
) {
  return serializeLifecycle(file.id, () => startMirrorNow(file, options));
}

async function stopMirrorNow(fileId: FileId) {
  const state = states.get(fileId);
  if (!state) return;
  state.intentionalStop = true;
  if (state.restartTimer) clearTimeout(state.restartTimer);
  rejectPending(state, 'mirror-stopped');
  states.delete(fileId);
  if (state.child.exitCode != null) return;
  await new Promise<void>(resolve => {
    const forceTimer = setTimeout(() => state.child.kill(), 2_000);
    state.child.once('exit', () => {
      clearTimeout(forceTimer);
      resolve();
    });
    if (state.child.connected) {
      state.child.send({ type: 'shutdown' });
    } else {
      state.child.kill();
    }
  });
}

export function stopMirror(fileId: FileId) {
  return serializeLifecycle(fileId, () => stopMirrorNow(fileId));
}

export function removeMirror(fileId: FileId) {
  return serializeLifecycle(fileId, async () => {
    await stopMirrorNow(fileId);
    degradedFiles.delete(fileId);
    await rm(mirrorRoot(fileId), { recursive: true, force: true });
  });
}

async function readyState(fileId: FileId) {
  const file = getCurrentFile(fileId);
  let state = states.get(fileId);
  if (!state && file.serverAccessEnabled) {
    await startMirror(file);
    state = states.get(fileId);
  }
  if (!state || state.status !== 'ready') {
    throw new Error('mirror-unavailable');
  }
  return state;
}

export async function catchUpMirror(fileId: FileId) {
  const state = await readyState(fileId);
  const startedAt = performance.now();
  try {
    await sendCommand(state, { type: 'catch-up' });
    state.catchUpLatencyMs = performance.now() - startedAt;
  } catch {
    degradeAndRestart(state);
    throw new Error('mirror-unavailable');
  }
}

export function notifyMirror(fileId: FileId) {
  const state = states.get(fileId);
  if (!state || state.status !== 'ready') return;
  state.notificationPending = true;
  if (state.notificationRunning) return;
  state.notificationRunning = true;
  void (async () => {
    try {
      while (state.notificationPending) {
        state.notificationPending = false;
        await sendCommand(state, { type: 'catch-up' });
      }
    } catch {
      degradeAndRestart(state);
    } finally {
      state.notificationRunning = false;
    }
  })();
}

export async function callMirrorRpc(
  fileId: FileId,
  method: string,
  args: unknown[],
) {
  const state = await readyState(fileId);
  try {
    return await sendCommand(state, { type: 'rpc', method, args });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'mirror-reconciliation-failed'
    ) {
      degradeAndRestart(state);
      throw new Error('mirror-unavailable');
    }
    throw error;
  }
}

export async function runMirrorSchedules(fileId: FileId) {
  const state = await readyState(fileId);
  try {
    await sendCommand(state, { type: 'schedule' }, 120_000);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'mirror-reconciliation-failed'
    ) {
      degradeAndRestart(state);
    }
    throw error;
  }
}

export async function initializeMirrors() {
  const service = new FilesService(getAccountDb());
  const rows = getAccountDb().all(
    'SELECT * FROM files WHERE deleted = 0 AND server_access_enabled = 1',
  ) as RawFile[];
  await Promise.all(rows.map(row => startMirror(service.validate(row))));
}

export async function getMirrorStatus(file: File): Promise<MirrorStatus> {
  if (!file.serverAccessEnabled && !file.serverAccessPending) return 'disabled';
  const serverKey = await getServerAccessKey();
  if (!serverKey || serverKey.fingerprint !== file.serverAccessFingerprint) {
    return 'degraded';
  }
  if (degradedFiles.has(file.id)) return 'degraded';
  if (file.serverAccessPending) return 'starting';
  return states.get(file.id)?.status ?? 'starting';
}

export function getMirrorMetrics() {
  const values = [...states.values()];
  const degraded = new Set(degradedFiles);
  const catchUpLatencies = values.flatMap(state =>
    state.catchUpLatencyMs == null ? [] : [state.catchUpLatencyMs],
  );
  for (const state of values) {
    if (state.status === 'degraded') degraded.add(state.fileId);
  }
  return {
    processCount: values.filter(state => state.child.exitCode == null).length,
    degraded: degraded.size,
    restartCount: totalRestartCount,
    catchUpLatencyMs: {
      average:
        catchUpLatencies.length === 0
          ? null
          : catchUpLatencies.reduce((sum, value) => sum + value, 0) /
            catchUpLatencies.length,
      maximum:
        catchUpLatencies.length === 0 ? null : Math.max(...catchUpLatencies),
    },
  };
}
