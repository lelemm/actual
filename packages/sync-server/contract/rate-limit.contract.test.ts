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
    });
  },
);
