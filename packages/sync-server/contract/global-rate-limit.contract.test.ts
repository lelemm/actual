import { inject } from 'vitest';

const serverUrl = inject('contractServerUrl');

describe.runIf(process.env.ACTUAL_CONTRACT_VARIANT === 'global-rate-limit')(
  'global HTTP rate-limit contract',
  () => {
    it('allows 500 requests per client and leaves CORS preflight outside the limiter', async () => {
      const first = await fetch(serverUrl + '/health');
      expect(first.status).toBe(200);
      expect(first.headers.get('ratelimit-limit')).toBe('500');
      expect(first.headers.get('ratelimit-policy')).toBe('500;w=60');
      const remaining = Number(first.headers.get('ratelimit-remaining'));
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThan(500);

      let lastAllowed = first;
      for (let index = 0; index < remaining; index++) {
        lastAllowed = await fetch(serverUrl + '/health');
      }
      expect(lastAllowed.status).toBe(200);
      expect(lastAllowed.headers.get('ratelimit-remaining')).toBe('0');

      const blocked = await fetch(serverUrl + '/health');
      expect(blocked.status).toBe(429);
      expect(await blocked.text()).toBe(
        'Too many requests, please try again later.',
      );
      expect(blocked.headers.get('ratelimit-limit')).toBe('500');
      expect(blocked.headers.get('ratelimit-remaining')).toBe('0');
      expect(Number(blocked.headers.get('ratelimit-reset'))).toBeGreaterThan(0);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);

      const preflight = await fetch(serverUrl + '/health', {
        method: 'OPTIONS',
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('ratelimit-limit')).toBeNull();
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    });
  },
);
