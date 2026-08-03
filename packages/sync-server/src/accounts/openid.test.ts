import { getAccountDb } from '#account-db';

import { bootstrapOpenId, loginWithOpenIdFinalize } from './openid';

function insertOpenIdAuth(extraData: Record<string, unknown>) {
  getAccountDb().mutate(
    'INSERT INTO auth (method, display_name, extra_data, active) VALUES (?, ?, ?, ?)',
    ['openid', 'OpenID', JSON.stringify(extraData), 1],
  );
}

function insertPendingRequest(state: string) {
  getAccountDb().mutate(
    'INSERT INTO pending_openid_requests (state, code_verifier, return_url, expiry_time) VALUES (?, ?, ?, ?)',
    [state, 'code-verifier', 'https://actual.example.com', Date.now() + 60_000],
  );
}

const staticIssuer = {
  name: 'https://issuer.invalid',
  authorization_endpoint: 'https://issuer.invalid/auth',
  token_endpoint: 'https://issuer.invalid/token',
  userinfo_endpoint: 'https://issuer.invalid/userinfo',
};

describe('bootstrapOpenId', () => {
  afterEach(() => {
    getAccountDb().mutate('DELETE FROM auth');
  });

  it('keeps the existing client secret when saving with an empty one', async () => {
    const config = {
      issuer: staticIssuer,
      client_id: 'client-id',
      client_secret: 'client-secret',
      server_hostname: 'https://actual.example.com',
    };

    expect(await bootstrapOpenId({ ...config })).toEqual({});
    expect(await bootstrapOpenId({ ...config, client_secret: '' })).toEqual({});

    const { extra_data: extraData } = getAccountDb().first(
      'SELECT extra_data FROM auth WHERE method = ?',
      ['openid'],
    );
    expect(JSON.parse(extraData).client_secret).toEqual('client-secret');
  });

  it('rejects an empty client secret when no previous configuration exists', async () => {
    const res = await bootstrapOpenId({
      issuer: staticIssuer,
      client_id: 'client-id',
      client_secret: '',
      server_hostname: 'https://actual.example.com',
    });

    expect(res).toEqual({ error: 'missing-client-secret' });
  });
});

describe('loginWithOpenIdFinalize', () => {
  beforeEach(() => {
    insertOpenIdAuth({
      issuer: staticIssuer,
      client_id: 'client-id',
      client_secret: 'client-secret',
      server_hostname: 'https://actual.example.com',
    });
  });

  afterEach(() => {
    getAccountDb().mutate('DELETE FROM auth');
    getAccountDb().mutate('DELETE FROM pending_openid_requests');
  });

  it('consumes the pending request so the same state cannot be replayed', async () => {
    insertPendingRequest('test-state');

    const first = await loginWithOpenIdFinalize({
      code: 'auth-code',
      state: 'test-state',
    });
    expect(first).toEqual({ error: 'openid-grant-failed' });

    const second = await loginWithOpenIdFinalize({
      code: 'auth-code',
      state: 'test-state',
    });
    expect(second).toEqual({ error: 'invalid-or-expired-state' });
  });

  it('rejects unknown states without touching other pending requests', async () => {
    insertPendingRequest('other-state');

    const res = await loginWithOpenIdFinalize({
      code: 'auth-code',
      state: 'unknown-state',
    });

    expect(res).toEqual({ error: 'invalid-or-expired-state' });
    expect(
      getAccountDb().first(
        'SELECT state FROM pending_openid_requests WHERE state = ?',
        ['other-state'],
      ),
    ).not.toBeNull();
  });
});
