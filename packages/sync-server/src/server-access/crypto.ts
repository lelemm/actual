import {
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

import { safeUnzip } from '@actual-app/core/server/util/zip';
import sodium from 'libsodium-wrappers';

import type { File } from '#app-sync/services/files-service';
import { config } from '#load-config';
import type { FileId } from '#util/paths';

export const SERVER_ACCESS_PROTOCOL_VERSION = 1;

type ServerAccessKey = {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyBase64: string;
  fingerprint: string;
};

type SealedKeyPayload = {
  version: typeof SERVER_ACCESS_PROTOCOL_VERSION;
  fileId: string;
  encryptKeyId: string | null;
  budgetKey: string;
};

let cachedConfigValue: string | null = null;
let cachedKey: ServerAccessKey | null = null;

function decodePrivateKey(value: string): Uint8Array | null {
  try {
    const decoded = sodium.from_base64(value, sodium.base64_variants.ORIGINAL);
    return decoded.length === sodium.crypto_box_SECRETKEYBYTES ? decoded : null;
  } catch {
    return null;
  }
}

export async function getServerAccessKey(): Promise<ServerAccessKey | null> {
  await sodium.ready;
  const configValue = config.get('serverPrivateKey').trim();
  if (cachedConfigValue === configValue) {
    return cachedKey;
  }

  cachedConfigValue = configValue;
  cachedKey = null;
  if (!configValue) {
    return null;
  }

  const privateKey = decodePrivateKey(configValue);
  if (!privateKey) {
    return null;
  }

  const publicKey = sodium.crypto_scalarmult_base(privateKey);
  const publicKeyBase64 = sodium.to_base64(
    publicKey,
    sodium.base64_variants.ORIGINAL,
  );
  const fingerprint = `sha256:${createHash('sha256')
    .update(publicKey)
    .digest('base64url')}`;

  cachedKey = { privateKey, publicKey, publicKeyBase64, fingerprint };
  return cachedKey;
}

export async function sealServerAccessKey({
  fileId,
  encryptKeyId,
  budgetKey,
}: {
  fileId: FileId;
  encryptKeyId: string | null;
  budgetKey: Uint8Array;
}): Promise<string> {
  const serverKey = await getServerAccessKey();
  if (!serverKey) {
    throw new Error('server-access-unavailable');
  }
  if (budgetKey.length !== 32) {
    throw new Error('invalid-budget-key');
  }

  const payload: SealedKeyPayload = {
    version: SERVER_ACCESS_PROTOCOL_VERSION,
    fileId,
    encryptKeyId,
    budgetKey: Buffer.from(budgetKey).toString('base64'),
  };
  return Buffer.from(
    sodium.crypto_box_seal(JSON.stringify(payload), serverKey.publicKey),
  ).toString('base64');
}

export async function openServerAccessKey(
  sealedKey: string,
  file: File,
): Promise<Buffer> {
  const serverKey = await getServerAccessKey();
  if (!serverKey) {
    throw new Error('server-access-unavailable');
  }

  let plaintext: Uint8Array;
  try {
    plaintext = sodium.crypto_box_seal_open(
      Buffer.from(sealedKey, 'base64'),
      serverKey.publicKey,
      serverKey.privateKey,
    );
  } catch {
    throw new Error('invalid-sealed-key');
  }

  let payload: SealedKeyPayload;
  try {
    payload = JSON.parse(Buffer.from(plaintext).toString('utf8'));
  } catch {
    throw new Error('invalid-sealed-key');
  } finally {
    sodium.memzero(plaintext);
  }

  const budgetKey = Buffer.from(payload.budgetKey || '', 'base64');
  if (
    payload.version !== SERVER_ACCESS_PROTOCOL_VERSION ||
    payload.fileId !== file.id ||
    payload.encryptKeyId !== file.encryptKeyId ||
    budgetKey.length !== 32
  ) {
    budgetKey.fill(0);
    throw new Error('invalid-sealed-key-bindings');
  }

  return budgetKey;
}

export function createMirrorSeed(): Buffer {
  return randomBytes(32);
}

export function deriveMirrorKeys(seed: Uint8Array, fileId: FileId) {
  const salt = Buffer.from(fileId, 'utf8');
  return {
    databaseKey: Buffer.from(
      hkdfSync(
        'sha256',
        seed,
        salt,
        Buffer.from('actual-server-mirror-database-v1'),
        32,
      ),
    ),
    cacheKey: Buffer.from(
      hkdfSync(
        'sha256',
        seed,
        salt,
        Buffer.from('actual-server-mirror-cache-v1'),
        32,
      ),
    ),
  };
}

function decryptAesGcm(
  ciphertext: Uint8Array,
  metadata: {
    algorithm: string;
    iv: string;
    authTag: string;
  },
  key: Uint8Array,
) {
  if (metadata.algorithm !== 'aes-256-gcm') {
    throw new Error('unsupported-budget-encryption');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(metadata.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(metadata.authTag, 'base64'));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function validateEncryptionTest(file: File, budgetKey: Uint8Array) {
  if (!file.encryptKeyId) {
    return;
  }
  if (!file.encryptTest) {
    throw new Error('missing-encryption-test');
  }

  const test = JSON.parse(file.encryptTest);
  if (test.meta?.keyId !== file.encryptKeyId) {
    throw new Error('invalid-encryption-test-bindings');
  }
  decryptAesGcm(Buffer.from(test.value, 'base64'), test.meta, budgetKey);
}

export function decryptAndValidateSnapshot(
  file: File,
  snapshot: Uint8Array,
  budgetKey: Uint8Array,
): Buffer {
  const zip = file.encryptMeta
    ? decryptAesGcm(snapshot, JSON.parse(file.encryptMeta), budgetKey)
    : Buffer.from(snapshot);

  const entries = safeUnzip(zip, {
    maxArchiveSize: 50 * 1024 * 1024,
    maxEntrySize: 200 * 1024 * 1024,
    maxTotalUncompressedSize: 250 * 1024 * 1024,
  });
  const database = entries['db.sqlite'];
  const metadata = entries['metadata.json'];
  if (
    !database ||
    !metadata ||
    Buffer.from(database.subarray(0, 16)).toString('utf8') !==
      'SQLite format 3\0'
  ) {
    throw new Error('invalid-budget-snapshot');
  }
  JSON.parse(Buffer.from(metadata).toString('utf8'));
  return zip;
}

export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || timeZone.length > 255) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}
