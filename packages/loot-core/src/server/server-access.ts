import sodium from 'libsodium-wrappers';

import * as asyncStorage from '#platform/server/asyncStorage';
import { fetch } from '#platform/server/fetch';
import * as encryption from '#server/encryption';
import { post } from '#server/post';
import * as prefs from '#server/prefs';
import { getServer } from '#server/server-config';
import { resetSync } from '#server/sync';

const PROTOCOL_VERSION = 1;

async function authenticatedGet(path: string) {
  const server = getServer();
  const token = await asyncStorage.getItem('user-token');
  if (!server || !token) {
    throw new Error('server-access-unavailable');
  }
  const response = await fetch(server.BASE_SERVER + path, {
    headers: { 'X-ACTUAL-TOKEN': token },
  });
  if (!response.ok) {
    throw new Error('server-access-unavailable');
  }
  return response.json();
}

async function authenticatedPost(path: string, data: unknown) {
  const server = getServer();
  const token = await asyncStorage.getItem('user-token');
  if (!server || !token) {
    throw new Error('server-access-unavailable');
  }
  return post(server.BASE_SERVER + path, data, {
    'X-ACTUAL-TOKEN': token,
  });
}

export async function getServerAccessStatus() {
  const { cloudFileId } = prefs.getPrefs() || {};
  if (!cloudFileId || !getServer()) {
    return { available: false, status: 'disabled' as const };
  }
  try {
    const [keyResponse, statusResponse] = await Promise.all([
      authenticatedGet('/sync/server-access-key'),
      authenticatedGet(`/api/v1/files/${cloudFileId}/status`),
    ]);
    return {
      ...keyResponse.data,
      status: statusResponse.data.status,
    };
  } catch {
    return { available: false, status: 'disabled' as const };
  }
}

export async function enableServerAccess({ timeZone }: { timeZone: string }) {
  const { cloudFileId, encryptKeyId } = prefs.getPrefs();
  const server = getServer();
  if (!cloudFileId || !server) {
    return { error: { reason: 'server-access-unavailable' } };
  }

  const keyResponse = await authenticatedGet('/sync/server-access-key');
  const serverKey = keyResponse.data;
  if (
    !serverKey.available ||
    serverKey.protocolVersion !== PROTOCOL_VERSION ||
    typeof serverKey.publicKey !== 'string'
  ) {
    return { error: { reason: 'server-access-unavailable' } };
  }

  let sealedKey: string | null = null;
  if (encryptKeyId) {
    await sodium.ready;
    const serializedKey = encryption.getKey(encryptKeyId).serialize();
    const payload = JSON.stringify({
      version: PROTOCOL_VERSION,
      fileId: cloudFileId,
      encryptKeyId,
      budgetKey: serializedKey.base64,
    });
    sealedKey = Buffer.from(
      sodium.crypto_box_seal(
        payload,
        sodium.from_base64(
          serverKey.publicKey,
          sodium.base64_variants.ORIGINAL,
        ),
      ),
    ).toString('base64');
  }

  const result = await authenticatedPost('/sync/enable-server-access', {
    fileId: cloudFileId,
    sealedKey,
    timeZone,
  });
  if (result.requiresUpload) {
    return resetSync();
  }
  return {};
}

export async function disableServerAccess() {
  const { cloudFileId } = prefs.getPrefs();
  const server = getServer();
  if (!cloudFileId || !server) {
    return { error: { reason: 'server-access-unavailable' } };
  }
  await authenticatedPost('/sync/disable-server-access', {
    fileId: cloudFileId,
  });
  return {};
}
