import { inject } from 'vitest';

const serverUrl = inject('contractServerUrl');
const upstreamUrl = inject('corsProxyMockUrl');

let token = '';
let clientNumber = 1;

function proxyUrl(target: string) {
  return '/cors-proxy/?url=' + encodeURIComponent(target);
}

function clientIp(group?: number) {
  const value = group ?? clientNumber++;
  return `198.51.${Math.floor(value / 250)}.${(value % 250) + 1}`;
}

async function request(path: string, init: RequestInit = {}, group?: number) {
  const headers = new Headers(init.headers);
  headers.set('x-forwarded-for', clientIp(group));
  return fetch(serverUrl + path, { ...init, headers });
}

async function proxy(target: string, init: RequestInit = {}, group?: number) {
  const headers = new Headers(init.headers);
  headers.set('x-actual-token', token);
  return request(proxyUrl(target), { ...init, headers }, group);
}

async function setAllowlist(
  mode: 'success' | 'network-error' | 'http-error' | 'invalid',
) {
  const response = await fetch(`${upstreamUrl}/contract/allowlist/${mode}`, {
    method: 'POST',
  });
  expect(response.status).toBe(204);
}

async function recordedRequests() {
  return (await (
    await fetch(upstreamUrl + '/contract/requests')
  ).json()) as Array<{
    method: string;
    url: string;
    token?: string;
    cookie?: string;
    custom?: string;
    authorization?: string;
    userAgent?: string;
    body?: string;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function jsonObject(response: Response) {
  const value: unknown = await response.json();
  if (!isRecord(value)) {
    throw new TypeError('Expected a JSON object');
  }
  return value;
}

describe.runIf(process.env.ACTUAL_CONTRACT_VARIANT === 'cors-proxy')(
  'CORS proxy HTTP contract',
  () => {
    beforeAll(async () => {
      await fetch(upstreamUrl + '/contract/reset', { method: 'POST' });
      const bootstrap = await request('/account/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'contract-password' }),
      });
      const body = (await bootstrap.json()) as { data: { token: string } };
      token = body.data.token;
    });

    it('handles the full-server CORS preflight', async () => {
      const response = await request('/cors-proxy/', { method: 'OPTIONS' });
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-methods')).toBe(
        'GET,HEAD,PUT,PATCH,POST,DELETE',
      );
      expect(response.headers.get('access-control-allow-headers')).toBeNull();
      expect(response.headers.get('access-control-max-age')).toBeNull();
    });

    it('returns 400 when the url parameter is missing', async () => {
      const response = await request('/cors-proxy/');
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Missing url parameter' });
    });

    it('treats an empty url parameter as missing', async () => {
      const response = await request('/cors-proxy/?url=', {
        headers: { 'x-actual-token': token },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Missing url parameter' });
    });

    it('returns 400 when the url parameter is invalid', async () => {
      const response = await proxy('invalid-url');
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid url parameter' });
    });

    it('returns the session validation response before proxying', async () => {
      const response = await request(proxyUrl('https://example.com'));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        status: 'error',
        reason: 'unauthorized',
        details: 'token-not-found',
      });
    });

    it('handles allowlist network failure safely', async () => {
      await setAllowlist('network-error');
      const response = await proxy(upstreamUrl + '/repo/readme.txt');
      expect(response.status).toBe(403);
      expect((await jsonObject(response)).error).toBe('URL not allowed');
    });

    it('handles allowlist HTTP failure safely', async () => {
      await setAllowlist('http-error');
      const response = await proxy(upstreamUrl + '/repo/readme.txt');
      expect(response.status).toBe(403);
      expect((await jsonObject(response)).error).toBe('URL not allowed');
    });

    it('fetches a valid allowlist and permits repository descendants', async () => {
      await setAllowlist('success');
      const response = await proxy(upstreamUrl + '/repo/readme.txt');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('contract text');
    });

    it('caches a non-empty allowlist', async () => {
      await proxy(upstreamUrl + '/repo/readme.txt');
      await proxy(upstreamUrl + '/repo/readme.txt');
      const requests = await recordedRequests();
      expect(
        requests.filter(({ url }) => url === '/plugins.json'),
      ).toHaveLength(3);
    });

    it('stringifies duplicate url parameters before allowlist validation', async () => {
      const response = await request(
        '/cors-proxy/?url=https%3A%2F%2Fexample.com&url=https%3A%2F%2Fexample.org',
        { headers: { 'x-actual-token': token } },
      );
      expect(response.status).toBe(403);
      expect((await jsonObject(response)).error).toBe('URL not allowed');
    });

    it.each([
      'http://192.168.1.1/test',
      'http://127.0.0.1:1/test',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/test',
      'http://[::ffff:127.0.0.1]/test',
    ])('blocks private, local, or link-local literal %s', async target => {
      const response = await proxy(target);
      expect(response.status).toBe(403);
      expect((await jsonObject(response)).error).toBe('URL not allowed');
    });

    it('blocks non-allowlisted public URLs', async () => {
      const response = await proxy('https://example.com/evil');
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'URL not allowed',
        message:
          'Only allowlisted plugin repositories are allowed (localhost only in development)',
      });
    });

    it('allows GET by default', async () => {
      const response = await proxy(upstreamUrl + '/repo/readme.txt');
      expect(response.status).toBe(200);
    });

    it('normalizes a lowercase GET method before forwarding', async () => {
      const response = await proxy(upstreamUrl + '/repo/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'get' }),
      });
      expect(response.status).toBe(200);
      expect((await jsonObject(response)).method).toBe('GET');
    });

    it('allows HEAD and returns no response body', async () => {
      const response = await proxy(upstreamUrl + '/repo/readme.txt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'HEAD' }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('');
    });

    it.each(['POST', 'PUT'])('blocks the %s upstream method', async method => {
      const response = await proxy(upstreamUrl + '/repo/readme.txt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method }),
      });
      expect(response.status).toBe(405);
      expect(await response.json()).toEqual({ error: 'Method not allowed' });
    });

    it.each([[['POST']], [{ value: 'POST' }]])(
      'rejects a non-string method',
      async method => {
        const response = await proxy(upstreamUrl + '/repo/readme.txt', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: 'Invalid method parameter',
        });
      },
    );

    it('forwards custom headers but strips credentials and body metadata', async () => {
      const response = await proxy(upstreamUrl + '/repo/echo', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'private-cookie=true',
        },
        body: JSON.stringify({
          method: 'GET',
          headers: { 'X-Contract-Custom': 'forwarded' },
        }),
      });
      expect(response.status).toBe(200);
      const forwarded = await jsonObject(response);
      expect(forwarded).toMatchObject({
        method: 'GET',
        custom: 'forwarded',
        body: '',
      });
      expect(forwarded.token).toBeUndefined();
      expect(forwarded.cookie).toBeUndefined();
    });

    it('does not add GitHub credentials to a non-GitHub host', async () => {
      const response = await proxy(upstreamUrl + '/repo/echo');
      expect(response.status).toBe(200);
      expect((await jsonObject(response)).authorization).toBeUndefined();
    });

    it('preserves JSON response status, body, and CORS headers', async () => {
      const response = await proxy(upstreamUrl + '/repo/data.json');
      expect(response.status).toBe(201);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('ratelimit-limit')).toBe('25');
      expect(await response.json()).toEqual({
        provider: 'contract-cors-proxy',
      });
    });

    it('preserves text responses', async () => {
      const response = await proxy(upstreamUrl + '/repo/readme.txt');
      expect(response.headers.get('content-type')).toContain('text/plain');
      expect(await response.text()).toBe('contract text');
    });

    it('wraps binary responses in the source JSON format', async () => {
      const response = await proxy(upstreamUrl + '/repo/file.bin');
      expect(response.headers.get('content-type')).toContain(
        'application/json',
      );
      expect(await response.json()).toEqual({
        data: [1, 2, 3, 4, 5],
        contentType: 'application/octet-stream',
        isBinary: true,
      });
    });

    it('falls back to text when a JSON-looking URL has invalid JSON', async () => {
      const response = await proxy(upstreamUrl + '/repo/invalid.json');
      expect(response.headers.get('content-type')).toContain('text/plain');
      expect(await response.text()).toBe('not valid json');
    });

    it.each([
      ['/repo/package.json', { package: true }],
      ['/repo/manifest', { manifest: true }],
    ])('detects JSON from the URL pattern %s', async (path, expected) => {
      const response = await proxy(upstreamUrl + path);
      expect(response.headers.get('content-type')).toContain(
        'application/json',
      );
      expect(await response.json()).toEqual(expected);
    });

    it('preserves upstream non-2xx status and body', async () => {
      const response = await proxy(upstreamUrl + '/repo/status');
      expect(response.status).toBe(418);
      expect(await response.text()).toBe('teapot');
      expect(response.headers.get('x-upstream')).toBeNull();
    });

    it('follows an allowlisted same-origin redirect', async () => {
      const response = await proxy(upstreamUrl + '/repo/redirect');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('contract text');
    });

    it('reports upstream network errors', async () => {
      const response = await proxy(upstreamUrl + '/repo/network-error');
      expect(response.status).toBe(500);
      const body = await jsonObject(response);
      expect(body.error).toBe('Error proxying request');
      expect(body.details).toEqual(expect.any(String));
    });

    it('keeps independent trusted client IPs below the proxy rate limit', async () => {
      const responses = await Promise.all(
        Array.from({ length: 30 }, () =>
          proxy(upstreamUrl + '/repo/readme.txt'),
        ),
      );
      expect(responses.every(response => response.status === 200)).toBe(true);
    });

    it('saturates concurrent requests atomically at 25 per client', async () => {
      const group = 24_000;
      const responses = await Promise.all(
        Array.from({ length: 26 }, () =>
          proxy(upstreamUrl + '/repo/slow', {}, group),
        ),
      );
      const statuses = responses
        .map(response => response.status)
        .sort((left, right) => left - right);
      expect(statuses.filter(status => status === 200)).toHaveLength(25);
      expect(statuses.filter(status => status === 429)).toHaveLength(1);
      const limited = responses.find(response => response.status === 429)!;
      expect(limited.headers.get('ratelimit-remaining')).toBe('0');
      expect(limited.headers.get('retry-after')).not.toBeNull();
      expect(await limited.text()).toBe(
        'Too many requests, please try again later.',
      );
    });
  },
);
