import { randomBytes } from 'node:crypto';

import request from 'supertest';

import { getAccountDb } from './account-db';
import { handlers as app } from './app-api';

const callMirrorRpc = vi.hoisted(() => vi.fn());
vi.mock('./server-access/mirror-manager', async importOriginal => ({
  ...(await importOriginal()),
  callMirrorRpc,
}));

function fileId() {
  return randomBytes(16).toString('hex');
}

describe('server budget API', () => {
  const files: string[] = [];

  afterEach(() => {
    callMirrorRpc.mockReset();
    for (const id of files.splice(0)) {
      getAccountDb().mutate('DELETE FROM files WHERE id = ?', [id]);
    }
  });

  it('requires authentication', async () => {
    const response = await request(app).get(`/files/${fileId()}/status`);
    expect(response.statusCode).toBe(401);
    expect(response.body.reason).toBe('unauthorized');
  });

  it('reports disabled status without exposing secrets', async () => {
    const id = fileId();
    files.push(id);
    getAccountDb().mutate(
      'INSERT INTO files (id, owner, server_access_sealed_key) VALUES (?, ?, ?)',
      [id, 'genericAdmin', 'secret-value'],
    );

    const response = await request(app)
      .get(`/files/${id}/status`)
      .set('x-actual-token', 'valid-token');
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      data: { status: 'disabled' },
    });
    expect(response.text).not.toContain('secret-value');
  });

  it('enforces file permissions before RPC validation', async () => {
    const id = fileId();
    files.push(id);
    getAccountDb().mutate('INSERT INTO files (id, owner) VALUES (?, ?)', [
      id,
      'someone-else',
    ]);

    const response = await request(app)
      .post(`/files/${id}/rpc`)
      .set('x-actual-token', 'valid-token-user')
      .send({ method: 'loadBudget', args: [] });
    expect(response.statusCode).toBe(403);
    expect(response.body.reason).toBe('file-access-not-allowed');
  });

  it('rejects methods outside the explicit allowlist', async () => {
    const id = fileId();
    files.push(id);
    getAccountDb().mutate('INSERT INTO files (id, owner) VALUES (?, ?)', [
      id,
      'genericAdmin',
    ]);

    const response = await request(app)
      .post(`/files/${id}/rpc`)
      .set('x-actual-token', 'valid-token')
      .send({ method: 'sync', args: [] });
    expect(response.statusCode).toBe(400);
    expect(response.body.reason).toBe('invalid-rpc-call');
  });

  it('returns 503 instead of serving an unhealthy mirror', async () => {
    const id = fileId();
    files.push(id);
    getAccountDb().mutate(
      'INSERT INTO files (id, owner, server_access_enabled) VALUES (?, ?, 1)',
      [id, 'genericAdmin'],
    );
    callMirrorRpc.mockRejectedValueOnce(new Error('mirror-unavailable'));

    const response = await request(app)
      .post(`/files/${id}/rpc`)
      .set('x-actual-token', 'valid-token')
      .send({ method: 'getAccounts', args: [] });

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({
      status: 'error',
      reason: 'mirror-unavailable',
    });
  });
});
