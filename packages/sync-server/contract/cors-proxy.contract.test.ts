import { inject } from 'vitest';

const serverUrl = inject('contractServerUrl');
const upstreamUrl = inject('corsProxyMockUrl');

async function request(path: string, init?: RequestInit) {
  return fetch(serverUrl + path, init);
}

function proxyUrl(target: string) {
  return '/cors-proxy/?url=' + encodeURIComponent(target);
}

describe.runIf(process.env.ACTUAL_CONTRACT_VARIANT === 'cors-proxy')(
  'CORS proxy HTTP contract',
  () => {
    it('preserves validation, allowlisting, forwarding, and response formats', async () => {
      const preflight = await request('/cors-proxy/', { method: 'OPTIONS' });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
      expect(preflight.headers.get('access-control-allow-methods')).toBe(
        'GET,HEAD,PUT,PATCH,POST,DELETE',
      );
      expect(preflight.headers.get('access-control-allow-headers')).toBeNull();
      expect(preflight.headers.get('access-control-max-age')).toBeNull();

      const missing = await request('/cors-proxy/');
      expect(missing.status).toBe(400);
      expect(await missing.json()).toEqual({ error: 'Missing url parameter' });

      const bootstrap = await request('/account/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'contract-password' }),
      });
      const bootstrapBody = (await bootstrap.json()) as {
        data: { token: string };
      };
      const token = bootstrapBody.data.token;

      const invalid = await request(proxyUrl('invalid-url'), {
        headers: { 'x-actual-token': token },
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: 'Invalid url parameter' });

      const data = await request(proxyUrl(upstreamUrl + '/repo/data.json'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': token,
          cookie: 'private-cookie=true',
        },
        body: JSON.stringify({
          method: 'get',
          headers: { 'X-Contract-Custom': 'forwarded' },
        }),
      });
      expect(data.status).toBe(201);
      expect(data.headers.get('access-control-allow-origin')).toBe('*');
      expect(data.headers.get('ratelimit-limit')).toBe('25');
      expect(await data.json()).toEqual({
        provider: 'contract-cors-proxy',
      });

      const textResponse = await request(
        proxyUrl(upstreamUrl + '/repo/readme.txt'),
        { headers: { 'x-actual-token': token } },
      );
      expect(textResponse.status).toBe(200);
      expect(textResponse.headers.get('content-type')).toContain('text/plain');
      expect(await textResponse.text()).toBe('contract text');

      const binary = await request(proxyUrl(upstreamUrl + '/repo/file.bin'), {
        headers: { 'x-actual-token': token },
      });
      expect(await binary.json()).toEqual({
        data: [1, 2, 3, 4, 5],
        contentType: 'application/octet-stream',
        isBinary: true,
      });

      const invalidJson = await request(
        proxyUrl(upstreamUrl + '/repo/invalid.json'),
        { headers: { 'x-actual-token': token } },
      );
      expect(invalidJson.headers.get('content-type')).toContain('text/plain');
      expect(await invalidJson.text()).toBe('not valid json');

      const rejectedMethod = await request(
        proxyUrl(upstreamUrl + '/repo/readme.txt'),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-actual-token': token,
          },
          body: JSON.stringify({ method: 'POST' }),
        },
      );
      expect(rejectedMethod.status).toBe(405);
      expect(await rejectedMethod.json()).toEqual({
        error: 'Method not allowed',
      });

      const blocked = await request(proxyUrl('http://127.0.0.1:1/private'), {
        headers: { 'x-actual-token': token },
      });
      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toEqual({
        error: 'URL not allowed',
        message:
          'Only allowlisted plugin repositories are allowed (localhost only in development)',
      });

      const requests = (await (
        await fetch(upstreamUrl + '/contract/requests')
      ).json()) as Array<{
        url: string;
        token?: string;
        cookie?: string;
        custom?: string;
      }>;
      expect(requests.map(({ url }) => url)).toEqual([
        '/plugins.json',
        '/repo/data.json',
        '/repo/readme.txt',
        '/repo/file.bin',
        '/repo/invalid.json',
      ]);
      expect(requests[1].token).toBeUndefined();
      expect(requests[1].cookie).toBeUndefined();
      expect(requests[1].custom).toBe('forwarded');
    });
  },
);
