import { randomBytes } from 'node:crypto';

import { create, SyncRequestSchema, toBinary } from '@actual-app/crdt';
import request from 'supertest';

import { getAccountDb } from '#account-db';
import { handlers as app } from '#app-sync';
import { config } from '#load-config';

describe('server access sync endpoints', () => {
  const originalKey = config.get('serverPrivateKey');
  const files: string[] = [];

  afterEach(() => {
    config.set('serverPrivateKey', originalKey);
    for (const id of files.splice(0)) {
      getAccountDb().mutate('DELETE FROM files WHERE id = ?', [id]);
    }
  });

  it('requires authentication before advertising the server key', async () => {
    const response = await request(app).get('/server-access-key');
    expect(response.statusCode).toBe(401);
  });

  it('advertises missing or invalid key configuration as unavailable', async () => {
    config.set('serverPrivateKey', 'invalid');
    const response = await request(app)
      .get('/server-access-key')
      .set('x-actual-token', 'valid-token');
    expect(response.statusCode).toBe(200);
    expect(response.body.data).toEqual({
      available: false,
      publicKey: null,
      fingerprint: null,
      protocolVersion: 1,
    });
  });

  it('rejects an unaware client when server automation is authoritative', async () => {
    const fileId = randomBytes(16).toString('hex');
    files.push(fileId);
    getAccountDb().mutate(
      `INSERT INTO files
        (id, owner, group_id, sync_version, server_access_enabled)
       VALUES (?, ?, ?, 2, 1)`,
      [fileId, 'genericAdmin', 'server-access-group'],
    );
    const body = toBinary(
      SyncRequestSchema,
      create(SyncRequestSchema, {
        fileId,
        groupId: 'server-access-group',
        since: '1970-01-01T00:00:00.000Z-0000-0000000000000000',
      }),
    );

    const response = await request(app)
      .post('/sync')
      .set('x-actual-token', 'valid-token')
      .set('Content-Type', 'application/actual-sync')
      .send(Buffer.from(body));
    expect(response.statusCode).toBe(409);
    expect(response.body.reason).toBe('client-server-automation-required');
  });
});
