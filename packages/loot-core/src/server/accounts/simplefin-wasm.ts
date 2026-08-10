import * as asyncStorage from '#platform/server/asyncStorage';
import type { GlobalPrefsJson } from '#types/prefs';

const TOKEN_KEY = 'simplefin_token';
const ACCESS_KEY = 'simplefin_accessKey';
const AKAHU_USER_TOKEN_KEY = 'akahu_userToken';
const AKAHU_APP_TOKEN_KEY = 'akahu_appToken';
const PLUGGY_CLIENT_ID_KEY = 'pluggyai_clientId';
const PLUGGY_CLIENT_SECRET_KEY = 'pluggyai_clientSecret';
const PLUGGY_ITEM_IDS_KEY = 'pluggyai_itemIds';
const MODULE_URL = '/bank-sync-wasm/actual_bank_sync.js';
const BINARY_URL = '/bank-sync-wasm/actual_bank_sync_bg.wasm';
const BANK_SYNC_SECRET_KEYS = [
  TOKEN_KEY,
  ACCESS_KEY,
  AKAHU_USER_TOKEN_KEY,
  AKAHU_APP_TOKEN_KEY,
  PLUGGY_CLIENT_ID_KEY,
  PLUGGY_CLIENT_SECRET_KEY,
  PLUGGY_ITEM_IDS_KEY,
] as const satisfies readonly (keyof GlobalPrefsJson)[];

type BankSyncSecretKey = (typeof BANK_SYNC_SECRET_KEYS)[number];

type WasmModule = {
  default: (binaryUrl: string) => Promise<unknown>;
  simplefin_accounts: (token: string, accessKey: string) => Promise<unknown>;
  simplefin_transactions: (accessKey: string, body: string) => Promise<unknown>;
  akahu_status: (userToken: string, appToken: string) => Promise<unknown>;
  akahu_accounts: (userToken: string, appToken: string) => Promise<unknown>;
  akahu_transactions: (
    userToken: string,
    appToken: string,
    body: string,
  ) => Promise<unknown>;
  pluggyai_status: (
    clientId: string,
    clientSecret: string,
    itemIds: string,
  ) => Promise<unknown>;
  pluggyai_accounts: (
    clientId: string,
    clientSecret: string,
    itemIds: string,
  ) => Promise<unknown>;
  pluggyai_transactions: (
    clientId: string,
    clientSecret: string,
    itemIds: string,
    body: string,
  ) => Promise<unknown>;
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

export function isSimpleFinSecret(name: string): name is BankSyncSecretKey {
  return BANK_SYNC_SECRET_KEYS.includes(name as BankSyncSecretKey);
}

export async function setSimpleFinSecret(name: string, value: string | null) {
  if (!isSimpleFinSecret(name)) {
    throw new Error(`Unsupported bank sync secret: ${name}`);
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
    throw new Error(`Unsupported bank sync secret: ${name}`);
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

export async function getAkahuStatus() {
  const wasm = await loadModule();
  return parseJson<Record<string, unknown>>(
    await wasm.akahu_status(
      (await asyncStorage.getItem(AKAHU_USER_TOKEN_KEY)) ?? '',
      (await asyncStorage.getItem(AKAHU_APP_TOKEN_KEY)) ?? '',
    ),
  );
}

export async function getAkahuAccounts() {
  const wasm = await loadModule();
  return parseJson<Record<string, unknown>>(
    await wasm.akahu_accounts(
      (await asyncStorage.getItem(AKAHU_USER_TOKEN_KEY)) ?? '',
      (await asyncStorage.getItem(AKAHU_APP_TOKEN_KEY)) ?? '',
    ),
  );
}

export async function getAkahuTransactions(body: {
  accountId: string;
  startDate: string;
}) {
  const wasm = await loadModule();
  return parseJson<Record<string, unknown>>(
    await wasm.akahu_transactions(
      (await asyncStorage.getItem(AKAHU_USER_TOKEN_KEY)) ?? '',
      (await asyncStorage.getItem(AKAHU_APP_TOKEN_KEY)) ?? '',
      JSON.stringify(body),
    ),
  );
}

async function getPluggySecrets() {
  const [clientId, clientSecret, itemIds] = await Promise.all([
    asyncStorage.getItem(PLUGGY_CLIENT_ID_KEY),
    asyncStorage.getItem(PLUGGY_CLIENT_SECRET_KEY),
    asyncStorage.getItem(PLUGGY_ITEM_IDS_KEY),
  ]);
  return [clientId ?? '', clientSecret ?? '', itemIds ?? ''] as const;
}

export async function getPluggyAiStatus() {
  const wasm = await loadModule();
  return parseJson<Record<string, unknown>>(
    await wasm.pluggyai_status(...(await getPluggySecrets())),
  );
}

export async function getPluggyAiAccounts() {
  const wasm = await loadModule();
  return parseJson<Record<string, unknown>>(
    await wasm.pluggyai_accounts(...(await getPluggySecrets())),
  );
}

export async function getPluggyAiTransactions(body: {
  accountId: string;
  startDate: string;
}) {
  const wasm = await loadModule();
  return parseJson<Record<string, unknown>>(
    await wasm.pluggyai_transactions(
      ...(await getPluggySecrets()),
      JSON.stringify(body),
    ),
  );
}
