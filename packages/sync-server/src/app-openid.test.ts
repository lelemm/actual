import request from 'supertest';

import type { ConfigParameter } from '#accounts/openid';

import { getAccountDb } from './account-db';
import { bootstrapPassword } from './accounts/password';
import { handlers as app, openIdConfigRateLimiter } from './app-openid';

function insertOpenIdAuth(extraData: ConfigParameter) {
  getAccountDb().mutate(
    'INSERT INTO auth (method, display_name, extra_data, active) VALUES (?, ?, ?, ?)',
    ['openid', 'OpenID', JSON.stringify(extraData), 1],
  );
}

describe('/config', () => {
  beforeEach(() => {
    openIdConfigRateLimiter.resetKey('127.0.0.1');
  });

  afterEach(() => {
    getAccountDb().mutate('DELETE FROM auth');
  });

  it('rejects config access after an owner has already been created', async () => {
    await bootstrapPassword('bootstrap-password');
    insertOpenIdAuth({
      client_id: 'client-id',
      client_secret: 'client-secret',
      issuer: 'https://issuer.example.com',
    });

    const res = await request(app)
      .post('/config')
      .send({ password: 'bootstrap-password' });

    expect(res.statusCode).toEqual(400);
    expect(res.body).toEqual({
      status: 'error',
      reason: 'already-bootstraped',
    });
  });

  it('does not expose the client secret', async () => {
    const { owner: previousOwner } = getAccountDb().first(
      'SELECT owner FROM users WHERE id = ?',
      ['genericAdmin'],
    );
    getAccountDb().mutate('UPDATE users SET owner = 0 WHERE owner = 1');

    try {
      await bootstrapPassword('review-password');
      insertOpenIdAuth({
        client_id: 'client-id',
        client_secret: 'client-secret',
        issuer: 'https://issuer.example.com',
        server_hostname: 'https://actual.example.com',
      });

      const res = await request(app)
        .post('/config')
        .send({ password: 'review-password' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.status).toEqual('ok');
      expect(res.body.data.openId).toEqual({
        client_id: 'client-id',
        issuer: 'https://issuer.example.com',
        server_hostname: 'https://actual.example.com',
      });
      expect(res.body.data.openId).not.toHaveProperty('client_secret');
    } finally {
      getAccountDb().mutate('UPDATE users SET owner = ? WHERE id = ?', [
        previousOwner,
        'genericAdmin',
      ]);
    }
  });
});
