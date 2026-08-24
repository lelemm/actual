import sodium from 'libsodium-wrappers';

import { File } from '#app-sync/services/files-service';
import { config } from '#load-config';
import type { FileId, GroupId } from '#util/paths';

import {
  deriveMirrorKeys,
  getServerAccessKey,
  isValidTimeZone,
  openServerAccessKey,
  sealServerAccessKey,
} from './crypto';

function testFile(id = 'budget-file') {
  return new File({
    id: id as FileId,
    name: 'Budget',
    groupId: 'group' as GroupId,
    encryptKeyId: 'key-id',
    encryptMeta: null,
    syncVersion: '2',
    owner: 'owner',
  });
}

describe('server access keys', () => {
  const originalKey = config.get('serverPrivateKey');

  beforeAll(async () => {
    await sodium.ready;
  });

  afterEach(() => {
    config.set('serverPrivateKey', originalKey);
  });

  it('advertises invalid configuration as unavailable', async () => {
    config.set('serverPrivateKey', 'not-a-private-key');
    expect(await getServerAccessKey()).toBeNull();
  });

  it('opens only a sealed key with matching budget bindings', async () => {
    const keyPair = sodium.crypto_box_keypair();
    config.set(
      'serverPrivateKey',
      sodium.to_base64(keyPair.privateKey, sodium.base64_variants.ORIGINAL),
    );
    const file = testFile();
    const budgetKey = Buffer.alloc(32, 7);
    const sealed = await sealServerAccessKey({
      fileId: file.id,
      encryptKeyId: file.encryptKeyId ?? null,
      budgetKey,
    });

    await expect(openServerAccessKey(sealed, file)).resolves.toEqual(budgetKey);
    await expect(
      openServerAccessKey(sealed, testFile('another-budget')),
    ).rejects.toThrow('invalid-sealed-key-bindings');
  });

  it('rejects sealed keys after the server private key changes', async () => {
    const originalPair = sodium.crypto_box_keypair();
    config.set(
      'serverPrivateKey',
      sodium.to_base64(
        originalPair.privateKey,
        sodium.base64_variants.ORIGINAL,
      ),
    );
    const file = testFile();
    const sealed = await sealServerAccessKey({
      fileId: file.id,
      encryptKeyId: file.encryptKeyId ?? null,
      budgetKey: Buffer.alloc(32, 4),
    });

    const replacementPair = sodium.crypto_box_keypair();
    config.set(
      'serverPrivateKey',
      sodium.to_base64(
        replacementPair.privateKey,
        sodium.base64_variants.ORIGINAL,
      ),
    );
    await expect(openServerAccessKey(sealed, file)).rejects.toThrow(
      'invalid-sealed-key',
    );
  });

  it('rejects a tampered sealed key', async () => {
    const keyPair = sodium.crypto_box_keypair();
    config.set(
      'serverPrivateKey',
      sodium.to_base64(keyPair.privateKey, sodium.base64_variants.ORIGINAL),
    );
    const file = testFile();
    const sealed = Buffer.from(
      await sealServerAccessKey({
        fileId: file.id,
        encryptKeyId: file.encryptKeyId ?? null,
        budgetKey: Buffer.alloc(32, 5),
      }),
      'base64',
    );
    sealed[sealed.length - 1] ^= 1;

    await expect(
      openServerAccessKey(sealed.toString('base64'), file),
    ).rejects.toThrow('invalid-sealed-key');
  });

  it('derives stable, separate database and cache keys', () => {
    const seed = Buffer.alloc(32, 3);
    const first = deriveMirrorKeys(seed, 'budget-file' as FileId);
    const second = deriveMirrorKeys(seed, 'budget-file' as FileId);

    expect(first.databaseKey).toEqual(second.databaseKey);
    expect(first.cacheKey).toEqual(second.cacheKey);
    expect(first.databaseKey).not.toEqual(first.cacheKey);
  });

  it('validates IANA time zones', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('not/a-zone')).toBe(false);
  });
});
