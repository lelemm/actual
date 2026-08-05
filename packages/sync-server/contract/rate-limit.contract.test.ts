import { inject } from 'vitest';

const serverUrl = inject('contractServerUrl');

async function post(path: string, password: string) {
  return fetch(`${serverUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

function expectRateHeaders(
  response: Response,
  remaining: number,
  hasRetryAfter = false,
) {
  expect(response.headers.get('ratelimit-policy')).toBe('5;w=900');
  expect(response.headers.get('ratelimit-limit')).toBe('5');
  expect(response.headers.get('ratelimit-remaining')).toBe(String(remaining));
  expect(Number(response.headers.get('ratelimit-reset'))).toBeGreaterThan(0);
  expect(response.headers.has('retry-after')).toBe(hasRetryAfter);
}

function expectOpenIdRateHeaders(
  response: Response,
  remaining: number,
  previousReset = 901,
  hasRetryAfter = false,
) {
  expect(response.headers.get('content-type')).toBe(
    'application/json; charset=utf-8',
  );
  expect(response.headers.get('ratelimit-policy')).toBe('5;w=900');
  expect(response.headers.get('ratelimit-limit')).toBe('5');
  expect(response.headers.get('ratelimit-remaining')).toBe(String(remaining));
  const reset = Number(response.headers.get('ratelimit-reset'));
  expect(reset).toBeGreaterThan(0);
  expect(reset).toBeLessThanOrEqual(previousReset);
  if (hasRetryAfter) {
    expect(Number(response.headers.get('retry-after'))).toBe(reset);
  } else {
    expect(response.headers.has('retry-after')).toBe(false);
  }
  return reset;
}

describe.runIf(process.env.ACTUAL_CONTRACT_VARIANT === 'rate-limit')(
  'authentication rate-limit contract',
  () => {
    it('rolls back successful requests and blocks the sixth failed attempt', async () => {
      const bootstrap = await post('/account/bootstrap', 'contract-password');
      expect(bootstrap.status).toBe(200);
      expectRateHeaders(bootstrap, 4);

      for (let attempt = 1; attempt <= 5; attempt++) {
        const rejected = await post('/account/login', 'wrong-password');
        expect(rejected.status).toBe(400);
        expectRateHeaders(rejected, 5 - attempt);
      }

      const blocked = await post('/account/login', 'wrong-password');
      expect(blocked.status).toBe(429);
      expectRateHeaders(blocked, 0, true);
      expect(await blocked.json()).toEqual({
        status: 'error',
        reason: 'too-many-requests',
      });
    }, 15_000);

    it('limits OpenID config access and reports an absent initial configuration', async () => {
      let reset = 901;
      const absent = await post('/openid/config', 'contract-password');
      expect(absent.status).toBe(500);
      expect(await absent.json()).toEqual({
        status: 'error',
        reason: 'OpenID configuration not found',
      });
      reset = expectOpenIdRateHeaders(absent, 4, reset);
      expect(reset).toBe(900);

      for (let attempt = 1; attempt <= 4; attempt++) {
        const rejected = await post('/openid/config', 'wrong-password');
        expect(rejected.status).toBe(400);
        expect(await rejected.json()).toEqual({
          status: 'error',
          reason: 'invalid-password',
        });
        reset = expectOpenIdRateHeaders(rejected, 4 - attempt, reset);
      }

      const blocked = await post('/openid/config', 'contract-password');
      expect(blocked.status).toBe(429);
      expect(await blocked.json()).toEqual({
        status: 'error',
        reason: 'too-many-requests',
      });
      expectOpenIdRateHeaders(blocked, 0, reset, true);
    }, 15_000);
  },
);
