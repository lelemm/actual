import { inject } from 'vitest';

const serverUrl = inject('contractServerUrl');

async function login(headers: Record<string, string>) {
  return fetch(`${serverUrl}/account/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}',
  });
}

describe.runIf(process.env.ACTUAL_CONTRACT_VARIANT === 'header')(
  'trusted-header authentication contract',
  () => {
    beforeAll(async () => {
      const bootstrap = await fetch(`${serverUrl}/account/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'contract-password' }),
      });
      expect(bootstrap.status).toBe(200);
    });

    it('requires the header and authenticates only the trusted direct peer', async () => {
      const missing = await login({});
      expect(missing.status).toBe(200);
      expect(await missing.json()).toEqual({
        status: 'error',
        reason: 'invalid-header',
      });

      const rejected = await login({ 'x-actual-password': 'wrong-password' });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({
        status: 'error',
        reason: 'invalid-password',
      });

      const accepted = await login({
        'x-actual-password': 'contract-password',
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({
        status: 'ok',
        data: { token: expect.any(String) },
      });
    });
  },
);
