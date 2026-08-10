import * as asyncStorage from '#platform/server/asyncStorage';

const TOKEN_KEY = 'simplefin_token';
const ACCESS_KEY = 'simplefin_accessKey';
const MODULE_URL = '/bank-sync-wasm/actual_sync_server.js';
const BINARY_URL = '/bank-sync-wasm/actual_sync_server_bg.wasm';

type WasmModule = {
  default: (binaryUrl: string) => Promise<unknown>;
  simplefin_accounts: (token: string, accessKey: string) => Promise<unknown>;
  simplefin_transactions: (accessKey: string, body: string) => Promise<unknown>;
};

let isEnabled = false;
let modulePromise: Promise<WasmModule> | undefined;

export function configureSimpleFinWasm(enabled: boolean) {
  isEnabled = enabled;
}

export function isSimpleFinWasmEnabled() {
  return isEnabled;
}

async function loadModule() {
  modulePromise ??= import(/* @vite-ignore */ MODULE_URL).then(
    async loadedModule => {
      const wasm = loadedModule as WasmModule;
      await wasm.default(BINARY_URL);
      return wasm;
    },
  );
  return modulePromise;
}

function parseJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

export function isSimpleFinSecret(name: string) {
  return name === TOKEN_KEY || name === ACCESS_KEY;
}

export async function setSimpleFinSecret(name: string, value: string | null) {
  if (!isSimpleFinSecret(name)) {
    throw new Error(`Unsupported SimpleFIN secret: ${name}`);
  }

  if (value === null) {
    await asyncStorage.removeItem(name);
  } else {
    await asyncStorage.setItem(name, value);
  }
  return {};
}

export async function checkSimpleFinSecret(name: string) {
  if (!isSimpleFinSecret(name)) {
    throw new Error(`Unsupported SimpleFIN secret: ${name}`);
  }

  return { data: (await asyncStorage.getItem(name)) != null };
}

export async function getSimpleFinStatus() {
  const token = await asyncStorage.getItem(TOKEN_KEY);
  return {
    configured: token != null && !token.startsWith('Forbidden'),
  };
}

export async function getSimpleFinAccounts() {
  const token = (await asyncStorage.getItem(TOKEN_KEY)) ?? '';
  const accessKey = (await asyncStorage.getItem(ACCESS_KEY)) ?? '';
  const wasm = await loadModule();
  const result = parseJson<{ data: unknown; accessKey?: string }>(
    await wasm.simplefin_accounts(token, accessKey),
  );

  if (result.accessKey) {
    await asyncStorage.setItem(ACCESS_KEY, result.accessKey);
  }
  return result.data;
}

export async function getSimpleFinTransactions(body: {
  accountId: string | string[];
  startDate: string | string[];
}) {
  const accessKey = (await asyncStorage.getItem(ACCESS_KEY)) ?? '';
  const wasm = await loadModule();
  return parseJson<Record<string, unknown>>(
    await wasm.simplefin_transactions(accessKey, JSON.stringify(body)),
  );
}
